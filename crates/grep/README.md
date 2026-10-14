# harness-grep

ripgrep-backed content search with discriminated `output_mode`, regex-escape hints, and pagination.

Rust port of [`@agent-sh/harness-grep`](https://www.npmjs.com/package/@agent-sh/harness-grep). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-grep = "0.1"
```

## Usage

```rust
use harness_grep::{grep, GrepSessionConfig};
use harness_core::PermissionPolicy;
use serde_json::json;

let perms = PermissionPolicy::new(vec!["/workspace".into()]);
let session = GrepSessionConfig::new("/workspace", perms);
let r = grep(json!({ "pattern": "TODO", "output_mode": "content" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/grep.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/grep.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-grep`](https://www.npmjs.com/package/@agent-sh/harness-grep).

## License

MIT © Avi Fenesh
