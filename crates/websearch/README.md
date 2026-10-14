# harness-websearch

Web search for AI agent harnesses — **works with no API key and no setup**. With nothing configured it queries a bundled keyless fallback chain (Exa → Parallel → Mojeek → Marginalia → Wikipedia) and returns the first backend that has results. Exa and Parallel run their own web indexes and are reached through their official keyless MCP endpoints. Optionally upgrade to Brave/Tavily (API key) or a self-hosted SearXNG. Tool-layer SSRF defense, a permission hook, a result-count cap, engine provenance, and a discriminated `ok`/`empty`/`error` result surface.

Rust port of [`@agent-sh/harness-websearch`](https://www.npmjs.com/package/@agent-sh/harness-websearch). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context. WebSearch finds; [`webfetch`](https://github.com/agent-sh/tools/tree/main/crates/webfetch) reads — they compose.

## Install

```toml
[dependencies]
harness-websearch = "0.1"
```

## Usage

Zero-config — keyless, just works:

```rust
use harness_websearch::{websearch, WebSearchSessionConfig, WebSearchPermissionPolicy};
use harness_core::PermissionPolicy;
use serde_json::json;

let perms = WebSearchPermissionPolicy::new(PermissionPolicy::new(vec![]))
    .with_unsafe_bypass(true);
let session = WebSearchSessionConfig::auto(perms); // keyless chain
let r = websearch(json!({ "query": "rust async runtime benchmarks" }), &session).await;
// The served-by engine is in r's metadata (e.g. "exa").
```

Upgrade to a keyed provider, or a self-hosted SearXNG:

```rust
let mut brave = WebSearchSessionConfig::auto(perms.clone());
brave.brave_api_key = Some(std::env::var("BRAVE_API_KEY").unwrap());

let mut searxng = WebSearchSessionConfig::auto(perms);
searxng.searxng_url = Some("http://127.0.0.1:8888".to_string());
searxng.allow_loopback = true; // a self-hosted SearXNG usually runs on localhost
// An explicit backend is exclusive by default; set fallback_to_keyless = true
// to append the keyless chain as a backstop. disable_mojeek drops the scrape engine.

// Put the hosted AI indexes ahead of SearXNG with an explicit chain. This
// replaces the default ordering and ignores the disable_* flags.
searxng.engine_order = Some(vec!["exa".into(), "parallel".into(), "searxng".into(), "mojeek".into()]);
```

Exa and Parallel are keyless by default (rate-limited free tiers); `exa_api_key` / `parallel_api_key` raise their limits, and `disable_exa` / `disable_parallel` drop them from the default chain. Their long page excerpts are reduced to the passage that matches the query before the snippet cap applies.

`WebSearchSessionConfig::new(perms, default_engine())` still works (back-compat) and pins the SearXNG engine as an explicit override.

## Contract

The full contract lives in [`agent-knowledge/design/websearch.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/websearch.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-websearch`](https://www.npmjs.com/package/@agent-sh/harness-websearch).
