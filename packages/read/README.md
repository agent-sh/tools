# @agent-sh/harness-read

Safe, bounded, line-numbered file reading with pagination, binary refusal, and fuzzy-sibling NOT_FOUND.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-read
```

Requires Node ≥ 20.

## Usage

```ts
import { read } from "@agent-sh/harness-read";

const r = await read(
  { path: "src/index.ts", offset: 1, limit: 200 },
  { cwd: process.cwd(), permissions: { roots: [process.cwd()], sensitivePatterns: [] } },
);

if (r.kind === "text") console.log(r.output);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/read.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/read.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
