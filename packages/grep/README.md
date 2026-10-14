# @agent-sh/harness-grep

ripgrep-backed content search with discriminated `output_mode`, regex-escape hints, and pagination.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-grep
```

Requires Node ≥ 20.

## Usage

```ts
import { grep } from "@agent-sh/harness-grep";

const r = await grep(
  { pattern: "TODO", output_mode: "content", glob: "**/*.ts", context_before: 2, context_after: 2 },
  { cwd: process.cwd(), permissions: { roots: [process.cwd()], sensitivePatterns: [] } },
);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/grep.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/grep.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
