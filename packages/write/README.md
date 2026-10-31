# @agent-sh/harness-write

Atomic file write + `edit` + `multi_edit` with read-before-edit ledger, OLD_STRING_NOT_UNIQUE match locations, and fuzzy candidate suggestions on miss.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-write
```

Requires Node ≥ 20.

## Usage

```ts
import { edit } from "@agent-sh/harness-write";
import { InMemoryLedger } from "@agent-sh/harness-core";

const ledger = new InMemoryLedger();
// ... after the model Reads the file, the read-executor records into ledger ...
const r = await edit(
  { path: "src/index.ts", old_string: "old", new_string: "new" },
  { cwd: process.cwd(), permissions: { roots: [process.cwd()], sensitivePatterns: [] }, ledger },
);
```

## Tool naming

The MultiEdit tool's canonical name is `multi_edit` (exported as
`MULTIEDIT_TOOL_NAME`), matching the `multiEdit` entry point and the snake_case
convention of the other multi-word tool names (`bash_output`, `bash_kill`).
The pre-0.6.0 spelling `multiedit` is still exported as
`MULTIEDIT_TOOL_NAME_LEGACY`. `isMultiEditToolName()` is a pure matcher that
accepts both spellings; `normalizeMultiEditToolName()` maps both to the
canonical name and emits a one-time `DeprecationWarning` when it sees the
legacy spelling — use it at dispatch points. Permission hooks receive
`tool: "multi_edit"` on every query a MultiEdit call makes. The `multiedit`
alias will be removed in a future major release — migrate registrations and
any hardcoded name matching to `multi_edit`.

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/write.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/write.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
