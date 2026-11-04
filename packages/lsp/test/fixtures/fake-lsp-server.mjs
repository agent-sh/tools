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
//   stop-reading-after-shutdown
//                              stops reading its stdin, answers `shutdown`
//                              200ms later, and stays alive until signalled.
//   die-on-initialize          writes to stderr and exits with code 3
//                              instead of answering `initialize`.
//   silent-on-initialize       never answers `initialize`.
//   flood-stderr-on-initialize writes FLOOD_BYTES to stderr, then answers
//                              `initialize` once the write has drained.
//   flood-stderr-then-die      writes FLOOD_BYTES and a last line to stderr,
//                              then exits with code 1 instead of answering
//                              `initialize`.
//   die-on-hover               writes to stderr and exits with code 1
//                              instead of answering `textDocument/hover`.
//   close-stdin-on-hover       closes its stdin, then answers the first
//                              `textDocument/hover` and stays alive until
//                              signalled.
//   close-stdout-on-hover      closes its stdout instead of answering
//                              `textDocument/hover`, and stays alive until
//                              signalled.
//
// Every mode appends the URI of each `textDocument/didOpen` it reads to
// STATE_DIR/didopen.

import { appendFileSync, closeSync, writeFileSync } from "node:fs";
import path from "node:path";

const [mode = "well-behaved", stateDir] = process.argv.slice(2);
if (!stateDir) throw new Error("usage: fake-lsp-server.mjs MODE STATE_DIR");

// Larger than any pipe or socket buffer, so the write only completes if the
// client keeps reading stderr.
const FLOOD_BYTES = 2 * 1024 * 1024;

writeFileSync(path.join(stateDir, "pid"), String(process.pid));

// A server that closed its input has nothing left keeping it alive.
// Hold it open so the client has to stop it.
const keepAlive = [
  "stop-reading-after-initialize",
  "stop-reading-after-shutdown",
  "stubborn",
];
if (mode.startsWith("close-std") || keepAlive.includes(mode)) {
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

function flood() {
  const line = `${"x".repeat(99)}\n`;
  return line.repeat(Math.ceil(FLOOD_BYTES / line.length));
}

// Exit only after the stderr write has drained, so the words are in the pipe.
function die(code, words) {
  process.stderr.write(words, () => process.exit(code));
}

function handle(message) {
  switch (message.method) {
    case "initialize":
      if (mode === "reject-initialize-slow-exit") {
        send({ id: message.id, error: { code: -32603, message: "fake server: refuses to start" } });
        return;
      }
      if (mode === "die-on-initialize") return die(3, "fake server: cannot start\n");
      if (mode === "silent-on-initialize") return;
      if (mode === "flood-stderr-then-die") {
        return die(1, `${flood()}fake server: last words\n`);
      }
      if (mode === "close-stdin-on-initialize") closeStdin();
      if (mode === "flood-stderr-on-initialize") {
        process.stderr.write(flood(), () =>
          send({ id: message.id, result: { capabilities: { hoverProvider: true } } }),
        );
        return;
      }
      send({ id: message.id, result: { capabilities: { hoverProvider: true } } });
      if (mode === "stop-reading-after-initialize") process.stdin.pause();
      return;
    case "textDocument/didOpen":
      appendFileSync(path.join(stateDir, "didopen"), `${message.params.textDocument.uri}\n`);
      return;
    case "textDocument/hover":
      if (mode === "silent-on-hover") return;
      if (mode === "die-on-hover") return die(1, "fake server: hover crashed\n");
      if (mode === "close-stdin-on-hover") closeStdin();
      if (mode === "close-stdout-on-hover") {
        // Same as stdin: libuv keeps fd 1 open through destroy().
        process.stdout.destroy();
        closeSync(1);
        return;
      }
      send({ id: message.id, result: { contents: "fake hover" } });
      return;
    case "shutdown":
      if (mode === "die-on-shutdown") process.exit(0);
      if (mode === "close-stdin-on-shutdown") closeStdin();
      if (mode === "stop-reading-after-shutdown") {
        process.stdin.pause();
        // Give the client time to queue more writes before `exit`.
        setTimeout(() => send({ id: message.id, result: null }), 200);
        return;
      }
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
