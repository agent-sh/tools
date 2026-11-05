//! LSP tool — Rust port of `@agent-sh/harness-lsp`.
//!
//! Conforms to `agent-knowledge/design/lsp.md`. Same contract as the TS
//! package: 1-indexed position boundary, discriminated-union result,
//! hover/definition/references/documentSymbol/workspaceSymbol/implementation
//! operations, `server_starting` exponential retry hint, stub client
//! for tests + real spawn client for production.

mod constants;
mod fence;
mod format;
mod manifest;
mod run;
mod schema;
mod spawn_client;
mod stub_client;
mod types;

pub use constants::*;
pub use format::{
    cap_hover_markdown, cap_preview, format_document_symbols, format_hover, format_locations,
    format_no_results, format_server_starting, format_workspace_symbols, no_results_hint,
};
pub use manifest::{find_lsp_root, load_manifest, profile_for_path};
pub use run::lsp;
pub use schema::{
    safe_parse_lsp_params, validate_per_op, LspParams, LspParseError, LspValidateResult,
    LSP_TOOL_DESCRIPTION, LSP_TOOL_NAME,
};
pub use spawn_client::{SpawnLspClient, SpawnLspClientOptions};
pub use stub_client::{StubBehavior, StubLspClient, StubResponses};
pub use types::{
    CancelSignal, LspClient, LspClientError, LspDefinitionOk, LspDocumentSymbolOk, LspError,
    LspHoverOk, LspHoverResult, LspImplementationOk, LspLocation, LspManifest, LspNoResults,
    LspOperation, LspPermissionPolicy, LspReferencesOk, LspResult, LspServerProfile,
    LspServerStarting, LspSessionConfig, LspSymbolInfo, LspWorkspaceSymbolOk, Position1,
    ServerHandle, ServerState,
};
