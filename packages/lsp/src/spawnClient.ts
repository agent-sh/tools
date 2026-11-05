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
import { DEFAULT_INITIALIZE_TIMEOUT_MS, LSP_SYMBOL_KIND_NAMES } from "./constants.js";
import { LspServerCrashedError, LspServerExitedError } from "./errors.js";
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

/**
 * Bytes of server stderr kept for the exit error. Enough for a typical
 * Node stack trace or Rust panic message; the rest is read and dropped.
 */
const STDERR_TAIL_BYTES = 4_096;

const TIMED_OUT = Symbol("timed out");

/**
 * On POSIX each server leads its own process group (`detached`, which also
 * gives it its own session), so a signal reaches its children too, such as
 * tsserver under typescript-language-server. Windows has no process groups:
 * there the client signals the server process only. Design spec 5.4.
 */
const OWN_GROUP = process.platform !== "win32";

/**
 * Servers of every client whose process has not exited yet, retired ones
 * included. While there is one, a single `process` exit handler kills each
 * one's process group, so a host that exits without `closeSession` leaves
 * no server or child behind, as a Rust runtime that shuts down does. The
 * handler is shared by all clients, so any number of them adds one
 * listener, and it goes once the last live server has exited, so
 * `closeSession` removes it. Hosts still handle SIGINT and SIGTERM
 * themselves: the library installs no signal handler.
 */
const liveServers = new Set<ChildProcess>();

function killLiveGroups(): void {
  for (const proc of liveServers) signalServer(proc, "SIGKILL");
}

function trackLive(proc: ChildProcess): void {
  if (liveServers.size === 0) process.once("exit", killLiveGroups);
  liveServers.add(proc);
  proc.once("exit", () => {
    liveServers.delete(proc);
    if (liveServers.size === 0) process.off("exit", killLiveGroups);
  });
}

export interface SpawnLspClientOptions {
  /**
   * Bound for the `initialize` handshake, in ms. Defaults to
   * DEFAULT_INITIALIZE_TIMEOUT_MS, the session backstop (design spec
   * section 8), so a start can outlive the tool call that began it.
   */
  readonly initializeTimeoutMs?: number;
}

interface ServerEntry {
  handle: ServerHandle;
  readonly proc: ChildProcess;
  readonly conn: MessageConnection;
  /** Resolves when the process has exited, or failed to spawn. */
  readonly exited: Promise<void>;
  /**
   * Fires once the server can no longer serve calls, with the error to
   * report: the process is gone, or a pipe broke while it lives.
   */
  readonly gone: GoneNotice;
  /** The server's stderr tail, as text. */
  readonly stderr: () => string;
  /** The connection closed: one of the pipes ended. */
  closed: boolean;
  /** Set once the server is taken out of service and being stopped. */
  stopping: Promise<void> | undefined;
  /**
   * Why the start failed, kept while no caller has seen it: the caller that
   * began the start gave up before it ended. The next ensureServer for this
   * key reports it once, then the call after that starts a new server.
   */
  unreportedStartError: unknown;
  /** didOpen per path: in flight or done. A failed open is dropped and retried. */
  readonly openedFiles: Map<string, Promise<void>>;
  state: "starting" | "ready" | "crashed";
}

export function createSpawnLspClient(
  options: SpawnLspClientOptions = {},
): LspClient {
  const initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  const servers = new Map<string, ServerEntry>();
  /** Stops of retired servers, which may no longer be in `servers`. */
  const stops = new Set<Promise<void>>();
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
      await call(entry, () =>
        entry.conn.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId,
            version: 1,
            text,
          },
        }),
      );
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

  /**
   * Run one send against the server. When the process is gone by the time
   * the send settles or fails, report the exit instead: a request still in
   * flight when the server dies rejects with LspServerExitedError, not with
   * a broken pipe and not by hanging until the caller's abort. When the
   * process lives but its stdin broke, it can never take another message:
   * retire it with LspServerCrashedError, so this call reports the crash and
   * the next call starts a new server.
   */
  function call<T>(entry: ServerEntry, send: () => Promise<T>): Promise<T> {
    const { gone, proc } = entry;
    if (gone.fired) return Promise.reject(gone.reason);
    return new Promise<T>((resolve, reject) => {
      const unsubscribe = gone.subscribe(reject);
      const fail = (e: unknown): void => {
        // In each early return the subscription rejects with the error to
        // report once `gone` fires.
        if (!isRunning(proc)) return;
        if (proc.stdin?.destroyed) {
          const { language } = entry.handle;
          retire(
            entry,
            new LspServerCrashedError(
              language,
              `Language server for ${language} stopped reading its input (${messageOf(e)}).`,
              entry.stderr(),
              { cause: e },
            ),
          );
          return;
        }
        // A closed connection gets its verdict from the onClose handler.
        if (entry.closed) return;
        unsubscribe();
        reject(e);
      };
      try {
        send().then((value) => {
          unsubscribe();
          resolve(value);
        }, fail);
      } catch (e) {
        fail(e);
      }
    });
  }

  /**
   * Take a server out of service: mark it crashed, so the next call starts
   * a new one, and stop its process. With a reason, every call still waiting
   * on it rejects with that reason. closeSession waits for the stop even
   * after a new server has replaced this one.
   */
  function retire(entry: ServerEntry, reason?: unknown): void {
    entry.state = "crashed";
    if (reason !== undefined) entry.gone.fire(reason);
    if (entry.stopping) return;
    const stop = stopServer(entry);
    entry.stopping = stop;
    stops.add(stop);
    void stop.then(() => stops.delete(stop));
  }

  async function ensureServer(args: {
    language: string;
    root: string;
    profile: LspServerProfile;
    signal?: AbortSignal;
  }): Promise<ServerHandle> {
    const k = key(args.language, args.root);
    const existing = servers.get(k);
    if (existing && existing.state !== "crashed") {
      return existing.handle;
    }
    if (args.signal?.aborted) throw new Error("aborted");
    if (existing?.unreportedStartError !== undefined) {
      const reason = existing.unreportedStartError;
      servers.delete(k);
      throw reason;
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
      detached: OWN_GROUP,
    });
    // A failed spawn has no pid and never exits.
    if (proc.pid !== undefined) trackLive(proc);

    // Drain stderr: once the pipe fills, a server that keeps writing to it
    // blocks. Keep only a bounded tail, for the exit error.
    let stderrTail: Buffer = Buffer.alloc(0);
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_BYTES);
    });
    proc.stderr?.on("error", () => {
      // Losing diagnostics must not crash the host.
    });

    const reader = new StreamMessageReader(proc.stdout!);
    const writer = new StreamMessageWriter(proc.stdin!);
    const conn = createMessageConnection(reader, writer);

    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const gone = new GoneNotice();

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
      gone,
      stderr: () => stderrTail.toString("utf8").trim(),
      closed: false,
      stopping: undefined,
      unreportedStartError: undefined,
      openedFiles: new Map(),
      state: "starting",
    };
    servers.set(k, entry);

    // Handlers touch only their own entry: a re-spawned server under the
    // same key is a different entry and stays untouched by an old exit.
    // An exit while starting leaves the state at "starting": the start's own
    // failure handler marks it crashed and stores the error to report. A pipe
    // that breaks during the start marks it crashed first and the error is
    // stored later in the same turn, so no call sees it crashed without it.
    const markCrashed = (): void => {
      if (entry.state !== "starting") entry.state = "crashed";
    };
    const markGone = (reason: unknown): void => {
      markCrashed();
      resolveExited();
      gone.fire(reason);
      // Rejects whatever the connection still holds; no write can follow.
      conn.dispose();
    };
    proc.on("error", (e) => {
      // A failed spawn has no pid and emits no 'exit'.
      if (proc.pid === undefined) markGone(e);
      else entry.state = "crashed";
    });
    proc.on("exit", (code, signal) => {
      // The server is gone; its children go with it, whether it exited on
      // its own, on `exit`, or on a signal some child ignored.
      killGroup(proc);
      markCrashed();
      resolveExited();
      // One more turn lets stderr that is already in the pipe arrive, so
      // the error carries the server's last words.
      setImmediate(() =>
        markGone(
          new LspServerExitedError(
            args.language,
            code,
            signal,
            entry.stderr(),
          ),
        ),
      );
    });
    // A pipe closed. A process that lives on can never answer again: give
    // it one stop step to exit on its own, then retire it.
    conn.onClose(() => {
      entry.closed = true;
      if (!isRunning(proc)) return;
      void within(exited, STOP_STEP_MS).then((result) => {
        if (result !== TIMED_OUT || !isRunning(proc)) return;
        retire(
          entry,
          new LspServerCrashedError(
            args.language,
            `Language server for ${args.language} closed its output and stopped answering.`,
            entry.stderr(),
          ),
        );
      });
    });

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

    const starting = (async (): Promise<ServerHandle> => {
      try {
        const init = await within(
          call(entry, () =>
            conn.sendRequest<InitializeResult>("initialize", initParams),
          ),
          initializeTimeoutMs,
        );
        if (init === TIMED_OUT) {
          throw new Error(
            `Language server for ${args.language} did not answer initialize within ${initializeTimeoutMs}ms. The next call starts it again.`,
          );
        }
        // Await the write: a server whose stdin broke here is not ready.
        await call(entry, () => conn.sendNotification("initialized", {}));
        // A server that exited right after the handshake is not ready either.
        if (!isRunning(proc)) throw await gone.wait();
        // We deliberately return a fresh handle rather than mutating the
        // old one to keep the ServerHandle immutable from the caller's pov.
        const readyHandle: ServerHandle = { ...handle, state: "ready" };
        entry.handle = readyHandle;
        entry.state = "ready";
        return readyHandle;
      } catch (e) {
        retire(entry);
        entry.unreportedStartError = e;
        throw e;
      }
    })();
    // An abort releases the caller only. The handshake goes on, bounded by
    // initializeTimeoutMs, and the next call finds the server starting or
    // ready, or is told why the start failed. This handler keeps a failure
    // nobody waits for handled.
    starting.catch(() => {});
    try {
      return await (args.signal ? withAbort(() => starting, args.signal) : starting);
    } catch (e) {
      // This caller got the start's own error: it is reported.
      if (e === entry.unreportedStartError) entry.unreportedStartError = undefined;
      throw e;
    }
  }

  async function requireReady(h: ServerHandle): Promise<ServerEntry> {
    const entry = servers.get(key(h.language, h.root));
    // A server that died, or lost a pipe, since the caller got its handle
    // reports that.
    if (entry && (entry.gone.fired || (entry.state === "crashed" && !isRunning(entry.proc)))) {
      throw await entry.gone.wait();
    }
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
    const entry = await requireReady(h);
    await withAbort(() => didOpenIfNeeded(entry, filePath), signal);
    const uri = pathToFileURL(filePath).toString();
    const result = await withAbort<Hover | null>(
      () =>
        call(entry, () =>
          entry.conn.sendRequest("textDocument/hover", {
            textDocument: { uri },
            position: toLspPosition(pos),
          }),
        ),
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
    const entry = await requireReady(h);
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
      () => call(entry, () => entry.conn.sendRequest(method, body)),
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
    const entry = await requireReady(h);
    await withAbort(() => didOpenIfNeeded(entry, filePath), signal);
    const uri = pathToFileURL(filePath).toString();
    const result = await withAbort<
      DocumentSymbol[] | SymbolInformation[] | null
    >(
      () =>
        call(entry, () =>
          entry.conn.sendRequest("textDocument/documentSymbol", {
            textDocument: { uri },
          }),
        ),
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
    const entry = await requireReady(h);
    const result = await withAbort<SymbolInformation[] | null>(
      () =>
        call(entry, () => entry.conn.sendRequest("workspace/symbol", { query })),
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
      signalServer(proc, "SIGTERM");
      if ((await within(exited, STOP_STEP_MS)) !== TIMED_OUT) return;
      signalServer(proc, "SIGKILL");
      await within(exited, STOP_STEP_MS);
    } finally {
      conn.dispose();
    }
  }

  async function closeSession(): Promise<void> {
    const entries = [...servers.values()];
    servers.clear();
    await Promise.all([
      ...entries.map((e) => e.stopping ?? stopServer(e)),
      ...stops,
    ]);
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

/**
 * One-shot notice that the server can no longer serve calls, with the
 * error to report. Each send subscribes while in flight and unsubscribes when it
 * settles, so a long-lived server keeps no reference to finished requests.
 */
class GoneNotice {
  private done = false;
  private why: unknown;
  private readonly waiters = new Set<(reason: unknown) => void>();

  get fired(): boolean {
    return this.done;
  }

  get reason(): unknown {
    return this.why;
  }

  fire(reason: unknown): void {
    if (this.done) return;
    this.done = true;
    this.why = reason;
    for (const waiter of this.waiters) waiter(reason);
    this.waiters.clear();
  }

  /** Call `waiter` once fired, at once if already fired. Returns an unsubscribe. */
  subscribe(waiter: (reason: unknown) => void): () => void {
    if (this.done) {
      waiter(this.why);
      return () => {};
    }
    this.waiters.add(waiter);
    return () => {
      this.waiters.delete(waiter);
    };
  }

  /** Resolves with the reason. Await it only once the process is known gone. */
  wait(): Promise<unknown> {
    return new Promise((resolve) => this.subscribe(resolve));
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Signal the server and, on POSIX, everything in its process group. Sent
 * only while the server has not exited, so its pid, and with it the group
 * id, are still its own.
 */
function signalServer(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (OWN_GROUP && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // No such group: fall back to the process itself.
    }
  }
  proc.kill(signal);
}

/**
 * Kill what is left of the process group of a server that has exited.
 * Node reaps the server before it emits `exit`, so in theory a new process
 * could take the group id first; that needs the pid space to wrap around
 * within that one turn of the event loop.
 */
function killGroup(proc: ChildProcess): void {
  if (!OWN_GROUP || proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // The group is already empty.
  }
}

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

/** The last `limit` bytes of `tail` followed by `chunk`, in a fresh buffer. */
function appendTail(tail: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) {
    return Buffer.from(chunk.subarray(chunk.length - limit));
  }
  const keep = Math.min(tail.length, limit - chunk.length);
  return Buffer.concat([tail.subarray(tail.length - keep), chunk]);
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
