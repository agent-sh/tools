# harness-glob

File discovery by pattern. Ignore-aware, mtime-sorted, workspace-fenced.

Rust port of [`@agent-sh/harness-glob`](https://www.npmjs.com/package/@agent-sh/harness-glob). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-glob = "0.1"
```

## Usage

```rust
use harness_glob::{glob, GlobSessionConfig};
use harness_core::PermissionPolicy;
use serde_json::json;

let perms = PermissionPolicy::new(vec!["/workspace".into()]);
let session = GlobSessionConfig::new("/workspace", perms);
let r = glob(json!({ "pattern": "**/*.rs" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/glob.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/glob.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-glob`](https://www.npmjs.com/package/@agent-sh/harness-glob).

## License

MIT © Avi Fenesh
