# harness-webfetch

HTTP GET/POST with tool-layer SSRF defense, readability+markdown extraction, redirect-chain reporting, per-session cache.

Rust port of [`@agent-sh/harness-webfetch`](https://www.npmjs.com/package/@agent-sh/harness-webfetch). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-webfetch = "0.1"
```

## Usage

```rust
use harness_webfetch::{webfetch, WebFetchSessionConfig, WebFetchPermissionPolicy, default_engine};
use harness_core::PermissionPolicy;
use serde_json::json;

let perms = WebFetchPermissionPolicy::new(PermissionPolicy::new(vec![]))
    .with_unsafe_bypass(true);
let session = WebFetchSessionConfig::new(perms, default_engine()).with_cache();
let r = webfetch(json!({ "url": "https://example.com" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/webfetch.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/webfetch.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-webfetch`](https://www.npmjs.com/package/@agent-sh/harness-webfetch).

## License

MIT © Avi Fenesh
