use async_trait::async_trait;
use harness_core::{PermissionPolicy, ToolError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LspOperation {
    Hover,
    Definition,
    References,
    DocumentSymbol,
    WorkspaceSymbol,
    Implementation,
}

impl LspOperation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Hover => "hover",
            Self::Definition => "definition",
            Self::References => "references",
            Self::DocumentSymbol => "documentSymbol",
            Self::WorkspaceSymbol => "workspaceSymbol",
            Self::Implementation => "implementation",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Position1 {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspServerProfile {
    pub language: String,
    pub extensions: Vec<String>,
    pub command: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_patterns: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initialization_options: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspManifest {
    pub servers: HashMap<String, LspServerProfile>,
}

/// `ensure_server` never returns a crashed server: it starts a new one, or
/// returns an error. Design spec section 5.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerState {
    Starting,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerHandle {
    pub language: String,
    pub root: String,
    pub state: ServerState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspLocation {
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspSymbolInfo {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub line: u32,
    pub character: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<LspSymbolInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspHoverResult {
    pub contents: String,
    pub is_markdown: bool,
}

/// Cancel signal: a tokio watch channel shared with the caller.
/// When `*rx.borrow()` is true, the operation should abort.
pub type CancelSignal = watch::Receiver<bool>;

#[async_trait]
pub trait LspClient: Send + Sync {
    async fn ensure_server(
        &self,
        language: &str,
        root: &str,
        profile: &LspServerProfile,
    ) -> Result<ServerHandle, String>;

    async fn hover(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Option<LspHoverResult>, String>;

    async fn definition(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, String>;

    async fn references(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, String>;

    async fn document_symbol(
        &self,
        handle: &ServerHandle,
        path: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, String>;

    async fn workspace_symbol(
        &self,
        handle: &ServerHandle,
        query: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, String>;

    async fn implementation(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, String>;

    async fn close_session(&self);
}

#[derive(Clone)]
pub struct LspPermissionPolicy {
    pub inner: PermissionPolicy,
    pub unsafe_allow_lsp_without_hook: bool,
}

impl LspPermissionPolicy {
    pub fn new(inner: PermissionPolicy) -> Self {
        Self {
            inner,
            unsafe_allow_lsp_without_hook: false,
        }
    }

    pub fn with_unsafe_bypass(mut self, v: bool) -> Self {
        self.unsafe_allow_lsp_without_hook = v;
        self
    }
}

impl std::fmt::Debug for LspPermissionPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspPermissionPolicy")
            .field(
                "unsafe_allow_lsp_without_hook",
                &self.unsafe_allow_lsp_without_hook,
            )
            .field("inner", &self.inner)
            .finish()
    }
}

#[derive(Clone)]
pub struct LspSessionConfig {
    pub cwd: String,
    pub permissions: LspPermissionPolicy,
    pub client: Arc<dyn LspClient>,
    pub manifest: Option<LspManifest>,
    pub manifest_path: Option<String>,
    pub default_head_limit: Option<usize>,
    pub default_timeout_ms: Option<u64>,
    pub session_backstop_ms: Option<u64>,
    pub server_startup_max_wait_ms: Option<u64>,
    pub max_hover_markdown_bytes: Option<usize>,
    pub max_preview_line_length: Option<usize>,
    /// Retry counter for `server_starting` exponential backoff. Callers
    /// can share a Map across calls by holding the Arc themselves.
    pub retry_counter: Arc<tokio::sync::Mutex<HashMap<String, u64>>>,
}

impl LspSessionConfig {
    pub fn new(
        cwd: impl Into<String>,
        permissions: LspPermissionPolicy,
        client: Arc<dyn LspClient>,
    ) -> Self {
        Self {
            cwd: cwd.into(),
            permissions,
            client,
            manifest: None,
            manifest_path: None,
            default_head_limit: None,
            default_timeout_ms: None,
            session_backstop_ms: None,
            server_startup_max_wait_ms: None,
            max_hover_markdown_bytes: None,
            max_preview_line_length: None,
            retry_counter: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

impl std::fmt::Debug for LspSessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspSessionConfig")
            .field("cwd", &self.cwd)
            .field("permissions", &self.permissions)
            .finish()
    }
}

// ---- Result union ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspHoverOk {
    pub output: String,
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub contents: String,
    pub is_markdown: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspDefinitionOk {
    pub output: String,
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub locations: Vec<LspLocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspReferencesOk {
    pub output: String,
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub locations: Vec<LspLocation>,
    pub total: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspDocumentSymbolOk {
    pub output: String,
    pub path: String,
    pub symbols: Vec<LspSymbolInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspWorkspaceSymbolOk {
    pub output: String,
    pub query: String,
    pub symbols: Vec<LspSymbolInfo>,
    pub total: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspImplementationOk {
    pub output: String,
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub locations: Vec<LspLocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspNoResults {
    pub output: String,
    pub operation: LspOperation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspServerStarting {
    pub output: String,
    pub language: String,
    pub retry_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspError {
    pub error: ToolError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LspResult {
    #[serde(rename = "hover")]
    Hover(LspHoverOk),
    #[serde(rename = "definition")]
    Definition(LspDefinitionOk),
    #[serde(rename = "references")]
    References(LspReferencesOk),
    #[serde(rename = "documentSymbol")]
    DocumentSymbol(LspDocumentSymbolOk),
    #[serde(rename = "workspaceSymbol")]
    WorkspaceSymbol(LspWorkspaceSymbolOk),
    #[serde(rename = "implementation")]
    Implementation(LspImplementationOk),
    #[serde(rename = "no_results")]
    NoResults(LspNoResults),
    #[serde(rename = "server_starting")]
    ServerStarting(LspServerStarting),
    #[serde(rename = "error")]
    Error(LspError),
}

impl From<LspError> for LspResult {
    fn from(e: LspError) -> Self {
        LspResult::Error(e)
    }
}
