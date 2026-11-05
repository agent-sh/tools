import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  SESSION_BACKSTOP_MS,
} from "../src/constants.js";
import { lsp } from "../src/lsp.js";
import { createSpawnLspClient } from "../src/spawnClient.js";
import type { LspClient, LspServerProfile } from "../src/types.js";
import { makeSession, makeTempDir, write } from "./helpers.js";

const FAKE_SERVER = fileURLToPath(
  new URL("./fixtures/fake-lsp-server.mjs", import.meta.url),
);
// A host process that loads this package's source: see the fixtures.
const TS_HOOKS = fileURLToPath(new URL("./fixtures/ts-hooks.mjs", import.meta.url));
const EXIT_HOST = fileURLToPath(new URL("./fixtures/exit-host.mjs", import.meta.url));

type FakeMode =
  | "well-behaved"
  | "close-stdin-on-shutdown"
  | "die-on-shutdown"
  | "close-stdin-on-initialize"
  | "reject-initialize-slow-exit"
  | "silent-on-hover"
  | "stop-reading-after-initialize"
  | "stubborn"
  | "stop-reading-after-shutdown"
  | "die-on-initialize"
  | "silent-on-initialize"
  | "flood-stderr-on-initialize"
  | "flood-stderr-then-die"
  | "die-on-hover"
  | "close-stdin-on-hover"
  | "close-stdout-on-hover"
  | "slow-initialize"
  | "slow-die-on-initialize";

// A mode that also starts a child: one that ignores SIGTERM, or one that
// exits on it.
type FakeModeWithChild = `${FakeMode}-with-child` | `${FakeMode}-with-sigterm-child`;

// Cases that hung before their fix get a short limit, so a regression fails
// fast instead of at the 30s default.
const HANG_LIMIT_MS = 10_000;

function fakeProfile(mode: FakeMode | FakeModeWithChild, stateDir: string): LspServerProfile {
  return {
    language: "fake",
    extensions: [".fake"],
    command: [process.execPath, FAKE_SERVER, mode, stateDir],
  };
}

function serverPid(stateDir: string): number {
  return Number(readFileSync(path.join(stateDir, "pid"), "utf8"));
}

/** The pid of the server's child, once the server has started it. */
async function childPid(stateDir: string): Promise<number> {
  const file = path.join(stateDir, "child-pid");
  await expect.poll(() => existsSync(file), { timeout: 5_000 }).toBe(true);
  return Number(readFileSync(file, "utf8"));
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await settle(20);
  }
  return true;
}

/** Runs exit-host.mjs to its end. A host still running after 20s is killed. */
function runHost(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", TS_HOOKS, EXIT_HOST, ...args],
      { timeout: 20_000, killSignal: "SIGKILL" },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/**
 * SIGKILL the process group that the fake server in `stateDir` leads, but
 * only while a member of it is still a process this test started: the
 * server, whose command line names `stateDir`, or its child, which runs the
 * fixture's child script. A group id stays taken while any member lives, so
 * it cannot belong to anyone else then.
 */
function killFakeGroup(stateDir: string): void {
  const pidFile = path.join(stateDir, "pid");
  if (!existsSync(pidFile)) return;
  const group = Number(readFileSync(pidFile, "utf8"));
  const ps = execFileSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,command="], { encoding: "utf8" });
  const ours = ps.split("\n").some((line) => {
    const m = /^\s*\d+\s+(\d+)\s+(.*)$/.exec(line);
    return (
      m !== null &&
      Number(m[1]) === group &&
      (m[2]!.includes(stateDir) || m[2]!.includes("setInterval(() => {}, 60000)"))
    );
  });
  if (!ours) return;
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // The group emptied since.
  }
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

function spawnCount(stateDir: string): number {
  return readFileSync(path.join(stateDir, "spawns"), "utf8").trim().split("\n").length;
}

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
    // Let hover run every step that needs no I/O, so the open has started
    // reading the file before the abort, whatever awaits sit before it.
    await new Promise((resolve) => process.nextTick(resolve));
    controller.abort();
    await expect(op).rejects.toThrow("aborted");

    await client.closeSession();
    const aliveAfterClose = isAlive(pid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  }, 10_000);

  it("takes the server's children when the server exits on `exit`", async () => {
    const client = createSpawnLspClient();
    // Exits on `exit`; its child ignores SIGTERM and never exits.
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("well-behaved-with-child", root),
    });
    const child = await childPid(root);

    await client.closeSession();

    expect(existsSync(path.join(root, "exit"))).toBe(true);
    expect(await goneWithin(child, 1_000)).toBe(true);
  });

  it("sends SIGTERM to the server's whole process group", async () => {
    const client = createSpawnLspClient();
    // The server ignores `exit` and SIGTERM; its child exits on SIGTERM.
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("stubborn-with-sigterm-child", root),
    });
    const pid = serverPid(root);
    const child = await childPid(root);

    await client.closeSession();

    // The server outlives the SIGTERM step, so it saw how its child ended.
    // Without a group signal the child would end only after the server,
    // from the kill after the exit.
    expect(readFileSync(path.join(root, "child-exit"), "utf8")).toBe("SIGTERM");
    expect(isAlive(pid)).toBe(false);
    expect(await goneWithin(child, 1_000)).toBe(true);
  }, 15_000);

  it("takes the server's children with the final SIGKILL", async () => {
    const client = createSpawnLspClient();
    // Ignores `exit` and SIGTERM, and so does its child.
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("stubborn-with-child", root),
    });
    const pid = serverPid(root);
    const child = await childPid(root);

    await client.closeSession();

    expect(isAlive(pid)).toBe(false);
    expect(await goneWithin(child, 1_000)).toBe(true);
  }, 15_000);

  it("kills each live server's group when the host exits without closeSession", async () => {
    // A real host process: after process.exit() no event loop runs, so only
    // the exit handler itself can stop the server and its child.
    let ok = false;
    try {
      await runHost([root]);
      const pid = serverPid(root);
      const child = await childPid(root);
      expect(await goneWithin(pid, 1_000)).toBe(true);
      expect(await goneWithin(child, 1_000)).toBe(true);
      ok = true;
    } finally {
      // Only a failed run can leave the server or its child behind.
      if (!ok) killFakeGroup(root);
    }
  });

  it("keeps a live server covered when another client closes its session", async () => {
    const closedRoot = makeTempDir("lsp-spawn-closed-");
    let ok = false;
    try {
      // The second client closes while the first one's server still runs.
      await runHost([root, closedRoot]);
      expect(existsSync(path.join(closedRoot, "exit"))).toBe(true);
      const pid = serverPid(root);
      const child = await childPid(root);
      expect(await goneWithin(pid, 1_000)).toBe(true);
      expect(await goneWithin(child, 1_000)).toBe(true);
      ok = true;
    } finally {
      if (!ok) {
        killFakeGroup(root);
        killFakeGroup(closedRoot);
      }
      rmSync(closedRoot, { recursive: true, force: true });
    }
  });

  it("shares one exit handler among all clients", async () => {
    const before = process.listeners("exit").length;
    const warnings: Error[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w);
    };
    process.on("warning", onWarning);
    const clients = Array.from({ length: 20 }, () => createSpawnLspClient());
    try {
      for (const client of clients) {
        await client.ensureServer({
          language: "fake",
          root,
          profile: fakeProfile("well-behaved", root),
        });
      }
      expect(process.listeners("exit").length - before).toBeLessThanOrEqual(1);
      await settle();
      expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
      await Promise.all(clients.map((c) => c.closeSession()));
    }
    expect(process.listeners("exit").length).toBe(before);
  }, 30_000);

  it("removes its exit handler once closeSession has stopped every server", async () => {
    const before = process.listeners("exit");
    const client = createSpawnLspClient();
    await client.ensureServer({
      language: "fake",
      root,
      profile: fakeProfile("well-behaved", root),
    });
    const added = process.listeners("exit").filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);

    await client.closeSession();

    expect(process.listeners("exit").includes(added[0]!)).toBe(false);
  });

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
      ).rejects.toMatchObject({
        name: "LspServerCrashedError",
        cause: { code: "EPIPE" },
      });
    } finally {
      await client.closeSession();
    }
    const aliveAfterClose = isAlive(serverPid(root));
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  });

  it("rejects an in-flight request with a server-exited error, then re-spawns", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    try {
      const handle = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("die-on-hover", root),
      });
      const firstPid = serverPid(root);
      // The abort would end a hang after 5s; the exit must win well before.
      await expect(
        client.hover(handle, file, { line: 1, character: 1 }, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({
        name: "LspServerExitedError",
        exitCode: 1,
        message: expect.stringContaining("fake server: hover crashed"),
      });

      const again = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("die-on-hover", root),
      });
      expect(again.state).toBe("ready");
      expect(serverPid(root)).not.toBe(firstPid);
    } finally {
      await client.closeSession();
    }
    await settle();
    expect(unhandled).toEqual([]);
  }, HANG_LIMIT_MS);

  it("returns SERVER_CRASHED from the tool for the call that saw the exit", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("die-on-hover", root) } },
      defaultTimeoutMs: 5_000,
    });
    try {
      const r = await lsp({ operation: "hover", path: file, line: 1, character: 1 }, session);
      expect(r).toMatchObject({
        kind: "error",
        error: {
          code: "SERVER_CRASHED",
          message: expect.stringContaining("fake server: hover crashed"),
        },
      });
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("re-spawns a server whose stdin broke after startup", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    let firstPid = 0;
    try {
      const handle = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("close-stdin-on-hover", root),
      });
      firstPid = serverPid(root);
      // The server closes its stdin before it answers this hover.
      await client.hover(handle, file, POS, AbortSignal.timeout(5_000));
      await expect(
        client.hover(handle, file, POS, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({
        name: "LspServerCrashedError",
        message: expect.stringContaining("stopped reading its input (write EPIPE)"),
      });

      const again = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("close-stdin-on-hover", root),
      });
      expect(again.state).toBe("ready");
      expect(serverPid(root)).not.toBe(firstPid);
    } finally {
      await client.closeSession();
    }
    // closeSession also waits for the retired server.
    const firstAliveAfterClose = isAlive(firstPid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(firstAliveAfterClose).toBe(false);
  }, HANG_LIMIT_MS);

  it("reports SERVER_CRASHED for the tool call that finds stdin broken, and the next call works", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("close-stdin-on-hover", root) } },
      defaultTimeoutMs: 5_000,
    });
    const hover = { operation: "hover", path: file, line: 1, character: 1 };
    try {
      // The server closes its stdin before it answers this hover.
      expect(await lsp(hover, session)).toMatchObject({ kind: "hover" });
      expect(await lsp(hover, session)).toMatchObject({
        kind: "error",
        error: {
          code: "SERVER_CRASHED",
          message: expect.stringContaining("The next call starts it again."),
        },
      });
      expect(await lsp(hover, session)).toMatchObject({ kind: "hover" });
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("retires a server that closes its output but stays alive", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    let firstPid = 0;
    try {
      const handle = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("close-stdout-on-hover", root),
      });
      firstPid = serverPid(root);
      await expect(
        client.hover(handle, file, POS, AbortSignal.timeout(5_000)),
      ).rejects.toMatchObject({
        name: "LspServerCrashedError",
        message: expect.stringContaining("closed its output"),
      });

      const again = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("close-stdout-on-hover", root),
      });
      expect(again.state).toBe("ready");
      expect(serverPid(root)).not.toBe(firstPid);
    } finally {
      await client.closeSession();
    }
    const firstAliveAfterClose = isAlive(firstPid);
    await settle();

    expect(unhandled).toEqual([]);
    expect(firstAliveAfterClose).toBe(false);
  }, HANG_LIMIT_MS);

  it("starts a new server for the next call after an idle exit", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("well-behaved", root) } },
    });
    const hover = { operation: "hover", path: file, line: 1, character: 1 };
    try {
      expect(await lsp(hover, session)).toMatchObject({ kind: "hover" });
      process.kill(serverPid(root), "SIGKILL");
      await settle();
      expect(await lsp(hover, session)).toMatchObject({ kind: "hover" });
    } finally {
      await client.closeSession();
    }
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

describe("spawn client: startup", () => {
  it("rejects ensureServer when the server exits during initialize", async () => {
    const client = createSpawnLspClient();
    try {
      await expect(
        client.ensureServer({
          language: "fake",
          root,
          profile: fakeProfile("die-on-initialize", root),
        }),
      ).rejects.toMatchObject({
        name: "LspServerExitedError",
        exitCode: 3,
        message: expect.stringContaining("fake server: cannot start"),
      });
    } finally {
      await client.closeSession();
    }
    await settle();
    expect(unhandled).toEqual([]);
  }, HANG_LIMIT_MS);

  it("rejects ensureServer and stops the server when initialize gets no answer in time", async () => {
    const client = createSpawnLspClient({ initializeTimeoutMs: 300 });
    try {
      await expect(
        client.ensureServer({
          language: "fake",
          root,
          profile: fakeProfile("silent-on-initialize", root),
        }),
      ).rejects.toThrow(/did not answer initialize within 300ms/);
    } finally {
      await client.closeSession();
    }
    const aliveAfterClose = isAlive(serverPid(root));
    await settle();

    expect(unhandled).toEqual([]);
    expect(aliveAfterClose).toBe(false);
  }, HANG_LIMIT_MS);

  it("reports a missing server binary as the spawn error", async () => {
    const client = createSpawnLspClient();
    const missing = path.join(root, "no-such-server");
    try {
      await expect(
        client.ensureServer({
          language: "fake",
          root,
          profile: { language: "fake", extensions: [".fake"], command: [missing] },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.closeSession();
    }
    await settle();
    expect(unhandled).toEqual([]);
  }, HANG_LIMIT_MS);

  it("stops waiting for initialize when the caller's signal aborts, and the server keeps starting", async () => {
    const client = createSpawnLspClient();
    const profile = fakeProfile("silent-on-initialize", root);
    try {
      await expect(
        client.ensureServer({ language: "fake", root, profile, signal: AbortSignal.timeout(300) }),
      ).rejects.toThrow("aborted");
      const pid = serverPid(root);
      const again = await client.ensureServer({ language: "fake", root, profile });
      expect(again.state).toBe("starting");
      expect(serverPid(root)).toBe(pid);
    } finally {
      await client.closeSession();
    }
    await settle();
    expect(unhandled).toEqual([]);
  }, HANG_LIMIT_MS);

  it("spawns nothing when the caller's signal is already aborted", async () => {
    const client = createSpawnLspClient();
    try {
      await expect(
        client.ensureServer({
          language: "fake",
          root,
          profile: fakeProfile("well-behaved", root),
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow("aborted");
    } finally {
      await client.closeSession();
    }
    expect(existsSync(path.join(root, "pid"))).toBe(false);
  });

  it("bounds a slow start by the tool call's timeout", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("silent-on-initialize", root) } },
      defaultTimeoutMs: 500,
    });
    const hover = { operation: "hover", path: file, line: 1, character: 1 };
    try {
      expect(await lsp(hover, session)).toMatchObject({
        kind: "error",
        error: {
          code: "TIMEOUT",
          message: expect.stringContaining("while the fake server was starting"),
        },
      });
      expect(await lsp(hover, session)).toMatchObject({ kind: "server_starting" });
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("lets a start outlive the tool call that began it with the default limits", () => {
    // Every call's budget is capped by the session backstop.
    const callBudget = Math.min(DEFAULT_TIMEOUT_MS, SESSION_BACKSTOP_MS);
    expect(DEFAULT_INITIALIZE_TIMEOUT_MS).toBeGreaterThan(callBudget);
  });

  it("keeps a start slower than the call budget going: TIMEOUT, then server_starting, then the result", async () => {
    // The same relation as the defaults, scaled down: initialize limit 3s,
    // call budget 300ms, server ready after 800ms.
    const client = createSpawnLspClient({ initializeTimeoutMs: 3_000 });
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("slow-initialize", root) } },
      defaultTimeoutMs: 300,
    });
    const hover = { operation: "hover", path: file, line: 1, character: 1 };
    try {
      expect(await lsp(hover, session)).toMatchObject({
        kind: "error",
        error: {
          code: "TIMEOUT",
          message: expect.stringContaining("The start goes on in the background; retry."),
        },
      });
      expect(await lsp(hover, session)).toMatchObject({ kind: "server_starting" });
      await settle(800);
      expect(await lsp(hover, session)).toMatchObject({ kind: "hover" });
    } finally {
      await client.closeSession();
    }
    expect(readFileSync(path.join(root, "spawns"), "utf8").trim().split("\n")).toHaveLength(1);
  }, HANG_LIMIT_MS);

  it("says a call cancelled before it started sent nothing", async () => {
    const client = createSpawnLspClient();
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("well-behaved", root) } },
      signal: AbortSignal.abort(),
    });
    try {
      expect(
        await lsp({ operation: "hover", path: file, line: 1, character: 1 }, session),
      ).toMatchObject({
        kind: "error",
        error: {
          code: "TIMEOUT",
          message: expect.stringContaining("was cancelled before it started"),
        },
      });
    } finally {
      await client.closeSession();
    }
    expect(existsSync(path.join(root, "pid"))).toBe(false);
  });

  it("says a call cancelled during a start was cancelled, not timed out", async () => {
    // Cancel once the start has begun, not on a clock, so a slow machine
    // cannot make the cancel land before the call reaches the server.
    const inner = createSpawnLspClient();
    const cancel = new AbortController();
    const client: LspClient = {
      ...inner,
      ensureServer: (args) => {
        const starting = inner.ensureServer(args);
        cancel.abort();
        return starting;
      },
    };
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("silent-on-initialize", root) } },
      signal: cancel.signal,
    });
    try {
      expect(
        await lsp({ operation: "hover", path: file, line: 1, character: 1 }, session),
      ).toMatchObject({
        kind: "error",
        error: {
          code: "TIMEOUT",
          message: expect.stringContaining("was cancelled while the fake server was starting"),
        },
      });
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("bounds initialize by DEFAULT_INITIALIZE_TIMEOUT_MS by default", async () => {
    const client = createSpawnLspClient();
    // Fake only the timers; the server process and its pipes stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = client
        .ensureServer({ language: "fake", root, profile: fakeProfile("silent-on-initialize", root) })
        .then(() => "ready", (e: unknown) => (e as Error).message);
      let settled: string | undefined;
      void outcome.then((m) => (settled = m));
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(DEFAULT_INITIALIZE_TIMEOUT_MS - DEFAULT_TIMEOUT_MS);
      expect(await outcome).toContain(`within ${DEFAULT_INITIALIZE_TIMEOUT_MS}ms`);
    } finally {
      vi.useRealTimers();
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("reports a start that hit the initialize limit after its call gave up, once", async () => {
    const client = createSpawnLspClient({ initializeTimeoutMs: 800 });
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("silent-on-initialize", root) } },
      defaultTimeoutMs: 300,
    });
    const hover = { operation: "hover", path: file, line: 1, character: 1 };
    try {
      expect(await lsp(hover, session)).toMatchObject({ kind: "error", error: { code: "TIMEOUT" } });
      // Past the 800ms limit, with room for a slow machine.
      await settle(1_500);
      expect(await lsp(hover, session)).toMatchObject({
        kind: "error",
        error: {
          code: "SERVER_NOT_AVAILABLE",
          message: expect.stringContaining("did not answer initialize within 800ms"),
        },
      });
      expect(spawnCount(root)).toBe(1);
      // Reported once: the next call starts a new server.
      expect(await lsp(hover, session)).toMatchObject({ kind: "error", error: { code: "TIMEOUT" } });
      // The new server records its spawn once node has started, which under
      // load can be after the 300ms call gave up.
      await expect.poll(() => spawnCount(root), { timeout: 5_000 }).toBe(2);
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("reports a start that exits in the same turn as the next call", async () => {
    const client = createSpawnLspClient({ initializeTimeoutMs: 3_000 });
    const args = { language: "fake", root, profile: fakeProfile("slow-die-on-initialize", root) };
    try {
      const cancel = new AbortController();
      const first = client.ensureServer({ ...args, signal: cancel.signal });
      cancel.abort();
      await expect(first).rejects.toThrow("aborted");
      // Call on every turn of the event loop, so one call lands in the turn
      // where the exit is seen but the start has not failed yet.
      let outcome: unknown;
      const deadline = Date.now() + 5_000;
      while (outcome === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
        try {
          const handle = await client.ensureServer(args);
          if (handle.state !== "starting") outcome = handle;
        } catch (e) {
          outcome = e;
        }
      }
      expect(outcome).toMatchObject({
        name: "LspServerExitedError",
        exitCode: 3,
        message: expect.stringContaining("missing config, giving up"),
      });
      expect(spawnCount(root)).toBe(1);
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("reports the exit code and stderr of a start that died after its call gave up", async () => {
    const client = createSpawnLspClient({ initializeTimeoutMs: 3_000 });
    const file = write(root, "a.fake", "x\n");
    const session = makeSession(root, client, {
      manifest: { servers: { fake: fakeProfile("slow-die-on-initialize", root) } },
      defaultTimeoutMs: 300,
    });
    const hover = { operation: "hover", path: file, line: 1, character: 1 };
    try {
      expect(await lsp(hover, session)).toMatchObject({ kind: "error", error: { code: "TIMEOUT" } });
      // The server exits 800ms into the start.
      await settle(1_500);
      expect(await lsp(hover, session)).toMatchObject({
        kind: "error",
        error: {
          code: "SERVER_NOT_AVAILABLE",
          message: expect.stringMatching(
            /^Failed to start fake server: Language server for fake exited with code 3[\s\S]*missing config, giving up/,
          ),
        },
      });
      expect(spawnCount(root)).toBe(1);
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);
});

describe("spawn client: stderr", () => {
  it("drains stderr, so a server that writes a lot of it still starts", async () => {
    const client = createSpawnLspClient();
    try {
      const handle = await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("flood-stderr-on-initialize", root),
      });
      expect(handle.state).toBe("ready");
    } finally {
      await client.closeSession();
    }
  }, HANG_LIMIT_MS);

  it("keeps only a bounded stderr tail for the exit error", async () => {
    const client = createSpawnLspClient();
    let error: unknown;
    try {
      await client.ensureServer({
        language: "fake",
        root,
        profile: fakeProfile("flood-stderr-then-die", root),
      });
    } catch (e) {
      error = e;
    } finally {
      await client.closeSession();
    }
    expect(error).toMatchObject({
      name: "LspServerExitedError",
      exitCode: 1,
      message: expect.stringContaining("fake server: last words"),
    });
    const tail = (error as { stderrTail: string }).stderrTail;
    expect(tail.endsWith("fake server: last words")).toBe(true);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4_096);
  }, HANG_LIMIT_MS);
});
