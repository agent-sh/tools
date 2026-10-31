# @agent-sh/harness-webfetch

HTTP GET/POST with tool-layer SSRF defense, readability+markdown extraction, redirect-chain reporting, and per-session cache.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface.

## Use from Claude Code or Codex (no code)

[`@agent-sh/harness-web-mcp`](https://www.npmjs.com/package/@agent-sh/harness-web-mcp) serves this tool (together with `websearch`) over MCP:

```sh
claude mcp add -s user harness-web -- npx -y @agent-sh/harness-web-mcp
codex mcp add harness-web -- npx -y @agent-sh/harness-web-mcp
```

SSRF defenses stay on; `HARNESS_WEB_FETCH_ALLOW_LOOPBACK=1` opts into localhost. See the [web-mcp README](https://github.com/agent-sh/tools/tree/main/packages/web-mcp#readme) for configuration and config-file setups.

## Install

```sh
npm install @agent-sh/harness-webfetch
```

Requires Node 22.22.2+, 24.15.0+ or 26+.

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
