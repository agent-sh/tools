//! Spawn-based LSP client. Talks LSP JSON-RPC over stdio to a child
//! language server. Framing: `Content-Length: N\r\n\r\n<body>`.
//!
//! The lifecycle follows `agent-knowledge/design/lsp.md`, sections 5.3 to
//! 5.5 and 8, the same way the TypeScript spawn client does:
//!
//! - The start runs in its own task, bounded by the `initialize` limit. A
//!   caller waits for it under its cancel signal; the start goes on when
//!   the caller gives up, and a start that fails after that is reported
//!   once, to the next call.
//! - A task watches the process. When it exits, every call still waiting
//!   on it fails at once with the exit code or signal and the stderr tail.
//! - stderr is always drained; only its last bytes are kept.
//! - A broken stdin, or a stdout that closes while the process lives,
//!   takes the server out of service, so the next call starts a new one.
//! - Writes go through one writer task, so a cancelled call never cuts a
//!   message off midway, and nothing is written once the pipe is gone.
//! - `close_session` stops every server in bounded steps: `shutdown`,
//!   `exit`, SIGTERM, SIGKILL, and waits for each process to exit.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use url::Url;

use crate::constants::{kind_name, DEFAULT_INITIALIZE_TIMEOUT_MS, SESSION_BACKSTOP_MS};
use crate::types::{
    CancelSignal, LspClient, LspClientError, LspHoverResult, LspLocation, LspServerProfile,
    LspSymbolInfo, Position1, ServerHandle, ServerState,
};

/// Bound for each step of stopping a server: the `shutdown` reply, the
/// `exit` write, the exit after `exit`, and the exit after SIGTERM and
/// after SIGKILL. Design spec section 5.4.
const STOP_STEP: Duration = Duration::from_millis(2_000);

/// Bytes of server stderr kept for the crash error. Enough for a typical
/// Node stack trace or Rust panic message; the rest is read and dropped.
const STDERR_TAIL_BYTES: usize = 4_096;

/// After the process exits, how long to wait for its stderr to reach end
/// of file, so the crash error carries what the server wrote last. What it
/// wrote before exiting is already in the pipe; the wait only runs long
/// when another process inherited the pipe.
const STDERR_SETTLE: Duration = Duration::from_millis(100);

/// Options for [`SpawnLspClient::with_options`].
#[derive(Debug, Clone, Default)]
pub struct SpawnLspClientOptions {
    /// Bound for the `initialize` handshake, in ms. Defaults to
    /// [`DEFAULT_INITIALIZE_TIMEOUT_MS`], the session backstop, so a start
    /// can outlive the tool call that began it.
    pub initialize_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryState {
    Starting,
    Ready,
    Crashed,
}

impl EntryState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Crashed => "crashed",
        }
    }
}

struct Status {
    state: EntryState,
    /// Why the start failed, kept while no caller has seen it: the call
    /// that began the start gave up before it ended. The next
    /// `ensure_server` for this key reports it once.
    unreported_start_error: Option<LspClientError>,
    stopping: bool,
}

type Reply = Result<Value, LspClientError>;

struct Rpc {
    /// Set once the server can no longer serve calls: the error to report.
    gone: Option<LspClientError>,
    pending: HashMap<i64, oneshot::Sender<Reply>>,
}

struct WriteJob {
    bytes: Vec<u8>,
    done: oneshot::Sender<Result<(), String>>,
}

enum KillSignal {
    Term,
    Kill,
}

type OpenResult = Option<Result<(), LspClientError>>;

struct ServerEntry {
    language: String,
    root: String,
    /// Which server this is; handles carry it (`ServerHandle::instance`).
    instance: u64,
    status: StdMutex<Status>,
    rpc: StdMutex<Rpc>,
    /// Flips to true when `rpc.gone` is set.
    gone_flag: watch::Sender<bool>,
    /// Flips to true once the process has exited.
    exited: watch::Sender<bool>,
    writer: StdMutex<Option<mpsc::UnboundedSender<WriteJob>>>,
    kill: mpsc::UnboundedSender<KillSignal>,
    next_id: AtomicI64,
    /// didOpen per path: in flight or done. A failed open is dropped.
    opened: StdMutex<HashMap<String, watch::Receiver<OpenResult>>>,
    stderr: Arc<StdMutex<Vec<u8>>>,
    /// Stops of servers taken out of service, shared with the client.
    stops: Arc<StdMutex<Vec<JoinHandle<()>>>>,
    /// Test record: whether the exited server was still unreaped when the
    /// watcher killed its group.
    #[cfg(all(test, unix))]
    unreaped_at_group_kill: StdMutex<Option<bool>>,
}

impl ServerEntry {
    fn handle(&self) -> ServerHandle {
        ServerHandle {
            language: self.language.clone(),
            root: self.root.clone(),
            instance: self.instance,
            state: match self.status.lock().unwrap().state {
                EntryState::Ready => ServerState::Ready,
                _ => ServerState::Starting,
            },
        }
    }

    fn running(&self) -> bool {
        !*self.exited.borrow()
    }

    async fn wait_exited(&self) {
        let mut rx = self.exited.subscribe();
        let _ = rx.wait_for(|e| *e).await;
    }

    fn stderr_tail(&self) -> String {
        let buf = self.stderr.lock().unwrap();
        String::from_utf8_lossy(&buf).trim().to_string()
    }

    fn crashed(&self, summary: String) -> LspClientError {
        LspClientError::Crashed(crash_message(summary, &self.stderr_tail()))
    }

    fn gone_reason(&self) -> Option<LspClientError> {
        self.rpc.lock().unwrap().gone.clone()
    }

    /// Mark the server unable to serve calls. Every call still waiting on a
    /// reply fails with `reason`; later calls fail with it at once. Only
    /// the first reason counts.
    fn fire_gone(&self, reason: LspClientError) {
        let pending = {
            let mut rpc = self.rpc.lock().unwrap();
            if rpc.gone.is_some() {
                return;
            }
            rpc.gone = Some(reason.clone());
            std::mem::take(&mut rpc.pending)
        };
        for (_, tx) in pending {
            let _ = tx.send(Err(reason.clone()));
        }
        self.gone_flag.send_replace(true);
    }

    async fn wait_gone(&self) -> LspClientError {
        let mut rx = self.gone_flag.subscribe();
        let _ = rx.wait_for(|g| *g).await;
        self.gone_reason()
            .unwrap_or_else(|| LspClientError::Other("language server is gone".to_string()))
    }

    /// Queue one message for the writer task and wait until it is written.
    async fn write(&self, msg: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        bytes.extend_from_slice(&body);
        let (done, rx) = oneshot::channel();
        let sent = match self.writer.lock().unwrap().as_ref() {
            Some(tx) => tx.send(WriteJob { bytes, done }).is_ok(),
            None => false,
        };
        if !sent {
            return Err("the server's stdin is closed".to_string());
        }
        rx.await
            .unwrap_or_else(|_| Err("the server's stdin is closed".to_string()))
    }

    /// The error to report for a write that failed. A process that has
    /// exited reports its exit. One that lives but lost its stdin can never
    /// take another message: retire it.
    async fn write_failed(self: &Arc<Self>, e: String) -> LspClientError {
        if !self.running() {
            return self.wait_gone().await;
        }
        let reason = self.crashed(format!(
            "Language server for {} stopped reading its input ({}).",
            self.language, e
        ));
        self.retire(Some(reason.clone()));
        self.gone_reason().unwrap_or(reason)
    }

    async fn notify(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        cancel: Option<&CancelSignal>,
    ) -> Result<(), LspClientError> {
        if let Some(reason) = self.gone_reason() {
            return Err(reason);
        }
        let msg = serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let written = with_cancel(cancel, self.write(&msg)).await?;
        match written {
            Ok(()) => Ok(()),
            Err(e) => Err(self.write_failed(e).await),
        }
    }

    async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        cancel: Option<&CancelSignal>,
    ) -> Result<Value, LspClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let reply = {
            let mut rpc = self.rpc.lock().unwrap();
            if let Some(reason) = &rpc.gone {
                return Err(reason.clone());
            }
            let (tx, rx) = oneshot::channel();
            rpc.pending.insert(id, tx);
            rx
        };
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let outcome = with_cancel(cancel, async {
            if let Err(e) = self.write(&msg).await {
                self.rpc.lock().unwrap().pending.remove(&id);
                return Err(self.write_failed(e).await);
            }
            match reply.await {
                Ok(r) => r,
                Err(_) => Err(self.wait_gone().await),
            }
        })
        .await;
        match outcome {
            Ok(r) => r,
            Err(aborted) => {
                self.rpc.lock().unwrap().pending.remove(&id);
                self.send_cancel_request(id);
                Err(aborted)
            }
        }
    }

    /// Ask the server to drop a request the caller gave up on. Best effort:
    /// queued without waiting for the write.
    fn send_cancel_request(&self, id: i64) {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "$/cancelRequest",
            "params": { "id": id },
        });
        let Ok(body) = serde_json::to_vec(&msg) else {
            return;
        };
        let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        bytes.extend_from_slice(&body);
        let (done, _) = oneshot::channel();
        if let Some(tx) = self.writer.lock().unwrap().as_ref() {
            let _ = tx.send(WriteJob { bytes, done });
        }
    }

    /// Send didOpen once per path. Concurrent callers share the one in
    /// flight, and wait for it under their own cancel signal, so a server
    /// that stops reading stdin cannot hold a call past its budget.
    async fn did_open_if_needed(
        self: &Arc<Self>,
        file_path: &str,
        cancel: &CancelSignal,
    ) -> Result<(), LspClientError> {
        let mut rx = {
            let mut opened = self.opened.lock().unwrap();
            match opened.get(file_path) {
                Some(rx) => rx.clone(),
                None => {
                    let (tx, rx) = watch::channel(None);
                    opened.insert(file_path.to_string(), rx.clone());
                    let me = Arc::clone(self);
                    let path = file_path.to_string();
                    tokio::spawn(async move {
                        let text = tokio::fs::read_to_string(&path).await.unwrap_or_default();
                        let params = serde_json::json!({
                            "textDocument": {
                                "uri": file_uri(&path),
                                "languageId": me.language,
                                "version": 1,
                                "text": text,
                            }
                        });
                        let r = me.notify("textDocument/didOpen", params, None).await;
                        if r.is_err() {
                            // A failed open is retried by the next call.
                            me.opened.lock().unwrap().remove(&path);
                        }
                        let _ = tx.send(Some(r));
                    });
                    rx
                }
            }
        };
        let open = with_cancel(Some(cancel), async {
            match rx.wait_for(|v| v.is_some()).await {
                Ok(v) => v.clone().unwrap_or(Ok(())),
                Err(_) => Err(LspClientError::Other("didOpen was dropped".to_string())),
            }
        })
        .await?;
        open
    }

    /// Take the server out of service: mark it crashed, so the next call
    /// starts a new one, and stop its process. With a reason, every call
    /// still waiting on it fails with that reason. A server still starting
    /// stays `Starting` until its start fails, so no call sees it crashed
    /// without the error to report.
    fn retire(self: &Arc<Self>, reason: Option<LspClientError>) {
        {
            let mut st = self.status.lock().unwrap();
            if st.state != EntryState::Starting {
                st.state = EntryState::Crashed;
            }
        }
        if let Some(r) = reason {
            self.fire_gone(r);
        }
        self.begin_stop();
    }

    /// Start stopping the server in the background, once. `close_session`
    /// waits for every stop that was begun.
    fn begin_stop(self: &Arc<Self>) {
        // Mark and register under the stops lock, so close_session either
        // sees this stop or runs before it begins.
        let mut stops = self.stops.lock().unwrap();
        {
            let mut st = self.status.lock().unwrap();
            if st.stopping {
                return;
            }
            st.stopping = true;
        }
        stops.retain(|h| !h.is_finished());
        let me = Arc::clone(self);
        stops.push(tokio::spawn(async move { me.stop().await }));
    }

    /// Stop the server in bounded steps (design spec section 5.4).
    async fn stop(self: &Arc<Self>) {
        if self.running() {
            let ready = self.status.lock().unwrap().state == EntryState::Ready;
            let graceful = ready
                && self.request_exit().await
                && tokio::time::timeout(STOP_STEP, self.wait_exited())
                    .await
                    .is_ok();
            if !graceful && self.running() {
                let _ = self.kill.send(KillSignal::Term);
                if tokio::time::timeout(STOP_STEP, self.wait_exited())
                    .await
                    .is_err()
                {
                    let _ = self.kill.send(KillSignal::Kill);
                    let _ = tokio::time::timeout(STOP_STEP, self.wait_exited()).await;
                }
            }
        }
        // No write after this point.
        self.writer.lock().unwrap().take();
        if self.running() {
            self.fire_gone(LspClientError::Other(format!(
                "Language server for {} did not exit after SIGKILL.",
                self.language
            )));
        } else {
            // The process watcher reports the exit to calls still waiting.
            let _ = tokio::time::timeout(STOP_STEP, self.wait_gone()).await;
        }
        let mut st = self.status.lock().unwrap();
        if st.state != EntryState::Starting {
            st.state = EntryState::Crashed;
        }
    }

    /// Send `shutdown` and `exit`. True once `exit` is written; false when
    /// the server failed or did not answer `shutdown` in time, exited, its
    /// stdin broke, or `exit` was not written in time.
    async fn request_exit(self: &Arc<Self>) -> bool {
        let answered = tokio::time::timeout(STOP_STEP, async {
            tokio::select! {
                r = self.request("shutdown", Value::Null, None) => r.is_ok(),
                _ = self.wait_exited() => false,
            }
        })
        .await
        .unwrap_or(false);
        if !answered || !self.running() {
            return false;
        }
        matches!(
            tokio::time::timeout(STOP_STEP, self.notify("exit", Value::Null, None)).await,
            Ok(Ok(()))
        )
    }
}

/// Run `fut` unless `cancel` fires first; then return `Aborted`. Nothing is
/// cut off: a write already queued finishes in the writer task.
async fn with_cancel<T>(
    cancel: Option<&CancelSignal>,
    fut: impl std::future::Future<Output = T>,
) -> Result<T, LspClientError> {
    let Some(cancel) = cancel else {
        return Ok(fut.await);
    };
    if *cancel.borrow() {
        return Err(LspClientError::Aborted);
    }
    let mut rx = cancel.clone();
    let cancelled = async move {
        let fired = rx.wait_for(|c| *c).await.is_ok();
        if !fired {
            // The sender is gone without cancelling: it never will.
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        v = fut => Ok(v),
        _ = cancelled => Err(LspClientError::Aborted),
    }
}

fn crash_message(summary: String, stderr_tail: &str) -> String {
    let mut m = format!("{} The next call starts it again.", summary);
    if !stderr_tail.is_empty() {
        m.push_str("\nLast stderr output:\n");
        m.push_str(stderr_tail);
    }
    m
}

fn exit_summary(language: &str, status: Option<ExitStatus>) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.and_then(|s| s.signal()) {
            return format!(
                "Language server for {} was killed by {}.",
                language,
                signal_name(sig)
            );
        }
    }
    match status.and_then(|s| s.code()) {
        Some(code) => format!(
            "Language server for {} exited with code {}.",
            language, code
        ),
        None => format!("Language server for {} exited.", language),
    }
}

#[cfg(unix)]
fn signal_name(sig: i32) -> String {
    let name = match sig {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        6 => "SIGABRT",
        7 => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return format!("signal {}", sig),
    };
    name.to_string()
}

/// Signal the server and everything it started. On Unix each server runs
/// in its own process group (see `spawn_server`), so the signal reaches
/// its children too, such as tsserver under typescript-language-server.
fn signal_server(child: &mut Child, kill: bool) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let sig = if kill { libc::SIGKILL } else { libc::SIGTERM };
            // SAFETY: kill(2) on the process group our child leads. The
            // child is not reaped yet, since this task owns it and has not
            // seen it exit, so the group id is still ours.
            unsafe {
                libc::kill(-(pid as libc::pid_t), sig);
            }
            return;
        }
    }
    let _ = kill;
    let _ = child.start_kill();
}

fn append_tail(buf: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.len() >= STDERR_TAIL_BYTES {
        buf.clear();
        buf.extend_from_slice(&chunk[chunk.len() - STDERR_TAIL_BYTES..]);
        return;
    }
    let keep = buf.len().min(STDERR_TAIL_BYTES - chunk.len());
    let drop = buf.len() - keep;
    buf.drain(..drop);
    buf.extend_from_slice(chunk);
}

/// Writes queued messages in order, each one whole. After the first
/// failure it writes nothing more and fails every later job.
async fn writer_loop(mut stdin: ChildStdin, mut jobs: mpsc::UnboundedReceiver<WriteJob>) {
    let mut broken: Option<String> = None;
    while let Some(job) = jobs.recv().await {
        if let Some(e) = &broken {
            let _ = job.done.send(Err(e.clone()));
            continue;
        }
        let r = async {
            stdin.write_all(&job.bytes).await?;
            stdin.flush().await
        }
        .await;
        match r {
            Ok(()) => {
                let _ = job.done.send(Ok(()));
            }
            Err(e) => {
                let e = e.to_string();
                broken = Some(e.clone());
                let _ = job.done.send(Err(e));
            }
        }
    }
}

async fn stderr_loop<R: AsyncRead + Unpin>(
    mut stderr: R,
    tail: Arc<StdMutex<Vec<u8>>>,
    eof: oneshot::Sender<()>,
) {
    let mut chunk = vec![0u8; 8192];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => append_tail(&mut tail.lock().unwrap(), &chunk[..n]),
        }
    }
    let _ = eof.send(());
}

/// The process group a server leads (Unix). Dropping it kills the group,
/// so a watcher dropped before it reaped its server, as on a runtime that
/// shuts down without `close_session`, still takes the server's children.
/// The watcher disarms it once it has reaped the server, since the group id
/// is then free for another process to take.
struct ServerGroup(Option<u32>);

impl ServerGroup {
    fn kill(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            // SAFETY: kill(2) on the group our child leads. The child is
            // not reaped yet (see `disarm`), so the group id is still ours.
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for ServerGroup {
    fn drop(&mut self) {
        self.kill();
    }
}

/// A notice that fires once process `pid` has exited, without reaping it:
/// until `child.wait()` reaps it, its pid and group id stay taken. It
/// carries true once `waitid` saw the exit, false if `waitid` failed. None
/// when the waiting thread could not start. A stopped or continued process
/// has not exited: macOS reports those to this `waitid` too.
#[cfg(unix)]
fn exit_notice(pid: u32) -> Option<oneshot::Receiver<bool>> {
    let (tx, rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("lsp-exit-wait".to_string())
        .stack_size(64 * 1024)
        .spawn(move || {
            let exited = loop {
                // SAFETY: a zeroed siginfo_t is a valid out-parameter.
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                // SAFETY: waitid on our own child. WNOWAIT leaves it
                // unreaped, so `child.wait()` still reaps it.
                let r = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOWAIT,
                    )
                };
                if r != 0 {
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    break false;
                }
                match info.si_code {
                    libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED => break true,
                    _ => {
                        // A stop or continue, which macOS reports here even
                        // without WSTOPPED. WNOWAIT leaves the report
                        // pending, so consume it and wait again, as CPython
                        // does (python/cpython#158962). The pause keeps an
                        // unknown report from making this loop spin.
                        // SAFETY: as above; without WEXITED this call cannot
                        // reap the process.
                        unsafe {
                            let mut seen: libc::siginfo_t = std::mem::zeroed();
                            libc::waitid(
                                libc::P_PID,
                                pid as libc::id_t,
                                &mut seen,
                                libc::WSTOPPED | libc::WCONTINUED | libc::WNOHANG,
                            );
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            };
            let _ = tx.send(exited);
        })
        .ok()?;
    Some(rx)
}

/// Waits for the server to exit and reaps it. On Unix the exit is seen
/// first without a reap, and what is left of the server's group is killed
/// then, while the exited server still holds the group id. So no new
/// process can have taken that id.
async fn reap(
    entry: &ServerEntry,
    child: &mut Child,
    notice: &mut Option<oneshot::Receiver<bool>>,
    group: &ServerGroup,
) -> Option<ExitStatus> {
    if let Some(rx) = notice.as_mut() {
        let exited = rx.await.unwrap_or(false);
        *notice = None;
        if exited {
            // Signal 0 finds a zombie too: unreaped means it still exists.
            #[cfg(all(test, unix))]
            if let Some(pid) = group.0 {
                // SAFETY: signal 0 only checks that the process exists.
                *entry.unreaped_at_group_kill.lock().unwrap() =
                    Some(unsafe { libc::kill(pid as libc::pid_t, 0) } == 0);
            }
            group.kill();
        }
    }
    let _ = entry;
    child.wait().await.ok()
}

/// Watches the process: delivers signals, and when it exits reports the
/// exit to every call still waiting on it. The server's children go with
/// it, whether it exited on its own, on `exit`, or on a signal some child
/// ignored.
async fn watch_process(
    entry: Arc<ServerEntry>,
    mut child: Child,
    mut kills: mpsc::UnboundedReceiver<KillSignal>,
    stderr_eof: oneshot::Receiver<()>,
) {
    // Declared before anything that can reap the server: when this future
    // is dropped, its locals drop before its parameters, so `group` kills
    // the group before the drop of `child` (kill_on_drop) can reap it.
    #[cfg(unix)]
    let mut group = ServerGroup(child.id());
    #[cfg(not(unix))]
    let mut group = ServerGroup(None);
    #[cfg(unix)]
    let mut notice = child.id().and_then(exit_notice);
    #[cfg(not(unix))]
    let mut notice: Option<oneshot::Receiver<bool>> = None;
    let status = loop {
        tokio::select! {
            s = reap(&entry, &mut child, &mut notice, &group) => break s,
            Some(k) = kills.recv() => match k {
                KillSignal::Term => signal_server(&mut child, false),
                KillSignal::Kill => signal_server(&mut child, true),
            },
        }
    };
    group.disarm();
    entry.exited.send_replace(true);
    {
        let mut st = entry.status.lock().unwrap();
        if st.state == EntryState::Ready {
            st.state = EntryState::Crashed;
        }
    }
    let _ = tokio::time::timeout(STDERR_SETTLE, stderr_eof).await;
    let summary = exit_summary(&entry.language, status);
    entry.fire_gone(entry.crashed(summary));
    entry.writer.lock().unwrap().take();
}

/// Reads replies off stdout. At end of file the server can never answer
/// again: if the process lives on, it gets one stop step to exit, then it
/// is retired.
async fn read_loop<R: AsyncRead + Unpin>(entry: Arc<ServerEntry>, reader: R) {
    let mut reader = BufReader::new(reader);
    loop {
        let mut content_length: Option<usize> = None;
        let mut eof = false;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => {
                    eof = true;
                    break;
                }
                Ok(_) => {}
            }
            let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
            if trimmed.is_empty() {
                break;
            }
            if let Some(v) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
                if let Ok(n) = v.trim().parse::<usize>() {
                    content_length = Some(n);
                }
            }
        }
        if eof {
            break;
        }
        let Some(len) = content_length else {
            continue;
        };
        let mut buf = vec![0u8; len];
        if reader.read_exact(&mut buf).await.is_err() {
            break;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        // Route replies only; server-pushed messages are ignored.
        let Some(id) = value.get("id").and_then(|i| i.as_i64()) else {
            continue;
        };
        if value.get("method").is_some() {
            continue;
        }
        let tx = entry.rpc.lock().unwrap().pending.remove(&id);
        if let Some(tx) = tx {
            let reply = match value.get("error") {
                Some(err) => Err(LspClientError::Other(
                    err.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("error")
                        .to_string(),
                )),
                None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(reply);
        }
    }
    if entry.running()
        && tokio::time::timeout(STOP_STEP, entry.wait_exited())
            .await
            .is_err()
        && entry.running()
    {
        let reason = entry.crashed(format!(
            "Language server for {} closed its output and stopped answering.",
            entry.language
        ));
        entry.retire(Some(reason));
    }
}

fn file_uri(p: &str) -> String {
    Url::from_file_path(Path::new(p))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| format!("file://{}", p))
}

/// The path of a `file://` URI, percent-decoded, as the TypeScript client
/// reads it. Anything else comes back unchanged.
fn file_uri_to_path(uri: &str) -> String {
    if !uri.starts_with("file://") {
        return uri.to_string();
    }
    match Url::parse(uri).ok().and_then(|u| u.to_file_path().ok()) {
        Some(p) => p.to_string_lossy().into_owned(),
        None => uri["file://".len()..].to_string(),
    }
}

fn lsp_pos(p: Position1) -> Value {
    serde_json::json!({
        "line": p.line.saturating_sub(1),
        "character": p.character.saturating_sub(1),
    })
}

fn from_lsp_line(n: i64) -> u32 {
    (n + 1).max(1) as u32
}

fn from_lsp_char(n: i64) -> u32 {
    (n + 1).max(1) as u32
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
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let kind = v.get("kind").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let range = v
        .get("range")
        .or_else(|| v.get("selectionRange"))
        .cloned()
        .unwrap_or(Value::Null);
    let start = range.get("start").cloned().unwrap_or(Value::Null);
    let line = start.get("line").and_then(|x| x.as_i64()).unwrap_or(0);
    let character = start.get("character").and_then(|x| x.as_i64()).unwrap_or(0);
    let children = v.get("children").and_then(|x| x.as_array()).map(|arr| {
        arr.iter()
            .map(|c| map_document_symbol(c, file_path))
            .collect()
    });
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
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
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

/// Where the server a handle names stands under its key.
enum Lookup {
    /// It is the server under the key.
    Server(Arc<ServerEntry>),
    /// Its spawn is still running outside the lock.
    Spawning,
    /// Another server, or nothing, is under the key now.
    Gone,
}

/// A server that a new one replaced under its key, and when.
struct Retired {
    at: tokio::time::Instant,
    entry: Arc<ServerEntry>,
}

/// How many replaced servers a client keeps for calls that still hold their
/// handles. They are kept for at most the session backstop, the longest any
/// call can run, so no call can outlive its server's record.
const RETIRED_KEEP: usize = 32;

/// One key's place in the client: a server, or a spawn still running.
enum Slot {
    /// A spawn is running outside the lock. The number tells this spawn
    /// apart from a later one for the same key; the channel closes once
    /// the spawn is handled (its server in the map, or its stop begun).
    Spawning(u64, watch::Receiver<()>),
    Server(Arc<ServerEntry>),
}

pub struct SpawnLspClient {
    servers: StdMutex<HashMap<String, Slot>>,
    /// The next instance id; a spawn claims one before it runs.
    next_spawn: AtomicU64,
    /// Servers replaced under their key, newest last, so a call that still
    /// holds a handle to one can report why it went (see `replaced`).
    retired: StdMutex<VecDeque<Retired>>,
    /// How many replaced servers `retired` keeps, and for how long.
    retired_keep: (usize, Duration),
    stops: Arc<StdMutex<Vec<JoinHandle<()>>>>,
    initialize_timeout: Duration,
    /// Test hook: wait for the server to exit between the handshake and
    /// the readiness check.
    #[cfg(test)]
    exit_before_ready_check: bool,
    /// Test hook: block every spawn of this language for this long, as an
    /// exec on a hung mount would, and add a permit once each begins.
    #[cfg(test)]
    slow_spawn: Option<(String, Duration, Arc<tokio::sync::Semaphore>)>,
    /// Test hook: the next spawn panics.
    #[cfg(test)]
    panic_spawn: std::sync::atomic::AtomicBool,
    /// Test record: the pid of every server spawned.
    #[cfg(test)]
    spawned: StdMutex<Vec<u32>>,
}

/// Removes a `Spawning` placeholder that is still there when dropped, so a
/// spawn that panics does not leave its key `server_starting` until
/// `close_session`. On every other path the placeholder is gone by then.
struct Unclaim<'a> {
    servers: &'a StdMutex<HashMap<String, Slot>>,
    key: String,
    claim: u64,
}

impl Drop for Unclaim<'_> {
    fn drop(&mut self) {
        let mut servers = match self.servers.lock() {
            Ok(servers) => servers,
            Err(poisoned) => poisoned.into_inner(),
        };
        if matches!(servers.get(&self.key), Some(Slot::Spawning(c, _)) if *c == self.claim) {
            servers.remove(&self.key);
        }
    }
}

impl SpawnLspClient {
    pub fn new() -> Self {
        Self::with_options(SpawnLspClientOptions::default())
    }

    pub fn with_options(options: SpawnLspClientOptions) -> Self {
        Self {
            servers: StdMutex::new(HashMap::new()),
            next_spawn: AtomicU64::new(1),
            retired: StdMutex::new(VecDeque::new()),
            retired_keep: (RETIRED_KEEP, Duration::from_millis(SESSION_BACKSTOP_MS)),
            stops: Arc::new(StdMutex::new(Vec::new())),
            initialize_timeout: Duration::from_millis(
                options
                    .initialize_timeout_ms
                    .unwrap_or(DEFAULT_INITIALIZE_TIMEOUT_MS),
            ),
            #[cfg(test)]
            exit_before_ready_check: false,
            #[cfg(test)]
            slow_spawn: None,
            #[cfg(test)]
            panic_spawn: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            spawned: StdMutex::new(Vec::new()),
        }
    }

    fn key(language: &str, root: &str) -> String {
        format!("{}|{}", language, root)
    }

    fn spawn_server(
        &self,
        language: &str,
        root: &str,
        profile: &LspServerProfile,
        instance: u64,
    ) -> Result<Arc<ServerEntry>, LspClientError> {
        let (cmd_str, args) = match profile.command.split_first() {
            Some((c, rest)) => (c.clone(), rest.to_vec()),
            None => {
                return Err(LspClientError::Other(format!(
                    "LSP profile '{}' has empty command",
                    language
                )));
            }
        };
        #[cfg(test)]
        if let Some((slow, pause, began)) = &self.slow_spawn {
            if slow == language {
                began.add_permits(1);
                std::thread::sleep(*pause);
            }
        }
        #[cfg(test)]
        if self.panic_spawn.swap(false, Ordering::SeqCst) {
            panic!("test hook: the spawn panics");
        }
        let mut cmd = Command::new(&cmd_str);
        cmd.args(&args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Its own process group, so a stop or a dropped client can signal
        // the server's children along with it.
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| LspClientError::Other(format!("spawn {}: {}", cmd_str, e)))?;
        #[cfg(test)]
        if let Some(pid) = child.id() {
            self.spawned.lock().unwrap().push(pid);
        }
        let missing = || LspClientError::Other(format!("spawn {}: no stdio pipes", cmd_str));
        let stdin = child.stdin.take().ok_or_else(missing)?;
        let stdout = child.stdout.take().ok_or_else(missing)?;
        let stderr = child.stderr.take().ok_or_else(missing)?;

        let (writer_tx, writer_rx) = mpsc::unbounded_channel();
        let (kill_tx, kill_rx) = mpsc::unbounded_channel();
        let (gone_flag, _) = watch::channel(false);
        let (exited, _) = watch::channel(false);
        let entry = Arc::new(ServerEntry {
            language: language.to_string(),
            root: root.to_string(),
            instance,
            status: StdMutex::new(Status {
                state: EntryState::Starting,
                unreported_start_error: None,
                stopping: false,
            }),
            rpc: StdMutex::new(Rpc {
                gone: None,
                pending: HashMap::new(),
            }),
            gone_flag,
            exited,
            writer: StdMutex::new(Some(writer_tx)),
            kill: kill_tx,
            next_id: AtomicI64::new(1),
            opened: StdMutex::new(HashMap::new()),
            stderr: Arc::new(StdMutex::new(Vec::new())),
            stops: Arc::clone(&self.stops),
            #[cfg(all(test, unix))]
            unreaped_at_group_kill: StdMutex::new(None),
        });

        let (stderr_eof_tx, stderr_eof_rx) = oneshot::channel();
        tokio::spawn(writer_loop(stdin, writer_rx));
        tokio::spawn(stderr_loop(
            stderr,
            Arc::clone(&entry.stderr),
            stderr_eof_tx,
        ));
        tokio::spawn(read_loop(Arc::clone(&entry), stdout));
        tokio::spawn(watch_process(
            Arc::clone(&entry),
            child,
            kill_rx,
            stderr_eof_rx,
        ));
        Ok(entry)
    }

    /// Run the `initialize` handshake in its own task, so it goes on when
    /// the caller gives up. Resolves with the start's outcome.
    fn start(
        &self,
        entry: Arc<ServerEntry>,
        profile: &LspServerProfile,
    ) -> watch::Receiver<OpenResult> {
        let root = entry.root.clone();
        let root_uri = Url::from_file_path(Path::new(&root))
            .map(|u| u.to_string())
            .unwrap_or_else(|_| format!("file://{}", root));
        let init_params = serde_json::json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "workspaceFolders": [
                { "uri": root_uri, "name": Path::new(&root).file_name().and_then(|s| s.to_str()).unwrap_or("workspace") }
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
        let limit = self.initialize_timeout;
        #[cfg(test)]
        let exit_before_ready_check = self.exit_before_ready_check;
        let (tx, rx) = watch::channel(None);
        tokio::spawn(async move {
            let init =
                tokio::time::timeout(limit, entry.request("initialize", init_params, None)).await;
            let result = match init {
                Err(_) => Err(LspClientError::Other(format!(
                    "Language server for {} did not answer initialize within {}ms. The next call starts it again.",
                    entry.language,
                    limit.as_millis()
                ))),
                Ok(Err(e)) => Err(e),
                Ok(Ok(_)) => entry
                    .notify("initialized", serde_json::json!({}), None)
                    .await,
            };
            #[cfg(test)]
            if result.is_ok() && exit_before_ready_check {
                entry.wait_exited().await;
            }
            // Decide under the status lock, with the liveness check. The
            // watcher marks `exited` before it takes this lock, so either
            // it sees `Ready` and marks the server crashed, or this sees
            // the exit: a dead server never stays ready.
            let result = match result {
                Ok(()) => {
                    let ready = {
                        let mut st = entry.status.lock().unwrap();
                        let ready = st.state == EntryState::Starting && entry.running();
                        if ready {
                            st.state = EntryState::Ready;
                        }
                        ready
                    };
                    if ready {
                        Ok(())
                    } else {
                        // A server that exited right after the handshake is
                        // not ready either.
                        Err(entry.wait_gone().await)
                    }
                }
                Err(e) => Err(e),
            };
            match &result {
                Ok(()) => {}
                Err(e) => {
                    {
                        let mut st = entry.status.lock().unwrap();
                        st.state = EntryState::Crashed;
                        st.unreported_start_error = Some(e.clone());
                    }
                    entry.retire(None);
                }
            }
            let _ = tx.send(Some(result));
        });
        rx
    }

    /// Where the server the handle names stands under its key.
    fn entry_for(&self, handle: &ServerHandle) -> Lookup {
        let key = Self::key(&handle.language, &handle.root);
        match self.servers.lock().unwrap().get(&key) {
            Some(Slot::Server(entry)) if entry.instance == handle.instance => {
                Lookup::Server(Arc::clone(entry))
            }
            // A concurrent call got a `starting` handle for this spawn.
            Some(Slot::Spawning(claim, _)) if *claim == handle.instance => Lookup::Spawning,
            _ => Lookup::Gone,
        }
    }

    /// Keep a server that a new one replaces under its key, for calls that
    /// still hold its handle. Bounded in count and in age.
    fn retire_instance(&self, entry: Arc<ServerEntry>) {
        let (keep, _) = self.retired_keep;
        let mut retired = self.retired.lock().unwrap();
        retired.push_back(Retired {
            at: tokio::time::Instant::now(),
            entry,
        });
        while retired.len() > keep {
            retired.pop_front();
        }
    }

    /// The error for a call whose server has been replaced since it got its
    /// handle, or is gone: the old server's own reason while it is kept,
    /// else a plain crash. Either way the tool reports `SERVER_CRASHED`, and
    /// the next call uses or starts the server now under the key.
    async fn replaced(&self, handle: &ServerHandle) -> LspClientError {
        let old = {
            let (_, keep_for) = self.retired_keep;
            let mut retired = self.retired.lock().unwrap();
            let now = tokio::time::Instant::now();
            while retired
                .front()
                .is_some_and(|r| now.duration_since(r.at) > keep_for)
            {
                retired.pop_front();
            }
            retired
                .iter()
                .find(|r| r.entry.instance == handle.instance)
                .map(|r| Arc::clone(&r.entry))
        };
        if let Some(old) = old {
            if let Some(reason) = old.gone_reason() {
                return reason;
            }
            // Its exit is reported within the stderr settle; bounded anyway.
            if let Ok(reason) = tokio::time::timeout(STOP_STEP, old.wait_gone()).await {
                return reason;
            }
        }
        LspClientError::Crashed(crash_message(
            format!(
                "Language server for {} stopped after this call got its handle.",
                handle.language
            ),
            "",
        ))
    }

    /// The entry for a call. A server that died, or lost a pipe, since the
    /// caller got its handle reports that, also once another server has
    /// replaced it under the same key.
    async fn ready_entry(&self, handle: &ServerHandle) -> Result<Arc<ServerEntry>, LspClientError> {
        let not_ready = |state: EntryState| {
            LspClientError::Other(format!(
                "Server for {} at {} is not ready (state={})",
                handle.language,
                handle.root,
                state.as_str()
            ))
        };
        let entry = match self.entry_for(handle) {
            Lookup::Server(entry) => entry,
            // Still spawning: as starting as the entry it becomes.
            Lookup::Spawning => return Err(not_ready(EntryState::Starting)),
            Lookup::Gone => return Err(self.replaced(handle).await),
        };
        if let Some(reason) = entry.gone_reason() {
            return Err(reason);
        }
        let state = entry.status.lock().unwrap().state;
        if state == EntryState::Crashed && !entry.running() {
            return Err(entry.wait_gone().await);
        }
        if state != EntryState::Ready {
            return Err(not_ready(state));
        }
        Ok(entry)
    }

    async fn locations_like(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
        method: &str,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        let entry = self.ready_entry(handle).await?;
        entry.did_open_if_needed(path, &cancel).await?;
        let mut params = serde_json::json!({
            "textDocument": { "uri": file_uri(path) },
            "position": lsp_pos(pos),
        });
        if method == "textDocument/references" {
            params["context"] = serde_json::json!({ "includeDeclaration": true });
        }
        let r = entry.request(method, params, Some(&cancel)).await?;
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

impl Default for SpawnLspClient {
    fn default() -> Self {
        Self::new()
    }
}

/// A client dropped without `close_session` still leaves no process
/// behind: each server gets SIGKILL. Its watcher then reaps it and the
/// background tasks end, which frees the entry.
impl Drop for SpawnLspClient {
    fn drop(&mut self) {
        let servers = match self.servers.get_mut() {
            Ok(servers) => servers,
            Err(poisoned) => poisoned.into_inner(),
        };
        for (_, slot) in servers.drain() {
            if let Slot::Server(entry) = slot {
                let _ = entry.kill.send(KillSignal::Kill);
            }
        }
    }
}

#[async_trait]
impl LspClient for SpawnLspClient {
    async fn ensure_server(
        &self,
        language: &str,
        root: &str,
        profile: &LspServerProfile,
        cancel: CancelSignal,
    ) -> Result<ServerHandle, LspClientError> {
        let key = Self::key(language, root);
        let starting = |instance: u64| ServerHandle {
            language: language.to_string(),
            root: root.to_string(),
            state: ServerState::Starting,
            instance,
        };
        // Claim the key under the lock, with a placeholder, so concurrent
        // first calls share one server. The spawn itself runs outside the
        // lock, so a slow exec on one key holds up no other key.
        let claim = {
            let mut servers = self.servers.lock().unwrap();
            match servers.get(&key) {
                Some(Slot::Spawning(claim, _)) => return Ok(starting(*claim)),
                Some(Slot::Server(entry)) => {
                    let entry = Arc::clone(entry);
                    let mut st = entry.status.lock().unwrap();
                    if st.state != EntryState::Crashed {
                        drop(st);
                        return Ok(entry.handle());
                    }
                    if *cancel.borrow() {
                        return Err(LspClientError::Aborted);
                    }
                    // A start that failed after its caller gave up: report
                    // it once; the call after this one starts a new server.
                    if let Some(reason) = st.unreported_start_error.take() {
                        drop(st);
                        servers.remove(&key);
                        return Err(reason);
                    }
                    drop(st);
                    if !*cancel.borrow() {
                        // A new server replaces it below. A call that still
                        // holds a handle to this one learns why it went.
                        self.retire_instance(entry);
                    }
                }
                None => {}
            }
            if *cancel.borrow() {
                return Err(LspClientError::Aborted);
            }
            let claim = self.next_spawn.fetch_add(1, Ordering::Relaxed);
            let (handled, handled_rx) = watch::channel(());
            servers.insert(key.clone(), Slot::Spawning(claim, handled_rx));
            (claim, handled)
        };
        let (claim, handled) = claim;
        let unclaim = Unclaim {
            servers: &self.servers,
            key: key.clone(),
            claim,
        };
        let spawned = self.spawn_server(language, root, profile, claim);
        let (entry, mut started) = {
            // Dropped at the end of this block, which tells a waiting
            // close_session that this spawn is handled.
            let _handled = handled;
            let mut servers = self.servers.lock().unwrap();
            let still_ours = matches!(servers.get(&key), Some(Slot::Spawning(c, _)) if *c == claim);
            match spawned {
                Ok(entry) if still_ours => {
                    servers.insert(key, Slot::Server(Arc::clone(&entry)));
                    let started = self.start(Arc::clone(&entry), profile);
                    (entry, started)
                }
                Ok(entry) => {
                    // The session closed while the spawn ran: stop this
                    // server instead of leaving it outside the map.
                    drop(servers);
                    entry.retire(None);
                    return Err(LspClientError::Other(format!(
                        "The session closed while the {} server was starting.",
                        language
                    )));
                }
                Err(e) => {
                    if still_ours {
                        servers.remove(&key);
                    }
                    return Err(e);
                }
            }
        };
        drop(unclaim);
        // An abort releases the caller only. The handshake goes on, bounded
        // by the initialize limit, and the next call finds the server
        // starting or ready, or is told why the start failed.
        let outcome = with_cancel(Some(&cancel), async {
            match started.wait_for(|v| v.is_some()).await {
                Ok(v) => v.clone().unwrap_or(Ok(())),
                Err(_) => Err(LspClientError::Other("the start was dropped".to_string())),
            }
        })
        .await?;
        match outcome {
            Ok(()) => Ok(entry.handle()),
            Err(e) => {
                // This caller got the start's own error: it is reported.
                entry.status.lock().unwrap().unreported_start_error = None;
                Err(e)
            }
        }
    }

    async fn hover(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Option<LspHoverResult>, LspClientError> {
        let entry = self.ready_entry(handle).await?;
        entry.did_open_if_needed(path, &cancel).await?;
        let params = serde_json::json!({
            "textDocument": { "uri": file_uri(path) },
            "position": lsp_pos(pos),
        });
        let r = entry
            .request("textDocument/hover", params, Some(&cancel))
            .await?;
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
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.locations_like(handle, path, pos, cancel, "textDocument/definition")
            .await
    }

    async fn references(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.locations_like(handle, path, pos, cancel, "textDocument/references")
            .await
    }

    async fn implementation(
        &self,
        handle: &ServerHandle,
        path: &str,
        pos: Position1,
        cancel: CancelSignal,
    ) -> Result<Vec<LspLocation>, LspClientError> {
        self.locations_like(handle, path, pos, cancel, "textDocument/implementation")
            .await
    }

    async fn document_symbol(
        &self,
        handle: &ServerHandle,
        path: &str,
        cancel: CancelSignal,
    ) -> Result<Vec<LspSymbolInfo>, LspClientError> {
        let entry = self.ready_entry(handle).await?;
        entry.did_open_if_needed(path, &cancel).await?;
        let params = serde_json::json!({
            "textDocument": { "uri": file_uri(path) },
        });
        let r = entry
            .request("textDocument/documentSymbol", params, Some(&cancel))
            .await?;
        let Some(arr) = r.as_array() else {
            return Ok(Vec::new());
        };
        if arr.is_empty() {
            return Ok(Vec::new());
        }
        if arr[0].get("location").is_some() {
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
    ) -> Result<Vec<LspSymbolInfo>, LspClientError> {
        let entry = self.ready_entry(handle).await?;
        let params = serde_json::json!({ "query": query });
        let r = entry
            .request("workspace/symbol", params, Some(&cancel))
            .await?;
        let Some(arr) = r.as_array() else {
            return Ok(Vec::new());
        };
        Ok(arr.iter().map(map_symbol_information).collect())
    }

    /// Stop every server, in parallel, and return once each has exited.
    async fn close_session(&self) {
        self.retired.lock().unwrap().clear();
        let mut entries: Vec<Arc<ServerEntry>> = Vec::new();
        let mut spawning: Vec<watch::Receiver<()>> = Vec::new();
        for (_, slot) in self.servers.lock().unwrap().drain() {
            match slot {
                Slot::Server(e) => entries.push(e),
                Slot::Spawning(_, handled) => spawning.push(handled),
            }
        }
        for entry in &entries {
            entry.begin_stop();
        }
        // A spawn in flight finds its placeholder gone and stops its
        // server. Wait until each such stop is begun, so the loop below
        // waits for it too: one stop step for all of them, as they run in
        // parallel.
        let deadline = tokio::time::Instant::now() + STOP_STEP;
        for mut handled in spawning {
            let _ = tokio::time::timeout_at(deadline, handled.changed()).await;
        }
        loop {
            let stops: Vec<JoinHandle<()>> = std::mem::take(&mut *self.stops.lock().unwrap());
            if stops.is_empty() {
                break;
            }
            for stop in stops {
                let _ = stop.await;
            }
        }
    }
}

/// Spawn-client tests against the fake server. They check processes with
/// pid files and `kill(pid, 0)`, so they run on every Unix, macOS included.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const FAKE_SERVER: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/lsp/test/fixtures/fake-lsp-server.mjs"
    );

    fn fake_profile(mode: &str, root: &str) -> LspServerProfile {
        LspServerProfile {
            language: "fake".to_string(),
            extensions: vec![".fake".to_string()],
            command: vec![
                "node".to_string(),
                FAKE_SERVER.to_string(),
                mode.to_string(),
                root.to_string(),
            ],
            root_patterns: None,
            initialization_options: None,
        }
    }

    fn spawns(root: &str) -> usize {
        std::fs::read_to_string(Path::new(root).join("spawns"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_exits_right_after_the_handshake_is_not_kept_ready() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // The server exits 100ms after `initialized`; the hook holds the
        // start between the handshake and the readiness check until it has.
        let profile = fake_profile("exit-after-initialized", &root);
        let mut client = SpawnLspClient::new();
        client.exit_before_ready_check = true;
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let first = client
            .ensure_server("fake", &root, &profile, cancel_rx.clone())
            .await;
        let e = first.expect_err("a server that exited must not be ready");
        assert!(e.to_string().contains("exited with code 0"), "{e}");
        // The next call starts a new server instead of reusing a dead one.
        let _ = client
            .ensure_server("fake", &root, &profile, cancel_rx)
            .await;
        assert_eq!(spawns(&root), 2);
        client.close_session().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn finished_stops_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let profile = fake_profile("silent-on-initialize", &root);
        let client = SpawnLspClient::with_options(SpawnLspClientOptions {
            initialize_timeout_ms: Some(100),
        });
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        for _ in 0..4 {
            // Each start misses the limit and its server is stopped.
            let _ = client
                .ensure_server("fake", &root, &profile, cancel_rx.clone())
                .await;
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        assert!(client.stops.lock().unwrap().len() <= 1);
        client.close_session().await;
    }

    #[test]
    fn file_uris_are_percent_decoded() {
        assert_eq!(
            file_uri_to_path("file:///tmp/a%20b/c%23d.ts"),
            "/tmp/a b/c#d.ts"
        );
        assert_eq!(file_uri_to_path("file:///tmp/plain.ts"), "/tmp/plain.ts");
        assert_eq!(
            file_uri_to_path("untitled:Untitled-1"),
            "untitled:Untitled-1"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_exit_write_is_bounded_when_a_queued_write_fills_the_pipe() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // The server stops reading its stdin when it reads `shutdown`, and
        // answers only once `reply-shutdown` exists.
        let profile = fake_profile("hold-shutdown-reply", &root);
        let client = SpawnLspClient::new();
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        client
            .ensure_server("fake", &root, &profile, cancel_rx)
            .await
            .unwrap();
        let entry = server_entry(&client, &root);
        // Build the filler first: a message larger than the pipe buffer, as
        // an abandoned didOpen would be.
        let body = serde_json::to_vec(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": "file:///big", "languageId": "fake", "version": 1, "text": "x".repeat(4 * 1024 * 1024) } },
        }))
        .unwrap();
        let mut filler = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        filler.extend_from_slice(&body);

        let exit_requested = {
            let e = Arc::clone(&entry);
            tokio::spawn(async move { e.request_exit().await })
        };
        // Order by events, not time: the server has read `shutdown`, then
        // the filler is queued, then the server may answer, so `exit` is
        // queued behind the filler.
        let got_shutdown = Path::new(&root).join("got-shutdown");
        wait_for_file(&got_shutdown).await;
        let (done, _written) = oneshot::channel();
        let queued = entry
            .writer
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .send(WriteJob {
                bytes: filler,
                done,
            });
        assert!(queued.is_ok());
        std::fs::write(Path::new(&root).join("reply-shutdown"), "").unwrap();

        let sent = tokio::time::timeout(Duration::from_secs(10), exit_requested)
            .await
            .expect("request_exit did not return")
            .unwrap();
        assert!(!sent, "`exit` cannot be written behind a blocked write");
        client.close_session().await;
    }

    fn server_entry(client: &SpawnLspClient, root: &str) -> Arc<ServerEntry> {
        match client
            .servers
            .lock()
            .unwrap()
            .get(&SpawnLspClient::key("fake", root))
        {
            Some(Slot::Server(entry)) => Arc::clone(entry),
            _ => panic!("no server for the key"),
        }
    }

    async fn wait_for_file(path: &Path) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{} never appeared",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// True while the process exists, a zombie not yet reaped included.
    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn signal(pid: i32, sig: libc::c_int) {
        // SAFETY: kill(2) on a process this test started.
        assert_eq!(unsafe { libc::kill(pid, sig) }, 0);
    }

    async fn gone_within(pid: i32, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        while alive(pid) {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
    }

    fn temp_root() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (dir, root)
    }

    fn fake_session(
        client: Arc<SpawnLspClient>,
        root: &str,
        mode: &str,
        timeout_ms: u64,
    ) -> crate::LspSessionConfig {
        let perms = harness_core::PermissionPolicy::new([root.to_string()]);
        let lsp_perms = crate::LspPermissionPolicy::new(perms).with_unsafe_bypass(true);
        let mut cfg = crate::LspSessionConfig::new(root.to_string(), lsp_perms, client);
        let mut servers = HashMap::new();
        servers.insert("fake".to_string(), fake_profile(mode, root));
        cfg.manifest = Some(crate::LspManifest { servers });
        cfg.default_timeout_ms = Some(timeout_ms);
        cfg
    }

    fn read_pid(root: &str, name: &str) -> i32 {
        std::fs::read_to_string(Path::new(root).join(name))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_slow_spawn_on_one_key_does_not_hold_up_another_key() {
        let slow_dir = tempfile::tempdir().unwrap();
        let fast_dir = tempfile::tempdir().unwrap();
        let slow_root = slow_dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let fast_root = fast_dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let began = Arc::new(tokio::sync::Semaphore::new(0));
        let mut client = SpawnLspClient::new();
        // The `slow` spawn blocks its thread for 6s, as an exec on a hung
        // mount would.
        client.slow_spawn = Some((
            "slow".to_string(),
            Duration::from_secs(6),
            Arc::clone(&began),
        ));
        let client = Arc::new(client);
        let slow = {
            let client = Arc::clone(&client);
            let mut profile = fake_profile("well-behaved", &slow_root);
            profile.language = "slow".to_string();
            let root = slow_root.clone();
            tokio::spawn(async move {
                let (_tx, rx) = watch::channel(false);
                client.ensure_server("slow", &root, &profile, rx).await
            })
        };
        began.acquire().await.unwrap().forget();
        let fast = {
            let client = Arc::clone(&client);
            let profile = fake_profile("well-behaved", &fast_root);
            let root = fast_root.clone();
            tokio::spawn(async move {
                let (_tx, rx) = watch::channel(false);
                client.ensure_server("fake", &root, &profile, rx).await
            })
        };
        let fast = tokio::time::timeout(Duration::from_secs(4), fast)
            .await
            .expect("another key waited for the slow spawn")
            .unwrap();
        assert_eq!(fast.unwrap().state, ServerState::Ready);
        assert!(!slow.is_finished(), "the slow spawn ended early");
        let _ = slow.await;
        client.close_session().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dropping_the_client_stops_the_server_and_its_children() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let client = SpawnLspClient::new();
        let (_tx, rx) = watch::channel(false);
        client
            .ensure_server(
                "fake",
                &root,
                &fake_profile("well-behaved-with-child", &root),
                rx,
            )
            .await
            .unwrap();
        let server = read_pid(&root, "pid");
        wait_for_file(&Path::new(&root).join("child-pid")).await;
        let child = read_pid(&root, "child-pid");
        drop(client);
        assert!(
            gone_within(server, Duration::from_millis(1_500)).await,
            "the server outlived its client"
        );
        assert!(
            gone_within(child, Duration::from_millis(1_500)).await,
            "the server's child outlived its client"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_graceful_exit_does_not_leave_the_server_s_children() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let client = SpawnLspClient::new();
        let (_tx, rx) = watch::channel(false);
        // Exits on `exit`; its child ignores SIGTERM and never exits.
        client
            .ensure_server(
                "fake",
                &root,
                &fake_profile("well-behaved-with-child", &root),
                rx,
            )
            .await
            .unwrap();
        wait_for_file(&Path::new(&root).join("child-pid")).await;
        let child = read_pid(&root, "child-pid");
        client.close_session().await;
        assert!(
            Path::new(&root).join("exit").exists(),
            "the server did not get `exit`"
        );
        assert!(
            gone_within(child, Duration::from_millis(1_000)).await,
            "the server's child outlived a graceful exit"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn close_session_waits_for_a_spawn_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let began = Arc::new(tokio::sync::Semaphore::new(0));
        let mut client = SpawnLspClient::new();
        // The spawn blocks its thread for 500ms before the exec.
        client.slow_spawn = Some((
            "fake".to_string(),
            Duration::from_millis(500),
            Arc::clone(&began),
        ));
        let client = Arc::new(client);
        let call = {
            let client = Arc::clone(&client);
            let profile = fake_profile("well-behaved", &root);
            let root = root.clone();
            tokio::spawn(async move {
                let (_tx, rx) = watch::channel(false);
                client.ensure_server("fake", &root, &profile, rx).await
            })
        };
        began.acquire().await.unwrap().forget();
        let closing = tokio::time::Instant::now();
        client.close_session().await;
        let took = closing.elapsed();
        // close_session returns only after the spawn it raced is stopped,
        // unless that takes a whole stop step, as only a starved machine
        // makes this one take: then it stops waiting, so a hung exec cannot
        // hold it.
        if took < STOP_STEP {
            let spawned = client.spawned.lock().unwrap().clone();
            assert_eq!(
                spawned.len(),
                1,
                "close_session returned before the spawn ended"
            );
            assert!(!alive(spawned[0] as i32), "a server outlived close_session");
        }
        assert!(call.await.unwrap().is_err());
        // Either way the spawn stops its server, and a close waits for it.
        client.close_session().await;
        let spawned = client.spawned.lock().unwrap().clone();
        assert_eq!(spawned.len(), 1);
        assert!(!alive(spawned[0] as i32), "a server outlived close_session");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn close_session_sends_sigterm_to_the_server_s_whole_group() {
        let (_dir, root) = temp_root();
        let client = Arc::new(SpawnLspClient::new());
        let (_tx, rx) = watch::channel(false);
        // The server ignores `exit` and SIGTERM; its child exits on SIGTERM.
        client
            .ensure_server(
                "fake",
                &root,
                &fake_profile("stubborn-with-sigterm-child", &root),
                rx,
            )
            .await
            .unwrap();
        let server = read_pid(&root, "pid");
        wait_for_file(&Path::new(&root).join("child-pid")).await;
        let child = read_pid(&root, "child-pid");
        client.close_session().await;
        // The server outlives the SIGTERM step, so it saw how its child
        // ended. Without a group signal the child would end only after the
        // server, from the kill after the exit.
        let ended = std::fs::read_to_string(Path::new(&root).join("child-exit"))
            .expect("the child did not end while the server lived");
        assert_eq!(ended, "SIGTERM");
        assert!(!alive(server), "the server is still running");
        assert!(
            gone_within(child, Duration::from_millis(1_000)).await,
            "the server's child is still running"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_final_kill_reaches_the_server_s_children() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let client = SpawnLspClient::new();
        let (_tx, rx) = watch::channel(false);
        // Ignores `exit` and SIGTERM, and so does its child.
        client
            .ensure_server(
                "fake",
                &root,
                &fake_profile("stubborn-with-child", &root),
                rx,
            )
            .await
            .unwrap();
        let server = read_pid(&root, "pid");
        wait_for_file(&Path::new(&root).join("child-pid")).await;
        let child = read_pid(&root, "child-pid");
        client.close_session().await;
        assert!(!alive(server), "the server is still running");
        assert!(
            gone_within(child, Duration::from_millis(1_000)).await,
            "the server's child is still running"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 6)]
    async fn close_session_bounds_all_spawns_in_flight_together() {
        let roots: Vec<_> = (0..3).map(|_| temp_root()).collect();
        let began = Arc::new(tokio::sync::Semaphore::new(0));
        let mut client = SpawnLspClient::new();
        // Each spawn blocks its thread for 6s, as an exec on a hung mount
        // would: three stop steps.
        client.slow_spawn = Some((
            "fake".to_string(),
            Duration::from_secs(6),
            Arc::clone(&began),
        ));
        let client = Arc::new(client);
        let calls: Vec<_> = roots
            .iter()
            .map(|(_, root)| {
                let client = Arc::clone(&client);
                let profile = fake_profile("well-behaved", root);
                let root = root.clone();
                tokio::spawn(async move {
                    let (_tx, rx) = watch::channel(false);
                    client.ensure_server("fake", &root, &profile, rx).await
                })
            })
            .collect();
        began.acquire_many(3).await.unwrap().forget();
        let closing = tokio::time::Instant::now();
        client.close_session().await;
        let took = closing.elapsed();
        // One stop step for all three, not one each (6s).
        assert!(
            took < Duration::from_secs(4),
            "close_session took {took:?} for three spawns in flight"
        );
        for call in calls {
            assert!(call.await.unwrap().is_err());
        }
        // The spawns that lost their slots stop their servers; this close
        // waits for those stops.
        client.close_session().await;
        let spawned = client.spawned.lock().unwrap().clone();
        assert_eq!(spawned.len(), 3);
        for pid in spawned {
            assert!(!alive(pid as i32), "a server outlived close_session");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_group_is_killed_before_the_server_is_reaped() {
        let (_dir, root) = temp_root();
        let client = SpawnLspClient::new();
        let (_tx, rx) = watch::channel(false);
        // Exits on `exit`; its child ignores SIGTERM and never exits.
        client
            .ensure_server(
                "fake",
                &root,
                &fake_profile("well-behaved-with-child", &root),
                rx,
            )
            .await
            .unwrap();
        let entry = server_entry(&client, &root);
        wait_for_file(&Path::new(&root).join("child-pid")).await;
        let child = read_pid(&root, "child-pid");
        client.close_session().await;
        assert_eq!(
            *entry.unreaped_at_group_kill.lock().unwrap(),
            Some(true),
            "the group was killed after the server was reaped, when its id may be taken"
        );
        assert!(
            gone_within(child, Duration::from_millis(1_000)).await,
            "the server's child is still running"
        );
    }

    #[test]
    fn a_runtime_dropped_without_close_session_kills_each_server_s_group() {
        let (_dir, root) = temp_root();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = runtime.block_on(async {
            let client = SpawnLspClient::new();
            let (_tx, rx) = watch::channel(false);
            client
                .ensure_server(
                    "fake",
                    &root,
                    &fake_profile("well-behaved-with-child", &root),
                    rx,
                )
                .await
                .unwrap();
            wait_for_file(&Path::new(&root).join("child-pid")).await;
            client
        });
        let child = read_pid(&root, "child-pid");
        // A host that keeps its client for the life of the process, in a
        // static, and exits without `close_session`.
        std::mem::forget(client);
        drop(runtime);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while alive(child) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(child), "the server's child outlived the runtime");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_spawn_that_panics_does_not_leave_its_key_starting() {
        let (_dir, root) = temp_root();
        let client = Arc::new(SpawnLspClient::new());
        client.panic_spawn.store(true, Ordering::SeqCst);
        let panicked = {
            let client = Arc::clone(&client);
            let profile = fake_profile("well-behaved", &root);
            let root = root.clone();
            tokio::spawn(async move {
                let (_tx, rx) = watch::channel(false);
                client.ensure_server("fake", &root, &profile, rx).await
            })
        };
        assert!(panicked.await.unwrap_err().is_panic());
        let (_tx, rx) = watch::channel(false);
        let next = client
            .ensure_server("fake", &root, &fake_profile("well-behaved", &root), rx)
            .await
            .unwrap();
        assert_eq!(
            next.state,
            ServerState::Ready,
            "the key stayed starting after the spawn panicked"
        );
        client.close_session().await;
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
                let (_dir, root) = temp_root();
                let file = Path::new(&root).join("a.fake");
                std::fs::write(&file, "x\n").unwrap();
                let file = file.to_string_lossy().into_owned();
                let client = Arc::new(SpawnLspClient::new());
                let session = Arc::new(fake_session(
                    Arc::clone(&client),
                    &root,
                    "well-behaved",
                    10_000,
                ));
                let barrier = Arc::new(tokio::sync::Barrier::new(tasks));
                let calls: Vec<_> = (0..tasks)
                    .map(|_| {
                        let (session, barrier, file) =
                            (Arc::clone(&session), Arc::clone(&barrier), file.clone());
                        tokio::spawn(async move {
                            barrier.wait().await;
                            let input = serde_json::json!({
                                "operation": "hover",
                                "path": file,
                                "line": 1,
                                "character": 1,
                            });
                            crate::lsp(input, &session).await
                        })
                    })
                    .collect();
                for call in calls {
                    let r = call.await.unwrap();
                    assert!(
                        matches!(
                            r,
                            crate::LspResult::Hover(_) | crate::LspResult::ServerStarting(_)
                        ),
                        "round {round}: {r:?}"
                    );
                }
                client.close_session().await;
                // The client's own record: every spawn, slow or not.
                let spawned = client.spawned.lock().unwrap().clone();
                assert_eq!(
                    spawned.len(),
                    1,
                    "round {round}: {} servers for one key",
                    spawned.len()
                );
                let running: Vec<u32> = spawned
                    .iter()
                    .copied()
                    .filter(|p| alive(*p as i32))
                    .collect();
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

    /// A ready server, then SIGKILL, then the moment the client has its
    /// reason. Returns the stale handle and the reason.
    async fn crashed_handle(client: &SpawnLspClient, root: &str) -> (ServerHandle, LspClientError) {
        let (_tx, rx) = watch::channel(false);
        let handle = client
            .ensure_server("fake", root, &fake_profile("well-behaved", root), rx)
            .await
            .unwrap();
        assert_eq!(handle.state, ServerState::Ready);
        let entry = server_entry(client, root);
        signal(read_pid(root, "pid"), libc::SIGKILL);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let reason = loop {
            if let Some(reason) = entry.gone_reason() {
                break reason;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the client never saw the exit"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        (handle, reason)
    }

    async fn hover_with(
        client: &SpawnLspClient,
        handle: &ServerHandle,
        root: &str,
    ) -> Result<(), LspClientError> {
        let file = Path::new(root).join("a.fake");
        std::fs::write(&file, "x\n").unwrap();
        let (_tx, rx) = watch::channel(false);
        client
            .hover(
                handle,
                &file.to_string_lossy(),
                Position1 {
                    line: 1,
                    character: 1,
                },
                rx,
            )
            .await
            .map(|_| ())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_handle_held_across_a_crash_and_a_starting_replacement_reports_the_crash() {
        let (_dir, root) = temp_root();
        let client = Arc::new(SpawnLspClient::new());
        let (stale, reason) = crashed_handle(&client, &root).await;
        assert!(reason.to_string().contains("killed by SIGKILL"), "{reason}");
        // Another call starts a replacement, which answers initialize after
        // 800ms, so it is still starting below.
        let replacement = {
            let client = Arc::clone(&client);
            let root = root.clone();
            tokio::spawn(async move {
                let (_tx, rx) = watch::channel(false);
                client
                    .ensure_server("fake", &root, &fake_profile("slow-initialize", &root), rx)
                    .await
            })
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !matches!(
            client.servers.lock().unwrap().get(&SpawnLspClient::key("fake", &root)),
            Some(Slot::Server(e)) if e.instance != stale.instance
        ) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "no replacement started"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let r = hover_with(&client, &stale, &root).await;
        assert_eq!(
            r,
            Err(reason),
            "the stale handle did not report its own server's crash"
        );
        assert_eq!(
            replacement.await.unwrap().unwrap().state,
            ServerState::Ready
        );
        client.close_session().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_handle_held_while_a_replacement_spawns_reports_the_crash() {
        let (_dir, root) = temp_root();
        let began = Arc::new(tokio::sync::Semaphore::new(0));
        let mut client = SpawnLspClient::new();
        // Every spawn blocks its thread for 1s, so the replacement's
        // placeholder is in the map for that long.
        client.slow_spawn = Some((
            "fake".to_string(),
            Duration::from_secs(1),
            Arc::clone(&began),
        ));
        let client = Arc::new(client);
        let (stale, reason) = crashed_handle(&client, &root).await;
        began.acquire().await.unwrap().forget();
        let replacement = {
            let client = Arc::clone(&client);
            let root = root.clone();
            tokio::spawn(async move {
                let (_tx, rx) = watch::channel(false);
                client
                    .ensure_server("fake", &root, &fake_profile("well-behaved", &root), rx)
                    .await
            })
        };
        began.acquire().await.unwrap().forget();
        assert!(matches!(
            client
                .servers
                .lock()
                .unwrap()
                .get(&SpawnLspClient::key("fake", &root)),
            Some(Slot::Spawning(..))
        ));
        let r = hover_with(&client, &stale, &root).await;
        assert_eq!(
            r,
            Err(reason),
            "a call during the replacement's spawn got another error"
        );
        assert!(replacement.await.unwrap().is_ok());
        client.close_session().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_starting_handle_for_a_spawn_in_flight_is_not_ready_rather_than_crashed() {
        let (_dir, root) = temp_root();
        let began = Arc::new(tokio::sync::Semaphore::new(0));
        let mut client = SpawnLspClient::new();
        // The spawn blocks its thread for 1s; then the server answers
        // initialize 800ms after it reads it.
        client.slow_spawn = Some((
            "fake".to_string(),
            Duration::from_secs(1),
            Arc::clone(&began),
        ));
        let client = Arc::new(client);
        let first = {
            let client = Arc::clone(&client);
            let root = root.clone();
            tokio::spawn(async move {
                let (_tx, rx) = watch::channel(false);
                client
                    .ensure_server("fake", &root, &fake_profile("slow-initialize", &root), rx)
                    .await
            })
        };
        began.acquire().await.unwrap().forget();
        // A second call finds the placeholder and gets a `starting` handle.
        let (_tx, rx) = watch::channel(false);
        let starting = client
            .ensure_server("fake", &root, &fake_profile("slow-initialize", &root), rx)
            .await
            .unwrap();
        assert_eq!(starting.state, ServerState::Starting);
        let key = SpawnLspClient::key("fake", &root);
        assert!(matches!(
            client.servers.lock().unwrap().get(&key),
            Some(Slot::Spawning(claim, _)) if *claim == starting.instance
        ));
        let not_ready = Err(LspClientError::Other(format!(
            "Server for fake at {root} is not ready (state=starting)"
        )));
        assert_eq!(
            hover_with(&client, &starting, &root).await,
            not_ready,
            "during the spawn"
        );
        // The spawn is done and the server is starting: the same answer.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !matches!(
            client.servers.lock().unwrap().get(&key),
            Some(Slot::Server(e)) if e.instance == starting.instance
        ) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the spawn never ended"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            hover_with(&client, &starting, &root).await,
            not_ready,
            "after the spawn"
        );
        assert_eq!(first.await.unwrap().unwrap().state, ServerState::Ready);
        client.close_session().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_handle_held_across_a_ready_replacement_does_not_use_it() {
        let (_dir, root) = temp_root();
        let client = SpawnLspClient::new();
        let (stale, reason) = crashed_handle(&client, &root).await;
        let (_tx, rx) = watch::channel(false);
        let fresh = client
            .ensure_server("fake", &root, &fake_profile("well-behaved", &root), rx)
            .await
            .unwrap();
        assert_eq!(fresh.state, ServerState::Ready);
        assert_ne!(fresh.instance, stale.instance);
        // The stale call saw its server die; it does not run on the new one.
        assert_eq!(hover_with(&client, &stale, &root).await, Err(reason));
        assert_eq!(hover_with(&client, &fresh, &root).await, Ok(()));
        client.close_session().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_replaced_server_s_reason_is_kept_for_a_bounded_time_and_count() {
        let generic = |r: Result<(), LspClientError>| match r {
            Err(LspClientError::Crashed(m)) => m.contains("stopped after this call got its handle"),
            _ => false,
        };
        // Count: only the newest replaced server is kept.
        let (_dir, root) = temp_root();
        let mut client = SpawnLspClient::new();
        client.retired_keep = (1, Duration::from_secs(60));
        let (first, _) = crashed_handle(&client, &root).await;
        let (second, second_reason) = crashed_handle(&client, &root).await;
        let (_tx, rx) = watch::channel(false);
        client
            .ensure_server("fake", &root, &fake_profile("well-behaved", &root), rx)
            .await
            .unwrap();
        assert_eq!(
            hover_with(&client, &second, &root).await,
            Err(second_reason)
        );
        let r = hover_with(&client, &first, &root).await;
        assert!(
            generic(r.clone()),
            "an old reason outlived the count bound: {r:?}"
        );
        client.close_session().await;

        // Age: a reason older than the bound is dropped.
        let (_dir, root) = temp_root();
        let mut client = SpawnLspClient::new();
        client.retired_keep = (32, Duration::from_millis(100));
        let (stale, _) = crashed_handle(&client, &root).await;
        let (_tx, rx) = watch::channel(false);
        client
            .ensure_server("fake", &root, &fake_profile("well-behaved", &root), rx)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let r = hover_with(&client, &stale, &root).await;
        assert!(generic(r.clone()), "a reason outlived the age bound: {r:?}");
        client.close_session().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stopped_server_is_not_taken_for_an_exited_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let profile = fake_profile("well-behaved-with-child", &root);
        let client = SpawnLspClient::new();
        let (_tx, rx) = watch::channel(false);
        client
            .ensure_server("fake", &root, &profile, rx)
            .await
            .unwrap();
        let entry = server_entry(&client, &root);
        let server = read_pid(&root, "pid");
        wait_for_file(&Path::new(&root).join("child-pid")).await;
        let child = read_pid(&root, "child-pid");
        signal(server, libc::SIGSTOP);
        // A watcher that takes the stop for an exit kills the group at once.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            entry.running() && alive(server) && alive(child),
            "a stopped server was taken for an exited one"
        );
        signal(server, libc::SIGCONT);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            entry.running() && alive(server) && alive(child),
            "a continued server was taken for an exited one"
        );
        client.close_session().await;
        assert!(
            Path::new(&root).join("exit").exists(),
            "the server did not get `exit`"
        );
        assert!(!alive(server), "the server is still running");
    }
}
