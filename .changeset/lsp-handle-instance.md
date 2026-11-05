---
"@agent-sh/harness-lsp": minor
"@agent-sh/harness-tools": minor
---

A server handle now names one server instance. An operation whose server died after the call got its handle, and was replaced by another call under the same language and root, no longer fails with `IO_ERROR` "not ready (state=starting)" or runs on the replacement: it gets `SERVER_CRASHED` with the old server's own reason. The client keeps the reasons of replaced servers for the 60s session backstop, at most 32 of them; past that, the call gets `SERVER_CRASHED` saying the server stopped after the call got its handle.

Breaking: `ServerHandle` has a new required field, `instance`, set by the client that made the handle. An `LspClient` adapter that builds handles must set it; one that never replaces a server may use a fixed value.
