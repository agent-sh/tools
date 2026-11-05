//! Shared helpers for the spawn-client tests. The fake server is the one the
//! TypeScript tests use, so both ports run the same cases.
#![allow(dead_code)]

use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_lsp::{
    lsp, LspClient, LspManifest, LspPermissionPolicy, LspResult, LspServerProfile, LspSessionConfig,
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

/// A new child process holds a copy of every pipe end its parent had open
/// when it was created, until it execs. So a server that another test
/// spawns while this test's server starts can hold this server's stdin
/// open, and under load it can hold it for longer than this server takes
/// to start. A write after this server closed its stdin then succeeds
/// instead of failing. Tests that need that write to fail run alone, with
/// `bounded_alone`; every other test holds `SPAWNS` shared.
static SPAWNS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

pub async fn bounded<F: Future<Output = ()>>(test: F) {
    let _shared = SPAWNS.read().await;
    limit(test).await;
}

/// `bounded`, with no other test of this binary running meanwhile.
pub async fn bounded_alone<F: Future<Output = ()>>(test: F) {
    let _alone = SPAWNS.write().await;
    limit(test).await;
}

async fn limit<F: Future<Output = ()>>(test: F) {
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

    /// The server's pid once it has written it, waiting up to 5s. None if
    /// no server wrote one by then.
    pub async fn wait_pid(&self) -> Option<i32> {
        let file = Path::new(&self.root).join("pid");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(pid) = fs::read_to_string(&file)
                .ok()
                .and_then(|s| s.trim().parse().ok())
            {
                return Some(pid);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Pids of the processes that run the fake server for this root,
    /// whether or not node got as far as writing a pid, plus any server
    /// that wrote one and is a zombie not yet reaped.
    pub fn running(&self) -> Vec<i32> {
        let mut found = Vec::new();
        for p in fs::read_dir("/proc").into_iter().flatten().flatten() {
            let Some(pid) = p.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else {
                continue;
            };
            let cmdline = fs::read(p.path().join("cmdline")).unwrap_or_default();
            let cmdline = String::from_utf8_lossy(&cmdline);
            let zombie = fs::read_to_string(p.path().join("stat"))
                .map(|s| {
                    s.rsplit(')')
                        .next()
                        .unwrap_or("")
                        .trim_start()
                        .starts_with('Z')
                })
                .unwrap_or(false);
            let ours = cmdline.contains(FAKE_SERVER) && cmdline.contains(&self.root);
            if ours || (zombie && self.spawned_pids().contains(&pid)) {
                found.push(pid);
            }
        }
        found
    }

    pub fn spawns(&self) -> usize {
        fs::read_to_string(Path::new(&self.root).join("spawns"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    /// `spawns()` once it reaches `n`, or after 5s. A server records its
    /// spawn once node has started, which under load can be well after the
    /// call that spawned it gave up.
    pub async fn spawns_reaching(&self, n: usize) -> usize {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let count = self.spawns();
            if count >= n || tokio::time::Instant::now() >= deadline {
                return count;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Pids of every server started in this dir, in start order.
    pub fn spawned_pids(&self) -> Vec<i32> {
        fs::read_to_string(Path::new(&self.root).join("spawns"))
            .map(|s| s.lines().filter_map(|l| l.trim().parse().ok()).collect())
            .unwrap_or_default()
    }

    pub fn did_opens(&self) -> usize {
        fs::read_to_string(Path::new(&self.root).join("didopen"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    pub fn exists(&self, name: &str) -> bool {
        Path::new(&self.root).join(name).exists()
    }
}

/// Calls `lsp` until the server is past its start, up to 10s, and returns
/// the first other result. Under load node can take longer to start than
/// the fake server's own delays, so a fixed pause is not enough.
pub async fn past_start(input: Value, session: &LspSessionConfig) -> LspResult {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let r = lsp(input.clone(), session).await;
        if !matches!(r, LspResult::ServerStarting(_)) || tokio::time::Instant::now() >= deadline {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
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

/// Wait until the process is gone, up to `limit`. True when it is gone.
pub async fn gone_within(pid: i32, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    while alive(pid) {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    true
}

pub fn kill9(pid: i32) {
    let status = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success(), "kill -9 {pid} failed");
}
