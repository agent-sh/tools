# @agent-sh/harness-web-mcp

## 0.2.2

### Patch Changes

- 73293c4: Protect generated logs, spill files and metadata with private exclusive creation. Read background output through one file descriptor and parse search markup without repeated regular-expression backtracking. Support JSON-RPC 10's Node export and update dependencies while retaining Pi 1.3 host compatibility.
- Updated dependencies [73293c4]
  - @agent-sh/harness-webfetch@0.9.2
  - @agent-sh/harness-websearch@0.9.2

## 0.2.1

### Patch Changes

- @agent-sh/harness-webfetch@0.9.1
- @agent-sh/harness-websearch@0.9.1

## 0.2.0

### Minor Changes

- c2aa8d6: Bump jsdom to 30. Node engines now `^22.22.2 || ^24.15.0 || >=26.0.0` for webfetch and the packages that depend on it (harness-tools, harness-web-mcp), matching jsdom 30 and its undici 8 dependency; Node 20 is no longer supported.

### Patch Changes

- Updated dependencies [c2aa8d6]
  - @agent-sh/harness-webfetch@0.9.0

## 0.1.1

### Patch Changes

- Updated dependencies [f233528]
  - @agent-sh/harness-websearch@0.8.1
  - @agent-sh/harness-webfetch@0.8.1

## 0.1.0

### Minor Changes

- df49f52: New package: MCP stdio server exposing `websearch` and `webfetch` to Claude Code, Codex and any MCP client (`npx -y @agent-sh/harness-web-mcp`). Keyless search by default; optional `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `SEARXNG_URL`; webfetch keeps SSRF defaults unless `HARNESS_WEB_FETCH_ALLOW_LOOPBACK` / `HARNESS_WEB_FETCH_ALLOW_PRIVATE` are set.
