export const DEFAULT_HEAD_LIMIT = 200;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const SESSION_BACKSTOP_MS = 60_000;
/**
 * Default bound for the spawn client's `initialize` handshake. It is the
 * session backstop, which also caps every tool call's budget, so with the
 * defaults a start outlives the call that began it and a later call finds
 * the server starting or ready. Keep it above the session's call budget
 * (`defaultTimeoutMs`): when the two are equal, the call gives up first and
 * the next call only learns that the start failed.
 */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = SESSION_BACKSTOP_MS;
export const SERVER_STARTUP_MAX_WAIT_MS = 5_000;
export const MAX_HOVER_MARKDOWN_BYTES = 10_000;
export const MAX_PREVIEW_LINE_LENGTH = 200;
export const MAX_WORKSPACE_SYMBOLS_SCANNED = 10_000;

/**
 * Exponential retry cap for `server_starting` hints. The tool emits
 * progressively larger retry_ms values so models don't spam the session
 * while a slow server (rust-analyzer) indexes a crate.
 */
export const SERVER_STARTING_RETRY_BASE_MS = 3_000;
export const SERVER_STARTING_RETRY_MAX_MS = 30_000;

/**
 * LSP SymbolKind enum → short human name. Flattened for the structured
 * symbol list output. LSP spec uses numeric codes; we translate so the
 * model sees 'class' rather than '5'.
 *
 * Index = LSP SymbolKind numeric value.
 */
export const LSP_SYMBOL_KIND_NAMES: readonly string[] = [
  "_unknown",    // 0
  "file",        // 1
  "module",      // 2
  "namespace",   // 3
  "package",     // 4
  "class",       // 5
  "method",      // 6
  "property",    // 7
  "field",       // 8
  "constructor", // 9
  "enum",        // 10
  "interface",   // 11
  "function",    // 12
  "variable",    // 13
  "constant",    // 14
  "string",      // 15
  "number",      // 16
  "boolean",     // 17
  "array",       // 18
  "object",      // 19
  "key",         // 20
  "null",        // 21
  "enumMember",  // 22
  "struct",      // 23
  "event",       // 24
  "operator",    // 25
  "typeParameter", // 26
];

/** Default manifest filename looked up at workspace root. */
export const MANIFEST_FILENAME = ".lsp.json";
