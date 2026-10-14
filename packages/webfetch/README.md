# @agent-sh/harness-webfetch

HTTP GET/POST with tool-layer SSRF defense, readability+markdown extraction, redirect-chain reporting, and per-session cache.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Install

```sh
npm install @agent-sh/harness-webfetch
```

Requires Node ≥ 20.

## Usage

```ts
import { webfetch, makeSessionCache } from "@agent-sh/harness-webfetch";

const session = {
  permissions: { roots: [], sensitivePatterns: [], unsafeAllowFetchWithoutHook: true },
  cache: makeSessionCache(),
};

const r = await webfetch({ url: "https://example.com", extract: "markdown" }, session);
```

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/webfetch.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/webfetch.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
