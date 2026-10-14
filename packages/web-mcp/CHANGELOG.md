# @agent-sh/harness-web-mcp

## 0.1.1

### Patch Changes

- Updated dependencies [f233528]
  - @agent-sh/harness-websearch@0.8.1
  - @agent-sh/harness-webfetch@0.8.1

## 0.1.0

### Minor Changes

- df49f52: New package: MCP stdio server exposing `websearch` and `webfetch` to Claude Code, Codex and any MCP client (`npx -y @agent-sh/harness-web-mcp`). Keyless search by default; optional `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `SEARXNG_URL`; webfetch keeps SSRF defaults unless `HARNESS_WEB_FETCH_ALLOW_LOOPBACK` / `HARNESS_WEB_FETCH_ALLOW_PRIVATE` are set.
