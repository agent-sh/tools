//! Spawn-client lifecycle tests against a real child process. They use the
//! same fake stdio server as the TypeScript tests
//! (`packages/lsp/test/fixtures/fake-lsp-server.mjs`), so both ports run
//! the same cases. Needs `node` on PATH. Linux only: liveness checks read
//! `/proc`.
//!
//! These tests use only the API both before and after the lifecycle work
//! (`lsp`, `SpawnLspClient::new`, `close_session`); the ones that need the
//! new API are in `spawn_client_api.rs`.
#![cfg(target_os = "linux")]

mod common;

use common::{alive, code_and_message, gone_within, hover_input, Fake};
use harness_core::ToolErrorCode;
use harness_lsp::{lsp, LspClient, LspResult, SpawnLspClient};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn in_flight_request_gets_server_crashed_with_exit_code_and_stderr() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "die-on-hover", Some(5_000));
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerCrashed, "{msg}");
        assert!(msg.contains("exited with code 1"), "{msg}");
        assert!(msg.contains("fake server: hover crashed"), "{msg}");
        assert!(msg.contains("The next call starts it again."), "{msg}");
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_during_start_gets_server_not_available_with_the_reason() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "die-on-initialize", Some(5_000));
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerNotAvailable, "{msg}");
        assert!(msg.starts_with("Failed to start fake server: "), "{msg}");
        assert!(msg.contains("exited with code 3"), "{msg}");
        assert!(msg.contains("fake server: cannot start"), "{msg}");
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_binary_names_the_spawn() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let missing = format!("{}/no-such-server", fake.root);
        let session = fake.session_with_command(client.clone(), vec![missing.clone()], Some(5_000));
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerNotAvailable, "{msg}");
        assert!(msg.contains(&format!("spawn {missing}")), "{msg}");
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_start_outlives_the_call_then_server_starting_then_the_result() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // The server answers initialize after 800ms; the call budget is 300ms.
        let session = fake.session(client.clone(), "slow-initialize", Some(300));
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout, "{msg}");
        assert!(
            msg.contains(
                "while the fake server was starting. The start goes on in the background; retry."
            ),
            "{msg}"
        );
        let r = lsp(hover_input(&file), &session).await;
        assert!(matches!(r, LspResult::ServerStarting(_)), "{r:?}");
        tokio::time::sleep(Duration::from_millis(900)).await;
        let r = lsp(hover_input(&file), &session).await;
        assert!(matches!(r, LspResult::Hover(_)), "{r:?}");
        assert_eq!(fake.spawns(), 1);
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_that_exits_after_its_call_gave_up_is_reported_once() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // The server exits with code 3, 800ms into the start.
        let session = fake.session(client.clone(), "slow-die-on-initialize", Some(300));
        let (code, _) =
            code_and_message(&lsp(hover_input(&file), &session).await).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout);
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerNotAvailable, "{msg}");
        assert!(msg.contains("exited with code 3"), "{msg}");
        assert!(msg.contains("missing config, giving up"), "{msg}");
        assert_eq!(fake.spawns(), 1);
        // Reported once: the next call starts a new server.
        let (code, _) =
            code_and_message(&lsp(hover_input(&file), &session).await).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout);
        assert_eq!(fake.spawns(), 2);
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_exit_is_replaced_by_the_next_call() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "well-behaved", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let first = fake.pid();
        common::kill9(first);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let r = lsp(hover_input(&file), &session).await;
        assert!(matches!(r, LspResult::Hover(_)), "{r:?}");
        assert_ne!(fake.pid(), first);
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_broken_stdin_reports_server_crashed_and_the_next_call_works() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // The server closes its stdin before it answers the first hover.
        let session = fake.session(client.clone(), "close-stdin-on-hover", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let first = fake.pid();
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerCrashed, "{msg}");
        assert!(msg.contains("stopped reading its input"), "{msg}");
        let r = lsp(hover_input(&file), &session).await;
        assert!(matches!(r, LspResult::Hover(_)), "{r:?}");
        assert_ne!(fake.pid(), first);
        client.close_session().await;
        assert!(!alive(first), "the retired server is still running");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_stdout_retires_the_server() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "close-stdout-on-hover", Some(8_000));
        let first_call = lsp(hover_input(&file), &session).await;
        let first = fake.pid();
        let (code, msg) = code_and_message(&first_call).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerCrashed, "{msg}");
        assert!(msg.contains("closed its output"), "{msg}");
        // The next call starts a new server (which closes its stdout again).
        let _ = lsp(hover_input(&file), &session).await;
        assert_ne!(fake.pid(), first);
        client.close_session().await;
        assert!(!alive(first), "the retired server is still running");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stderr_is_drained_so_a_chatty_server_starts() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // 2 MiB to stderr before it answers initialize.
        let session = fake.session(client.clone(), "flood-stderr-on-initialize", Some(5_000));
        let r = lsp(hover_input(&file), &session).await;
        assert!(matches!(r, LspResult::Hover(_)), "{r:?}");
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_bounded_stderr_tail_reaches_the_error() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // 2 MiB to stderr and a last line, then exit with code 1.
        let session = fake.session(client.clone(), "flood-stderr-then-die", Some(5_000));
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerNotAvailable, "{msg}");
        assert!(msg.ends_with("fake server: last words"), "{msg}");
        let tail = msg
            .split("Last stderr output:\n")
            .nth(1)
            .expect("a stderr tail");
        assert!(tail.len() <= 4_096, "tail is {} bytes", tail.len());
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn close_session_lets_the_server_exit_on_exit_and_waits_for_it() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "well-behaved", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let pid = fake.pid();
        client.close_session().await;
        assert!(
            !alive(pid),
            "the server is still running after close_session"
        );
        assert!(fake.exists("exit"), "the server never got `exit`");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn close_session_returns_when_the_server_dies_on_shutdown() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "die-on-shutdown", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let pid = fake.pid();
        client.close_session().await;
        assert!(!alive(pid));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn close_session_stops_a_server_that_needs_sigkill() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // Answers shutdown, ignores exit and SIGTERM.
        let session = fake.session(client.clone(), "stubborn", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let pid = fake.pid();
        client.close_session().await;
        assert!(
            !alive(pid),
            "the server is still running after close_session"
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn close_session_handles_a_server_that_closed_stdin_before_answering_shutdown() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "close-stdin-on-shutdown", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let pid = fake.pid();
        client.close_session().await;
        assert!(!alive(pid));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_open_the_server_does_not_read_is_bounded_by_the_call() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        // Larger than any pipe buffer, so the write cannot complete.
        let file = fake.file("big.fake", &"x".repeat(4 * 1024 * 1024));
        let session = fake.session(client.clone(), "stop-reading-after-initialize", Some(500));
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::Timeout, "{msg}");
        let pid = fake.pid();
        client.close_session().await;
        assert!(!alive(pid));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_first_calls_share_one_server_and_close_stops_every_process() {
    let rounds: usize = std::env::var("LSP_STRESS_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let tasks: usize = std::env::var("LSP_STRESS_TASKS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8);
    let run = async {
        for round in 0..rounds {
            let fake = Fake::new();
            let client = Arc::new(SpawnLspClient::new());
            let file = fake.file("a.fake", "x\n");
            let session = Arc::new(fake.session(client.clone(), "well-behaved", Some(10_000)));
            let barrier = Arc::new(tokio::sync::Barrier::new(tasks));
            let calls: Vec<_> = (0..tasks)
                .map(|_| {
                    let (session, barrier, file) = (session.clone(), barrier.clone(), file.clone());
                    tokio::spawn(async move {
                        barrier.wait().await;
                        lsp(hover_input(&file), &session).await
                    })
                })
                .collect();
            for call in calls {
                let r = call.await.unwrap();
                assert!(
                    matches!(r, LspResult::Hover(_) | LspResult::ServerStarting(_)),
                    "round {round}: {r:?}"
                );
            }
            client.close_session().await;
            // Give any extra server time to start and record its pid.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let pids = fake.spawned_pids();
            let running: Vec<i32> = pids.iter().copied().filter(|p| alive(*p)).collect();
            assert_eq!(
                pids.len(),
                1,
                "round {round}: {} servers for one key",
                pids.len()
            );
            assert!(
                running.is_empty(),
                "round {round}: still running after close: {running:?}"
            );
        }
    };
    if tokio::time::timeout(Duration::from_secs(120), run)
        .await
        .is_err()
    {
        panic!("the stress run did not finish");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_the_client_stops_its_servers() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "well-behaved", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let pid = fake.pid();
        drop(session);
        drop(client);
        assert!(
            gone_within(pid, Duration::from_millis(1_500)).await,
            "the server outlived its client"
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stdin_that_breaks_during_the_start_fails_the_start() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // The server closes its stdin, then answers initialize.
        let session = fake.session(client.clone(), "close-stdin-on-initialize", Some(5_000));
        let r = lsp(hover_input(&file), &session).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerNotAvailable, "{msg}");
        assert!(msg.contains("stopped reading its input"), "{msg}");
        let pid = fake.pid();
        client.close_session().await;
        assert!(!alive(pid));
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_error_reply_to_initialize_fails_the_start_and_a_late_exit_leaves_the_new_server_alone()
{
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        // Answers initialize with an error and exits 400ms after SIGTERM.
        let rejecting = fake.session(client.clone(), "reject-initialize-slow-exit", Some(5_000));
        let r = lsp(hover_input(&file), &rejecting).await;
        let (code, msg) = code_and_message(&r).expect("an error");
        assert_eq!(code, ToolErrorCode::ServerNotAvailable, "{msg}");
        assert!(msg.contains("fake server: refuses to start"), "{msg}");
        let old = fake.pid();
        let session = fake.session(client.clone(), "well-behaved", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        let new = fake.pid();
        assert!(
            gone_within(old, Duration::from_secs(3)).await,
            "the old server did not exit"
        );
        assert!(matches!(
            lsp(hover_input(&file), &session).await,
            LspResult::Hover(_)
        ));
        assert_eq!(fake.pid(), new, "the late exit replaced the new server");
        assert_eq!(fake.spawned_pids().len(), 2);
        client.close_session().await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_operations_on_one_file_send_one_did_open() {
    common::bounded(async {
        let fake = Fake::new();
        let client = Arc::new(SpawnLspClient::new());
        let file = fake.file("a.fake", "x\n");
        let session = fake.session(client.clone(), "well-behaved", Some(5_000));
        assert!(matches!(
            lsp(hover_input(&fake.file("b.fake", "y\n")), &session).await,
            LspResult::Hover(_)
        ));
        let (a, b) = tokio::join!(
            lsp(hover_input(&file), &session),
            lsp(hover_input(&file), &session)
        );
        assert!(matches!(a, LspResult::Hover(_)), "{a:?}");
        assert!(matches!(b, LspResult::Hover(_)), "{b:?}");
        // One for b.fake, one for a.fake.
        assert_eq!(fake.did_opens(), 2);
        client.close_session().await;
    })
    .await;
}
