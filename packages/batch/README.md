# @agent-sh/harness-batch

Run one shell command across many directories: subdirectories of a path, a glob, or an explicit list. Sequential or parallel, with per-target timeouts, fail-fast and summary-only output.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo. See the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-batch
```

Requires Node ≥ 20.

## Usage

```ts
import { executeBatch, safeParseBatchParams } from "@agent-sh/harness-batch";

const parsed = safeParseBatchParams({
  command: "git status --short",
  targets: { kind: "subdirs", path: process.cwd() },
  mode: "parallel",
});

if (parsed.ok) {
  const r = await executeBatch(parsed.value, process.cwd());
  console.log(r.message);
}
```

Each command runs with `bash -c` in the target directory, with `$TARGET` set to that path. Defaults: `mode: "sequential"`, `max_concurrent: 4`, `timeout_secs: 120`.

`batch` has no permission hook. `executeBatch` only drops targets that resolve outside the `workspaceRoot` you pass; gate the call yourself before running a model's command.

## Contract

The contract lives in [`agent-knowledge/design/batch.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/batch.md).

## License

MIT © Avi Fenesh
