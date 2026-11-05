//! `harness-lsp-cli` stops its language servers when it exits. Each server
//! runs in its own process group, so a signal sent to the CLI, or to the
//! CLI's group, never reaches the server or its children: the CLI has to
//! stop them itself. Needs `node` on PATH. Unix only: liveness checks use
//! `kill(pid, 0)`, and processes are found with `ps`.
#![cfg(unix)]

mod common;

use common::{alive, gone_within, Fake, FAKE_SERVER};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct Cli {
    process: Child,
    stdin: Option<ChildStdin>,
    _stdout: BufReader<ChildStdout>,
    server: i32,
    child: i32,
}

/// Starts the CLI and has it start a fake server in `mode`.
async fn cli_with_a_server(fake: &Fake, mode: &str) -> Cli {
    cli_with_a_server_and_env(fake, mode, &[]).await
}

async fn cli_with_a_server_and_env(fake: &Fake, mode: &str, env: &[(&str, &Path)]) -> Cli {
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness-lsp-cli"));
    for (key, value) in env {
        command.env(key, value);
    }
    let mut process = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn harness-lsp-cli");
    let mut stdin = process.stdin.take().unwrap();
    let mut stdout = BufReader::new(process.stdout.take().unwrap());
    let file = fake.file("a.fake", "x\n");
    let request = json!({
        "id": 1,
        "method": "lsp",
        "params": {
            "params": { "operation": "hover", "path": file, "line": 1, "character": 1 },
            "session": {
                "cwd": fake.root,
                "roots": [fake.root],
                "unsafe_allow_lsp_without_hook": true,
                "default_timeout_ms": 10_000,
                "manifest": { "servers": { "fake": {
                    "language": "fake",
                    "extensions": [".fake"],
                    "command": ["node", FAKE_SERVER, mode, fake.root],
                } } },
            },
        },
    });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    stdin.flush().await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(15), stdout.read_line(&mut line))
        .await
        .expect("no reply from the CLI")
        .unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["result"]["kind"], "hover", "{reply}");
    let server = fake.wait_pid().await.expect("the server never started");
    let child_pid = Path::new(&fake.root).join("child-pid");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !child_pid.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the server's child never started"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let child = std::fs::read_to_string(child_pid)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    Cli {
        process,
        stdin: Some(stdin),
        _stdout: stdout,
        server,
        child,
    }
}

async fn exit_code(cli: &mut Cli) -> Option<i32> {
    tokio::time::timeout(Duration::from_secs(15), cli.process.wait())
        .await
        .expect("the CLI did not exit")
        .unwrap()
        .code()
}

fn send(cli: &Cli, signal: &str) {
    let pid = cli.process.id().unwrap().to_string();
    let status = std::process::Command::new("kill")
        .args([format!("-{signal}"), pid])
        .status()
        .unwrap();
    assert!(status.success(), "kill -{signal} failed");
}

fn assert_stopped(fake: &Fake, cli: &Cli) {
    assert!(fake.exists("exit"), "the server never got `exit`");
    assert!(!alive(cli.server), "the server outlived the CLI");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_cli_stops_its_servers_at_end_of_input() {
    common::bounded(async {
        let fake = Fake::new();
        // Exits on `exit`; its child ignores SIGTERM and never exits.
        let mut cli = cli_with_a_server(&fake, "well-behaved-with-child").await;
        drop(cli.stdin.take());
        assert_eq!(exit_code(&mut cli).await, Some(0));
        assert_stopped(&fake, &cli);
        assert!(
            gone_within(cli.child, Duration::from_secs(1)).await,
            "the server's child outlived the CLI"
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_cli_stops_its_servers_on_a_stop_signal() {
    common::bounded(async {
        for (signal, code) in [("TERM", 143), ("INT", 130), ("HUP", 129)] {
            let fake = Fake::new();
            let mut cli = cli_with_a_server(&fake, "well-behaved-with-child").await;
            let pid = cli.process.id().unwrap().to_string();
            let status = std::process::Command::new("kill")
                .args([format!("-{signal}"), pid])
                .status()
                .unwrap();
            assert!(status.success());
            assert_eq!(exit_code(&mut cli).await, Some(code), "SIG{signal}");
            assert_stopped(&fake, &cli);
            assert!(
                gone_within(cli.child, Duration::from_secs(1)).await,
                "SIG{signal}: the server's child outlived the CLI"
            );
        }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_signal_right_after_end_of_input_still_lets_the_close_finish() {
    common::bounded(async {
        let fake = Fake::new();
        // Ignores `exit` and SIGTERM, and so does its child, so the close
        // takes two stop steps and the signal comes during it.
        let mut cli = cli_with_a_server(&fake, "stubborn-with-child").await;
        // What a host does that closes stdin and sends SIGTERM at once.
        drop(cli.stdin.take());
        let pid = cli.process.id().unwrap().to_string();
        let status = std::process::Command::new("kill")
            .args(["-TERM".to_string(), pid])
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(exit_code(&mut cli).await, Some(143));
        assert!(!alive(cli.server), "the server outlived the CLI");
        assert!(
            gone_within(cli.child, Duration::from_secs(1)).await,
            "the server's child outlived the CLI"
        );
    })
    .await;
}

/// Waits for `name` in `dir`, up to 10s.
async fn wait_for(dir: &Path, name: &str, what: &str) {
    let path = dir.join(name);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(tokio::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// The pause hook exists in debug builds only.
#[cfg(debug_assertions)]
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_signal_before_the_close_begins_is_kept() {
    common::bounded(async {
        let fake = Fake::new();
        let pause = tempfile::tempdir().unwrap();
        let mut cli = cli_with_a_server_and_env(
            &fake,
            "well-behaved-with-child",
            &[("HARNESS_LSP_CLI_TEST_PAUSE_DIR", pause.path())],
        )
        .await;
        drop(cli.stdin.take());
        // The CLI has seen the end of its input and waits before the close,
        // with no wait for a signal running.
        wait_for(pause.path(), "paused", "the CLI never paused").await;
        send(&cli, "TERM");
        // The runtime has taken the signal, before any wait could.
        wait_for(
            pause.path(),
            "signalled",
            "the SIGTERM never reached the CLI",
        )
        .await;
        std::fs::write(pause.path().join("resume"), "").unwrap();
        assert_eq!(exit_code(&mut cli).await, Some(143), "the SIGTERM was lost");
        assert_stopped(&fake, &cli);
        assert!(
            gone_within(cli.child, Duration::from_secs(1)).await,
            "the server's child outlived the CLI"
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_stop_signal_cuts_the_close_short_and_still_stops_every_server() {
    common::bounded(async {
        let fake = Fake::new();
        // Ignores `exit` and SIGTERM, and so does its child: a full close
        // takes two 2s stop steps.
        let mut cli = cli_with_a_server(&fake, "stubborn-with-child").await;
        let first = tokio::time::Instant::now();
        send(&cli, "TERM");
        // The close has begun: the server has read `shutdown`.
        wait_for(
            Path::new(&fake.root),
            "got-shutdown",
            "the close never began",
        )
        .await;
        send(&cli, "INT");
        assert_eq!(exit_code(&mut cli).await, Some(130));
        let took = first.elapsed();
        assert!(
            took < Duration::from_secs(3),
            "the CLI waited {took:?}, so the second signal did not cut the close short"
        );
        assert!(
            gone_within(cli.server, Duration::from_secs(1)).await,
            "the server outlived the CLI"
        );
        assert!(
            gone_within(cli.child, Duration::from_secs(1)).await,
            "the server's child outlived the CLI"
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_signal_exit_does_not_wait_for_the_stdin_reader() {
    common::bounded(async {
        let mut process = Command::new(env!("CARGO_BIN_EXE_harness-lsp-cli"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn harness-lsp-cli");
        let mut stdin = process.stdin.take().unwrap();
        let mut stdout = BufReader::new(process.stdout.take().unwrap());
        // Any reply shows the CLI is serving, with its signals set up.
        stdin.write_all(b"{}\n").await.unwrap();
        stdin.flush().await.unwrap();
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(15), stdout.read_line(&mut line))
            .await
            .expect("no reply from the CLI")
            .unwrap();
        // stdin stays open, so the reader is still waiting for a line. No
        // server runs, so the close has nothing to wait for.
        let pid = process.id().unwrap().to_string();
        let sent = tokio::time::Instant::now();
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid])
            .status()
            .unwrap();
        assert!(status.success());
        let code = tokio::time::timeout(Duration::from_secs(15), process.wait())
            .await
            .expect("the CLI did not exit")
            .unwrap()
            .code();
        let took = sent.elapsed();
        assert_eq!(code, Some(143));
        // The runtime shutdown is bounded at 500ms; it waits all of it for
        // a reader in tokio's blocking pool.
        assert!(
            took < Duration::from_millis(300),
            "the exit took {took:?}, so it waited for the stdin reader"
        );
        drop(stdin);
    })
    .await;
}
