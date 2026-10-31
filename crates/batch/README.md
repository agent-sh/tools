# harness-batch

Run one shell command across many directories: subdirectories of a path, a glob, or an explicit list. Sequential or parallel, with per-target timeouts, fail-fast and summary-only output.

Rust port of [`@agent-sh/harness-batch`](https://www.npmjs.com/package/@agent-sh/harness-batch). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo. See the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-batch = "0.1"
```

## Usage

```rust
use harness_batch::run::{execute_batch, BatchResponse};
use harness_batch::schema::safe_parse_batch_params;
use serde_json::json;

let params = safe_parse_batch_params(&json!({
    "command": "git status --short",
    "targets": { "kind": "subdirs", "path": "/workspace" },
    "mode": "parallel"
}))?;
match execute_batch(&params, Some("/workspace")).await? {
    BatchResponse::Summary(s) => println!("{}", s.message),
    BatchResponse::Detailed(d) => println!("{}", d.message),
}
```

Each command runs with `bash -c` in the target directory, with `$TARGET` set to that path. Defaults: sequential mode, `max_concurrent` 4, `timeout_secs` 120.

`batch` has no permission hook. `execute_batch` only drops targets that resolve outside the `workspace_root` you pass; gate the call yourself before running a model's command.

## Contract

The contract lives in [`agent-knowledge/design/batch.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/batch.md).

## License

MIT © Avi Fenesh
