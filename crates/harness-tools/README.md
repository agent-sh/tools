# harness-tools

Umbrella crate re-exporting every `harness-*` AI agent tool under one dependency.

Rust port of [`@agent-sh/harness-tools`](https://www.npmjs.com/package/@agent-sh/harness-tools). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```toml
[dependencies]
harness-tools = "0.1"
```

## Usage

Each tool is re-exposed as a submodule. Import what you need:

```rust
use harness_tools::{read, write, grep, glob, bash, webfetch, websearch, lsp, skill};
// e.g.
let r = read::read(serde_json::json!({ "path": "src/main.rs" }), &session).await;
```

If you only need one tool, depend on its individual crate (for example [`harness-read`](https://crates.io/crates/harness-read)) to cut compile time.

## The ten tools

| Tool | Purpose |
|---|---|
| [`harness-core`](https://crates.io/crates/harness-core) | Shared types: errors, permission policy, operation adapters. |
| [`harness-read`](https://crates.io/crates/harness-read) | Safe bounded file reading with pagination + binary refusal. |
| [`harness-write`](https://crates.io/crates/harness-write) | Atomic write + edit + multi-edit with read-before-edit ledger. |
| [`harness-grep`](https://crates.io/crates/harness-grep) | ripgrep-backed search with discriminated output modes. |
| [`harness-glob`](https://crates.io/crates/harness-glob) | File discovery by pattern, ignore-aware. |
| [`harness-bash`](https://crates.io/crates/harness-bash) | Shell with cwd-carry + timeouts + background jobs. |
| [`harness-webfetch`](https://crates.io/crates/harness-webfetch) | HTTP with SSRF defense + readability markdown extraction. |
| [`harness-websearch`](https://crates.io/crates/harness-websearch) | Web search via a session-configured SearXNG backend. |
| [`harness-lsp`](https://crates.io/crates/harness-lsp) | Language-server operations with 1-indexed positions. |
| [`harness-skill`](https://crates.io/crates/harness-skill) | [Agent Skills](https://agentskills.io) activation. |

## License

MIT © Avi Fenesh
