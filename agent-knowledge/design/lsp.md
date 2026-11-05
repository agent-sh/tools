# LSP Tool — Cross-Language Design Spec

**Status**: Draft v1 — 2026-04-21
**Implementations**: TypeScript (`@agent-sh/harness-lsp`), Rust (`harness-lsp` crate)
**Scope**: Language-neutral contract. Implementation files (`packages/lsp/` for TS, `crates/lsp/` for Rust) must conform.

This spec is the source of truth. Implementation-specific ergonomics are allowed; public semantics are not.

Prior art surveyed: Claude Code `LSP` (plugin-manifest model), OpenCode experimental `lsp` (9-op enum), Serena (semantic-symbol MCP), mcp-language-server (isaacphi), lsp-mcp (jonrad dynamic schema), Multilspy / monitors4codegen (Microsoft Research, NeurIPS 2023), Aider (tree-sitter + PageRank), Cline `list_code_definition_names`. See `agent-knowledge/lsp-tool-design-across-harnesses.md` for the 12-dimensional design-space analysis that informed the decisions below.

---

## 1. Purpose

Expose Language Server Protocol operations to an **autonomous** LLM as a structured tool. The model should be able to:

1. Ask "where is this symbol defined?" (definition)
2. Ask "where is this symbol used?" (references)
3. Ask "what does this expression mean?" (hover: type, doc, signature)
4. List the symbols in a file or the workspace (documentSymbol, workspaceSymbol)
5. Ask "which types implement this interface?" (implementation)
6. (v1.1 roadmap) Ask "rename this symbol everywhere" (rename)

Enforce at the tool layer every invariant that cannot be trusted to the model:

- **Workspace-scoped** — same fence as Read/Write/Grep/Glob (roots, sensitive paths).
- **Language-server lifecycle** — spawn on first use, pre-warm optionally, clean up on session close. Fail-closed if no server configured for a language.
- **Position sanity** — 1-indexed lines and characters at the tool boundary; convert to LSP's 0-indexed UTF-16 internally.
- **Size caps** — `references` on a heavily-used symbol can return 10,000 hits. Cap at 200 with a `truncated` hint.
- **Discriminated error surface** — `no_results` vs `server_not_available` vs `server_starting` vs `position_invalid` — each has a different recovery path.
- **Permission hook** (autonomous — no `ask`).

Non-goals for v1:
- **Rename, code actions, completion, signature help.** Rename is the first v1.1 addition; the rest deferred pending evidence of need.
- **Diagnostics as a tool operation.** Diagnostics fire automatically via a PostToolUse hook on Write/Edit; the model doesn't ask for them. (See §10.)
- **Call hierarchy, type hierarchy.** Deferred.
- **Bundled language servers.** The user wires servers via `.lsp.json`; we don't ship binaries.
- **Multi-language incremental sync across sessions.** v1 is single-session.

---

## 2. Input contract

```text
{
  operation:  "hover" | "definition" | "references"
            | "documentSymbol" | "workspaceSymbol"
            | "implementation"
  path?:      string    // required for hover/definition/references/
                        //   documentSymbol/implementation
  line?:      int ≥ 1   // 1-indexed line number, required when
                        //   operation needs a position
  character?: int ≥ 1   // 1-indexed character column, required when
                        //   operation needs a position
  query?:     string    // workspaceSymbol only
  head_limit?: int ≥ 1  // default 200; only applied to list-shape ops
}
```

Per-operation shape:

| operation | required fields |
|---|---|
| `hover` | `path`, `line`, `character` |
| `definition` | `path`, `line`, `character` |
| `references` | `path`, `line`, `character` |
| `documentSymbol` | `path` (no position) |
| `workspaceSymbol` | `query` |
| `implementation` | `path`, `line`, `character` |

### Deliberate omissions

- **No `language` selector.** Detected automatically from `path` extension via the `.lsp.json` manifest. For `workspaceSymbol` (no path), the session's primary language is used; if ambiguous, return `position_invalid` with a hint to narrow via filename pattern.
- **No `include_declaration` on references.** LSP exposes it; we always include the declaration (what the model expects when asking "where is this used"). If someone wants exclude-declaration, they can narrow with grep.
- **No `uri` field.** Paths are absolute filesystem paths, not LSP `file://` URIs. We convert at the boundary. Models see paths they can also pass to Read/Edit.
- **No `max_results` per operation — just `head_limit`.** Matches grep/glob pagination.
- **No raw LSP JSON passthrough.** We flatten to grep-style `path:line:text` for references; markdown for hover; structured symbol list for symbols. Raw JSON is an escape hatch via session config only.

### Parameter validation

- `operation` not in the enum → `INVALID_PARAM`.
- Missing required fields for the operation (e.g. `hover` without `line`) → `INVALID_PARAM` with a hint naming the required fields.
- `path` not absolute → resolve against `session.cwd` (same rule as other tools).
- `path` outside workspace, no hook → `OUTSIDE_WORKSPACE`.
- `line < 1` or `character < 1` → `INVALID_PARAM`: "positions are 1-indexed".
- `head_limit < 1` → `INVALID_PARAM`.

### 2.1 Known-alias pushback

Required aliases (minimum):

- `op`, `action`, `verb`, `method` → `operation`
- `file`, `file_path`, `filename`, `uri` → `path`
- `row`, `line_number`, `ln` → `line`
- `col`, `column`, `ch`, `offset` → `character`
- `symbol`, `term`, `name`, `pattern` → `query`
- `limit`, `max_results`, `max_count` → `head_limit`
- `language`, `lang` → drop; detected from path
- `include_declaration` → drop; always included
- `open`, `didOpen` → drop; sync handled internally
- `start_position`, `end_position`, `range` → drop; use line+character

### Description guidance (model-facing)

Tool description must call out:

> Language-server operations for code navigation. Ask for the definition, references, hover info, or symbol list of code under `path`. Positions are 1-INDEXED — line 1 is the first line, character 1 is the first column. If you've got a position from a grep result or Read output, use those numbers directly.
>
> - `hover` — type and doc for the symbol at path:line:character.
> - `definition` — where the symbol at path:line:character is defined.
> - `references` — every place the symbol at path:line:character is used.
> - `documentSymbol` — outline of all symbols in `path` (no position needed).
> - `workspaceSymbol` — find symbols matching `query` across the workspace.
> - `implementation` — for an interface/abstract symbol, who implements it.
>
> **Cold start.** First call for a language spawns its language server. If the server is still indexing, the tool returns `server_starting` with a retry hint. Wait the suggested time and call again — subsequent calls will be fast.
>
> **No diagnostics operation.** Compiler/linter diagnostics run automatically after your Write/Edit calls; you'll see them in the post-edit hook output. Don't ask for diagnostics here.

Research backing: flattened `path:line:text` output for references lets the model reuse its existing understanding from grep output. Raw LSP `Location[]` JSON requires schema learning per call — measured cost to token efficiency and tool-call correctness in multiple harnesses (see lsp-research §Output shape).

---

## 3. Output contract

Output is a discriminated union by `kind`. Each operation has a kind-specific success shape; all share the error / server-state kinds.

### 3.1 `kind: "hover"`

```text
<operation>hover</operation>
<path>{path}</path>
<position>{line}:{character}</position>
<contents>
{markdown or plain text — the LSP hover contents}
</contents>
```

- `contents` is markdown (LSP `Hover.contents.value` when `kind: "markdown"`) or plain text when the server returns `MarkedString[]` / plain.
- If hover returns nothing at that position: kind becomes `no_results` with hint `"No hover info at {line}:{character}. The position might be on whitespace or inside a comment."`.

### 3.2 `kind: "definition"`

```text
<operation>definition</operation>
<path>{original path}</path>
<position>{line}:{character}</position>
<locations>
{target_path}:{target_line}:{target_character} {preview line}
...
</locations>
```

- One or more target locations. Most operations return 1; overloaded symbols in C++/Go can return N.
- `preview line` is the actual source line at the target position, so the model can see the definition without a second Read call.

### 3.3 `kind: "references"`

```text
<operation>references</operation>
<path>{original path}</path>
<position>{line}:{character}</position>
<locations>
{target_path}:{target_line}:{target_character} {preview line}
{target_path}:{target_line}:{target_character} {preview line}
...
</locations>
{continuation_hint}
```

- Same shape as definition.
- Capped at `head_limit` (default 200). If more exist: `(Showing 200 of {total} references. Narrow to a specific directory by grepping within it first.)`
- Path groupings: locations sorted by path, then by line. Makes scan-ability grep-like.

### 3.4 `kind: "documentSymbol"`

```text
<operation>documentSymbol</operation>
<path>{path}</path>
<symbols>
{line}: {kind} {name}
  {line}: {kind} {name}        # child symbols indented
{line}: {kind} {name}
...
</symbols>
```

- `kind` is a short string: `class`, `interface`, `function`, `method`, `variable`, `constant`, `enum`, `enumMember`, `property`, `namespace`, `module`, `field`, `constructor`, `type`. Flattened from LSP's numeric SymbolKind.
- Nested (via LSP DocumentSymbol tree) indented by 2 spaces per level.

### 3.5 `kind: "workspaceSymbol"`

```text
<operation>workspaceSymbol</operation>
<query>{query}</query>
<matches>
{path}:{line}: {kind} {name}
...
</matches>
{continuation_hint}
```

### 3.6 `kind: "implementation"`

Same shape as `definition`.

### 3.7 `kind: "no_results"`

```text
<operation>{op}</operation>
(No results. {hint})
```

Hint is operation-specific:
- hover: `"The position might be on whitespace or inside a comment."`
- definition: `"Symbol may be a primitive type (no source definition) or outside the indexed workspace."`
- references: `"No references found. The symbol is either unused or only defined. You may also be 1 character off — check the exact column in the source."`
- workspaceSymbol: `"No symbols matched '{query}'. Try a broader query or a substring."`

### 3.8 `kind: "server_starting"`

```text
<operation>{op}</operation>
(Language server for {language} is still indexing. Retry in ~{retry_ms}ms.)
```

`retry_ms` defaults to 3000 and grows logarithmically per retry, capping at 30000.

### 3.9 `kind: "error"`

| `code` | When |
|---|---|
| `INVALID_PARAM` | Schema error, alias pushback, missing required field for op. |
| `NOT_FOUND` | `path` does not exist; include up to 3 fuzzy sibling suggestions (same pattern as read/grep/glob). |
| `OUTSIDE_WORKSPACE` | Path outside all configured roots, no hook. |
| `SENSITIVE` | Path matches sensitive-pattern deny list. |
| `PERMISSION_DENIED` | Hook returned deny. |
| `SERVER_NOT_AVAILABLE` | No `.lsp.json` entry for the language; the model can fall back to grep. Hint: `"No language server configured for {language} ({ext}). Configure one in .lsp.json or session config."` Also when the server could not start: the spawn failed, it exited or broke a pipe during the start, it answered `initialize` with an error, or it did not answer `initialize` within the bound. A start that failed after the call that began it gave up is reported once, to the next call (5.3). |
| `POSITION_INVALID` | `line > file.length` OR `character > line.length`. Hint includes the actual bounds. |
| `SERVER_CRASHED` | Language server process died, or lost a pipe, while this call was using it. The next call starts a new server. |
| `TIMEOUT` | Server didn't respond within the per-op timeout (default 30s). Server might be CPU-bound; retry or narrow. |
| `IO_ERROR` | Unexpected protocol / IO failure; preserve `cause`. |

---

## 4. Size caps

| Constant | Default | Override |
|---|---|---|
| `DEFAULT_HEAD_LIMIT` | 200 (references, workspaceSymbol) | per-call `head_limit` |
| `DEFAULT_TIMEOUT_MS` | 30_000 (per-op) | session config |
| `SERVER_STARTUP_MAX_WAIT_MS` | 5_000 (first-call lazy wait before returning `server_starting`) | session config |
| `DEFAULT_INITIALIZE_TIMEOUT_MS` | 60_000 (`SESSION_BACKSTOP_MS`; bound for the spawn client's `initialize`) | `createSpawnLspClient({ initializeTimeoutMs })`; Rust `SpawnLspClient::with_options(SpawnLspClientOptions { initialize_timeout_ms })` |
| `MAX_HOVER_MARKDOWN_BYTES` | 10_000 (prune massive TSDoc) | session config |
| `MAX_PREVIEW_LINE_LENGTH` | 200 chars per preview line | session config |
| `MAX_WORKSPACE_SYMBOLS_SCANNED` | 10_000 (internal scan cap) | session config |

Rationale for 200: rust-analyzer on a moderately-sized crate returns ~500 refs for common types like `Option`. 200 gives models enough signal without flooding context; `references-with-narrowing` pattern covers the rest.

---

## 5. Language-server lifecycle

### 5.1 `.lsp.json` manifest

The session discovers servers via a `.lsp.json` file in the workspace root (or the session's `lspManifest` config field). Schema matches Claude Code's manifest:

```json
{
  "servers": {
    "typescript": {
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      "command": ["typescript-language-server", "--stdio"],
      "rootPatterns": ["tsconfig.json", "package.json"]
    },
    "rust": {
      "extensions": [".rs"],
      "command": ["rust-analyzer"],
      "rootPatterns": ["Cargo.toml"]
    },
    "python": {
      "extensions": [".py", ".pyi"],
      "command": ["pyright-langserver", "--stdio"],
      "rootPatterns": ["pyproject.toml", "pyrightconfig.json"]
    }
  }
}
```

- `extensions` — file extensions routed to this server.
- `command` — spawn command + args. Must be on `PATH` or an absolute path. Core does not auto-install.
- `rootPatterns` — files whose nearest-ancestor directory becomes the LSP `rootUri` for the server. Falls back to session cwd if none match.
- Missing `.lsp.json` is OK; first operation on an unrecognized extension returns `SERVER_NOT_AVAILABLE` with a hint pointing at the manifest.

### 5.2 Spawn policy

- **Lazy** — spawn on first operation for a language, not at session open.
- **One server per (language, workspace-root)**. Reuse across calls within the session.
- **Pre-warm optional** — a `lspPrewarm` session flag (default false) spawns all servers in `.lsp.json` at session open. Off by default: most sessions only touch one language and pre-warm wastes seconds.

### 5.3 Readiness

Language servers have two ready states:
1. **Process alive + LSP handshake done** — can accept requests. Fast (ms).
2. **Indexing complete** — can answer semantic queries. Slow (rust-analyzer: 15-60s on a real crate; pyright: 3-10s).

The tool returns `server_starting` when (1) has happened but (2) hasn't. The client decides:
- **Simple op (documentSymbol on a tiny file)** — usually works before indexing completes. Try it; fall back to `server_starting` if the server rejects.
- **Full-index op (references, workspaceSymbol)** — block up to `SERVER_STARTUP_MAX_WAIT_MS` for indexing, then return `server_starting` with `retry_ms`.

The handshake itself is bounded by `DEFAULT_INITIALIZE_TIMEOUT_MS`, the session backstop (60s, section 8); the spawn client takes `initializeTimeoutMs` (Rust: `initialize_timeout_ms`) to override it. The session backstop also caps every call's budget, so with the defaults a slow start outlives the call that began it: that call returns `TIMEOUT`, and a later call gets `server_starting` or a result from the same server. When the process exits, fails to spawn, breaks a pipe or answers `initialize` with an error, `ensureServer` rejects at once and the tool returns `SERVER_NOT_AVAILABLE` with the reason. When the bound passes, the client stops the server (SIGTERM, then SIGKILL after 2s). A start that fails after the call that began it has given up is reported once: the next call returns `SERVER_NOT_AVAILABLE` with the reason (the exit code or signal and the stderr tail, or the missed bound), and the call after it starts a new server. Keep the bound above the session's call budget; when the two are equal the call gives up first, and only the next call learns why the start failed.

### 5.4 Shutdown

- Session close → gracefully terminate all spawned servers, in parallel. Each server: LSP `shutdown` (wait up to 2s for the reply) → `exit` (wait up to 2s for the write) → wait up to 2s for the process to exit → SIGTERM → SIGKILL after 2s → wait up to 2s for the exit. Skip `exit` when `shutdown` failed, timed out or the server already exited. A server that is not ready (still starting, or crashed) skips `shutdown` and `exit` and goes straight to SIGTERM. `closeSession` returns once every server has exited, or 2s after its SIGKILL.
- No signal is sent before the `exit` write settles, and every write is awaited. The `didOpen` before an operation is awaited under that operation's signal, so a server that stops reading stdin cannot hold the call past its timeout. An operation whose signal is already aborted sends nothing. A server can exit or close its stdin at any point, so a write may fail with `EPIPE` or `ERR_STREAM_DESTROYED`. During shutdown that failure is expected and handled. In a live session it fails the operation that wrote, never as an unhandled rejection.
- **Process groups.** On POSIX each server runs in its own process group (TS: `detached`, which also gives it its own session; Rust: `process_group(0)`). SIGTERM and SIGKILL go to the whole group, so a server's children, such as tsserver under typescript-language-server, stop with it. Once a server has exited, for any reason, a clean `exit` included, the client sends SIGKILL to what is left of its group. A helper that a server means to keep running has to start its own group or session. The Rust client kills the group while the exited server is not yet reaped, so no new process can have taken the group id; Node reaps the process before its `exit` event, so the TS client kills the group just after the reap. In Rust, a runtime that shuts down without `close_session` kills each server's group too. Windows has no process groups: the client signals the server process only.
- **Hosts stop their servers on exit.** A server in its own group gets no Ctrl-C from the host's terminal and no signal sent to the host's group. So a host calls `closeSession` (Rust: `close_session`) before it exits, on SIGINT and SIGTERM too. `harness-lsp-cli` does this at the end of its input and on SIGINT, SIGTERM and SIGHUP, then exits with 128 plus the signal number; a second signal skips the wait.
- Harness crash → a server still sees its stdin close, and the `processId` it got in `initialize`; beyond that, orphaned servers are the OS's problem. rust-analyzer leaks are a known ecosystem hazard.

### 5.5 Crash handling

- If a ready server exits while no call is using it, the next call's `ensureServer` starts a new one and that call proceeds. A server that exits while it is still starting in the background is reported first (5.3): the next call gets `SERVER_NOT_AVAILABLE` with the reason, and the call after it starts a new server. Until its start has failed, such a server counts as starting, so a call in between gets `server_starting`, not a second server. `ensureServer` never returns a crashed handle: `ServerHandle.state` is `starting` or `ready`.
- A call that sees the server die gets `SERVER_CRASHED`, and the call after it starts a new server.
- A request in flight when the process exits rejects at once with `LspServerExitedError` (Rust: `LspClientError::Crashed`) (exit code or signal, plus the server's last stderr output). It does not wait for the per-op timeout. The tool returns it as `SERVER_CRASHED` for that call.
- The client always drains the server's stderr, so a server that writes a lot of it never blocks on a full pipe. Only the last 4 KB is kept, for that error.
- A server whose stdin breaks while the process lives can never take another message. The write that found it fails that call with `LspServerCrashedError` (Rust: `LspClientError::Crashed`; `SERVER_CRASHED`), and the client marks the server crashed and stops it, so the next call starts a new one.
- A server whose stdout closes while the process lives can never answer again. It gets one stop step (2s) to exit on its own. If it does not, it is retired the same way, and every call waiting on it gets `SERVER_CRASHED`.
- Deliberately don't auto-retry within the same call: the model gets to see the crash, decide whether the request was the cause (malformed position, etc.), and retry or not.

---

## 6. Workspace, permissions

Reuses the same fence as Read/Write/Grep/Glob/Bash.

### 6.1 Permission hook

Extends with LSP-specific fields:

```text
hook({
  tool: "lsp",
  action: "read",
  path: resolvedPath,
  always_patterns: [`Lsp(${operation}:*)`],
  metadata: {
    operation,
    language,
    line: line ?? null,
    character: character ?? null,
    query: query ?? null,
  }
}) → "allow" | "allow_once" | "deny"
```

- Autonomous — no `ask`.
- Fail-closed if no hook AND `session.permissions.unsafeAllowLspWithoutHook !== true` → `PERMISSION_DENIED`.

### 6.2 File sync

LSP servers track `textDocument/didOpen` and `textDocument/didChange` to understand unsaved edits. v1 opens files as the tool reads them (once per file per session) and NEVER pushes `didChange` — unsaved edits in the harness are out of scope. Mutations from our Write/Edit tool write to disk, then the LSP `textDocument/didSave` signal tells the server to re-index. Simpler than persistent sync; loses nothing for a stateless coding agent.

---

## 7. Position encoding

- **1-indexed** at the tool boundary — matches grep/read output, matches human editor counting.
- **Convert to LSP's 0-indexed UTF-16** internally. This is the load-bearing detail: LSP spec says positions are UTF-16 code units, not bytes or UTF-8 chars. For ASCII the number is identical; for emoji/CJK/etc. it diverges. The `LspClient` adapter is responsible for getting this right.
- Validation:
  - `line < 1` → `INVALID_PARAM`.
  - `line > actual_lines` → `POSITION_INVALID` with hint naming the file's line count.
  - `character < 1` → `INVALID_PARAM`.
  - `character > line_length + 1` → `POSITION_INVALID`. (`line_length + 1` is the position after the last char, legitimate for hover-at-end.)

---

## 8. Timeouts

- Default 30s per tool call, starting the server included. The call's signal reaches `ensureServer`. When the start outlasts it, the call returns `TIMEOUT` and the server keeps starting, bounded by the client's `initialize` limit (60s by default, above the call budget), so the next call gets `server_starting` or a result. If the start failed meanwhile, the next call gets `SERVER_NOT_AVAILABLE` with the reason instead (5.3).
- A call cancelled through the session signal returns `TIMEOUT` with a message that says it was cancelled. A call whose signal is already aborted sends nothing and starts no server.
- Session backstop 60s.
- On timeout, SIGTERM the LSP request (if the server supports `$/cancelRequest`), return `TIMEOUT`. The server stays alive; subsequent calls reuse it.

---

## 9. Pluggable adapter

```text
interface LspClient {
  /** Spawn or reuse a server for the given language + root. */
  ensureServer(args: {
    language: string;
    root: string;
    command: readonly string[];
    // Optional: initialization options, client capabilities overrides
    signal?: AbortSignal; // bounds the caller's wait, not the server start
  }): Promise<ServerHandle>;

  hover(h: ServerHandle, path: string, pos: Position): Promise<HoverResult>;
  definition(h: ServerHandle, path: string, pos: Position): Promise<Location[]>;
  references(h: ServerHandle, path: string, pos: Position): Promise<Location[]>;
  documentSymbol(h: ServerHandle, path: string): Promise<SymbolInfo[]>;
  workspaceSymbol(h: ServerHandle, query: string): Promise<SymbolInfo[]>;
  implementation(h: ServerHandle, path: string, pos: Position): Promise<Location[]>;

  close(h: ServerHandle): Promise<void>;
  closeSession(): Promise<void>;
}

interface ServerHandle {
  readonly language: string;
  readonly root: string;
  readonly state: "starting" | "ready"; // never "crashed": ensureServer re-spawns or rejects
}
```

Core ships `@agent-sh/harness-lsp` with:
- **Default `SpawnLspClient`** — spawns server binaries from `.lsp.json`, speaks JSON-RPC over stdio.

Adapter packages (separate, peer-installed):
- `@agent-sh/harness-lsp-mcp` — proxy to an external MCP LSP server (mcp-language-server, lsp-mcp, etc.)
- `@agent-sh/harness-lsp-stub` — in-memory stub for unit tests; lets us verify the orchestrator without spawning real servers.
- Future `@agent-sh/harness-lsp-multilspy` — Python-based research-grade client.

---

## 10. Diagnostics — PostToolUse hook, not a tool op

LSP servers emit diagnostics via `textDocument/publishDiagnostics` asynchronously. Surfacing them as a model-invoked operation is wrong for two reasons:

1. Models forget to ask → bugs land in the output.
2. Models over-ask → every call is a full "now check diagnostics" round-trip, wasting turns.

Correct pattern: after Write/Edit successfully mutates a file, a PostToolUse hook queries the LSP session for any diagnostics on that file and appends them to the tool result. The model ALWAYS sees compile errors on edit, never asks for them.

v1 ships:
- `createDiagnosticsHook(session)` — returns a hook function that Write/Edit sessions can plug in.
- The hook blocks for up to 500ms waiting for diagnostics (LSP's `publishDiagnostics` is async; if the server hasn't emitted in 500ms, we move on).
- Output appended to the tool result: `\n<diagnostics>\n{path}:{line}:{character} [{severity}] {message}\n...\n</diagnostics>`.

This is separate from the 6 user-callable operations. The `lsp` tool has NO diagnostics operation.

---

## 11. Ledger integration

LSP does not participate in the read ledger. Asking for `hover` or `references` is not a read of the file's full text — it's a semantic query. Models that want to edit still need to Read first.

---

## 12. Determinism, concurrency

- Language-server responses are deterministic for a given indexed state. Two identical calls with the same files on disk return byte-identical results in `hover` / `definition`. References order may vary with server implementation; the tool sorts (by path, then line) to stabilize.
- Multiple concurrent LSP calls in a session share the underlying server. LSP servers handle concurrency natively (request IDs).

---

## 13. Tests

### 13.1 Unit (code correctness)

Use a stub `LspClient` (mocked LSP responses) to exercise orchestrator + format logic without spawning real servers. Minimum:

1. Each operation returns the expected shape (hover / definition / references / documentSymbol / workspaceSymbol / implementation).
2. Missing required field for op → `INVALID_PARAM` with hint naming the field.
3. Alias pushback (`op`, `file`, `row`, `col`, `language`, `include_declaration`) → `INVALID_PARAM`.
4. `path` not in workspace, no hook → `OUTSIDE_WORKSPACE`.
5. `path` doesn't exist → `NOT_FOUND` with sibling suggestions.
6. `line > file.lines` → `POSITION_INVALID` with hint.
7. `line: 0` → `INVALID_PARAM` (1-indexed).
8. No `.lsp.json` entry for extension → `SERVER_NOT_AVAILABLE`.
9. Server not ready → `server_starting` with exponential retry_ms.
10. Server crashed mid-call → `SERVER_CRASHED`, next call re-spawns.
11. references result > 200 → capped with `truncated` hint.
12. hover result > MAX_HOVER_MARKDOWN_BYTES → truncated with elision marker.
13. Position UTF-16 conversion: emoji in line, character=1 (first byte) correctly maps to UTF-16 code unit 0.
14. documentSymbol with nested classes → flattened output with indentation.
15. workspaceSymbol with empty query → `INVALID_PARAM`.
16. Timeout → `TIMEOUT`, server stays alive.
17. Session close → `closeSession` called on client; all servers terminated.
18. `implementation` on a non-interface symbol → `no_results` with hint.
19. definition of a primitive type (e.g. `string` in TS lib.d.ts) → works via the TS server returning the lib file; tool should handle paths outside the workspace with a suitable hint.
20. Concurrent hover + references calls on same server → both complete.

### 13.2 LLM e2e (model-contract validation)

Lives in `packages/harness-e2e/test/lsp.e2e*.ts`. Uses a small fixed workspace (e.g. a 4-file TypeScript project checked into fixtures). Spawns `typescript-language-server` (a known-available dep) or uses the stub client.

- **LSP1 golden**: "Where is `UserService` defined?" → one `definition` call, correct file:line.
- **LSP2 references**: "Where is `handleAuth` used?" → one `references` call, result scoped.
- **LSP3 hover**: "What's the type of `user.email`?" → hover returns `string | null` or similar.
- **LSP4 documentSymbol**: "List the classes and methods in api.ts" → documentSymbol output.
- **LSP5 workspaceSymbol**: "Find all classes named *Service" → workspaceSymbol.
- **LSP6 server_starting**: stub client reports starting → model sees retry hint, waits, retries.
- **LSP7 position_invalid**: prompt implies a line-20 position in a 5-line file → model gets hint, re-checks.
- **LSP8 no-server-for-language**: workspace has a `.ml` file, no `.lsp.json` entry → SERVER_NOT_AVAILABLE → model falls back to grep. Stochastic — pass@k.

Multi-model coverage follows the matrix policy.

---

## 14. Stability

Breaking changes bump major. Additions (new ops, new error codes, new optional params) are minor. Error `code` and operation `kind` values are a public contract.

---

## 15. Open questions — v1.1 roadmap

- **Rename.** The user-requested immediate follow-up. LSP `textDocument/rename` returns a `WorkspaceEdit` touching multiple files. Interactions:
  - Must go through the same ledger as Edit (read-before-write invariant).
  - Must preview before applying (autonomous agents should SEE the edit, not just trust).
  - Per-file byte caps apply.
  - Failure mode: partial rename (some files edited, one fails). Revert policy: per-file atomic; the tool either finishes the whole set or reports which files were edited and which weren't.
- **Code actions** — extract function, add import, etc. Powerful but the model must understand the "which action to pick" problem. Deferred.
- **Completion and signature help** — more useful inside an editor than autonomous. Deferred.
- **Call hierarchy, type hierarchy** — advanced navigation; defer until we have evidence models ask for them.
- **LSP `workspaceEdit` as a mutation primitive** — ties into rename design.

---

## 16. References

- `agent-knowledge/lsp-tool-design-across-harnesses.md` — 12-dimensional deep dive (primary).
- `agent-knowledge/harness-tool-surface-audit.md` §Introspection — ship-list.
- Claude Code `.lsp.json` manifest schema — primary reference for our config format.
- Multilspy / monitors4codegen (Microsoft Research, NeurIPS 2023) — key academic prior art.
- Serena + mcp-language-server + lsp-mcp — MCP-based LSP bridges; inspiration for the adapter boundary.
- LSP 3.17 specification — protocol source of truth.

---

## Addendum: decision log

- **L-D1** (Tool name): single `lsp` tool with `operation` enum. Per-operation tools (`lsp_hover`, `lsp_definition`, ...) were rejected: multiplies schema surface, adds routing mistakes, muddies the single-purpose framing.
- **L-D2** (Operations): 6 read-only ops in v1 (hover, definition, references, documentSymbol, workspaceSymbol, implementation). Rename is v1.1, deferred to separate spec update.
- **L-D3** (Diagnostics): PostToolUse hook on Write/Edit, NOT a tool operation. Avoids model over-asking and under-asking.
- **L-D4** (Positions): 1-indexed at the boundary; convert to LSP 0-indexed UTF-16 internally. Matches what grep/read show the model.
- **L-D5** (Language detection): `.lsp.json` manifest with extension routing. No auto-install of server binaries. User-wired.
- **L-D6** (Spawn policy): lazy (on first op for a language). Optional pre-warm via `lspPrewarm`. Session-scoped lifecycle.
- **L-D7** (Readiness): `server_starting` kind with exponential retry_ms hint. Don't block forever on cold starts.
- **L-D8** (Output shape): flattened grep-style `path:line:text` for references; markdown for hover; structured list for symbols. No raw LSP JSON default.
- **L-D9** (Crash handling): return `SERVER_CRASHED` on the call that observed the death; transparently re-spawn on the NEXT call.
- **L-D10** (Adapter): `LspClient` interface. Core ships spawn-binary implementation; `bash-lsp-mcp`, `-stub` as peer packages. Same pattern as bash/webfetch.
- **L-D11** (Size caps): 200 for references + workspaceSymbol. Matches grep `DEFAULT_HEAD_LIMIT` intuition.
- **L-D12** (Alias pushback): `op`, `file`, `row`, `col`, `language`, `include_declaration` all redirect.
- **L-D13** (Ledger): LSP does not touch the read ledger. Semantic query ≠ file read.
- **L-D14** (v1.1 rename): explicit roadmap item. Not in v1 scope but tracked so the design can already accommodate it.
