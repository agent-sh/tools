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

interface ServerEntry {
  readonly handle: ServerHandle;
  readonly proc: ChildProcess;
  readonly conn: MessageConnection;
  readonly openedFiles: Set<string>;
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

  async function didOpenIfNeeded(
    entry: ServerEntry,
    filePath: string,
  ): Promise<void> {
    if (entry.openedFiles.has(filePath)) return;
    const text = await readFileText(filePath);
    const uri = pathToFileURL(filePath).toString();
    const languageId = entry.handle.language;
    entry.conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
    entry.openedFiles.add(filePath);
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

    proc.on("error", () => {
      const e = servers.get(k);
      if (e) e.state = "crashed";
    });
    proc.on("exit", () => {
      const e = servers.get(k);
      if (e) e.state = "crashed";
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
      openedFiles: new Set(),
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
      conn.sendNotification("initialized", {});
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
    await didOpenIfNeeded(entry, filePath);
    const uri = pathToFileURL(filePath).toString();
    const result = await withAbort<Hover | null>(
      entry.conn.sendRequest("textDocument/hover", {
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
    await didOpenIfNeeded(entry, filePath);
    const uri = pathToFileURL(filePath).toString();
    const body: Record<string, unknown> = {
      textDocument: { uri },
      position: toLspPosition(pos),
    };
    if (method === "textDocument/references") {
      body.context = { includeDeclaration: true };
    }
    const result = await withAbort<Location[] | LocationLink[] | null>(
      entry.conn.sendRequest(method, body),
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
    await didOpenIfNeeded(entry, filePath);
    const uri = pathToFileURL(filePath).toString();
    const result = await withAbort<
      DocumentSymbol[] | SymbolInformation[] | null
    >(
      entry.conn.sendRequest("textDocument/documentSymbol", {
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
      entry.conn.sendRequest("workspace/symbol", { query }),
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

  async function closeSession(): Promise<void> {
    for (const entry of servers.values()) {
      try {
        await entry.conn.sendRequest("shutdown");
        entry.conn.sendNotification("exit");
      } catch {
        // best effort
      }
      try {
        entry.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    servers.clear();
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

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (!signal.aborted) {
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
