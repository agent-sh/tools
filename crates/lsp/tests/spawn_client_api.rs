//! Spawn-client tests that need the lifecycle API: the `initialize` limit
//! option, the session cancel signal and `ensure_server`'s cancel. Same
//! fake server as `spawn_client.rs`.
#![cfg(target_os = "linux")]

mod common;

use async_trait::async_trait;
use common::{alive, code_and_message, hover_input, Fake};
use harness_core::ToolErrorCode;
use harness_lsp::{
    lsp, CancelSignal, LspClient, LspClientError, LspHoverResult, LspLocation, LspResult,
    LspServerProfile, LspSymbolInfo, Position1, ServerHandle, ServerState, SpawnLspClient,
    SpawnLspClientOptions, DEFAULT_INITIALIZE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, SESSION_BACKSTOP_MS,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

fn client_with_limit(ms: u64) -> Arc<SpawnLspClient> {
    Arc::new(SpawnLspClient::with_options(SpawnLspClientOptions {
        initialize_timeout_ms: Some(ms),
    }))
}

fn never_cancelled() -> CancelSignal {
    let (tx, rx) = watch::channel(false);
    // Keep the sender alive for the whole test, so the signal never closes.
    std::mem::forget(tx);
    rx
}

#[test]
fn the_default_initialize_limit_outlasts_the_default_call_budget() {
    // Every call's budget is capped by the session backstop.
    let call_budget = DEFAULT_TIMEOUT_MS.min(SESSION_BACKSTOP_MS);
    assert!(DEFAULT_INITIALIZE_TIMEOUT_MS > call_budget);
}

#[tokio::test(start_paused = true)]
async fn the_client_bounds_initialize_by_the_default_limit() {
    // Paused time jumps ahead whenever every task waits, so a 60s limit
    // takes no wall-clock time. The server process stays real.
    let fake = Fake::new();
    let client = SpawnLspClient::new();
    let started = tokio::time::Instant::now();
    let r = client
        .ensure_server(
            "fake",
            &fake.root,
            &fake.profile("silent-on-initialize"),
            never_cancelled(),
        )
        .await;
    let waited = started.elapsed();
    let e = r.expect_err("a silent server must not become ready");
    assert!(
        e.to_string()
            .contains(&format!("within {DEFAULT_INITIALIZE_TIMEOUT_MS}ms")),
        "{e}"
    );
    assert!(
        waited >= Duration::from_millis(DEFAULT_INITIALIZE_TIMEOUT_MS),
        "{waited:?}"
    );
    client.close_session().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn initialize_is_bounded_and_the_server_is_stopped() {
    common::bounded(async {
        let fake = Fake::new();
        let client = client_with_limit(300);
        let r = client
            .ensure_server(
                "fake",
                &fake.root,
                &fake.profile("silent-on-initialize"),
                never_cancelled(),
            )
            .await;
        let e = r.expect_err("a silent server must not become ready");
        assert_eq!(
            e,
            LspClientError::Other(
                "Language server for fake did not answer initialize within 300ms. The next call starts it again."
                    .to_string()
            )
        );
        let pid = fake.pid();
        client.close_session().await;
        assert!(!alive(pid), "the server is still running");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_that_misses_the_limit_after_its_call_gave_up_is_reported_once() {
    common::bounded(async {
        let fake = Fake::new();
        let client = client_with_limit(800);
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "silent-on-initialize", Some(300));
        let (code, _) = code_and_message(&lsp(hover_input(&file), &session).await).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout);
        let r = common::past_start(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerNotAvailable, "{msg}");
        assert!(
            msg.starts_with("Failed to start fake server: Language server for fake did not answer initialize within 800ms."),
            "{msg}"
        );
        assert_eq!(fake.spawns(), 1);
        let (code, _) = code_and_message(&lsp(hover_input(&file), &session).await).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout);
        assert_eq!(fake.spawns_reaching(2).await, 2);
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_that_exits_while_calls_keep_coming_is_reported_with_one_spawn() {
    common::bounded(async {
        let fake = Fake::new();
        let client = client_with_limit(3_000);
        let profile = fake.profile("slow-die-on-initialize");
        let (cancel_tx, cancel_rx) = watch::channel(true);
        let first = client
            .ensure_server("fake", &fake.root, &profile, cancel_rx)
            .await;
        assert_eq!(first.unwrap_err(), LspClientError::Aborted);
        drop(cancel_tx);
        assert_eq!(
            fake.spawns(),
            0,
            "an already-cancelled call must start nothing"
        );

        // Begin a start, give up on it at once, then call on every turn.
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let starting = client.ensure_server("fake", &fake.root, &profile, cancel_rx);
        tokio::pin!(starting);
        // Poll once, so the server is spawned before the cancel.
        tokio::select! {
            biased;
            _ = &mut starting => panic!("the start cannot be over yet"),
            _ = tokio::task::yield_now() => {}
        }
        let _ = cancel_tx.send(true);
        assert_eq!(starting.await.unwrap_err(), LspClientError::Aborted);
        let outcome = loop {
            tokio::task::yield_now().await;
            match client
                .ensure_server("fake", &fake.root, &profile, never_cancelled())
                .await
            {
                Ok(h) if h.state == ServerState::Starting => continue,
                other => break other,
            }
        };
        let e = outcome.expect_err("the start fails");
        assert!(e.to_string().contains("exited with code 3"), "{e}");
        assert!(e.to_string().contains("missing config, giving up"), "{e}");
        assert_eq!(fake.spawns(), 1);
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_cancelled_before_it_started_sends_nothing() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let mut session = fake.session(client.clone(), "well-behaved", Some(5_000));
        let (_cancel_tx, cancel_rx) = watch::channel(true);
        session.signal = Some(cancel_rx);
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout);
        assert_eq!(
            msg,
            "LSP hover was cancelled before it started. Nothing was sent to the fake server."
        );
        assert!(!fake.exists("pid"), "a server was started");
        client.close_session().await;
    })
    .await;
}

/// Wraps the spawn client to fire the session's cancel at a set point, so
/// tests cancel at a known step instead of on a clock.
struct CancelAt {
    inner: Arc<SpawnLspClient>,
    cancel: watch::Sender<bool>,
    on_start: bool,
}

#[async_trait]
impl LspClient for CancelAt {
    async fn ensure_server(
        &self,
        language: &str,
        root: &str,
        profile: &LspServerProfile,
        cancel: CancelSignal,
    ) -> Result<ServerHandle, LspClientError> {
        let start = self.inner.ensure_server(language, root, profile, cancel);
        tokio::pin!(start);
        if self.on_start {
            // Poll once, so the start has begun before the cancel.
            tokio::select! {
                biased;
                r = &mut start => return r,
                _ = tokio::task::yield_now() => {}
            }
            let _ = self.cancel.send(true);
        }
        start.await
    }
    async fn hover(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Option<LspHoverResult>, LspClientError> {
        let fire = self.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = fire.send(true);
        });
        self.inner.hover(handle, path, pos, cancel).await
    }
    async fn definition(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.inner.definition(handle, path, pos, cancel).await
    }
    async fn references(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.inner.references(handle, path, pos, cancel).await
    }
    async fn document_symbol(
        &self,
        handle: &ServerHandle,
        path: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, LspClientError> {
        self.inner.document_symbol(handle, path, cancel).await
    }
    async fn workspace_symbol(
        &self,
        handle: &ServerHandle,
        query: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, LspClientError> {
        self.inner.workspace_symbol(handle, query, cancel).await
    }
    async fn implementation(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.inner.implementation(handle, path, pos, cancel).await
    }
    async fn close_session(&self) {
        self.inner.close_session().await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_during_the_start_says_so_and_the_start_goes_on() {
    common::bounded(async {
        let fake = Fake::new();
        let inner = Arc::new(SpawnLspClient::new());
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let client = Arc::new(CancelAt {
            inner: inner.clone(),
            cancel: cancel_tx,
            on_start: true,
        });
        let file = fake.file("a.fake", "x\n");
        let mut session = fake.session(client.clone(), "slow-initialize", Some(5_000));
        session.signal = Some(cancel_rx);
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout);
        assert_eq!(
            msg,
            "LSP hover was cancelled while the fake server was starting. The start goes on in the background."
        );
        // A later call, without a cancel, finds the same server starting.
        let session = fake.session(inner.clone(), "slow-initialize", Some(5_000));
        let r = lsp(hover_input(&file), &session).await;
        assert!(matches!(r, LspResult::ServerStarting(_)), "{r:?}");
        // The server answers initialize after 800ms; then the same one serves.
        let r = common::past_start(hover_input(&file), &session).await;
        assert!(matches!(r, LspResult::Hover(_)), "{r:?}");
        assert_eq!(fake.spawns(), 1);
        inner.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_during_a_request_says_so_and_leaves_the_server_running() {
    common::bounded(async {
        let fake = Fake::new();
        let inner = Arc::new(SpawnLspClient::new());
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let client = Arc::new(CancelAt {
            inner: inner.clone(),
            cancel: cancel_tx,
            on_start: false,
        });
        let file = fake.file("a.fake", "x\n");
        let mut session = fake.session(client.clone(), "silent-on-hover", Some(5_000));
        session.signal = Some(cancel_rx);
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout);
        assert_eq!(msg, "LSP hover was cancelled.");
        assert!(alive(fake.pid()));
        inner.close_session().await;
    })
    .await;
}
