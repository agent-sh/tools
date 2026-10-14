# harness-lsp

Language-server operations (hover, definition, references, symbols, implementation) with 1-indexed positions and `server_starting` retry hints.

Rust port of [`@agent-sh/harness-lsp`](https://www.npmjs.com/package/@agent-sh/harness-lsp). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-lsp = "0.1"
```

## Usage

```rust
use harness_lsp::{lsp, LspSessionConfig, LspPermissionPolicy, SpawnLspClient};
use harness_core::PermissionPolicy;
use std::sync::Arc;
use serde_json::json;

let perms = LspPermissionPolicy::new(PermissionPolicy::new(vec!["/workspace".into()]))
    .with_unsafe_bypass(true);
let client = Arc::new(SpawnLspClient::new());
let session = LspSessionConfig::new("/workspace", perms, client);
let r = lsp(json!({ "operation": "hover", "path": "src/a.ts", "line": 5, "character": 10 }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/lsp.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/lsp.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-lsp`](https://www.npmjs.com/package/@agent-sh/harness-lsp).

## License

MIT © Avi Fenesh
