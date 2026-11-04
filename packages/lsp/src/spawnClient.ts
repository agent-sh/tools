import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { MessageConnection } from "vscode-jsonrpc";
import type {
  DocumentSymbol,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
  MarkupContent,
  Position,
  SymbolInformation,
} from "vscode-languageserver-protocol";
import { LSP_SYMBOL_KIND_NAMES } from "./constants.js";
import type {
  LspClient,
  LspHoverResult,
  LspLocation,
  LspServerProfile,
  LspSymbolInfo,
  Position1,
  ServerHandle,
} from "./types.js";

/**
 * Default LspClient that spawns language-server binaries over stdio
 * and speaks LSP via vscode-jsonrpc.
 *
 * Responsibilities this client owns:
 * - Process lifecycle: spawn, initialize handshake, shutdown/exit.
 * - State transitions: starting \u2192 ready, observed via initialize response.
 * - File sync: didOpen on first reference to a path per (server, path);
 *   didSave after external writes (not implemented in v1 \u2014 we rely on
 *   single-shot queries that re-read the file each time).
 * - Position conversion: 1-indexed (tool-boundary) \u2194 0-indexed UTF-16 (LSP).
 * - Request cancellation via AbortSignal \u2192 $/cancelRequest.
 * - Result normalization: LSP's ragged response shapes \u2192 our flat types.
 */

/**
 * Bound for each step of stopping a server: the `shutdown` reply, the exit
 * after `exit`, and the exit after SIGTERM before SIGKILL. Design spec
 * section 5.4 (agent-knowledge/design/lsp.md).
 */
const STOP_STEP_MS = 2_000;

const TIMED_OUT = Symbol("timed out");

interface ServerEntry {
  readonly handle: ServerHandle;
  readonly proc: ChildProcess;
  readonly conn: MessageConnection;
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
  /** didOpen per path: in flight or done. A failed open is dropped and retried. */
  readonly openedFiles: Map<string, Promise<void>>;
  state: "starting" | "ready" | "crashed";
}

export function createSpawnLspClient(): LspClient {
  const servers = new Map<string, ServerEntry>();

  function key(language: string, root: string): string {
    return `${language}|${root}`;
  }

  async function readFileText(p: string): Promise<string> {
    try {
      return await readFile(p, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * Send didOpen once per (server, path). Concurrent callers share the one
   * in flight. Callers wait for it under their operation signal, so a
   * server that stops reading stdin cannot hold an operation past its
   * timeout.
   */
  function didOpenIfNeeded(
    entry: ServerEntry,
    filePath: string,
  ): Promise<void> {
    const existing = entry.openedFiles.get(filePath);
    if (existing) return existing;
    const opening = (async () => {
      const text = await readFileText(filePath);
      const uri = pathToFileURL(filePath).toString();
      const languageId = entry.handle.language;
      // Await the write: if the server's stdin broke, the caller's
      // operation fails with that error instead of it going unhandled.
      await entry.conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text,
        },
      });
    })();
    entry.openedFiles.set(filePath, opening);
    // A failed open is retried by the next call. This handler also keeps
    // an open whose callers all gave up from ever going unhandled.
    opening.catch(() => {
      if (entry.openedFiles.get(filePath) === opening) {
        entry.openedFiles.delete(filePath);
      }
    });
    return opening;
  }

  async function ensureServer(args: {
    language: string;
    root: string;
    profile: LspServerProfile;
  }): Promise<ServerHandle> {
    const k = key(args.language, args.root);
    const existing = servers.get(k);
    if (existing && existing.state !== "crashed") {
      return existing.handle;
    }

    const [cmd, ...cmdArgs] = args.profile.command;
    if (!cmd) {
      throw new Error(
        `LSP profile '${args.language}' has empty command`,
      );
    }
    const proc = spawn(cmd, cmdArgs, {
      cwd: args.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    // Only mark this process's own entry: a re-spawned server under the
    // same key must not be marked crashed when an old process exits late.
    const markCrashed = (): void => {
      const e = servers.get(k);
      if (e?.proc === proc) e.state = "crashed";
    };
    proc.on("error", markCrashed);
    const exited = new Promise<void>((resolve) => {
      proc.on("exit", () => {
        markCrashed();
        resolve();
      });
    });

    const reader = new StreamMessageReader(proc.stdout!);
    const writer = new StreamMessageWriter(proc.stdin!);
    const conn = createMessageConnection(reader, writer);

    const handle: ServerHandle = {
      language: args.language,
      root: args.root,
      state: "starting",
    };
    const entry: ServerEntry = {
      handle,
      proc,
      conn,
      exited,
      openedFiles: new Map(),
      state: "starting",
    };
    servers.set(k, entry);

    conn.listen();

    const initParams: InitializeParams = {
      processId: process.pid,
      rootUri: pathToFileURL(args.root).toString(),
      workspaceFolders: [
        { uri: pathToFileURL(args.root).toString(), name: path.basename(args.root) },
      ],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          implementation: { linkSupport: true },
        },
        workspace: {
          symbol: {},
        },
      },
      ...(args.profile.initializationOptions
        ? { initializationOptions: args.profile.initializationOptions }
        : {}),
    };

    try {
      await conn.sendRequest<InitializeResult>("initialize", initParams);
      // Await the write: a server whose stdin broke here is not ready.
      await conn.sendNotification("initialized", {});
      entry.state = "ready";
      // We deliberately return a fresh handle rather than mutating the
      // old one to keep the ServerHandle immutable from the caller's pov.
      const readyHandle: ServerHandle = { ...handle, state: "ready" };
      servers.set(k, { ...entry, handle: readyHandle, state: "ready" });
      return readyHandle;
    } catch (e) {
      entry.state = "crashed";
      proc.kill("SIGTERM");
      throw e;
    }
  }

  function requireReady(h: ServerHandle): ServerEntry {
    const entry = servers.get(key(h.language, h.root));
    if (!entry || entry.state !== "ready") {
      throw new Error(
        `Server for ${h.language} at ${h.root} is not ready (state=${entry?.state ?? "missing"})`,
      );
    }
    return entry;
  }

  function toLspPosition(pos: Position1): Position {
    // 1-indexed \u2192 0-indexed. UTF-16 conversion is approximated here as
    // UTF-16 \u2248 UTF-8 for ASCII; for full correctness we'd need to read
    // the file and convert byte offsets to code-unit offsets. v1 uses
    // the character-as-column-number convention the LSP spec defines
    // (column 0 = first char), which matches what we send.
    return { line: pos.line - 1, character: pos.character - 1 };
  }

  function fromLspPositionLine(line: number): number {
    return line + 1;
  }
  function fromLspPositionChar(ch: number): number {
    return ch + 1;
  }

  async function hover(
    h: ServerHandle,
    filePath: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<LspHoverResult | null> {
    const entry = requireReady(h);
    await withAbort(() => didOpenIfNeeded(entry, filePath), signal);
    const uri = pathToFileURL(filePath).toString();
    const result = await withAbort<Hover | null>(
      () => entry.conn.sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: toLspPosition(pos),
      }),
      signal,
    );
    if (!result || !result.contents) return null;
    const flat = flattenHoverContents(result.contents);
    if (flat.text.length === 0) return null;
    return { contents: flat.text, isMarkdown: flat.isMarkdown };
  }

  async function definitionLike(
    method: "textDocument/definition" | "textDocument/references" | "textDocument/implementation",
    h: ServerHandle,
    filePath: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<readonly LspLocation[]> {
    const entry = requireReady(h);
    await withAbort(() => didOpenIfNeeded(entry, filePath), signal);
    const uri = pathToFileURL(filePath).toString();
    const body: Record<string, unknown> = {
      textDocument: { uri },
      position: toLspPosition(pos),
    };
    if (method === "textDocument/references") {
      body.context = { includeDeclaration: true };
    }
    const result = await withAbort<Location[] | LocationLink[] | null>(
      () => entry.conn.sendRequest(method, body),
      signal,
    );
    if (!result) return [];
    const locs = Array.isArray(result) ? result : [result];
    const out: LspLocation[] = [];
    for (const loc of locs) {
      const norm = await normalizeLocation(loc);
      if (norm) out.push(norm);
    }
    return out;
  }

  async function normalizeLocation(
    loc: Location | LocationLink,
  ): Promise<LspLocation | null> {
    const uri = (loc as Location).uri ?? (loc as LocationLink).targetUri;
    const range =
      (loc as Location).range ?? (loc as LocationLink).targetSelectionRange ?? (loc as LocationLink).targetRange;
    if (!uri || !range) return null;
    const filePath = fileUriToPath(uri);
    const preview = await previewLineAt(filePath, range.start.line);
    return {
      path: filePath,
      line: fromLspPositionLine(range.start.line),
      character: fromLspPositionChar(range.start.character),
      preview,
    };
  }

  async function previewLineAt(filePath: string, zeroIndexedLine: number): Promise<string> {
    const text = await readFileText(filePath);
    const lines = text.split(/\r?\n/);
    return (lines[zeroIndexedLine] ?? "").trim();
  }

  async function documentSymbol(
    h: ServerHandle,
    filePath: string,
    signal: AbortSignal,
  ): Promise<readonly LspSymbolInfo[]> {
    const entry = requireReady(h);
    await withAbort(() => didOpenIfNeeded(entry, filePath), signal);
    const uri = pathToFileURL(filePath).toString();
    const result = await withAbort<
      DocumentSymbol[] | SymbolInformation[] | null
    >(
      () => entry.conn.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      }),
      signal,
    );
    if (!result || result.length === 0) return [];
    // Detect shape: DocumentSymbol (has `children`) vs SymbolInformation (has `location`)
    const first = result[0] as { children?: unknown; location?: unknown };
    if (first.location !== undefined) {
      return (result as SymbolInformation[]).map((s) => ({
        name: s.name,
        kind: kindName(s.kind),
        path: fileUriToPath(s.location.uri),
        line: fromLspPositionLine(s.location.range.start.line),
        character: fromLspPositionChar(s.location.range.start.character),
        ...(s.containerName !== undefined
          ? { containerName: s.containerName }
          : {}),
      }));
    }
    // DocumentSymbol shape: recursive
    return (result as DocumentSymbol[]).map((d) => mapDocumentSymbol(d, filePath));
  }

  function mapDocumentSymbol(d: DocumentSymbol, filePath: string): LspSymbolInfo {
    return {
      name: d.name,
      kind: kindName(d.kind),
      path: filePath,
      line: fromLspPositionLine(d.range.start.line),
      character: fromLspPositionChar(d.range.start.character),
      ...(d.children && d.children.length > 0
        ? { children: d.children.map((c) => mapDocumentSymbol(c, filePath)) }
        : {}),
    };
  }

  async function workspaceSymbol(
    h: ServerHandle,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly LspSymbolInfo[]> {
    const entry = requireReady(h);
    const result = await withAbort<SymbolInformation[] | null>(
      () => entry.conn.sendRequest("workspace/symbol", { query }),
      signal,
    );
    if (!result) return [];
    return result.map((s) => ({
      name: s.name,
      kind: kindName(s.kind),
      path: fileUriToPath(s.location.uri),
      line: fromLspPositionLine(s.location.range.start.line),
      character: fromLspPositionChar(s.location.range.start.character),
      ...(s.containerName !== undefined
        ? { containerName: s.containerName }
        : {}),
    }));
  }

  /**
   * Send `shutdown` and `exit`. Resolves true once `exit` is written, false
   * when the server cannot take it: it failed or did not answer `shutdown`
   * in time, it exited, its stdin broke, or `exit` was not written in time. A write error here is expected
   * (the server may be gone) and is handled, never left unhandled.
   */
  async function requestExit(entry: ServerEntry): Promise<boolean> {
    try {
      const reply = await within(
        Promise.race([entry.conn.sendRequest("shutdown"), entry.exited]),
        STOP_STEP_MS,
      );
      if (reply === TIMED_OUT || !isRunning(entry.proc)) return false;
      // Bounded too: a write queued ahead (an abandoned didOpen, say) can
      // hold `exit` behind it when the server stops reading stdin.
      const sent = await within(entry.conn.sendNotification("exit"), STOP_STEP_MS);
      return sent !== TIMED_OUT;
    } catch {
      return false;
    }
  }

  /**
   * Stop one server: `shutdown` and `exit`, then SIGTERM, then SIGKILL,
   * each step bounded by STOP_STEP_MS. A server that is not ready skips
   * `shutdown` and `exit`. No signal is sent before the `exit` write
   * settles, so the write never races the process going away. Returns once
   * the process has exited, or STOP_STEP_MS after SIGKILL.
   */
  async function stopServer(entry: ServerEntry): Promise<void> {
    const { proc, conn, exited } = entry;
    try {
      if (!isRunning(proc)) return;
      if (
        entry.state === "ready" &&
        (await requestExit(entry)) &&
        (await within(exited, STOP_STEP_MS)) !== TIMED_OUT
      ) {
        return;
      }
      if (!isRunning(proc)) return;
      proc.kill("SIGTERM");
      if ((await within(exited, STOP_STEP_MS)) !== TIMED_OUT) return;
      proc.kill("SIGKILL");
      await within(exited, STOP_STEP_MS);
    } finally {
      conn.dispose();
    }
  }

  async function closeSession(): Promise<void> {
    const entries = [...servers.values()];
    servers.clear();
    await Promise.all(entries.map(stopServer));
  }

  return {
    ensureServer,
    hover,
    definition: (h, p, pos, s) => definitionLike("textDocument/definition", h, p, pos, s),
    references: (h, p, pos, s) => definitionLike("textDocument/references", h, p, pos, s),
    implementation: (h, p, pos, s) => definitionLike("textDocument/implementation", h, p, pos, s),
    documentSymbol,
    workspaceSymbol,
    closeSession,
  };
}

// ---- helpers ----

/** True while the process was spawned and has not exited yet. */
function isRunning(proc: ChildProcess): boolean {
  return (
    proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null
  );
}

/**
 * Settle with `promise`, or with TIMED_OUT after `ms`. The timer is cleared
 * when `promise` settles first, so it never holds the event loop open.
 */
async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function fileUriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri;
    }
  }
  return uri;
}

function kindName(kind: number): string {
  return LSP_SYMBOL_KIND_NAMES[kind] ?? "_unknown";
}

function flattenHoverContents(
  contents: Hover["contents"],
): { text: string; isMarkdown: boolean } {
  if (typeof contents === "string") {
    return { text: contents, isMarkdown: false };
  }
  if (Array.isArray(contents)) {
    const parts = contents.map((c) => {
      if (typeof c === "string") return c;
      const mc = c as { language?: string; value: string };
      return mc.language ? `\`\`\`${mc.language}\n${mc.value}\n\`\`\`` : mc.value;
    });
    return { text: parts.join("\n\n"), isMarkdown: true };
  }
  const mc = contents as MarkupContent;
  if (mc.kind !== undefined) {
    return { text: mc.value, isMarkdown: mc.kind === "markdown" };
  }
  const ms = contents as { language?: string; value: string };
  if (ms.value) {
    return {
      text: ms.language ? `\`\`\`${ms.language}\n${ms.value}\n\`\`\`` : ms.value,
      isMarkdown: true,
    };
  }
  return { text: "", isMarkdown: false };
}

/**
 * Run `start` under `signal`. Nothing is sent when the signal is already
 * aborted. On a later abort the caller gets "aborted" and the abandoned
 * promise stays handled, so a rejection that comes after (for example when
 * closeSession disposes the connection) is never unhandled.
 */
async function withAbort<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (!signal.aborted) {
    const promise = start();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }
  throw new Error("aborted");
}
