//! Shared helpers for the spawn-client tests. The fake server is the one the
//! TypeScript tests use, so both ports run the same cases.
#![allow(dead_code)]

use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_lsp::{
    LspClient, LspManifest, LspPermissionPolicy, LspResult, LspServerProfile, LspSessionConfig,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;

pub const FAKE_SERVER: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/lsp/test/fixtures/fake-lsp-server.mjs"
);

/// Limit for one test. A test that hangs fails here instead of blocking
/// the run.
pub const TEST_LIMIT: Duration = Duration::from_secs(20);

pub async fn bounded<F: Future<Output = ()>>(test: F) {
    if tokio::time::timeout(TEST_LIMIT, test).await.is_err() {
        panic!("test did not finish within {TEST_LIMIT:?}");
    }
}

pub struct Fake {
    _dir: TempDir,
    pub root: String,
}

impl Fake {
    pub fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("lsp-rust-test-")
            .tempdir()
            .unwrap();
        let root = fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        Self { _dir: dir, root }
    }

    pub fn profile(&self, mode: &str) -> LspServerProfile {
        self.profile_with_command(vec![
            "node".to_string(),
            FAKE_SERVER.to_string(),
            mode.to_string(),
            self.root.clone(),
        ])
    }

    pub fn profile_with_command(&self, command: Vec<String>) -> LspServerProfile {
        LspServerProfile {
            language: "fake".to_string(),
            extensions: vec![".fake".to_string()],
            command,
            root_patterns: None,
            initialization_options: None,
        }
    }

    pub fn session(
        &self,
        client: Arc<dyn LspClient>,
        mode: &str,
        timeout_ms: Option<u64>,
    ) -> LspSessionConfig {
        self.session_for(client, self.profile(mode), timeout_ms)
    }

    pub fn session_with_command(
        &self,
        client: Arc<dyn LspClient>,
        command: Vec<String>,
        timeout_ms: Option<u64>,
    ) -> LspSessionConfig {
        self.session_for(client, self.profile_with_command(command), timeout_ms)
    }

    fn session_for(
        &self,
        client: Arc<dyn LspClient>,
        profile: LspServerProfile,
        timeout_ms: Option<u64>,
    ) -> LspSessionConfig {
        let perms = PermissionPolicy::new([self.root.clone()]);
        let lsp_perms = LspPermissionPolicy::new(perms).with_unsafe_bypass(true);
        let mut cfg = LspSessionConfig::new(self.root.clone(), lsp_perms, client);
        let mut servers = HashMap::new();
        servers.insert("fake".to_string(), profile);
        cfg.manifest = Some(LspManifest { servers });
        cfg.default_timeout_ms = timeout_ms;
        cfg
    }

    pub fn file(&self, name: &str, content: &str) -> String {
        let p = Path::new(&self.root).join(name);
        fs::write(&p, content).unwrap();
        p.to_string_lossy().into_owned()
    }

    pub fn pid(&self) -> i32 {
        fs::read_to_string(Path::new(&self.root).join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    pub fn spawns(&self) -> usize {
        fs::read_to_string(Path::new(&self.root).join("spawns"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    pub fn exists(&self, name: &str) -> bool {
        Path::new(&self.root).join(name).exists()
    }
}

pub fn hover_input(file: &str) -> Value {
    json!({ "operation": "hover", "path": file, "line": 1, "character": 1 })
}

pub fn code_and_message(r: &LspResult) -> Option<(ToolErrorCode, String)> {
    match r {
        LspResult::Error(e) => Some((e.error.code, e.error.message.clone())),
        _ => None,
    }
}

/// True while the process exists, a zombie not yet reaped included.
pub fn alive(pid: i32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

pub fn kill9(pid: i32) {
    let status = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success(), "kill -9 {pid} failed");
}
