---
"@agent-sh/harness-lsp": minor
---

On POSIX each language server now runs in its own process group. SIGTERM and SIGKILL go to the whole group, and once a server has exited, a clean `exit` included, the client kills what is left of its group, so a server's children no longer outlive it. A helper that a server means to keep running has to start its own process group or session. A server no longer gets a Ctrl-C from the host's terminal: call `closeSession()` before the host exits, on SIGINT and SIGTERM too.
