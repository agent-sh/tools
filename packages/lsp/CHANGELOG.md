# @agent-sh/harness-lsp

## 0.10.0

### Minor Changes

- 8336c55: A server handle now names one server instance. An operation whose server died after the call got its handle, and was replaced by another call under the same language and root, no longer fails with `IO_ERROR` "not ready (state=starting)" or runs on the replacement: it gets `SERVER_CRASHED` with the old server's own reason. The client keeps the reasons of replaced servers for the 60s session backstop, at most 32 of them; past that, the call gets `SERVER_CRASHED` saying the server stopped after the call got its handle.

  Breaking: `ServerHandle` has a new required field, `instance`, set by the client that made the handle. An `LspClient` adapter that builds handles must set it; one that never replaces a server may use a fixed value.

- 6ac8240: On POSIX each language server now runs in its own process group. SIGTERM and SIGKILL go to the whole group, and once a server has exited, a clean `exit` included, the client kills what is left of its group, so a server's children no longer outlive it. A helper that a server means to keep running has to start its own process group or session. A server no longer gets a Ctrl-C from the host's terminal: call `closeSession()` before the host exits, on SIGINT and SIGTERM too. A host that exits without it still takes each live server's group: while any client has a live server, one `process` exit handler, shared by every client, sends SIGKILL to each live server's group; it is removed once the last live server has exited. The library installs no SIGINT or SIGTERM handler.
- 339f9c0: Report a language server that exits instead of hanging on it. A request in flight when the server process exits now rejects at once with `LspServerExitedError`, which carries the exit code or signal and the last 4 KB of the server's stderr, and the `lsp` tool returns `SERVER_CRASHED` for that call. `ensureServer` rejects when the server exits, fails to spawn, breaks a pipe or answers `initialize` with an error during startup, and `initialize` is bounded by `DEFAULT_INITIALIZE_TIMEOUT_MS`, the 60s session backstop, which outlasts the 30s call budget (`initializeTimeoutMs` on `createSpawnLspClient` overrides it). The client now drains the server's stderr, so a server that writes a lot of it can no longer block. A server whose stdin breaks after startup is marked crashed and stopped, so the next call starts a new one instead of reusing a server that cannot be reached. A server whose stdout closes while it stays alive is retired the same way after a 2s grace. The call that finds a broken pipe now gets `SERVER_CRASHED` (`LspServerCrashedError`, the new base class of `LspServerExitedError`). `ensureServer` takes the call's signal, so the `lsp` tool's timeout covers a slow start; the server keeps starting and the next call gets `server_starting`. A start that fails after its call gave up is reported once to the next call as `SERVER_NOT_AVAILABLE`, with the exit code or signal and the stderr tail, or with the missed `initialize` bound. A call cancelled through the session signal now says so, and one whose signal is already aborted starts no server.

  Breaking: `ServerHandle.state` no longer includes `crashed`, which `ensureServer` never returned. Code that compares the state with `"crashed"`, or an `LspClient` adapter that returns it, no longer compiles; an adapter should throw `LspServerCrashedError` instead.

### Patch Changes

- 50a93c3: Stop language servers without racing their exit. `closeSession` now waits for the `exit` notification to be written before it signals the server, lets the server exit on its own, and only then falls back to SIGTERM and SIGKILL. Every step is bounded, including the `exit` write. It returns once every server has exited. It no longer hangs when a server dies before answering `shutdown`, and a broken stdin during shutdown no longer surfaces as an unhandled `EPIPE` or `ERR_STREAM_DESTROYED`. The `initialized` and `textDocument/didOpen` writes are awaited, so a broken pipe in a live session fails the call that caused it. The `didOpen` wait runs under the operation's signal, so its timeout still holds, and concurrent operations on one file share a single `didOpen`. An operation whose signal is already aborted sends nothing.
- 54140d3: A start that fails after its call gave up is reported to the next call even when the server exits in the same event-loop turn as that call. Until the start has failed, the server counts as starting, so no call starts a second server in between and loses the first one's reason. Start failures now read "Failed to start" instead of "Failed to spawn", since the server may have spawned and then exited or missed the `initialize` bound.

## 0.9.2

### Patch Changes

- 73293c4: Protect generated logs, spill files and metadata with private exclusive creation. Read background output through one file descriptor and parse search markup without repeated regular-expression backtracking. Support JSON-RPC 10's Node export and update dependencies while retaining Pi 1.3 host compatibility.
- Updated dependencies [73293c4]
  - @agent-sh/harness-core@0.9.2

## 0.9.1

### Patch Changes

- Publish the current Valibot ^1.5.0 dependency manifests. The previous versions of these four packages still install older vulnerable Valibot releases; the source and workspace tests already use 1.5.0. Dependent harness packages receive patch updates so fresh installs use the validated dependency graph.
- Updated dependencies
  - @agent-sh/harness-core@0.9.1

## 0.2.0

### Minor Changes

- 6dbe9b0: Initial public release.

  Nine standalone tools plus an umbrella, each with a full cross-language design spec, per-tool permission model, fail-closed hooks, and discriminated-union result shapes. Matching Rust ports ship under `crates/` and are validated against real LLM traces via the `packages/harness-e2e` harness.

  Included in this release:

  - `@agent-sh/harness-core` — shared types, errors, permissions, operation adapters
  - `@agent-sh/harness-read` — safe bounded file reading
  - `@agent-sh/harness-write` — atomic write + edit + multiedit with read-before-edit ledger
  - `@agent-sh/harness-grep` — ripgrep-backed search with discriminated output_mode
  - `@agent-sh/harness-glob` — file discovery by pattern
  - `@agent-sh/harness-bash` — shell with cwd-carry, timeouts, background jobs
  - `@agent-sh/harness-webfetch` — HTTP with SSRF defense and readability+markdown extraction
  - `@agent-sh/harness-lsp` — language-server operations with 1-indexed positions
  - `@agent-sh/harness-skill` — [Agent Skills](https://agentskills.io) activation
  - `@agent-sh/harness-tools` — umbrella re-export of every tool

### Patch Changes

- Updated dependencies [6dbe9b0]
  - @agent-sh/harness-core@0.2.0
