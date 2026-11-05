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
 * In-memory LspClient used by unit tests and as a reference implementation
 * of the contract. Lets tests exercise the orchestrator without spawning
 * real language-server binaries.
 *
 * The stub stores a configurable response table per (language, op) and
 * per (language, op, path) override. Timeouts, starting states, and
 * crashes can be simulated via helper methods.
 */

type HoverResponder = (
  path: string,
  pos: Position1,
) => LspHoverResult | null | Promise<LspHoverResult | null>;

type LocationResponder = (
  path: string,
  pos: Position1,
) => readonly LspLocation[] | Promise<readonly LspLocation[]>;

type DocSymbolResponder = (
  path: string,
) => readonly LspSymbolInfo[] | Promise<readonly LspSymbolInfo[]>;

type WorkspaceSymbolResponder = (
  query: string,
) => readonly LspSymbolInfo[] | Promise<readonly LspSymbolInfo[]>;

export interface StubResponses {
  hover?: HoverResponder;
  definition?: LocationResponder;
  references?: LocationResponder;
  documentSymbol?: DocSymbolResponder;
  workspaceSymbol?: WorkspaceSymbolResponder;
  implementation?: LocationResponder;
}

interface StubBehavior {
  // Force ensureServer to return a "starting" handle for the first N calls
  // for this language; ready on the (N+1)th.
  startingCalls?: number;
  // Force a specific call to throw (simulate crash / timeout).
  throwOn?: {
    language?: string;
    op?: keyof StubResponses;
    error: Error;
  }[];
  // Force a specific call to delay longer than its abort signal.
  hangOn?: {
    op: keyof StubResponses;
  }[];
  // Responses per language.
  responses?: Record<string, StubResponses>;
}

export class StubLspClient implements LspClient {
  private readonly handles = new Map<string, ServerHandle>();
  private readonly callCounts = new Map<string, number>();
  public closed = false;

  constructor(private readonly behavior: StubBehavior = {}) {}

  async ensureServer(args: {
    language: string;
    root: string;
    profile: LspServerProfile;
  }): Promise<ServerHandle> {
    const key = `${args.language}|${args.root}`;
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);
    const starting = this.behavior.startingCalls ?? 0;
    const state: ServerHandle["state"] =
      count <= starting ? "starting" : "ready";
    const handle: ServerHandle = {
      language: args.language,
      root: args.root,
      state,
      // One stub server per key, never replaced.
      instance: 1,
    };
    this.handles.set(key, handle);
    return handle;
  }

  private async maybeThrow(
    language: string,
    op: keyof StubResponses,
    signal: AbortSignal,
  ): Promise<void> {
    const matches = this.behavior.throwOn?.find(
      (e) =>
        (e.language === undefined || e.language === language) &&
        (e.op === undefined || e.op === op),
    );
    if (matches) throw matches.error;
    const hang = this.behavior.hangOn?.find((h) => h.op === op);
    if (hang) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          reject(new Error("aborted"));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  async hover(
    h: ServerHandle,
    p: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<LspHoverResult | null> {
    await this.maybeThrow(h.language, "hover", signal);
    const r = this.behavior.responses?.[h.language]?.hover;
    return r ? r(p, pos) : null;
  }

  async definition(
    h: ServerHandle,
    p: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<readonly LspLocation[]> {
    await this.maybeThrow(h.language, "definition", signal);
    const r = this.behavior.responses?.[h.language]?.definition;
    return r ? r(p, pos) : [];
  }

  async references(
    h: ServerHandle,
    p: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<readonly LspLocation[]> {
    await this.maybeThrow(h.language, "references", signal);
    const r = this.behavior.responses?.[h.language]?.references;
    return r ? r(p, pos) : [];
  }

  async documentSymbol(
    h: ServerHandle,
    p: string,
    signal: AbortSignal,
  ): Promise<readonly LspSymbolInfo[]> {
    await this.maybeThrow(h.language, "documentSymbol", signal);
    const r = this.behavior.responses?.[h.language]?.documentSymbol;
    return r ? r(p) : [];
  }

  async workspaceSymbol(
    h: ServerHandle,
    q: string,
    signal: AbortSignal,
  ): Promise<readonly LspSymbolInfo[]> {
    await this.maybeThrow(h.language, "workspaceSymbol", signal);
    const r = this.behavior.responses?.[h.language]?.workspaceSymbol;
    return r ? r(q) : [];
  }

  async implementation(
    h: ServerHandle,
    p: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<readonly LspLocation[]> {
    await this.maybeThrow(h.language, "implementation", signal);
    const r = this.behavior.responses?.[h.language]?.implementation;
    return r ? r(p, pos) : [];
  }

  async closeSession(): Promise<void> {
    this.closed = true;
  }
}
