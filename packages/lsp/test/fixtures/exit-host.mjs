// A host that starts a fake server, waits until the server has started its
// child, and exits without closeSession. With CLOSED_DIR, a second client
// first starts a server there and closes its session, while the first
// client's server still runs.
//
// Usage: node --import ./ts-hooks.mjs exit-host.mjs STATE_DIR [CLOSED_DIR]
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSpawnLspClient } from "../../src/spawnClient.js";

const [stateDir, closedDir] = process.argv.slice(2);
if (!stateDir) throw new Error("usage: exit-host.mjs STATE_DIR [CLOSED_DIR]");
const fake = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

async function start(client, dir, mode) {
  await client.ensureServer({
    language: "fake",
    root: dir,
    profile: { language: "fake", extensions: [".fake"], command: [process.execPath, fake, mode, dir] },
  });
}

// Exits on `exit`; its child ignores SIGTERM and never exits.
await start(createSpawnLspClient(), stateDir, "well-behaved-with-child");
while (!existsSync(path.join(stateDir, "child-pid"))) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (closedDir) {
  const other = createSpawnLspClient();
  await start(other, closedDir, "well-behaved");
  await other.closeSession();
}
process.exit(0);
