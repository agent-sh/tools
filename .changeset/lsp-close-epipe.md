---
"@agent-sh/harness-lsp": patch
---

Stop language servers without racing their exit. `closeSession` now waits for the `exit` notification to be written before it signals the server, lets the server exit on its own, and only then falls back to SIGTERM and SIGKILL. Every step is bounded, including the `exit` write. It returns once every server has exited. It no longer hangs when a server dies before answering `shutdown`, and a broken stdin during shutdown no longer surfaces as an unhandled `EPIPE` or `ERR_STREAM_DESTROYED`. The `initialized` and `textDocument/didOpen` writes are awaited, so a broken pipe in a live session fails the call that caused it. The `didOpen` wait runs under the operation's signal, so its timeout still holds, and concurrent operations on one file share a single `didOpen`. An operation whose signal is already aborted sends nothing.
