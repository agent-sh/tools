# Grep Tool — Cross-Language Design Spec

**Status**: Draft v1 — 2026-04-20
**Implementations**: TypeScript (`@agent-sh/harness-grep`), Rust (pending)
**Scope**: Language-neutral contract. Implementation files (`packages/grep/` for TS, `crates/grep/` for Rust) must conform.

This spec is the source of truth. Implementation-specific ergonomics are allowed; public semantics are not.

Prior art surveyed: Claude Code `Grep`, opencode `grep` (`packages/opencode/src/tool/grep.ts`), Cline `search_files`, Codex CLI shell-based rg. See `agent-knowledge/agent-search-tools.md` for the cross-harness analysis that informed the decisions below.

---

## 1. Purpose

Expose regex content search to an LLM as a structured tool. The model should be able to:

1. Ask "do any files match this pattern?" cheaply before paying for content.
2. Ask "which lines match, with N lines of context?" when it needs to read.
3. Ask "how often does this appear per file?" for survey-style questions.
4. Page through results deterministically when the result set is bounded.

Enforce at the tool layer every invariant that cannot be trusted to the model:

- Workspace-bounded search (same roots/sensitive logic as Read).
- Output size bounds so one bad regex does not wipe the context window.
- `.gitignore` / `.ignore` respect by default (model should not grep `node_modules`).
- A structured error surface that tells the model what went wrong and what to try next.
- Deterministic, mtime-sorted file grouping in `content` mode so pagination is stable.

Non-goals: filename/path search (that is the Glob tool), semantic/AST search, vector retrieval, ranked/PageRanked repo-map.

---

## 2. Input contract

```text
{
  pattern:       string                 // required, ripgrep regex
  path?:         string                 // optional, default: session cwd
  glob?:         string                 // e.g. "*.ts", "*.{js,tsx}"
  type?:         string                 // rg --type (js, py, rust, go, ...)
  output_mode?:  "files_with_matches"   // default — paths only
               | "content"              // matching lines, grouped by file
               | "count"                // { path: count } per file
  case_insensitive?:  bool              // -i, default false
  multiline?:         bool              // -U --multiline-dotall, default false
  context_before?:    int ≥ 0           // -B, default 0, content mode only
  context_after?:     int ≥ 0           // -A, default 0, content mode only
  context?:           int ≥ 0           // -C, sets both, content mode only
  head_limit?:        int ≥ 1           // default 250; 0 = unlimited (discouraged)
  offset?:            int ≥ 0           // default 0; skip first N entries
}
```

### Deliberate omissions

- No `replace_all` / `-r`. This tool is read-only; mutations go through Edit.
- No `hidden` or `no_ignore`. The default posture is "respect gitignore, skip hidden." A workspace-level override is a session-config decision, not a per-call parameter — see §6.
- No `sort_by`. Results in `content` mode are mtime-sorted (newest first, matching Glob and opencode). Results in `files_with_matches` mode are mtime-sorted. `count` is alphabetical by path for stable diffs.
- No `binary`. Binary files are skipped (rg default); there is no escape hatch at the tool boundary.
- No `path_separator`. Output always uses forward slashes.

### Parameter validation

- `pattern` empty → `INVALID_PARAM`: "pattern is required".
- `pattern` does not compile → `INVALID_REGEX`: surface ripgrep's error verbatim (it already names the offending character). The error hint also points to `fixed_strings: true` as the escape-free alternative.
- `fixed_strings: true` → pattern is passed to ripgrep with `-F` (literal search); the regex compile-probe is skipped (a literal cannot be an invalid regex). Use to search exact strings with metacharacters (`( ) . * { }`) without escaping.
- `output_mode` unknown → `INVALID_PARAM`: list the three valid values.
- `context_*` set while `output_mode != "content"` → `INVALID_PARAM`. Context only makes sense for line output; rejecting the combination keeps the surface honest.
- `head_limit < 0` or `offset < 0` → `INVALID_PARAM`.
- Path not absolute → resolve against `cwd`. Same normalization rules as Read §2.

### Pattern guidance (lives in the tool description, not the schema)

Put mode selection before pattern syntax: discovery starts with `files_with_matches` (also the JSON schema default) or `count`, including definition-location questions. Use the distinguishing syntax in the pattern, e.g. `function\\s+handleRequest\\b`. Inspect content in a follow-up when needed. Existence/file-count questions end with the paths/counts; match comment syntax in the pattern if that is the requested scope, e.g. `//.*TODO`. Do not fetch content merely to quote unrequested examples. Direct line/context requests use `content`. Include these concrete recipes in the public description so the distinction survives real-model tool selection.

Tool description must call out:

> Regex syntax is ripgrep's (Rust `regex` crate). To match literal `{` `}` `(` `)` `[` `]` `.` `*` `+` `?` `|` `^` `$` `\\`, escape them (`interface\\{\\}` to find `interface{}`) — or set `fixed_strings: true` to treat the whole pattern as a literal string with no escaping. By default `.` does not match newlines — set `multiline: true` if your pattern needs to cross lines.

Research backing: the Claude Code Grep tool's description carries the same warning because models consistently try `interface{}` on Go code and get zero hits otherwise (see `agent-knowledge/agent-search-tools.md` §"Ripgrep as the Universal Engine").

---

## 3. Output contract

Output is a discriminated union by `kind`.

### 3.1 `kind: "files_with_matches"` (default)

```text
<pattern>{pattern}</pattern>
<matches>
{path_1}
{path_2}
...
</matches>

{continuation_hint}
```

- Paths sorted by mtime, newest first.
- One path per line, absolute.
- Empty result: `(No files matched)` — never return an empty body.
- Continuation hint:
  - Full: `(Found {N} file(s) matching the pattern.)`
  - Capped: `(Showing files {offset+1}-{offset+returned} of {total}. Next offset: {offset+returned}.)`

### 3.2 `kind: "content"`

```text
<pattern>{pattern}</pattern>
<matches>
{path_1}
  {line_no}: {line_text}
  {line_no}: {line_text}

{path_2}
  {line_no}: {line_text}
</matches>

{continuation_hint}
```

- Files separated by blank lines. Paths absolute.
- Lines prefixed with two-space indent, line number, colon, space, line content.
- Context lines (from `-A`/`-B`/`-C`) use the same format; the matching line is not visually distinguished. The model parses by line number, not by marker.
- Lines longer than `MAX_LINE_LENGTH` truncated with `... (truncated)` suffix.
- Files sorted by mtime newest-first; within a file, lines ascending by line number.
- Continuation hint:
  - Full: `(Found {N} match(es) across {F} file(s).)`
  - Capped by `head_limit`: `(Showing matches {offset+1}-{offset+returned} of {total}. Next offset: {offset+returned}.)`
  - Capped by byte guard: `(Output capped at {LIMIT} KB. Showing matches {offset+1}-{offset+returned} of {total}. Next offset: {offset+returned}.)`

### 3.3 `kind: "count"`

```text
<pattern>{pattern}</pattern>
<counts>
{path_1}: {count_1}
{path_2}: {count_2}
...
</counts>

{continuation_hint}
```

- Paths alphabetically sorted (stable diff ergonomics).
- `count` is per-line-matches, matching rg `--count` semantics (not per-occurrence).
- Empty: `(No matches)`.
- Complete counts retain the existing count label and append a `Count complete` hint telling the model to answer existence/file-count questions from the counts, without fetching unrequested matching text. Counts and runtime defaults stay unchanged. Paginated counts retain only the continuation hint until the final page. State the first-discovery-call requirement directly in the description and mode field, before the pattern fields.

### 3.4 `kind: "error"`

Errors are structured, not thrown.

| `code` | When |
|---|---|
| `INVALID_PARAM` | Bad schema (empty pattern, bad mode, negative int, context with wrong mode). |
| `INVALID_REGEX` | Pattern does not compile. Include ripgrep's error message. |
| `NOT_FOUND` | `path` does not exist. Include up to 3 fuzzy sibling suggestions. |
| `OUTSIDE_WORKSPACE` | Resolved `path` is outside all configured roots, no hook, bypass off. |
| `SENSITIVE` | `path` matches a sensitive-pattern deny list, no hook. |
| `PERMISSION_DENIED` | Hook denied the search. |
| `TIMEOUT` | Search exceeded the session deadline (see §7). |
| `IO_ERROR` | Unexpected filesystem / backend failure; preserve `cause`. |

Error message format:

```text
Error [{code}]: {human message}
```

`INVALID_REGEX` is critical: surface ripgrep's position/character diagnostic verbatim so the model can fix its pattern. Example:

```text
Error [INVALID_REGEX]: regex parse error:
    interface{}
             ^
error: repetition operator missing expression

Hint: escape literal regex metacharacters (e.g. `interface\\{\\}` for `interface{}`), or switch to a character-class form.
```

The hint is appended by the tool, not ripgrep. It is the difference between the model giving up and self-correcting.

---

## 4. Size and shape bounds

All caps apply together. Hit whichever first.

| Constant | Default | Override |
|---|---|---|
| `DEFAULT_HEAD_LIMIT` | 250 | per-call `head_limit` |
| `MAX_LINE_LENGTH` (chars per line in `content` mode) | 2000 | session config |
| `MAX_BYTES` (output payload) | 51200 (50 KB) | session config |
| `MAX_FILE_SIZE_INPUT` (skip files larger) | 5 MB | session config |
| `DEFAULT_TIMEOUT_MS` | 30000 | session config |

Rationale for 250 and 50 KB: matches Read's `MAX_BYTES`. Holding that constant across tools means a model that has learned "this tool costs roughly X tokens" transfers the intuition. Opencode's 100-match cap is lower and has no escape hatch; we trade a bigger default for pagination.

### Per-line truncation (`content` mode)

Lines longer than `MAX_LINE_LENGTH` are truncated and suffixed `... (line truncated to 2000 chars)`. Counted as the truncated length for the byte cap.

### Byte cap

Accumulate UTF-8 byte length of each output line plus 1 (for `\n`). When adding the next match would exceed `MAX_BYTES`, stop; set `more = true` and report `Next offset`.

### Entry cap (`head_limit`)

- `files_with_matches`: unit is files.
- `content`: unit is **matches** (each line reported counts as 1, including context lines).
- `count`: unit is files.

Entries skipped by `offset` are not re-counted.

---

## 5. Search engine

The engine is ripgrep. For the TypeScript implementation, the binding is the npm `ripgrep` package (pi0/ripgrep, WASM-bundled):

- Zero native postinstall, no prebuilt-binary download at install time.
- Works on Node, Bun, Deno uniformly (WASI `proc_exit` handling).
- `ripgrep(args, { buffer: true })` returns `{ code, stdout, stderr }`.
- Exposes `rgPath` (a JS shim) for consumers that want a `spawn`-able binary.
- ships SIMD-accelerated literal matching via `memchr`.

### Why not `@vscode/ripgrep`?

`@vscode/ripgrep` (Microsoft) downloads a prebuilt native binary at postinstall. It has 1.17M downloads/month and is battle-tested, but:

- Postinstall hooks fail in locked-down CI and fresh containers more often than WASM bytes.
- Platform matrix is constrained to what `microsoft/ripgrep-prebuilt` publishes.
- For a library consumed by agent harnesses (which may run in sandboxes, cloud functions, bundled Electron apps), WASM portability wins.

### Why not runtime-download (opencode pattern)?

Opencode rolls its own downloader for rg releases. This is ~200 lines of archive/extract/platform code that duplicates what the npm package already gives us. It's the right choice for a standalone CLI; it's the wrong choice for a library that wants to be dropped into arbitrary environments.

### Engine requirements (invariants implementations must preserve)

Regardless of binding, the implementation must:

- Pass `--json` for structured parsing (paths, line numbers, matches).
- Pass `--no-require-git` so `.gitignore` is honored even when the tree is not a git repo (rg's default requires a `.git` directory to load ignore files). Verified via probe: without this flag, a fresh directory's `.gitignore` is ignored.
- Pass `--no-messages` to suppress "permission denied" file-level chatter that would leak into stderr and confuse the error surface.
- Pass `--glob=!.git/*` to exclude the git directory specifically (defence in depth).
- Pass `--max-filesize=5M` to skip pathologically large files.
- Pass `--max-columns=<MAX_LINE_LENGTH>` so rg truncates mega-lines server-side.
- Not pass `--hidden` by default (the model should not be grepping dotfiles unless asked).
- Not pass `--follow` by default (symlink loops are a denial-of-service vector).

### Process model

- Run ripgrep as a subprocess (or WASI call), streaming its `--json` stdout.
- Apply a per-call timeout (`DEFAULT_TIMEOUT_MS`). On timeout, SIGTERM the process (or abort the WASI call) and return `TIMEOUT` with the partial result count.
- Never load the entire stdout into memory before parsing; stream-parse JSON lines, stopping when `head_limit + offset` matches have been accumulated. This keeps a runaway pattern from wedging the event loop.

---

## 6. Workspace, permissions, and `.gitignore`

### 6.1 Workspace roots

Same as Read §5.1. Search is scoped to the resolved `path`. If `path` is outside all roots and no hook is configured, return `OUTSIDE_WORKSPACE`.

### 6.2 Sensitive paths

Same sensitive-pattern deny list as Read §5.3. If the search root itself matches a sensitive pattern (e.g. searching under `~/.ssh`), return `SENSITIVE` without a hook, or ask via hook.

**Not filtered:** individual file matches under a non-sensitive root. If the model searches `.` and a match lives inside `.env`, that line is included — pattern-based redaction at result time is a separate concern (future §11).

### 6.3 Permission hook

Same signature as Read §5.4 with `tool: "grep"`, `action: "read"`. Hook receives the resolved search root, not each matched file, because an `ask` per match would be unusable.

### 6.4 `.gitignore` / `.ignore` / `.rgignore`

Respected by default. This is the single most important tool-design decision for agent grep: without ignore-file respect, every search produces thousands of `node_modules`/`dist`/`.next` hits and is worse than useless.

- Ripgrep's default behaviour already honors `.gitignore`, `.ignore`, `.rgignore`, `$XDG_CONFIG_HOME/git/ignore`.
- The `--no-require-git` flag is **mandatory** in our invocation so fresh or non-git workspaces still honor a local `.gitignore`.
- Hidden files (`.*`) are skipped by default (we never pass `--hidden`).
- There is no per-call escape hatch. If a workspace truly needs to search `node_modules`, that is a session-config decision (session can configure the engine to pass `--no-ignore-vcs` or `--hidden`), not a parameter the model picks.

Rationale for no escape hatch: giving the model an `include_hidden` or `no_ignore` parameter is a foot-gun. A model that does not find what it wants will flip the flag and flood the context. The right recovery is "narrow your pattern" or "use Glob first to find the file."

---

## 7. Timeouts and abort

- Default per-call timeout 30s. Overridable via session config.
- Must respect a session-provided `AbortSignal` (TS) / `CancellationToken` (Rust).
- On timeout, return `TIMEOUT` with `partial_count` in the error metadata so the model can decide whether to re-run with a narrower scope.

---

## 8. Pagination semantics

`offset` and `head_limit` together give `tail -n +N | head -N` semantics, identical to Read's offset/limit and Claude Code's Grep pagination. This is a deliberate cross-tool invariant.

- First page: `offset = 0, head_limit = 250` (default).
- Next page: `offset = previous_offset + returned_count`.
- `offset >= total` returns an empty page with a hint, not an error. This mirrors Read §2's decision that `offset > total_lines` is an error — but for search, zero matches is a valid answer and should not look like a failure.

### Stability

For pagination to be useful, the result set must be stable between calls on an unchanged tree:

- Files sorted by **mtime descending, path ascending** as tie-breaker. Mtime alone is not stable across filesystems with second-granularity timestamps.
- Within a file, lines sorted ascending by line number.
- If a file's mtime changes between pages, pagination may skip or repeat entries. This is acceptable; the model can notice (duplicate path in the output) and re-query.

---

## 9. Ledger integration

Grep does not participate in the read ledger. The ledger's contract is "Edit refuses to mutate a file that has not been read" — a grep match is not a read of the file's full content, and counting it as such would let the model bypass the gate by grepping once and editing without understanding the surroundings.

This is an explicit no; the opencode/Claude Code ecosystems both separate search from the read-before-edit invariant.

---

## 10. Pluggable backend

All engine calls route through an abstract interface so a future Rust implementation, an SSH-remote backend, or a cloud-indexed backend can substitute:

```text
interface GrepEngine {
  search(input: {
    pattern: string,
    root: string,
    glob?: string,
    type?: string,
    caseInsensitive?: bool,
    multiline?: bool,
    contextBefore?: int,
    contextAfter?: int,
    maxColumns: int,
    maxFilesize: int,
    signal?: AbortSignal,
  }): AsyncIterable<RgMatch>

  // RgMatch = { path, lineNumber, text, isContext }
}
```

The default implementation wraps pi0/ripgrep. Implementations are free to cache, batch, or precompute indexes — as long as the output contract in §3 is preserved.

---

## 11. Determinism and idempotence

Two searches of the same unchanged tree with identical parameters produce byte-identical output. No clocks, no randomness, stable sort.

---

## 12. Concurrency

Multiple concurrent greps in the same session are allowed and independent. There is no grep-grep serialization. Grep does not take the per-path read mutex (§12 in Read) because it never opens files through the `ReadOperations` interface — it delegates to rg.

---

## 13. Tests (acceptance matrix — both languages must pass equivalents)

Full test catalogue lives in `agent-knowledge/design/grep.tests.md` (to be drafted alongside TS implementation).

### 13.1 Unit (code correctness)

1. Empty pattern → `INVALID_PARAM`.
2. `interface{}` unescaped → `INVALID_REGEX` with hint about escaping.
3. `context_before` with `output_mode: files_with_matches` → `INVALID_PARAM`.
4. `path` outside workspace, no hook → `OUTSIDE_WORKSPACE`.
5. `path` matches sensitive pattern, no hook → `SENSITIVE`.
6. Non-existent `path` → `NOT_FOUND` with sibling suggestions.
7. `.gitignore` excludes a file → not in results (verified with and without `.git` dir present).
8. Hidden file (`.secret`) → not in results.
9. `node_modules/` → not in results.
10. 10 MB file in tree → skipped (`max-filesize`).
11. Single 100 KB line matching → truncated to `MAX_LINE_LENGTH` with `... (truncated)` suffix.
12. Pattern produces 10000 matches → output stops at `head_limit`, next-offset hint points at `head_limit`.
13. `offset >= total` → empty body with hint, not an error.
14. Two files with same mtime → tiebroken by path ascending (deterministic output).
15. Timeout → `TIMEOUT` with partial count.
16. `output_mode: count` → per-file counts, alphabetical path order.
17. `output_mode: content` with `-C 2` → 2 lines before/after each match; context lines use same format.
18. Multiline pattern `class.*?foo` with `multiline: true` → matches cross-line; without the flag → no match.
19. `case_insensitive: true` makes `Foo` match `foo`.
20. `type: "ts"` restricts to `.ts` (rg `--type ts`).
21. `glob: "*.{ts,tsx}"` restricts equivalently; `glob` + `type` together narrow (AND).

### 13.2 LLM e2e (model-contract validation, see AGENTS.md §"What counts as a test")

E2E suites live in `packages/harness-e2e/test/grep.e2e*.ts` and exercise real models. Minimum categories:

- **G1 golden**: "Find where `handleRequest` is defined." Expect: one Grep call in `files_with_matches` mode (cheap), one follow-up Grep in `content` mode or one Read.
- **G2 refine**: first query is too broad (>250 matches). Expect: the continuation hint is used to paginate, or the model narrows the pattern.
- **G3 escape**: user asks "find all Go interface declarations `interface{}`". Expect: the model escapes to `interface\\{\\}`, or (acceptable) gets `INVALID_REGEX` once and recovers.
- **G4 bash-decoy**: shell is available alongside grep. Expect: the model prefers `grep` tool over shelling out to `rg`/`grep`/`find`.
- **G5 gitignore respect**: tree has matches in `node_modules` and in source. Expect: model gets source-only hits and doesn't manually filter.
- **G6 mode selection**: "are there any TODOs?" expects `files_with_matches` or `count`, not `content`. The model should pick the cheap mode.
- **G7 context-aware**: "show me the body of the function that handles auth." Expect: `content` mode with `-C` ≥ 5, not a dump of every matching line.
- **G8 pagination exhaust**: scripted fixture with 600 matches. Expect: at most three Grep calls to cover the result set, using offset from the continuation hint.

Multi-model coverage follows the matrix policy in `memory/project_matrix_policy.md`: default matrix is 2× Gemma 4 + 2× Qwen local; Bedrock reserved for per-new-tool and release gates.

---

## 14. Stability

Breaking changes bump the spec major. Additions (new error codes, new output-mode fields) are minor. Error `code` values are a public contract and cannot be renamed without a major bump — the model has learned to act on them.

---

## 15. Open questions (deferred)

- **Ripgrep PCRE2 mode**: enabled via `--pcre2` / `-P`. Not exposed yet; adds lookaround at the cost of linear-time guarantees. Revisit once we see evidence models want it.
- **Binary result shape for MCP transport**: current spec assumes text over a JSON tool result. An MCP server wrapping this tool may want to emit the discriminated union as structured content. Out of scope for v1.
- **Result caching**: two greps of the same tree with the same pattern could share work via an index. Deferred until we measure the cost on real agent sessions; premature for v1.
- **Workspace-wide index**: Aider's repo-map is a precomputed identifier graph that subsumes many "where is X" greps. Considered and rejected for v1 because it's a different primitive and would pressure the grep surface to shrink in ways we don't yet understand.

---

## 16. References

OSS implementations studied in forming this spec:

- `sst/opencode` — `packages/opencode/src/tool/grep.ts` + `packages/opencode/src/file/ripgrep.ts`. Primary inspiration for output grouping, mtime sort, 2000-char line truncation, `--no-messages` / `--no-require-git` / `--glob=!.git/*` argument set.
- `anthropics` Claude Code — Grep tool description and parameter surface. Primary inspiration for `output_mode` design, `head_limit`+`offset` pagination, the escape-metacharacter hint.
- `microsoft/vscode-ripgrep` — considered as a binding; rejected in favor of pi0/ripgrep WASM (see §5).
- `pithings/ripgrep-node` (pi0) — the chosen TS engine. Probed 2026-04-20: `.gitignore` respect confirmed with `--no-require-git`, warm search ~80ms on a 15-file dir, JSON streaming works.
- `cline/cline` — `search_files` XML tool. Informed the `path` + regex + glob shape; rejected Cline's always-content default in favor of the cheaper files-with-matches default.
- `BurntSushi/ripgrep` user guide — regex syntax, `--type` vs `--glob`, multiline semantics. The description-level guidance in §2 is lifted from this doc.
- `agent-knowledge/agent-search-tools.md` — the prior cross-harness research pass that frames the "two primitives" split and the token-budget math.

---

## Addendum: decision log

- **D1** (Q1): Engine = pi0/ripgrep WASM. Trade-off accepted: younger package (0.3.1, ~13K downloads/mo) vs. `@vscode/ripgrep`'s 1.17M. Chosen for postinstall-free install and uniform Node/Bun/Deno support — critical for a library consumed by arbitrary harnesses.
- **D2** (Q2): Default `output_mode = files_with_matches`. Matches Claude Code; token-efficient by default; model opts into `content` deliberately. Trade-off accepted: more schema surface than opencode's always-content design.
- **D3** (Q3): Pagination via `head_limit` + `offset`, default 250. Matches Claude Code and our own Read tool, so the model learns one pagination pattern. Trade-off accepted: more complex than opencode's hard 100-cap, but gives a deterministic escape route.
- **D4** (Q4, prior session): Respect `.gitignore` by default, no per-call escape hatch. Non-negotiable for agent-grep usability. Session config may relax for exotic workspaces.
- **D5**: No `replace_all` / mutation. Read-only tool. Mutations belong to Edit / MultiEdit.
- **D6**: Grep does not participate in the read-ledger. Grep is not a substitute for Read as an Edit precondition.
- **D7**: Tool timeout default 30s with abort. Runaway patterns must not wedge the session.
- **D8**: `INVALID_REGEX` appends an escape-metacharacter hint after ripgrep's error. This hint is the difference between the model giving up and self-correcting — verified as a failure mode in `agent-knowledge/agent-search-tools.md`.
