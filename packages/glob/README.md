# @agent-sh/harness-glob

File discovery by pattern. Ignore-aware, mtime-sorted, workspace-fenced.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-glob
```

Requires Node ≥ 20.

## Usage

```ts
import { glob } from "@agent-sh/harness-glob";

const r = await glob(
  { pattern: "**/*.ts", head_limit: 100 },
  { cwd: process.cwd(), permissions: { roots: [process.cwd()], sensitivePatterns: [] } },
);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/glob.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/glob.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
