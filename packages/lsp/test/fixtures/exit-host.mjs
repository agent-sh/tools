// A host that starts a fake server, waits until the server has started its
// child, and exits without closeSession.
//
// Usage: node --import ./ts-hooks.mjs exit-host.mjs STATE_DIR
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSpawnLspClient } from "../../src/spawnClient.js";

const [stateDir] = process.argv.slice(2);
if (!stateDir) throw new Error("usage: exit-host.mjs STATE_DIR");
const fake = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));
const client = createSpawnLspClient();
await client.ensureServer({
  language: "fake",
  root: stateDir,
  profile: {
    language: "fake",
    extensions: [".fake"],
    // Exits on `exit`; its child ignores SIGTERM and never exits.
    command: [process.execPath, fake, "well-behaved-with-child", stateDir],
  },
});
while (!existsSync(path.join(stateDir, "child-pid"))) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
process.exit(0);
