---
"@agent-sh/harness-lsp": patch
---

A start that fails after its call gave up is reported to the next call even when the server exits in the same event-loop turn as that call. Until the start has failed, the server counts as starting, so no call starts a second server in between and loses the first one's reason. Start failures now read "Failed to start" instead of "Failed to spawn", since the server may have spawned and then exited or missed the `initialize` bound.
