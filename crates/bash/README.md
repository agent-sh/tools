# harness-bash

Shell with cwd-carry, inactivity + wall-clock timeouts, head+tail spill-to-file on overflow, and background jobs.

Rust port of [`@agent-sh/harness-bash`](https://www.npmjs.com/package/@agent-sh/harness-bash). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-bash = "0.1"
```

## Usage

```rust
use harness_bash::{bash, BashSessionConfig, BashPermissionPolicy, default_executor};
use harness_core::PermissionPolicy;
use serde_json::json;

let perms = BashPermissionPolicy::new(PermissionPolicy::new(vec!["/workspace".into()]))
    .with_unsafe_bypass(true);
let session = BashSessionConfig::new("/workspace", perms, default_executor())
    .with_logical_cwd_carry();
let r = bash(json!({ "command": "ls -la" }), &session).await;
```

## Contract

The full contract lives in [`agent-knowledge/design/bash.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/bash.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-bash`](https://www.npmjs.com/package/@agent-sh/harness-bash).

## License

MIT © Avi Fenesh
