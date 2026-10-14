# @agent-sh/harness-websearch

## 0.8.1

### Patch Changes

- f233528: README: point to `@agent-sh/harness-web-mcp` for using the tool from Claude Code or Codex with one `mcp add` command.

## 0.8.0

### Minor Changes

- 7d594f1: Exa and Parallel lead the keyless chain.

  With nothing configured, `websearch` now tries Exa, then Parallel, before Mojeek, Marginalia and Wikipedia. Both run their own web indexes and are reached through their official keyless MCP endpoints, so the default no longer leads with a scrape that bot-blocks.

  - New engines `exa` and `parallel`. They take optional `exaApiKey` / `parallelApiKey` to raise their rate limits and can be opted out with `disableExa` / `disableParallel`.
  - Their long page excerpts are reduced to the passage that matches the query, skipping page chrome, before the snippet cap applies. TS and Rust pick the same passage.
  - New harness-only `engineOrder` session option sets the exact engine chain (for example, AI indexes ahead of a self-hosted SearXNG). Invalid names or missing keys fail with `INVALID_PARAM`.
  - Any MCP-level failure (HTTP error, JSON-RPC error, `isError` result) is `SERVER_NOT_AVAILABLE`, never `INVALID_PARAM`.
  - Behavior change: the zero-config chain sends the query to Exa and Parallel first. Set `disableExa` / `disableParallel` to keep the previous order.

  The Rust crate (`harness-websearch`) is updated at parity.

## 0.7.0

### Minor Changes

- 8158441: Self-contained zero-config web search + token-efficient output + RRF ranking.

  `websearch` now works with **no API key and no self-hosted service**: with nothing
  configured it queries a bundled keyless fallback chain (Mojeek → Marginalia →
  Wikipedia) and returns the first backend with results. Optional Brave/Tavily API
  keys or a self-hosted SearXNG remain supported and take priority when configured.

  - **BREAKING**: the `INVALID_PARAM: no search backend configured` error is gone —
    zero config now uses the keyless chain instead of failing. Output rendering
    changed to a compact ranked-text format (the `<search>` XML block was replaced);
    parse the structured `meta`/`results`, not the `output` string.
  - Token-efficient compact output (~18% smaller at count=5), an engine-class label
    (`general web` / `indie/small-web index` / `encyclopedic`), and honest recency
    (per-result `age` only when the backend provides it; an explicit "time filter
    NOT applied" note when the serving engine ignores `time_range`).
  - Cross-engine gather + merge with a sufficiency threshold, URL de-duplication,
    engine-class-aware empty/degraded handling, rate-limit (401/403/429) →
    `SERVER_NOT_AVAILABLE`, per-engine timeout fairness, and Reciprocal Rank Fusion
    with engine weights for merge ranking.
  - New session options: `braveApiKey`, `tavilyApiKey`, `disableMojeek`,
    `fallbackToKeyless`, `snippetCap`, `engineBaseUrls`.

  Validated end-to-end against a real model (full websearch e2e suite, 10/10 on both
  the TS and Rust engines). The Rust crate (`harness-websearch`) is updated at parity.

## 0.3.0

### Minor Changes

- 3aac413: Add WebSearch and make `@agent-sh/harness-tools` the PI extension umbrella for the full tool surface.
