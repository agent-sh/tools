# @agent-sh/harness-write

## 0.9.1

### Patch Changes

- Updated dependencies
  - @agent-sh/harness-core@0.9.1
  - @agent-sh/harness-read@0.9.1

## 0.6.0

### Minor Changes

- f9d7eca: Rename the MultiEdit tool's canonical name from `multiedit` to `multi_edit`, matching the `multiEdit` entry point and the snake_case convention of the other multi-word tool names (`bash_output`, `bash_kill`).

  **Deprecation, not removal** — the old spelling keeps working during a migration window:

  - `MULTIEDIT_TOOL_NAME` is now `"multi_edit"`; `multieditToolDefinition.name` follows it, so registries pick up the new name on upgrade.
  - The old spelling is still exported as `MULTIEDIT_TOOL_NAME_LEGACY` (`"multiedit"`, marked `@deprecated`).
  - New `isMultiEditToolName(name)` pure matcher accepts both spellings; new `normalizeMultiEditToolName(name)` maps both to the canonical name and emits a one-time `DeprecationWarning` per process when it sees the legacy one — use it at dispatch points (`warnLegacyMultiEditToolName()` is also exported directly).
  - The pi extension in `@agent-sh/harness-tools` now registers the tool as `multi_edit`.
  - Permission hooks now receive `tool: "multi_edit"` on **every** query a MultiEdit call makes — both the path fence and the fail-open read-before-mutate (`action: "write_unread"`) query. **This label changes as soon as you upgrade**: if your hook matches `tool === "multiedit"`, update it to `multi_edit` (or match via `isMultiEditToolName`) when upgrading.

  The `multiedit` spelling will be removed in a future major release. If you hardcode the tool name anywhere (registries, allowlists, permission hooks, log filters), migrate to `multi_edit` or match via `isMultiEditToolName`.

## 0.4.0

### Minor Changes

- 9c3b9f5: Harness tool hardening — fixes for failure modes surfaced by real-model use.

  - **tools**: wire a shared per-process `InMemoryLedger` into the read and
    write/edit sessions. Previously neither session carried a ledger, so Read
    recorded nothing and every Edit/Write hit `NOT_READ_THIS_SESSION` and
    hard-denied — pushing models to fall back to `cat`/`sed` via Bash. The
    read-before-edit gate now works as designed.
  - **write**: preserve the file's original line endings (and BOM) on edit. Edits
    matched on CRLF→LF-normalized content but wrote the normalized (LF) bytes back,
    silently converting CRLF files to LF. Matching stays normalized; output keeps
    the file's convention.
  - **write**: the read-gate now fails open per Read spec D11 — a missing ledger
    entry asks the permission hook (deny only on explicit deny) or proceeds with a
    warning when no hook is wired, instead of a hard deny. `STALE_READ` stays hard.
  - **read**: read the file once for both content and sha256 (was reading twice);
    remove env-gated debug `console.error` from shipped source.
  - **grep**: add `fixed_strings` for literal search (ripgrep `-F`), skipping the
    regex compile-probe; `INVALID_REGEX` now points to it as the escape-free path.
  - **bash**: tool description steers stalling network calls (curl/wget) to
    `background: true` or an explicit client timeout, alongside servers/watchers.

### Patch Changes

- Updated dependencies [9c3b9f5]
  - @agent-sh/harness-read@0.4.0

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
  - @agent-sh/harness-read@0.2.0
