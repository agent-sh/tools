---
"@agent-sh/harness-webfetch": minor
"@agent-sh/harness-tools": minor
"@agent-sh/harness-web-mcp": minor
---

Bump jsdom to 30. Node engines now `^22.22.2 || ^24.15.0 || >=26.0.0` for webfetch and the packages that depend on it (harness-tools, harness-web-mcp), matching jsdom 30 and its undici 8 dependency; Node 20 is no longer supported.
