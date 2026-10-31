# harness-write

Atomic file write + edit + multi-edit with read-before-edit ledger, OLD_STRING_NOT_UNIQUE match locations, fuzzy candidate suggestions.

Rust port of [`@agent-sh/harness-write`](https://www.npmjs.com/package/@agent-sh/harness-write). Part of the [`harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context.

## Install

```toml
[dependencies]
harness-write = "0.3"
```

## Usage

```rust
use harness_write::{edit, WriteSessionConfig, InMemoryLedger};
use harness_core::PermissionPolicy;
use std::sync::Arc;
use serde_json::json;

let perms = PermissionPolicy::new(vec!["/workspace".into()]);
let ledger = Arc::new(InMemoryLedger::new());
let session = WriteSessionConfig::new("/workspace", perms, ledger);
// ... after Read, the read-executor should record into ledger ...
let r = edit(json!({ "path": "...", "old_string": "foo", "new_string": "bar" }), &session).await;
```

## Tool naming

The MultiEdit tool's canonical name is `multi_edit` (`MULTIEDIT_TOOL_NAME`),
matching `fn multi_edit` and the snake_case convention of the other multi-word
tool names. The pre-0.3.0 spelling `multiedit` remains available as the
deprecated `MULTIEDIT_TOOL_NAME_LEGACY`. `is_multi_edit_tool_name()` is a
pure matcher that accepts both spellings; `normalize_multi_edit_tool_name()`
maps both to the canonical name and emits a one-time stderr deprecation
warning for the legacy spelling — use it at dispatch points.
`harness-write-cli` likewise accepts both `multi_edit` and the deprecated
`multiedit` JSON-RPC methods. The `multiedit` alias will be removed in a
future major release — migrate to `multi_edit`.

## Contract

The full contract lives in [`agent-knowledge/design/write.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/write.md). Changes to this crate must stay in sync with that spec, and with the TypeScript sibling at [`@agent-sh/harness-write`](https://www.npmjs.com/package/@agent-sh/harness-write).

## License

MIT © Avi Fenesh
