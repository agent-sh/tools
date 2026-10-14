# @agent-sh/harness-core

Shared foundation for `@agent-sh/harness-*` tools — types, errors, permission policies, operation adapters.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## What it is

This is a runtime-only dependency of every other harness tool. You typically don't import it directly — installing any `@agent-sh/harness-<tool>` package pulls it in.

## Install

```sh
npm install @agent-sh/harness-core
```

Requires Node ≥ 20.

## Usage

```ts
import { toolError, formatToolError, type PermissionPolicy } from "@agent-sh/harness-core";

const err = toolError("NOT_FOUND", "File not found", { meta: { path: "/x" } });
console.log(formatToolError(err)); // "Error [NOT_FOUND]: File not found"
```

## Contract

This is a foundation package; see the per-tool packages it supports for concrete contracts.

## License

MIT © Avi Fenesh
