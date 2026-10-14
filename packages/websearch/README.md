# @agent-sh/harness-websearch

Web search for AI agent harnesses — **works with no API key and no setup**. With nothing configured it queries a bundled keyless fallback chain (Exa → Parallel → Mojeek → Marginalia → Wikipedia) and returns the first backend that has results. Exa and Parallel run their own web indexes and are reached through their official keyless MCP endpoints. Optionally upgrade to Brave/Tavily (API key) or a self-hosted SearXNG for higher coverage — same tool, same output. Tool-layer SSRF defense, declarative provider-neutral query controls, a result-count cap, engine provenance, and a discriminated result surface.

Part of the [`@agent-sh/harness-*`](https://github.com/agent-sh/tools) monorepo — see the top-level README for architectural context and the full tool surface. WebSearch finds URLs; [`webfetch`](../webfetch) reads them. They compose.

## Use from Claude Code or Codex (no code)

[`@agent-sh/harness-web-mcp`](../web-mcp) serves this tool (together with `webfetch`) over MCP:

```sh
claude mcp add -s user harness-web -- npx -y @agent-sh/harness-web-mcp
codex mcp add harness-web -- npx -y @agent-sh/harness-web-mcp
```

Search works with no API key. Add a Brave, Tavily or SearXNG backend with an env var, e.g. `-e BRAVE_API_KEY=...` (Claude Code) or `--env BRAVE_API_KEY=...` (Codex). See the [web-mcp README](../web-mcp#readme) for configuration and config-file setups.

## Install

```sh
npm install @agent-sh/harness-websearch
```

Requires Node ≥ 20.

## Usage

Zero-config — keyless, just works:

```ts
import { websearch } from "@agent-sh/harness-websearch";

const session = {
  permissions: { roots: [], sensitivePatterns: [], unsafeAllowSearchWithoutHook: true },
};

const r = await websearch({ query: "rust async runtime benchmarks", count: 5 }, session);
// r.meta.engine tells you which backend served the results (e.g. "exa").
```

Upgrade to a reliable keyed provider, or a self-hosted SearXNG:

```ts
// Brave (recommended; free tier at api-dashboard.search.brave.com):
const braveSession = { ...session, braveApiKey: process.env.BRAVE_API_KEY };

// Self-hosted SearXNG (loopback opt-in since it's usually on localhost):
const searxngSession = { ...session, searxngUrl: "http://127.0.0.1:8888", allowLoopback: true };

// An explicit backend is exclusive by default; opt into the keyless tail as a backstop:
const withFallback = { ...braveSession, fallbackToKeyless: true };
```

Notes:
- Exa and Parallel are keyless by default (rate-limited free tiers). `exaApiKey` / `parallelApiKey` raise their limits. `disableExa: true` / `disableParallel: true` drop them, since the query is sent to those companies.
- Both return long page excerpts. The tool picks the passage that matches the query (skipping page chrome like "Skip to main content") before trimming it to `snippetCap`.
- `engineOrder` lets a harness set the exact chain, e.g. `["exa", "parallel", "searxng", "mojeek"]` to put the AI indexes ahead of a self-hosted SearXNG. It replaces the default ordering and ignores the `disable*` flags and `fallbackToKeyless`. A keyed engine listed without its key, or `searxng` without `searxngUrl`, fails with `INVALID_PARAM`.
- `disableMojeek: true` drops the Mojeek scrape engine (its robots.txt disallows `/search`; the documented Marginalia/Wikipedia APIs remain).
- `snippetCap` tunes the per-result snippet length (default 240 chars; clamped 80–600) to trade detail for tokens.
- When the leading backend returns fewer than `count`, the tool **gathers and merges** results across the chain (de-duplicating the same page by normalized URL) until the quota is met; a backend that already satisfies `count` short-circuits. Merged results are ranked by **Reciprocal Rank Fusion + engine weights** (a page multiple engines agree on is boosted; a niche/encyclopedic backstop won't outrank broad web), name the contributing engines in the header, and tag each result with its `source`.
- Output is compact ranked text: a `WEB "query" · engine (class) · N results` header then numbered entries; the engine's coverage class (`general web` / `indie/small-web index` / `encyclopedic`) and per-result `age` (when the backend provides it) are shown so the model can judge source quality and freshness. Parse `meta`/`results`, not the `output` string.
- Zero hits is a normal `kind: "empty"` result, not an error.

## Contract

The full contract — input shape, output discriminated-union, error codes, permission model, and acceptance tests — lives in [`agent-knowledge/design/websearch.md`](https://github.com/agent-sh/tools/blob/main/agent-knowledge/design/websearch.md). Changes to this package must stay in sync with that spec.

## License

MIT © Avi Fenesh
