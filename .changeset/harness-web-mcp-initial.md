---
"@agent-sh/harness-web-mcp": minor
---

New package: MCP stdio server exposing `websearch` and `webfetch` to Claude Code, Codex and any MCP client (`npx -y @agent-sh/harness-web-mcp`). Keyless search by default; optional `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `PARALLEL_API_KEY`, `SEARXNG_URL`; webfetch keeps SSRF defaults unless `HARNESS_WEB_FETCH_ALLOW_LOOPBACK` / `HARNESS_WEB_FETCH_ALLOW_PRIVATE` are set.
