import type {
  PermissionPolicy,
  ToolError,
} from "@agent-sh/harness-core";

export type LspOperation =
  | "hover"
  | "definition"
  | "references"
  | "documentSymbol"
  | "workspaceSymbol"
  | "implementation";

export interface LspParams {
  readonly operation: LspOperation;
  readonly path?: string | undefined;
  /** 1-indexed line; matches grep/read output. Converted to LSP 0-indexed internally. */
  readonly line?: number | undefined;
  /** 1-indexed character column. */
  readonly character?: number | undefined;
  readonly query?: string | undefined;
  readonly head_limit?: number | undefined;
}

/**
 * 1-indexed position passed in from callers. The LspClient adapter is
 * responsible for converting to LSP's 0-indexed UTF-16 shape before
 * sending to the server.
 */
export interface Position1 {
  readonly line: number; // 1-indexed
  readonly character: number; // 1-indexed
}

/** Manifest entry describing one language server spawn profile. */
export interface LspServerProfile {
  readonly language: string;
  readonly extensions: readonly string[];
  readonly command: readonly string[];
  readonly rootPatterns?: readonly string[];
  readonly initializationOptions?: Readonly<Record<string, unknown>>;
}

export interface LspManifest {
  readonly servers: Readonly<Record<string, LspServerProfile>>;
}

/**
 * Pluggable LspClient — core ships a spawn-based implementation;
 * adapters (mcp, stub, multilspy) can substitute. The adapter owns the
 * language-server process lifecycle and the JSON-RPC plumbing; this
 * interface is the minimum our orchestrator needs.
 */
export interface ServerHandle {
  readonly language: string;
  readonly root: string;
  /**
   * `ensureServer` never returns a crashed server: it starts a new one, or
   * rejects. A call that sees a server die rejects with
   * LspServerCrashedError instead.
   */
  readonly state: "starting" | "ready";
  /**
   * The server instance this handle names, set by the client that made it.
   * An operation runs on that instance only: once another instance has
   * replaced it, the operation rejects with LspServerCrashedError and the
   * old instance's reason. An adapter that never replaces a server may use
   * one fixed value. Design spec 5.5 and 9.
   */
  readonly instance: number;
}

export interface LspLocation {
  readonly path: string;
  readonly line: number; // 1-indexed for display
  readonly character: number; // 1-indexed
  readonly preview: string;
}

export interface LspSymbolInfo {
  readonly name: string;
  readonly kind: string; // friendly name ("class", "function", ...)
  readonly path: string;
  readonly line: number; // 1-indexed
  readonly character: number; // 1-indexed
  readonly containerName?: string;
  readonly children?: readonly LspSymbolInfo[];
}

export interface LspHoverResult {
  readonly contents: string; // markdown or plain text
  readonly isMarkdown: boolean;
}

export interface LspClient {
  /**
   * Start or reuse the server for (language, root). `signal` bounds the
   * caller's wait; a server still starting when it aborts keeps starting,
   * and a later call gets it as `starting` or `ready`.
   */
  ensureServer(args: {
    language: string;
    root: string;
    profile: LspServerProfile;
    signal?: AbortSignal;
  }): Promise<ServerHandle>;

  hover(
    h: ServerHandle,
    path: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<LspHoverResult | null>;

  definition(
    h: ServerHandle,
    path: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<readonly LspLocation[]>;

  references(
    h: ServerHandle,
    path: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<readonly LspLocation[]>;

  documentSymbol(
    h: ServerHandle,
    path: string,
    signal: AbortSignal,
  ): Promise<readonly LspSymbolInfo[]>;

  workspaceSymbol(
    h: ServerHandle,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly LspSymbolInfo[]>;

  implementation(
    h: ServerHandle,
    path: string,
    pos: Position1,
    signal: AbortSignal,
  ): Promise<readonly LspLocation[]>;

  closeSession(): Promise<void>;
}

export interface LspPermissionPolicy extends PermissionPolicy {
  readonly unsafeAllowLspWithoutHook?: boolean;
}

export interface LspSessionConfig {
  readonly cwd: string;
  readonly permissions: LspPermissionPolicy;
  readonly client?: LspClient;
  readonly manifest?: LspManifest;
  readonly manifestPath?: string;
  readonly lspPrewarm?: boolean;
  readonly defaultHeadLimit?: number;
  readonly defaultTimeoutMs?: number;
  readonly sessionBackstopMs?: number;
  readonly serverStartupMaxWaitMs?: number;
  readonly maxHoverMarkdownBytes?: number;
  readonly maxPreviewLineLength?: number;
  readonly signal?: AbortSignal;
  /**
   * Retry counter for `server_starting` backoff. Callers can share a
   * Map across calls to give the tool visibility into how many times
   * the model has hit "starting" for a given language — drives the
   * exponential retry_ms hint.
   */
  retryCounter?: Map<string, number>;
}

// ---- Result union ----

export type LspHoverOk = {
  readonly kind: "hover";
  readonly output: string;
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly contents: string;
  readonly isMarkdown: boolean;
};

export type LspDefinitionOk = {
  readonly kind: "definition";
  readonly output: string;
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly locations: readonly LspLocation[];
};

export type LspReferencesOk = {
  readonly kind: "references";
  readonly output: string;
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly locations: readonly LspLocation[];
  readonly total: number;
  readonly truncated: boolean;
};

export type LspDocumentSymbolOk = {
  readonly kind: "documentSymbol";
  readonly output: string;
  readonly path: string;
  readonly symbols: readonly LspSymbolInfo[];
};

export type LspWorkspaceSymbolOk = {
  readonly kind: "workspaceSymbol";
  readonly output: string;
  readonly query: string;
  readonly symbols: readonly LspSymbolInfo[];
  readonly total: number;
  readonly truncated: boolean;
};

export type LspImplementationOk = {
  readonly kind: "implementation";
  readonly output: string;
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly locations: readonly LspLocation[];
};

export type LspNoResults = {
  readonly kind: "no_results";
  readonly output: string;
  readonly operation: LspOperation;
};

export type LspServerStarting = {
  readonly kind: "server_starting";
  readonly output: string;
  readonly language: string;
  readonly retryMs: number;
};

export type LspError = {
  readonly kind: "error";
  readonly error: ToolError;
};

export type LspResult =
  | LspHoverOk
  | LspDefinitionOk
  | LspReferencesOk
  | LspDocumentSymbolOk
  | LspWorkspaceSymbolOk
  | LspImplementationOk
  | LspNoResults
  | LspServerStarting
  | LspError;
