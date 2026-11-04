---
"@agent-sh/harness-lsp": patch
---

Stop language servers without racing their exit. `closeSession` now waits for the `exit` notification to be written before it signals the server, lets the server exit on its own, and only then falls back to SIGTERM and SIGKILL. It no longer hangs when a server dies before answering `shutdown`, and a broken stdin during shutdown no longer surfaces as an unhandled `EPIPE` or `ERR_STREAM_DESTROYED`. The `initialized` and `textDocument/didOpen` writes are awaited, so a broken pipe in a live session fails the call that caused it.
