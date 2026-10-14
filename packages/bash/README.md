# @agent-sh/harness-bash

Shell with tokio-style cwd-carry, inactivity + wall-clock timeouts, head+tail spill-to-file on overflow, and background jobs.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-bash
```

Requires Node ≥ 20.

## Usage

```ts
import { bash, bash_output, bash_kill, createLocalBashExecutor } from "@agent-sh/harness-bash";

const session = {
  cwd: process.cwd(),
  permissions: { roots: [process.cwd()], sensitivePatterns: [], unsafeAllowBashWithoutHook: true },
  executor: createLocalBashExecutor(),
  logicalCwd: { value: process.cwd() },
};

const r = await bash({ command: "ls -la" }, session);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/bash.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/bash.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
