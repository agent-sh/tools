pub const DEFAULT_HEAD_LIMIT: usize = 200;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const SESSION_BACKSTOP_MS: u64 = 60_000;
/// Default bound for the spawn client's `initialize` handshake. It is the
/// session backstop, which also caps every call's budget, so with the
/// defaults a start outlives the call that began it. Keep it above the
/// session's call budget (design spec section 5.3).
pub const DEFAULT_INITIALIZE_TIMEOUT_MS: u64 = SESSION_BACKSTOP_MS;
pub const SERVER_STARTUP_MAX_WAIT_MS: u64 = 5_000;
pub const MAX_HOVER_MARKDOWN_BYTES: usize = 10_000;
pub const MAX_PREVIEW_LINE_LENGTH: usize = 200;
pub const MAX_WORKSPACE_SYMBOLS_SCANNED: usize = 10_000;

pub const SERVER_STARTING_RETRY_BASE_MS: u64 = 3_000;
pub const SERVER_STARTING_RETRY_MAX_MS: u64 = 30_000;

pub const MANIFEST_FILENAME: &str = ".lsp.json";

/// LSP SymbolKind numeric → short name. Index = LSP SymbolKind enum value.
pub const LSP_SYMBOL_KIND_NAMES: &[&str] = &[
    "_unknown",
    "file",
    "module",
    "namespace",
    "package",
    "class",
    "method",
    "property",
    "field",
    "constructor",
    "enum",
    "interface",
    "function",
    "variable",
    "constant",
    "string",
    "number",
    "boolean",
    "array",
    "object",
    "key",
    "null",
    "enumMember",
    "struct",
    "event",
    "operator",
    "typeParameter",
];

pub fn kind_name(kind: u32) -> &'static str {
    LSP_SYMBOL_KIND_NAMES
        .get(kind as usize)
        .copied()
        .unwrap_or("_unknown")
}
