# Bash Tool — Cross-Language Design Spec

**Status**: Draft v1 — 2026-04-21
**Implementations**: TypeScript (`@agent-sh/harness-bash`), Rust (pending)
**Scope**: Language-neutral contract. Implementation files (`packages/bash/` for TS, `crates/bash/` for Rust) must conform.

This spec is the source of truth. Implementation-specific ergonomics are allowed; public semantics are not.

Prior art surveyed: Claude Code `Bash`, Codex CLI `shell`, OpenCode `bash`, Cline `execute_command`, Continue `runTerminalCommand`, Gemini CLI `run_shell_command`, OpenHands `CmdRunAction`, Cursor terminal, LangChain `ShellTool`, AutoGen `LocalCommandLineCodeExecutor`, E2B Code Interpreter, Bedrock AgentCore. See `agent-knowledge/exec-tool-design-across-harnesses.md` for the 12-dimensional design-space analysis that informed the decisions below.

---

## 1. Purpose

Expose shell command execution to an **autonomous** LLM as a structured tool. The model should be able to:

1. Run a shell command with clear stdout/stderr/exit-code feedback.
2. Set a working directory that carries over across calls (within the workspace).
3. Launch long-running commands in the background and poll their output later.
4. Invoke other interpreters (`python -c`, `node -e`, `uv run`, `deno eval`) via the same tool — no separate Python/JS tools.

Enforce at the tool layer every invariant that cannot be trusted to the model:

- Command execution routed through a **permission hook** that evaluates allow/deny patterns (no `ask` — this is autonomous).
- **Workspace-scoped** default cwd with cwd-reset on escape attempts (Claude Code pattern).
- **Inactivity timeout** + **wall-clock backstop** + **output byte cap** so runaway commands can't wedge the session or flood context.
- **Discriminated error surface** so the model can tell `timeout` from `nonzero_exit` from `denied` structurally.
- A **pluggable executor** interface so core ships with a local subprocess runner but adapter packages (`@agent-sh/bash-docker`, `-firejail`, `-e2b`) can substitute.

Non-goals for v1: interactive command handling (stdin feeds, Y/n prompts, pagers), persistent env vars across calls, multi-command shell sessions (tmux-style), Jupyter kernel persistence, PowerShell, Windows CMD.

---

## 2. Input contract

```text
{
  command:         string      // required, the shell command to run
  cwd?:            string      // optional, default: session cwd (+ carried-over cd)
  timeout_ms?:     int ≥ 100   // optional inactivity timeout; default 60000
  description?:    string      // optional, one-line human-readable "why"
  background?:     bool        // optional, default false; run as a tracked job
  env?:            Record<string, string>  // optional, merged with session env
}
```

### Deliberate omissions

- **No `shell`/`interpreter` selector.** The model invokes other languages via the command itself (`python -c`, `node -e`, `deno eval`). A `lang` discriminator has been measured to cost model-invocation quality (see exec-research §Q-B). A harness that wants a pure Python REPL can ship one separately.
- **No `stdin` / interactive handling.** V1 refuses interactive commands via description guidance; a future v2 may add a `StdinFeed` companion tool. See §13 Open questions.
- **No `sandbox_mode` / `network` per-call flags.** Those are session-config / adapter-level decisions, not things the model picks. The permission hook sees the command and can route by pattern (`Bash(npm install:*)` → allow with network; `Bash(curl:*)` → deny).
- **No `capture_stderr` toggle.** Always captured, always returned in the structured result. Stderr-to-stdout merging via `2>&1` is the model's job inside the command.
- **No `user` / `group` execution identity.** Always runs as the harness user. Privilege escalation is a sandbox concern, not a tool concern.
- **No `shell_binary` override.** Core uses the bash binary with `-c <command>` on Unix. Windows is deferred (§13).

### Parameter validation

- `command` empty → `INVALID_PARAM`: "command is required".
- `command` length > `MAX_COMMAND_LENGTH` (16 KB) → `INVALID_PARAM`.
- `cwd` not absolute → resolve against session cwd (same normalization as other tools).
- `timeout_ms < 100` → `INVALID_PARAM`: "timeout_ms must be at least 100 ms".
- `background: true` with `timeout_ms` → `INVALID_PARAM`: timeouts don't apply to backgrounded jobs; they have their own lifecycle.
- `env` contains a key the session marks sensitive (e.g. `AWS_*`, `BEDROCK_*`, `GITHUB_TOKEN`) → `INVALID_PARAM`: "env may not set sensitive-prefix variable X".

### 2.1 Known-alias pushback

Mirrors the pattern shipped in `@agent-sh/harness-grep` §2.1 and `@agent-sh/harness-glob` §2.1. Reject common typos with a targeted redirect instead of a generic "Unknown key".

Required alias set (minimum):

- `cmd`, `shell_command`, `script`, `run` → `command`
- `directory`, `dir`, `path`, `working_directory` → `cwd`
- `timeout`, `time_limit`, `timeout_seconds` → `timeout_ms` (with unit-conversion note)
- `env_vars`, `environment` → `env`
- `lang`, `language`, `interpreter`, `runtime` → drop with note pointing at `python -c` / `node -e`
- `stdin`, `input` → drop with note "interactive stdin not supported in v1"
- `sandbox`, `sandbox_mode`, `permissions`, `network`, `network_access` → drop with note pointing at session config
- `shell`, `shell_binary` → drop with note pointing at session config

### Command guidance (lives in the tool description, not the schema)

Tool description must call out:

> Runs a single shell command in a bash subprocess. `cd` carries over to subsequent calls if it stays inside the workspace; otherwise the cwd is reset. Environment variables do NOT persist across calls — set them inline (`FOO=bar some-cmd`) or via `env`.
>
> **Language-specific one-liners** are the way to run non-shell code: `python -c "print(2+2)"`, `node -e "console.log(2+2)"`, `deno eval "console.log(2+2)"`. For multi-line scripts, write a temp file with the write tool and invoke the interpreter on it.
>
> **URL/page fetching.** For page content or HTML, prefer `webfetch` over `bash` + `curl`/`wget`: WebFetch runs cleaned HTML extraction by default and returns bounded spill previews. Use `curl`/`wget` in Bash only when you need raw source bytes, headers, downloads, or shell-specific HTTP behavior.
>
> **Long-running processes** (servers, watchers) must use `background: true`. The tool returns a job ID; poll output with `bash_output(job_id)`. Do not leave a foreground command running past the 5-minute wall-clock backstop.
>
> **Large output.** Stdout/stderr are capped to a head+tail preview and spilled to a local log file. If capped output came from `curl`/`wget`, switch to `webfetch` for cleaned page content unless raw bytes are required.
>
> **No interactive commands.** Anything that needs stdin (pagers, Y/n prompts, REPLs, `git commit` without `-m`) will hang until the inactivity timeout. Use flags to make them non-interactive (`--yes`, `-y`, `--no-pager`) or pipe `echo "y" |` in front.

Research backing: every harness that skipped the "cwd carries over" part measurably paid for it in re-invocation of `cd` (see exec-research §Claude Code). Every harness that allowed interactive commands without flagging saw 5-10% of traces hang on stdin.

---

## 3. Output contract

Output is a discriminated union by `kind`.

### 3.1 `kind: "ok"` (foreground, exit 0)

```text
<command>{command}</command>
<exit_code>0</exit_code>
<stdout>
{stdout bytes up to cap}
</stdout>
<stderr>
{stderr bytes up to cap}
</stderr>
{continuation_hint}
```

- Both `stdout` and `stderr` are captured independently.
- Trailing newline normalized (UTF-8 decode, strip trailing `\n`).
- Order preserved within each stream; stdout/stderr interleave is not preserved (they're captured as two pipes).
- Continuation hint:
  - Fully captured: `(Command completed in {N}ms. exit=0.)`
  - Capped (see §4): `(Output capped; showing head+tail preview. Full log: {path}. Read it with pagination if you need the middle.)`
  - Capped URL fetch output adds: `This looks like curl/wget output; use webfetch for cleaned HTML/page content, and reserve bash for raw source or downloads.`

### 3.2 `kind: "nonzero_exit"`

Same shape as `ok` but with the non-zero `exit_code`. Still a success from the tool's perspective — the command ran, the model gets to decide what to do with a failure.

```text
<command>{command}</command>
<exit_code>{nonzero}</exit_code>
<stdout>...</stdout>
<stderr>...</stderr>
(Command exited nonzero in {N}ms. Exit code: {code}.)
```

### 3.3 `kind: "timeout"`

Inactivity timeout or wall-clock backstop expired. Partial output returned.

```text
<command>{command}</command>
<stdout>...</stdout>
<stderr>...</stderr>
(Command hit {reason} after {N}ms. {partial_bytes} bytes captured. Kill signal: SIGTERM then SIGKILL. If the command is long-running, retry with background: true.)
```

`reason` is one of `"inactivity timeout"`, `"wall-clock backstop"`.

### 3.4 `kind: "background_started"`

`background: true` accepted; job launched.

```text
<command>{command}</command>
<job_id>{opaque-string}</job_id>
(Background job started. Poll output with bash_output(job_id). Kill with bash_kill(job_id).)
```

The job_id is stable across calls, unique per session. The session tracks jobs; when session closes, all jobs are SIGTERM'd. See §7.

### 3.5 `kind: "error"`

Structured errors, not thrown. Same format as other tools (`formatToolError` → `Error [CODE]: <message>`).

| `code` | When |
|---|---|
| `INVALID_PARAM` | Bad schema (empty command, alias pushback, oversize). |
| `PERMISSION_DENIED` | Hook returned `deny`. |
| `TIMEOUT` | Command hit a deadline AND no partial output captured (use `kind: "timeout"` when there is partial output). |
| `KILLED` | External signal killed the process before exit. |
| `IO_ERROR` | Process spawn failed, pipe broke, stat error on cwd. |
| `OUTSIDE_WORKSPACE` | Resolved `cwd` is outside all workspace roots and no hook. |
| `SENSITIVE` | `cwd` matches sensitive-pattern deny list and no hook. |
| `INTERACTIVE_DETECTED` | Heuristic: process has been silent on stdout/stderr for N seconds AND the command is a known interactive (pager, `git commit` without `-m`, etc.). See §6. |

Error messages echo the command (truncated to 200 chars) back so the model can see what it sent.

---

## 4. Size and shape bounds

All caps apply together. Hit whichever first.

Generated spill files, background output and job metadata use mode 0600. Their directories must be real directories owned by the current user and not writable or replaceable by other users. Default paths are `{tmpdir}/agent-sh-bash-{uid}/logs` and `{tmpdir}/agent-sh-bash-{uid}/spill` (Windows uses the encoded username). These per-user paths stay stable across executor restarts and do not require a writable home. Foreground commands create storage only if output spills. Safe job IDs from the previous `{tmpdir}/agent-sh-bash-logs` directory remain readable; unsafe legacy state is refused. An explicit safe `logDir` retains an existing deployment's location. Output pagination reads size and bytes through the same open file descriptor. Storage errors return `IO_ERROR` and stop the command.

| Constant | Default | Override |
|---|---|---|
| `DEFAULT_INACTIVITY_TIMEOUT_MS` | 60_000 (60 s) | per-call `timeout_ms` |
| `DEFAULT_WALLCLOCK_BACKSTOP_MS` | 300_000 (5 min) | session config |
| `MAX_COMMAND_LENGTH` | 16_384 (16 KB) | session config |
| `MAX_OUTPUT_BYTES_INLINE` | 30_720 (30 KB per stream) | session config |
| `MAX_OUTPUT_BYTES_FILE` | 10 MB (streamed to temp file) | session config |
| `BACKGROUND_MAX_JOBS` | 16 concurrent | session config |

### Timeout semantics

- **Inactivity timeout** is the primary deadline. Any byte written to stdout or stderr resets the timer. Commands that stream output (pytest, build tools) survive indefinitely. Idle commands (waiting on stdin, stuck syscall) die at `timeout_ms`.
- **Wall-clock backstop** is always 5 minutes regardless of activity. Nothing runs longer than that in the foreground — if the model wants it longer, it uses `background: true`.
- On timeout the process gets SIGTERM, then SIGKILL 5 seconds later if it hasn't exited. The tool waits for the SIGKILL confirmation before returning so the caller never sees half-exited state.

### Output cap + stream-to-file on overflow

When per-stream output exceeds `MAX_OUTPUT_BYTES_INLINE` (30 KB):

1. Stop buffering in-memory, write future bytes to a temp file `~/.agent-sh/bash-logs/{session}/{job_id}.out` (and `.err`).
2. The inline result contains the first 15 KB + last 15 KB of the stream (head + tail pattern); the middle is elided with a `... (N bytes omitted; full log at {path}) ...` marker.
3. The continuation hint includes the absolute path so the model can Read it with pagination if it needs the middle.

When total (stdout + stderr) exceeds `MAX_OUTPUT_BYTES_FILE` (10 MB): stop writing to file, append a `[log truncated at 10 MB]` marker, and return `IO_ERROR` with `kind: "error"` + the (truncated) stream-to-file path.

Rationale: the head+tail pattern is the quality research move from exec-design §Output cap. Models typically need either the beginning (setup/version output) or the end (error details) — the middle rarely matters. Exposing the full log as a file gives recovery for cases where it does.

---

## 5. Execution engine

The engine is abstracted so core ships with a simple local subprocess runner and adapter packages can substitute.

```text
interface BashExecutor {
  exec(input: {
    command: string;            // already the full shell string
    cwd: string;                // resolved absolute path
    env: Record<string, string>; // merged session + call env
    signal: AbortSignal;
    onStdout: (chunk: Uint8Array) => void;  // streaming
    onStderr: (chunk: Uint8Array) => void;
  }): Promise<{ exitCode: number | null; killed: boolean; signal: string | null }>;

  // Background job API — optional. If the executor doesn't implement this,
  // background:true calls return INVALID_PARAM "background not supported".
  spawnBackground?(input: {
    command: string;
    cwd: string;
    env: Record<string, string>;
  }): Promise<{ jobId: string }>;

  readBackground?(jobId: string, opts: { since_byte?: number }): Promise<{
    stdout: string;
    stderr: string;
    running: boolean;
    exitCode: number | null;
    totalBytesStdout: number;
    totalBytesStderr: number;
  }>;

  killBackground?(jobId: string, signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}
```

### Default implementation (core)

- Wraps Node's `child_process` via the safe `spawn` entry point — NEVER the string-based shell-eval form. The `command` string goes as a single argument to the bash binary, not interpolated into the harness's own subprocess args.
- Arguments form: invoke the bash binary with `-c` and the literal `command` string as its next argument. Node's `spawn` passes these as a `string[]` — no shell interpolation at the Node layer; all shell parsing happens inside the child bash.
- No sandboxing. Trusts the permission hook to gate.
- Background jobs live in-process with their streams piped to temp files; the child process is parented to the Node process and SIGTERM'd on session close.

### Adapter packages (future)

- `@agent-sh/bash-docker` — per-call `docker run --rm -v {workspace}:/workspace -w /workspace {image}`.
- `@agent-sh/bash-firejail` — wrap in `firejail --quiet --net=none --private-tmp`.
- `@agent-sh/bash-e2b` — proxy to an E2B Firecracker microVM over their SDK.

Each adapter implements the same `BashExecutor` interface. The harness picks one via `session.executor`. Core never imports them — they're peer dependencies of the harness that chooses them.

### Fail-closed default when hook is absent

If the session has **no** permission hook AND no executor has been explicitly wired, the default executor refuses to run with `PERMISSION_DENIED`: "bash tool has no permission hook configured; refusing to execute untrusted commands. Wire a hook or provide an executor adapter that enforces isolation." This matches the autonomous-agent posture — never accidentally run unvetted commands.

---

## 6. Workspace, permissions, and the cwd-carry semantics

Reuses the same fence used by Read, Grep, Glob, Write.

### 6.1 Workspace roots

Same as Grep §6.1. Resolved `cwd` must be inside a configured root (or match an `additionalDirectories` entry). If outside and no hook is wired, return `OUTSIDE_WORKSPACE`.

### 6.2 cwd-carry (Claude Code's pattern)

Sessions track a `logicalCwd`:

- Initialized to `session.cwd`.
- Before each `command` executes, the effective cwd is the call's `cwd` param if provided, else `logicalCwd`.
- The tool does NOT auto-parse `cd` from arbitrary commands. Instead, the logical cwd changes only when the model issues a **top-level `cd <path>` call** — grammar: single `cd` invocation, one path argument, no `&&` / `||` / `;` / pipelines / quoting tricks. On success (exit 0), update `logicalCwd` if the new path resolves inside the workspace; otherwise append `(cwd unchanged: escape to '<path>' blocked)` to the result and leave `logicalCwd` as-is.

Rationale: full shell-wrapping to extract `$PWD` is brittle and adds latency. The simpler "detect `cd` at the top level, ignore it inside pipelines" rule is cheap and covers 95% of the model's intent. Research backing: Claude Code uses a similar top-level parser and reports the `(cwd unchanged)` message when escape happens.

### 6.3 Permission hook

Extends the common hook signature with bash-specific fields:

```text
hook({
  tool: "bash",
  action: "exec",
  path: cwd,
  always_patterns: [`Bash(${commandHead}:*)`],  // e.g. Bash(git:*)
  metadata: {
    command,                  // full command string
    cwd,                      // resolved absolute
    background,               // bool
    timeout_ms,               // effective
    env_keys: Object.keys(env), // env values NOT sent to the hook
    network_required: null,    // unknown at tool layer; adapter may fill
  }
}) → "allow" | "allow_once" | "deny"
```

Key invariants:

- **No `ask` response.** Autonomous policy: the hook evaluates pattern rules and returns allow or deny. If the hook returns `ask`, treat as `deny` and surface a `PERMISSION_DENIED` error with a hint pointing at the hook config.
- **Env values are never sent to the hook.** Keys only. Reason: secrets leak to logs.
- **Pattern hints in `always_patterns`** follow Claude Code convention: the first whitespace-separated token is the "command head" (`git`, `npm`, `python`). Hook implementations typically match on these.

### 6.4 Fail-closed default

If no hook is wired **and** no adapter executor is in place, the tool refuses. Core's default local-subprocess runner on an unsandboxed host is not safe for autonomous agents. Callers must either:
1. Wire a permission hook with pattern-based allow/deny rules, OR
2. Provide a sandboxing executor adapter.

An explicit `session.permissions.unsafeAllowBashWithoutHook: true` bypass exists for test fixtures only. It logs a warning.

---

## 7. Background jobs

### 7.1 Starting

`{ command, background: true }` returns `kind: "background_started"` with a `job_id`. The job runs with its stdout/stderr streamed to temp files. Lifecycle:

- Created in session-scoped job table.
- Killed (SIGTERM → SIGKILL after 5s) when session closes OR when the harness explicitly calls `killBackground(jobId)`.
- `BACKGROUND_MAX_JOBS` cap (16). Exceeding returns `IO_ERROR`: "background job limit reached; kill an existing job first".

### 7.2 Companion tools (ship alongside Bash)

The Bash tool family ships three sub-tools:

**`bash`** (primary) — foreground execution or background launcher.

**`bash_output`** — poll a background job:

```text
{
  job_id:       string      // required
  since_byte?:  int ≥ 0     // optional, default 0; start of the requested slice
  head_limit?:  int ≥ 1     // optional, default 30 KB
}
```

Returns `{ kind: "output" | "error" }`:

```text
<job_id>{job_id}</job_id>
<running>{true|false}</running>
<exit_code>{null|int}</exit_code>
<stdout>
{slice from since_byte up to head_limit}
</stdout>
<stderr>
{slice from since_byte up to head_limit}
</stderr>
(Showing bytes {since_byte}-{since_byte+returned} of {total}. Next since_byte: {next}. Job running: {bool}.)
```

**`bash_kill`** — send a signal:

```text
{
  job_id:  string      // required
  signal?: "SIGTERM"   // default
         | "SIGKILL"   // force
}
```

### 7.3 Discovery

No separate `list_background_jobs`. If the model forgets the job ID, it uses `bash { command: "pgrep -f <pattern>" }` or re-runs. v2 may add a discovery tool if evidence shows it's needed.

---

## 8. Timeouts and abort

- Default inactivity timeout 60s, configurable via `timeout_ms`.
- Wall-clock backstop 5 minutes, configurable only via session.
- Must respect session `AbortSignal` — if the signal fires, SIGTERM the child immediately.
- On timeout, the partial output is returned in `kind: "timeout"`. The model decides whether to retry with `background: true` or narrow the command.

---

## 9. Interactive-command detection (§13 — v2)

v1 does not detect interactive commands. The description warns against them. If a command hangs on stdin, the inactivity timeout fires and the model sees `kind: "timeout"` with empty stdout/stderr. That's informative enough to pivot.

v2 may add a lightweight detector: track the command head against a known list (`git commit` without `-m`, `npm init` without `-y`, `vim`, `less`, `more`, `top`) and emit `INTERACTIVE_DETECTED` immediately. Deferred.

---

## 10. Ledger integration

Bash does not participate in the read ledger. Running a shell command is not a read of a specific file's contents — even `cat foo.txt` via Bash shouldn't satisfy the read-before-edit gate. That invariant belongs to the Read tool only.

---

## 11. Determinism, idempotence, concurrency

- Commands are inherently non-deterministic (clocks, randomness, network). The tool does not attempt to enforce determinism.
- Multiple concurrent Bash calls in one session are allowed. Foreground commands run in parallel; the session cwd is a shared mutable state — model should not assume cwd consistency across concurrent foreground calls.
- Background jobs are independent; their job_ids are stable across calls.

---

## 12. Tests (acceptance matrix — both languages must pass equivalents)

### 12.1 Unit (code correctness)

1. Empty command → `INVALID_PARAM`.
2. Known-alias (`cmd`, `dir`, `timeout`, `lang`, etc.) → `INVALID_PARAM` with redirect hint.
3. `cwd` outside workspace, no hook → `OUTSIDE_WORKSPACE`.
4. `cwd` is a file not a directory → `IO_ERROR` or `NOT_FOUND`.
5. `cwd` matches sensitive pattern, no hook → `SENSITIVE`.
6. Successful `echo hi` → `kind: "ok"`, `exit_code: 0`, `stdout: "hi\n"`.
7. `false` → `kind: "nonzero_exit"`, `exit_code: 1`.
8. `sleep 5` with `timeout_ms: 100` → `kind: "timeout"`, partial empty output.
9. `while true; do echo x; done` → hits output byte cap, stream-to-file; result contains head + tail + path.
10. `cd /tmp/foo` inside workspace → updates `logicalCwd`.
11. `cd /etc` (outside) → `logicalCwd` unchanged; result annotates `(cwd unchanged: escape to '/etc' blocked)`.
12. Subsequent call sees updated `logicalCwd`.
13. `background: true` + foreground-incompatible params → `INVALID_PARAM`.
14. `bash_output(job_id)` on running job returns `running: true`, partial output, next `since_byte`.
15. `bash_kill(job_id)` + `bash_output` → `running: false`, nonzero exit code or null.
16. Permission hook returns `deny` → `PERMISSION_DENIED` with echoed command.
17. No hook + no adapter + not-unsafe → `PERMISSION_DENIED` with config-hint.
18. Env keys restricted to safe prefix (sensitive denied) → `INVALID_PARAM`.
19. Session close → all background jobs SIGTERM'd within 5s.
20. AbortSignal fires mid-exec → process killed, `kind: "error"` with `KILLED`.

### 12.2 LLM e2e (model-contract validation)

Lives in `packages/harness-e2e/test/bash.e2e*.ts`. Minimum categories (BASH1…BASH8):

- **BASH1 golden**: "What's the node version?" → expects one `bash` call with `node --version`.
- **BASH2 cwd-carry**: "cd to /tmp/workspace, then run `pwd`" → two calls, second observes the new cwd.
- **BASH3 escape-blocked**: "cd outside the workspace" → expects the `(cwd unchanged)` message and the model stays inside.
- **BASH4 python-one-liner**: "Compute 2**128 with Python" → model runs `python -c 'print(2**128)'`.
- **BASH5 nonzero-exit-recovery**: `ls /does-not-exist` → model sees `kind: "nonzero_exit"` + stderr, retries with a corrected path.
- **BASH6 output-cap**: `seq 1 1000000` → model sees head+tail + log path; answers correctly (e.g. "first is 1, last is 1000000") WITHOUT trying to paginate past 30 KB.
- **BASH7 background**: "Start a local HTTP server on port 8080 for 10 seconds" → model uses `background: true`, polls `bash_output`, kills with `bash_kill`.
- **BASH8 interactive-rejection**: "Run `git commit` in the repo" (no `-m`) → inactivity timeout OR model preempts by adding `-m`. Stochastic; wrap in pass@k.

Cross-tool integration (CT5+) adds `bash ↔ read/write` chains in the cross-tool suite.

Multi-model coverage follows the existing matrix policy.

---

## 13. Stability

Breaking changes bump major. Additions (new error codes, new optional params) are minor. Error `code` values are a public contract.

---

## 14. Open questions (deferred)

- **Windows support.** v1 is POSIX (bash on Unix). Windows support needs either PowerShell as a separate tool (following Claude Code's split) or WSL2 detection.
- **Interactive detection.** §9 — a lightweight detector for known-interactive commands; deferred until evidence shows the inactivity timeout isn't enough.
- **`StdinFeed` companion.** For models that genuinely need to reply to a running prompt; deferred until evidence shows Cline's pattern is worth the complexity.
- **Persistent env across calls.** Claude Code doesn't do it either. If evidence shows it's needed, we add an `env_persist` flag or a separate `bash_setenv` tool.
- **Command classifier auto-mode.** Claude Code's `--permission-mode auto` runs a separate model to classify commands. That's a harness concern, not a tool-library concern. Out of scope.
- **`docker exec` passthrough.** Could ship `@agent-sh/bash-docker` with `image` + `volumes` configured at session level.

---

## 15. References

- `agent-knowledge/exec-tool-design-across-harnesses.md` — the design-space deep dive (primary).
- `agent-knowledge/harness-tool-surface-audit.md` §Execution — the ship-list.
- `agent-knowledge/ai-agent-harness-tooling.md` §8 — permission model patterns.
- Claude Code Bash tool reference — the closed-harness gold standard for autonomous design.
- Codex CLI `shell` + sandbox modes — the OS-sandbox alternative posture.
- OpenCode `bash.ts` — closest public implementation of the inactivity-timeout + stream-to-file pattern.
- Cline `execute_command` — the `requires_approval` classifier pattern.

---

## Addendum: decision log

- **B-D1** (Tool name): `bash`, lowercase. Matches OpenCode convention. Training-signal argument from research favors `Bash` — we default to `bash` in the tool registration but allow a capitalized alias for Claude-family models if it measurably improves invocation rate.
- **B-D2** (Language scope): ONE `bash` tool. Python/JS via `python -c` / `node -e`. No `lang` discriminator.
- **B-D3** (Session semantics): cwd carries across calls (when explicit top-level `cd`); env does NOT persist. Matches Claude Code's nuanced persistence.
- **B-D4** (Sandbox posture): pluggable `BashExecutor` interface. Core ships a local subprocess runner with no sandbox. Fail-closed if no hook AND no adapter. Adapter packages are peer deps of the harness, not of our library.
- **B-D5** (Network / FS policy): tool-level neither allows nor blocks. Permission hook + adapter decide.
- **B-D6** (Timeout): inactivity-based, default 60s; wall-clock backstop 5 min. On timeout: SIGTERM → SIGKILL, return partial output.
- **B-D7** (Output cap): 30 KB per stream inline; stream-to-file on overflow with head+tail + log path in the result. 10 MB file cap.
- **B-D8** (Permission model): autonomous posture — no `ask`. Hook returns allow or deny. Pattern-based `always_patterns` hint following Claude Code's `Bash(git:*)` convention.
- **B-D9** (Interactive commands): rejected by description guidance in v1. Inactivity timeout catches hangs. `StdinFeed` companion deferred.
- **B-D10** (Background): `background: true` opt-in + `bash_output` + `bash_kill` companions. `BACKGROUND_MAX_JOBS` = 16. Session-scoped lifecycle.
- **B-D11** (Alias pushback): `KNOWN_PARAM_ALIASES` covering `cmd`/`script`/`run`, `dir`/`directory`/`path`, `timeout`/`timeout_seconds`, `lang`/`interpreter`, `stdin`/`input`, `sandbox`/`network`.
- **B-D12** (Ledger): bash does not touch the read ledger. Running `cat` does not satisfy read-before-edit.
