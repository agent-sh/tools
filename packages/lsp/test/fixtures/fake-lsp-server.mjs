// Minimal stdio language server for the spawn-client tests.
//
// Usage: node fake-lsp-server.mjs MODE STATE_DIR
//
// It writes its pid to STATE_DIR/pid at startup and STATE_DIR/exit when it
// receives the `exit` notification. MODE picks how it misbehaves:
//
//   well-behaved               answers `shutdown`, exits on `exit`.
//   close-stdin-on-shutdown    closes its stdin, then answers `shutdown` and
//                              stays alive until signalled.
//   die-on-shutdown            exits on `shutdown` without answering it.
//   close-stdin-on-initialize  closes its stdin, then answers `initialize`
//                              and stays alive until signalled.
//   reject-initialize-slow-exit
//                              answers `initialize` with an error, and exits
//                              400ms after SIGTERM instead of at once.
//   silent-on-hover            never answers `textDocument/hover`.
//   stop-reading-after-initialize
//                              answers `initialize`, then stops reading its
//                              stdin and stays alive until signalled.
//   stubborn                   answers `shutdown`, ignores `exit` and
//                              SIGTERM; only SIGKILL stops it.
//
// Every mode appends the URI of each `textDocument/didOpen` it reads to
// STATE_DIR/didopen.

import { appendFileSync, closeSync, writeFileSync } from "node:fs";
import path from "node:path";

const [mode = "well-behaved", stateDir] = process.argv.slice(2);
if (!stateDir) throw new Error("usage: fake-lsp-server.mjs MODE STATE_DIR");

writeFileSync(path.join(stateDir, "pid"), String(process.pid));

// A server that closed its input has nothing left keeping it alive.
// Hold it open so the client has to stop it.
const keepAlive = ["stop-reading-after-initialize", "stubborn"];
if (mode.startsWith("close-stdin") || keepAlive.includes(mode)) {
  setInterval(() => {}, 60_000);
}
if (mode === "stubborn") process.on("SIGTERM", () => {});
if (mode === "reject-initialize-slow-exit") {
  process.on("SIGTERM", () => setTimeout(() => process.exit(0), 400));
}

// libuv never closes fds 0-2, so destroying process.stdin alone leaves the
// pipe open. Close the descriptor too, so the client's next write breaks.
function closeStdin() {
  process.stdin.destroy();
  closeSync(0);
}

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  switch (message.method) {
    case "initialize":
      if (mode === "reject-initialize-slow-exit") {
        send({ id: message.id, error: { code: -32603, message: "fake server: refuses to start" } });
        return;
      }
      if (mode === "close-stdin-on-initialize") closeStdin();
      send({ id: message.id, result: { capabilities: { hoverProvider: true } } });
      if (mode === "stop-reading-after-initialize") process.stdin.pause();
      return;
    case "textDocument/didOpen":
      appendFileSync(path.join(stateDir, "didopen"), `${message.params.textDocument.uri}\n`);
      return;
    case "textDocument/hover":
      if (mode === "silent-on-hover") return;
      send({ id: message.id, result: { contents: "fake hover" } });
      return;
    case "shutdown":
      if (mode === "die-on-shutdown") process.exit(0);
      if (mode === "close-stdin-on-shutdown") closeStdin();
      send({ id: message.id, result: null });
      return;
    case "exit":
      if (mode === "stubborn") return;
      writeFileSync(path.join(stateDir, "exit"), "");
      process.exit(0);
  }
}

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const headerEnd = pending.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = pending.subarray(0, headerEnd).toString("ascii");
    const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    const start = headerEnd + 4;
    if (pending.length < start + length) return;
    const body = pending.subarray(start, start + length).toString("utf8");
    pending = pending.subarray(start + length);
    handle(JSON.parse(body));
  }
});
