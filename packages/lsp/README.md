# @agent-sh/harness-lsp

Language-server operations (hover, definition, references, symbols, implementation) with 1-indexed positions and `server_starting` retry hints.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-lsp
```

Requires Node ≥ 20.

## Usage

```ts
import { lsp, createSpawnLspClient } from "@agent-sh/harness-lsp";

const session = {
  cwd: process.cwd(),
  permissions: { roots: [process.cwd()], sensitivePatterns: [], unsafeAllowLspWithoutHook: true },
  client: createSpawnLspClient(),
  manifest: { servers: { typescript: { language: "typescript", extensions: [".ts"], command: ["typescript-language-server", "--stdio"] } } },
};

const r = await lsp({ operation: "definition", path: "src/a.ts", line: 5, character: 17 }, session);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/lsp.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/lsp.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
