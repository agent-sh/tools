# @agent-sh/harness-webfetch

## 0.8.1

### Patch Changes

- f233528: README: point to `@agent-sh/harness-web-mcp` for using the tool from Claude Code or Codex with one `mcp add` command.

## 0.7.1

### Patch Changes

- 008f1a6: Cap large shell and web fetch outputs to bounded previews while spilling full content to disk.

  WebFetch now returns a 64 KB head/tail preview for spilled raw responses and keeps default HTML output on the cleaned markdown path unless raw HTML is explicitly requested.

  Bash now renders capped stdout/stderr as head/tail previews, keeps the full log on disk, and steers capped curl/wget page output back to WebFetch for cleaned content.

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
