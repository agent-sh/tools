# harness-core

Shared foundation for `harness-*` Rust tools — types, errors, permission policies.

Rust port of [`@agent-sh/harness-core`](https://www.npmjs.com/package/@agent-sh/harness-core). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-core = "0.1"
```

## Usage

```rust
use harness_core::{ToolError, ToolErrorCode, format_tool_error};

let err = ToolError::new(ToolErrorCode::NotFound, "File not found");
println!("{}", format_tool_error(&err)); // "Error [NOT_FOUND]: File not found"
```

## Contract

Foundation crate; see the per-tool crates it supports for concrete contracts.

## License

MIT © Avi Fenesh
