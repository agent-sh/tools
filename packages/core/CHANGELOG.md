# @agent-sh/harness-core

## 0.9.1

### Patch Changes

- Publish the current Valibot ^1.5.0 dependency manifests. The previous versions of these four packages still install older vulnerable Valibot releases; the source and workspace tests already use 1.5.0. Dependent harness packages receive patch updates so fresh installs use the validated dependency graph.

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
