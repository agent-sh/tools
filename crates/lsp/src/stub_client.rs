use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::types::{
    CancelSignal, LspClient, LspClientError, LspHoverResult, LspLocation, LspServerProfile,
    LspSymbolInfo, Position1, ServerHandle, ServerState,
};

pub type HoverResponder = Arc<
    dyn Fn(&str, Position1) -> Option<LspHoverResult> + Send + Sync,
>;
pub type LocationResponder = Arc<dyn Fn(&str, Position1) -> Vec<LspLocation> + Send + Sync>;
pub type DocSymbolResponder = Arc<dyn Fn(&str) -> Vec<LspSymbolInfo> + Send + Sync>;
pub type WorkspaceSymbolResponder = Arc<dyn Fn(&str) -> Vec<LspSymbolInfo> + Send + Sync>;

#[derive(Clone, Default)]
pub struct StubResponses {
    pub hover: Option<HoverResponder>,
    pub definition: Option<LocationResponder>,
    pub references: Option<LocationResponder>,
    pub document_symbol: Option<DocSymbolResponder>,
    pub workspace_symbol: Option<WorkspaceSymbolResponder>,
    pub implementation: Option<LocationResponder>,
}

#[derive(Clone, Default)]
pub struct StubBehavior {
    /// Force ensureServer to return a "starting" handle for the first N calls
    /// for this language; ready on the (N+1)th.
    pub starting_calls: u32,
    /// Force responses by language.
    pub responses: HashMap<String, StubResponses>,
    /// Force any next call for the given op to throw.
    pub throw_on: Option<(Option<String>, Option<String>, String)>,
    /// Force the op to hang until the cancel signal fires.
    pub hang_on: Option<String>,
}

pub struct StubLspClient {
    behavior: StubBehavior,
    call_counts: Mutex<HashMap<String, u32>>,
    closed: Mutex<bool>,
}

impl StubLspClient {
    pub fn new(behavior: StubBehavior) -> Self {
        Self {
            behavior,
            call_counts: Mutex::new(HashMap::new()),
            closed: Mutex::new(false),
        }
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.lock().unwrap()
    }

    fn maybe_throw(&self, language: &str, op: &str) -> Result<(), LspClientError> {
        if let Some((l_opt, op_opt, err_msg)) = &self.behavior.throw_on {
            let l_match = l_opt.as_deref().map(|l| l == language).unwrap_or(true);
            let op_match = op_opt.as_deref().map(|o| o == op).unwrap_or(true);
            if l_match && op_match {
                return Err(LspClientError::Other(err_msg.clone()));
            }
        }
        Ok(())
    }

    async fn maybe_hang(&self, op: &str, cancel: &CancelSignal) -> Result<(), LspClientError> {
        if let Some(hang_op) = &self.behavior.hang_on {
            if hang_op == op {
                let mut rx = cancel.clone();
                loop {
                    if *rx.borrow() {
                        return Err(LspClientError::Aborted);
                    }
                    if rx.changed().await.is_err() {
                        return Err(LspClientError::Aborted);
                    }
                    if *rx.borrow() {
                        return Err(LspClientError::Aborted);
                    }
                }
            }
        }
        Ok(())
    }
}

#[async_trait]
impl LspClient for StubLspClient {
    async fn ensure_server(
        &self,
        language: &str,
        root: &str,
        _profile: &LspServerProfile,
        _cancel: CancelSignal,
    ) -> Result<ServerHandle, LspClientError> {
        let key = format!("{}|{}", language, root);
        let mut counts = self.call_counts.lock().unwrap();
        let next = counts.get(&key).copied().unwrap_or(0) + 1;
        counts.insert(key, next);
        let state = if next <= self.behavior.starting_calls {
            ServerState::Starting
        } else {
            ServerState::Ready
        };
        Ok(ServerHandle {
            language: language.to_string(),
            root: root.to_string(),
            state,
        })
    }

    async fn hover(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Option<LspHoverResult>, LspClientError> {
        self.maybe_throw(&handle.language, "hover")?;
        self.maybe_hang("hover", &cancel).await?;
        Ok(self
            .behavior
            .responses
            .get(&handle.language)
            .and_then(|r| r.hover.as_ref())
            .and_then(|f| f(path, pos)))
    }

    async fn definition(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.maybe_throw(&handle.language, "definition")?;
        self.maybe_hang("definition", &cancel).await?;
        Ok(self
            .behavior
            .responses
            .get(&handle.language)
            .and_then(|r| r.definition.as_ref())
            .map(|f| f(path, pos))
            .unwrap_or_default())
    }

    async fn references(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.maybe_throw(&handle.language, "references")?;
        self.maybe_hang("references", &cancel).await?;
        Ok(self
            .behavior
            .responses
            .get(&handle.language)
            .and_then(|r| r.references.as_ref())
            .map(|f| f(path, pos))
            .unwrap_or_default())
    }

    async fn document_symbol(
        &self,
        handle: &ServerHandle,
        path: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, LspClientError> {
        self.maybe_throw(&handle.language, "documentSymbol")?;
        self.maybe_hang("documentSymbol", &cancel).await?;
        Ok(self
            .behavior
            .responses
            .get(&handle.language)
            .and_then(|r| r.document_symbol.as_ref())
            .map(|f| f(path))
            .unwrap_or_default())
    }

    async fn workspace_symbol(
        &self,
        handle: &ServerHandle,
        query: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, LspClientError> {
        self.maybe_throw(&handle.language, "workspaceSymbol")?;
        self.maybe_hang("workspaceSymbol", &cancel).await?;
        Ok(self
            .behavior
            .responses
            .get(&handle.language)
            .and_then(|r| r.workspace_symbol.as_ref())
            .map(|f| f(query))
            .unwrap_or_default())
    }

    async fn implementation(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.maybe_throw(&handle.language, "implementation")?;
        self.maybe_hang("implementation", &cancel).await?;
        Ok(self
            .behavior
            .responses
            .get(&handle.language)
            .and_then(|r| r.implementation.as_ref())
            .map(|f| f(path, pos))
            .unwrap_or_default())
    }

    async fn close_session(&self) {
        *self.closed.lock().unwrap() = true;
    }
}
