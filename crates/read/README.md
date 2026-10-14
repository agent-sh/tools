# harness-read

Safe, bounded, line-numbered file reading with pagination, binary refusal, and fuzzy-sibling NOT_FOUND.

Rust port of [`@agent-sh/harness-read`](https://www.npmjs.com/package/@agent-sh/harness-read). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-read = "0.1"
```

## Usage

```rust
use harness_read::{read, ReadSessionConfig};
use harness_core::PermissionPolicy;
use serde_json::json;

let perms = PermissionPolicy::new(vec!["/workspace".into()]);
let session = ReadSessionConfig::new("/workspace", perms);
let r = read(json!({ "path": "/workspace/src/main.rs" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/read.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/read.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-read`](https://www.npmjs.com/package/@agent-sh/harness-read).

## License

MIT © Avi Fenesh
