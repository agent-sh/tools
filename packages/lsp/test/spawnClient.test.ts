import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpawnLspClient } from "../src/spawnClient.js";
import type { LspServerProfile } from "../src/types.js";
import { makeTempDir, write } from "./helpers.js";

const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/fake-lsp-server.mjs", import.meta.url),
);

type FakeMode =
  | "well-behaved"
  | "close-stdin-on-shutdown"
  | "die-on-shutdown"
  | "close-stdin-on-initialize"
  | "reject-initialize-slow-exit"
  | "silent-on-hover"
  | "stop-reading-after-initialize"
  | "stubborn"
  | "stop-reading-after-shutdown";

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
function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function didOpens(stateDir: string): string[] {
  const file = path.join(stateDir, "didopen");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

const POS = { line: 1, character: 1 };

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

describe("spawn client: closeSession", () => {
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

  it("bounds the exit write when an abandoned file open fills the pipe", async () => {
    const client = createSpawnLspClient();
    // Larger than any pipe or socket buffer, so the write cannot complete.
    const file = write(root, "big.fake", "x".repeat(4 * 1024 * 1024));
    const handle = await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("stop-reading-after-shutdown", root),
    });
    const pid = serverPid(root);
    // Abort while the file is still being read: the open goes on alone and
    // queues its write behind `shutdown`, ahead of `exit`.
    const controller = new AbortController();
    const op = client.hover(handle, file, POS, controller.signal);
    controller.abort();
    await expect(op).rejects.toThrow("aborted");

    await client.closeSession();
    const aliveAfterClose = isAlive(pid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  }, 10_000);

  it("returns only after a server that needs SIGKILL is gone", async () => {
    const client = createSpawnLspClient();
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("stubborn", root),
    });
    const pid = serverPid(root);

    await client.closeSession();
    const aliveAfterClose = isAlive(pid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  }, 15_000);
});

describe("spawn client: live session", () => {
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

describe("spawn client: operations", () => {
  it("sends nothing and leaks nothing when the signal is already aborted", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    try {
      const handle = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("silent-on-hover", root),
      });
      const aborted = AbortSignal.abort();
      await expect(client.hover(handle, file, POS, aborted)).rejects.toThrow("aborted");
      await expect(client.definition(handle, file, POS, aborted)).rejects.toThrow("aborted");
      await expect(client.documentSymbol(handle, file, aborted)).rejects.toThrow("aborted");
      await expect(client.workspaceSymbol(handle, "x", aborted)).rejects.toThrow("aborted");
    } finally {
      await client.closeSession();
    }
    await settle();

    expect(unhandled).toEqual([]);
    expect(didOpens(root)).toEqual([]);
  });

  it("gives up on a file open the server does not read when the signal aborts", async () => {
    const client = createSpawnLspClient();
    // Larger than any pipe or socket buffer, so the write cannot complete.
    const file = write(root, "big.fake", "x".repeat(4 * 1024 * 1024));
    try {
      const handle = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("stop-reading-after-initialize", root),
      });
      await expect(
        client.hover(handle, file, POS, AbortSignal.timeout(500)),
      ).rejects.toThrow("aborted");
    } finally {
      await client.closeSession();
    }
    await settle();

    expect(unhandled).toEqual([]);
  }, 10_000);

  it("sends one didOpen for concurrent operations on the same file", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    try {
      const handle = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("well-behaved", root),
      });
      const signal = AbortSignal.timeout(5_000);
      await Promise.all([
        client.hover(handle, file, POS, signal),
        client.hover(handle, file, POS, signal),
      ]);
    } finally {
      await client.closeSession();
    }

    expect(didOpens(root)).toHaveLength(1);
  });

  it("does not mark a re-spawned server crashed when the old process exits late", async () => {
    const client = createSpawnLspClient();
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    try {
      await expect(
        client.ensureServer({
          language: "fake",
          root,
          profile: fakeProfile("reject-initialize-slow-exit", first),
        }),
      ).rejects.toThrow("fake server: refuses to start");
      const oldPid = serverPid(first);
      await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("well-behaved", second),
      });
      const newPid = serverPid(second);

      // The first server exits 400ms after its SIGTERM.
      await settle(1_000);
      expect(isAlive(oldPid)).toBe(false);

      const again = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("well-behaved", second),
      });
      expect(again.state).toBe("ready");
      expect(serverPid(second)).toBe(newPid);
    } finally {
      await client.closeSession();
    }
  });
});
