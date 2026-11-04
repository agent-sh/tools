---
"@agent-sh/harness-lsp": patch
---

Report a language server that exits instead of hanging on it. A request in flight when the server process exits now rejects at once with `LspServerExitedError`, which carries the exit code or signal and the last 4 KB of the server's stderr, and the `lsp` tool returns `SERVER_CRASHED` for that call. `ensureServer` rejects when the server exits or fails to spawn during `initialize`, and `initialize` is bounded by the per-operation timeout (`initializeTimeoutMs` on `createSpawnLspClient` overrides it). The client now drains the server's stderr, so a server that writes a lot of it can no longer block. A server whose stdin breaks after startup is marked crashed and stopped, so the next call starts a new one instead of reusing a server that cannot be reached.
