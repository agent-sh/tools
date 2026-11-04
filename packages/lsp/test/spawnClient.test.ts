import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpawnLspClient } from "../src/spawnClient.js";
import type { LspServerProfile } from "../src/types.js";
import { makeTempDir } from "./helpers.js";

const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/fake-lsp-server.mjs", import.meta.url),
);

type FakeMode =
  | "well-behaved"
  | "close-stdin-on-shutdown"
  | "die-on-shutdown"
  | "close-stdin-on-initialize";

function fakeProfile(mode: FakeMode, stateDir: string): LspServerProfile {
  return {
    language: "fake",
    extensions: [".fake"],
    command: [process.execPath, FAKE_SERVER, mode, stateDir],
  };
}

function serverPid(stateDir: string): number {
  return Number(readFileSync(path.join(stateDir, "pid"), "utf8"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A write that fails after closeSession returned rejects on a later turn
// of the event loop. Give it time to surface before checking.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

describe("spawn client: closeSession", () => {
  let root: string;
  let unhandled: unknown[];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    root = makeTempDir("lsp-spawn-");
    unhandled = [];
    process.on("unhandledRejection", record);
  });

  afterEach(() => {
    process.off("unhandledRejection", record);
    rmSync(root, { recursive: true, force: true });
  });

  it("lets the server exit on `exit` and waits for it", async () => {
    const client = createSpawnLspClient();
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("well-behaved", root),
    });
    const pid = serverPid(root);

    await client.closeSession();
    const aliveAfterClose = isAlive(pid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(existsSync(path.join(root, "exit"))).toBe(true);
    expect(aliveAfterClose).toBe(false);
  });

  it("handles a broken stdin pipe when the server closed its input before answering shutdown", async () => {
    const client = createSpawnLspClient();
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("close-stdin-on-shutdown", root),
    });
    const pid = serverPid(root);

    await client.closeSession();
    const aliveAfterClose = isAlive(pid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  });

  it("returns when the server exits without answering shutdown", async () => {
    const client = createSpawnLspClient();
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("die-on-shutdown", root),
    });
    const pid = serverPid(root);

    await client.closeSession();
    const aliveAfterClose = isAlive(pid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  });
});

describe("spawn client: live session", () => {
  let root: string;
  let unhandled: unknown[];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    root = makeTempDir("lsp-spawn-");
    unhandled = [];
    process.on("unhandledRejection", record);
  });

  afterEach(() => {
    process.off("unhandledRejection", record);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails ensureServer when the server's stdin breaks during startup", async () => {
    const client = createSpawnLspClient();
    try {
      await expect(
        client.ensureServer({
          language: "fake",
          root,
          profile: fakeProfile("close-stdin-on-initialize", root),
        }),
      ).rejects.toMatchObject({ code: "EPIPE" });
    } finally {
      await client.closeSession();
    }
    const aliveAfterClose = isAlive(serverPid(root));
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  });
});
