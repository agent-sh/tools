//! Spawn-based LSP client. Talks LSP JSON-RPC over stdio to a child
//! language-server. Framing: `Content-Length: N\r\n\r\n<body>`.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use url::Url;

use crate::constants::kind_name;
use crate::types::{
    CancelSignal, LspClient, LspHoverResult, LspLocation, LspServerProfile, LspSymbolInfo,
    Position1, ServerHandle, ServerState,
};

struct ServerEntry {
    language: String,
    root: String,
    state: Mutex<ServerState>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicI64,
    opened_files: Mutex<HashMap<String, bool>>,
    _child: Mutex<Child>,
}

impl ServerEntry {
    async fn handle(&self) -> ServerHandle {
        ServerHandle {
            language: self.language.clone(),
            root: self.root.clone(),
            state: *self.state.lock().await,
        }
    }
}

pub struct SpawnLspClient {
    servers: Mutex<HashMap<String, Arc<ServerEntry>>>,
}

impl SpawnLspClient {
    pub fn new() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
        }
    }

    fn key(language: &str, root: &str) -> String {
        format!("{}|{}", language, root)
    }
}

impl Default for SpawnLspClient {
    fn default() -> Self {
        Self::new()
    }
}

async fn send_request(
    entry: &ServerEntry,
    method: &str,
    params: Value,
    cancel: CancelSignal,
) -> Result<Value, String> {
    let id = entry.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = entry.pending.lock().await;
        pending.insert(id, tx);
    }
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    write_message(entry, &msg).await?;

    let mut cancel_rx = cancel.clone();
    tokio::select! {
        res = rx => res.map_err(|_| "request dropped".to_string())?,
        _ = cancel_rx.changed() => {
            if *cancel_rx.borrow() {
                // Best-effort cancel notification.
                let _ = write_message(entry, &serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "$/cancelRequest",
                    "params": { "id": id },
                })).await;
                let mut pending = entry.pending.lock().await;
                pending.remove(&id);
                return Err("aborted".to_string());
            }
            Err("cancel channel closed".to_string())
        }
    }
}

async fn send_notification(
    entry: &ServerEntry,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    write_message(entry, &msg).await
}

async fn write_message<T: Serialize>(entry: &ServerEntry, msg: &T) -> Result<(), String> {
    let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut stdin = entry.stdin.lock().await;
    stdin
        .write_all(header.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(&body).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn read_loop<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>,
) {
    let mut reader = BufReader::new(reader);
    loop {
        // Parse headers
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let n = match reader.read_line(&mut line).await {
                Ok(n) => n,
                Err(_) => return,
            };
            if n == 0 {
                return; // EOF
            }
            let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
            if trimmed.is_empty() {
                break;
            }
            if let Some(v) = trimmed
                .to_ascii_lowercase()
                .strip_prefix("content-length:")
            {
                if let Ok(n) = v.trim().parse::<usize>() {
                    content_length = Some(n);
                }
            }
        }
        let Some(len) = content_length else {
            continue;
        };
        let mut buf = vec![0u8; len];
        if reader.read_exact(&mut buf).await.is_err() {
            return;
        }
        let value: Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Route responses only (ignore server-pushed notifications for now).
        if let Some(id_raw) = value.get("id") {
            if let Some(id) = id_raw.as_i64() {
                let tx_opt = {
                    let mut p = pending.lock().await;
                    p.remove(&id)
                };
                if let Some(tx) = tx_opt {
                    if let Some(err) = value.get("error") {
                        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("error");
                        let _ = tx.send(Err(msg.to_string()));
                    } else {
                        let r = value.get("result").cloned().unwrap_or(Value::Null);
                        let _ = tx.send(Ok(r));
                    }
                }
            }
        }
    }
}

fn file_uri(p: &str) -> String {
    Url::from_file_path(Path::new(p))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| format!("file://{}", p))
}

fn file_uri_to_path(uri: &str) -> String {
    if let Some(rest) = uri.strip_prefix("file://") {
        // Drop leading '/' iff Windows-style; otherwise keep as-is.
        return rest.to_string();
    }
    uri.to_string()
}

fn lsp_pos(p: Position1) -> Value {
    serde_json::json!({
        "line": p.line.saturating_sub(1),
        "character": p.character.saturating_sub(1),
    })
}

fn from_lsp_line(n: i64) -> u32 {
    (n as i64 + 1).max(1) as u32
}

fn from_lsp_char(n: i64) -> u32 {
    (n as i64 + 1).max(1) as u32
}

async fn did_open_if_needed(entry: &ServerEntry, file_path: &str) -> Result<(), String> {
    {
        let opened = entry.opened_files.lock().await;
        if opened.contains_key(file_path) {
            return Ok(());
        }
    }
    let text = tokio::fs::read_to_string(file_path)
        .await
        .unwrap_or_default();
    let uri = file_uri(file_path);
    let language_id = entry.language.clone();
    send_notification(
        entry,
        "textDocument/didOpen",
        serde_json::json!({
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": 1,
                "text": text,
            }
        }),
    )
    .await?;
    let mut opened = entry.opened_files.lock().await;
    opened.insert(file_path.to_string(), true);
    Ok(())
}

async fn preview_line_at(path: &str, zero_indexed_line: i64) -> String {
    let text = tokio::fs::read_to_string(path).await.unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines
        .get(zero_indexed_line.max(0) as usize)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

async fn normalize_location(v: &Value) -> Option<LspLocation> {
    let uri = v
        .get("uri")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("targetUri").and_then(|x| x.as_str()))?;
    let range = v
        .get("range")
        .or_else(|| v.get("targetSelectionRange"))
        .or_else(|| v.get("targetRange"))?;
    let start = range.get("start")?;
    let line = start.get("line")?.as_i64()?;
    let character = start.get("character")?.as_i64()?;
    let path = file_uri_to_path(uri);
    let preview = preview_line_at(&path, line).await;
    Some(LspLocation {
        path,
        line: from_lsp_line(line),
        character: from_lsp_char(character),
        preview,
    })
}

fn flatten_hover_contents(contents: &Value) -> (String, bool) {
    if let Some(s) = contents.as_str() {
        return (s.to_string(), false);
    }
    if let Some(arr) = contents.as_array() {
        let mut parts: Vec<String> = Vec::new();
        for c in arr {
            if let Some(s) = c.as_str() {
                parts.push(s.to_string());
            } else if let Some(obj) = c.as_object() {
                let language = obj.get("language").and_then(|x| x.as_str()).unwrap_or("");
                let value = obj.get("value").and_then(|x| x.as_str()).unwrap_or("");
                parts.push(if !language.is_empty() {
                    format!("```{}\n{}\n```", language, value)
                } else {
                    value.to_string()
                });
            }
        }
        return (parts.join("\n\n"), true);
    }
    if let Some(obj) = contents.as_object() {
        if let Some(kind) = obj.get("kind").and_then(|x| x.as_str()) {
            let value = obj.get("value").and_then(|x| x.as_str()).unwrap_or("");
            return (value.to_string(), kind == "markdown");
        }
        if let Some(value) = obj.get("value").and_then(|x| x.as_str()) {
            let language = obj.get("language").and_then(|x| x.as_str()).unwrap_or("");
            return (
                if !language.is_empty() {
                    format!("```{}\n{}\n```", language, value)
                } else {
                    value.to_string()
                },
                true,
            );
        }
    }
    (String::new(), false)
}

fn map_document_symbol(v: &Value, file_path: &str) -> LspSymbolInfo {
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let kind = v.get("kind").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let range = v
        .get("range")
        .or_else(|| v.get("selectionRange"))
        .cloned()
        .unwrap_or(Value::Null);
    let start = range.get("start").cloned().unwrap_or(Value::Null);
    let line = start.get("line").and_then(|x| x.as_i64()).unwrap_or(0);
    let character = start.get("character").and_then(|x| x.as_i64()).unwrap_or(0);
    let children = v
        .get("children")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().map(|c| map_document_symbol(c, file_path)).collect());
    LspSymbolInfo {
        name,
        kind: kind_name(kind).to_string(),
        path: file_path.to_string(),
        line: from_lsp_line(line),
        character: from_lsp_char(character),
        container_name: None,
        children,
    }
}

fn map_symbol_information(v: &Value) -> LspSymbolInfo {
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let kind = v.get("kind").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let loc = v.get("location").cloned().unwrap_or(Value::Null);
    let uri = loc.get("uri").and_then(|x| x.as_str()).unwrap_or("");
    let range = loc.get("range").cloned().unwrap_or(Value::Null);
    let start = range.get("start").cloned().unwrap_or(Value::Null);
    let line = start.get("line").and_then(|x| x.as_i64()).unwrap_or(0);
    let character = start.get("character").and_then(|x| x.as_i64()).unwrap_or(0);
    let container_name = v
        .get("containerName")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    LspSymbolInfo {
        name,
        kind: kind_name(kind).to_string(),
        path: file_uri_to_path(uri),
        line: from_lsp_line(line),
        character: from_lsp_char(character),
        container_name,
        children: None,
    }
}

#[async_trait]
impl LspClient for SpawnLspClient {
    async fn ensure_server(
        &self,
        language: &str,
        root: &str,
        profile: &LspServerProfile,
    ) -> Result<ServerHandle, String> {
        let key = Self::key(language, root);
        {
            let servers = self.servers.lock().await;
            if let Some(entry) = servers.get(&key) {
                return Ok(entry.handle().await);
            }
        }

        let (cmd_str, args) = match profile.command.split_first() {
            Some((c, rest)) => (c.clone(), rest.to_vec()),
            None => {
                return Err(format!("LSP profile '{}' has empty command", language));
            }
        };
        let mut cmd = Command::new(&cmd_str);
        cmd.args(&args);
        cmd.current_dir(root);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
        let stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;

        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        {
            let pending_clone = Arc::clone(&pending);
            tokio::spawn(read_loop(stdout, pending_clone));
        }

        let entry = Arc::new(ServerEntry {
            language: language.to_string(),
            root: root.to_string(),
            state: Mutex::new(ServerState::Starting),
            stdin: Mutex::new(stdin),
            pending: Arc::clone(&pending),
            next_id: AtomicI64::new(1),
            opened_files: Mutex::new(HashMap::new()),
            _child: Mutex::new(child),
        });

        {
            let mut servers = self.servers.lock().await;
            servers.insert(key.clone(), Arc::clone(&entry));
        }

        // initialize handshake
        let root_uri = Url::from_file_path(Path::new(root))
            .map(|u| u.to_string())
            .unwrap_or_else(|_| format!("file://{}", root));
        let init_params = serde_json::json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "workspaceFolders": [
                { "uri": root_uri, "name": Path::new(root).file_name().and_then(|s| s.to_str()).unwrap_or("workspace") }
            ],
            "capabilities": {
                "textDocument": {
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "linkSupport": true },
                    "references": {},
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                    "implementation": { "linkSupport": true },
                },
                "workspace": { "symbol": {} },
            },
            "initializationOptions": profile.initialization_options.clone().unwrap_or(Value::Null),
        });
        let (dummy_tx, _dummy_rx) = tokio::sync::watch::channel(false);
        if let Err(e) =
            send_request(&entry, "initialize", init_params, dummy_tx.subscribe()).await
        {
            let mut servers = self.servers.lock().await;
            servers.remove(&key);
            return Err(format!("initialize failed: {}", e));
        }
        let _ = send_notification(&entry, "initialized", serde_json::json!({})).await;

        {
            let mut state = entry.state.lock().await;
            *state = ServerState::Ready;
        }
        Ok(entry.handle().await)
    }

    async fn hover(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Option<LspHoverResult>, String> {
        let entry = self.entry_for(handle).await?;
        did_open_if_needed(&entry, path).await?;
        let params = serde_json::json!({
            "textDocument": { "uri": file_uri(path) },
            "position": lsp_pos(pos),
        });
        let r = send_request(&entry, "textDocument/hover", params, cancel).await?;
        if r.is_null() {
            return Ok(None);
        }
        let contents = r.get("contents").cloned().unwrap_or(Value::Null);
        let (text, is_md) = flatten_hover_contents(&contents);
        if text.is_empty() {
            return Ok(None);
        }
        Ok(Some(LspHoverResult {
            contents: text,
            is_markdown: is_md,
        }))
    }

    async fn definition(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, String> {
        self.locations_like(handle, path, pos, cancel, "textDocument/definition").await
    }

    async fn references(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, String> {
        self.locations_like(handle, path, pos, cancel, "textDocument/references").await
    }

    async fn implementation(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, String> {
        self.locations_like(handle, path, pos, cancel, "textDocument/implementation").await
    }

    async fn document_symbol(
        &self,
        handle: &ServerHandle,
        path: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, String> {
        let entry = self.entry_for(handle).await?;
        did_open_if_needed(&entry, path).await?;
        let params = serde_json::json!({
            "textDocument": { "uri": file_uri(path) },
        });
        let r = send_request(&entry, "textDocument/documentSymbol", params, cancel).await?;
        let Some(arr) = r.as_array() else {
            return Ok(Vec::new());
        };
        if arr.is_empty() {
            return Ok(Vec::new());
        }
        let first = &arr[0];
        if first.get("location").is_some() {
            Ok(arr.iter().map(map_symbol_information).collect())
        } else {
            Ok(arr.iter().map(|v| map_document_symbol(v, path)).collect())
        }
    }

    async fn workspace_symbol(
        &self,
        handle: &ServerHandle,
        query: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, String> {
        let entry = self.entry_for(handle).await?;
        let params = serde_json::json!({ "query": query });
        let r = send_request(&entry, "workspace/symbol", params, cancel).await?;
        let Some(arr) = r.as_array() else {
            return Ok(Vec::new());
        };
        Ok(arr.iter().map(map_symbol_information).collect())
    }

    async fn close_session(&self) {
        let mut servers = self.servers.lock().await;
        for (_, entry) in servers.drain() {
            // Best-effort shutdown.
            let (dummy_tx, _) = tokio::sync::watch::channel(false);
            let _ = send_request(
                &entry,
                "shutdown",
                Value::Null,
                dummy_tx.subscribe(),
            )
            .await;
            let _ = send_notification(&entry, "exit", Value::Null).await;
        }
    }
}

impl SpawnLspClient {
    async fn entry_for(&self, handle: &ServerHandle) -> Result<Arc<ServerEntry>, String> {
        let key = Self::key(&handle.language, &handle.root);
        let servers = self.servers.lock().await;
        servers
            .get(&key)
            .cloned()
            .ok_or_else(|| format!("no server entry for {}", key))
    }

    async fn locations_like(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
        method: &str,
    ) -> Result<Vec<LspLocation>, String> {
        let entry = self.entry_for(handle).await?;
        did_open_if_needed(&entry, path).await?;
        let mut params = serde_json::json!({
            "textDocument": { "uri": file_uri(path) },
            "position": lsp_pos(pos),
        });
        if method == "textDocument/references" {
            params["context"] = serde_json::json!({ "includeDeclaration": true });
        }
        let r = send_request(&entry, method, params, cancel).await?;
        if r.is_null() {
            return Ok(Vec::new());
        }
        let items: Vec<Value> = if let Some(arr) = r.as_array() {
            arr.clone()
        } else {
            vec![r]
        };
        let mut out: Vec<LspLocation> = Vec::new();
        for item in &items {
            if let Some(loc) = normalize_location(item).await {
                out.push(loc);
            }
        }
        Ok(out)
    }
}
