import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalBashExecutor } from "../src/executor.js";
import { HeadTailBuffer } from "../src/format.js";
import { bash } from "../src/bash.js";
import { makeSession } from "./helpers.js";
import { defaultBashDirectory } from "../src/directories.js";

const roots: string[] = [];
vi.mock("node:os", { spy: true });
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bash-security-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { vi.mocked(tmpdir).mockReset(); vi.mocked(homedir).mockReset(); vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("rejects a planted log-directory symlink and a writable shared directory", () => {
  const dir = root();
  const target = path.join(dir, "target");
  mkdirSync(target);
  const link = path.join(dir, "link");
  symlinkSync(target, link, "dir");
  expect(() => createLocalBashExecutor({ logDir: link })).toThrow();
  if (process.platform !== "win32") {
    chmodSync(target, 0o777);
    expect(() => createLocalBashExecutor({ logDir: target })).toThrow();
  }
});

it("creates private spill files and preserves the head/tail and full log", () => {
  const buffer = new HeadTailBuffer(4, 1024, "out", root());
  buffer.write(Buffer.from("abcdefgh"));
  const result = buffer.render();
  expect(result.text).toContain("ab");
  expect(result.text).toContain("gh");
  expect(readFileSync(result.logPath!, "utf8")).toBe("abcdefgh");
  if (process.platform !== "win32") expect(statSync(result.logPath!).mode & 0o777).toBe(0o600);
});

it("rejects a planted metadata-directory symlink before starting a job", () => {
  const dir = root();
  const target = path.join(dir, "target");
  mkdirSync(target);
  symlinkSync(target, path.join(dir, "job-meta"), "dir");
  expect(() => createLocalBashExecutor({ logDir: dir })).toThrow();
  expect(existsSync(path.join(target, "unexpected"))).toBe(false);
});

it("preserves background logs, pagination and restoration in an owned 0755 directory", async () => {
  const dir = root();
  chmodSync(dir, 0o755);
  const executor = createLocalBashExecutor({ logDir: dir });
  try {
    const { jobId } = await executor.spawnBackground({ command: "printf abcdef; printf error >&2", cwd: dir, env: {} });
    await expect.poll(async () => (await executor.readBackground(jobId, {})).running, { timeout: 5000 }).toBe(false);
    await expect.poll(async () => (await executor.readBackground(jobId, {})).stdout, { timeout: 5000 }).toBe("abcdef");
    const restored = createLocalBashExecutor({ logDir: dir });
    const result = await restored.readBackground(jobId, { since_byte: 2, head_limit: 3 });
    expect(result.stdout).toBe("cde");
    expect(result.stderr).toBe("ror");
    expect(result.totalBytesStdout).toBe(6);
    if (process.platform !== "win32") {
      for (const file of [`${jobId}.out`, `${jobId}.err`, `job-meta/${jobId}.json`]) {
        expect(statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
      }
    }
    rmSync(path.join(dir, `${jobId}.out`));
    expect((await restored.readBackground(jobId, {})).stdout).toBe("");
  } finally { await executor.closeSession(); }
});

it("does not recreate or follow a replaced spill file on later chunks", () => {
  const dir = root();
  const buffer = new HeadTailBuffer(4, 1024, "out", dir);
  buffer.write(Buffer.from("abcdefgh"));
  const file = buffer.render().logPath!;
  const target = path.join(root(), "secret");
  rmSync(file);
  symlinkSync(target, file);
  expect(() => buffer.write(Buffer.from("later"))).toThrow();
  expect(existsSync(target)).toBe(false);
});

it("contains output callback errors in the executor promise and returns a tool error", async () => {
  const dir = root();
  const executor = createLocalBashExecutor({ logDir: dir });
  await expect(executor.run({ command: "printf output", cwd: dir, env: {}, signal: AbortSignal.timeout(5000),
    onStdout: () => { throw new Error("spill unavailable"); }, onStderr: () => {},
  })).rejects.toThrow("spill unavailable");
  const session = makeSession(dir, { executor: { run: async () => { throw new Error("spill unavailable"); } } });
  const result = await bash({ command: "printf output" }, session);
  expect(result.kind).toBe("error");
  expect(result).toMatchObject({ kind: "error", error: { code: "IO_ERROR" } });
});

it("restores a job ID saved in the previous default directory", async () => {
  const dir = root();
  const legacyTmp = path.join(dir, "legacy-tmp");
  const home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  vi.mocked(homedir).mockReturnValue(home);
  vi.mocked(tmpdir).mockReturnValue(legacyTmp);
  const legacy = path.join(legacyTmp, "agent-sh-bash-logs");
  mkdirSync(path.join(legacy, "job-meta"), { recursive: true, mode: 0o700 });
  const jobId = "saved-job";
  const outPath = path.join(legacy, `${jobId}.out`);
  const errPath = path.join(legacy, `${jobId}.err`);
  writeFileSync(outPath, "old output", { mode: 0o600 });
  writeFileSync(errPath, "", { mode: 0o600 });
  writeFileSync(path.join(legacy, "job-meta", `${jobId}.json`), JSON.stringify({ outPath, errPath,
    running: false, exitCode: 0, createdAt: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
  const executor = createLocalBashExecutor();
  expect((await executor.readBackground(jobId, {})).stdout).toBe("old output");
});

it("opens metadata read-only and does not follow a metadata symlink", async () => {
  const dir = root();
  const executor = createLocalBashExecutor({ logDir: dir });
  await expect(executor.readBackground("missing", {})).rejects.toThrow("Unknown job_id");
  expect(existsSync(path.join(dir, "job-meta", "missing.json"))).toBe(false);
  if (process.platform !== "win32") {
    const target = path.join(root(), "metadata.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, path.join(dir, "job-meta", "linked.json"));
    await expect(executor.readBackground("linked", {})).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("{}");
  }
});

it("runs foreground commands without creating storage or requiring a writable home", async () => {
  const dir = root();
  vi.mocked(tmpdir).mockReturnValue(dir);
  vi.mocked(homedir).mockImplementation(() => { throw new Error("home unavailable"); });
  const logDir = defaultBashDirectory("logs");
  const executor = createLocalBashExecutor();
  expect(existsSync(logDir)).toBe(false);
  const result = await executor.run({ command: "printf inline", cwd: dir, env: {}, signal: AbortSignal.timeout(5000),
    onStdout: () => {}, onStderr: () => {},
  });
  expect(result.exitCode).toBe(0);
  expect(existsSync(logDir)).toBe(false);
  const { jobId } = await executor.spawnBackground({ command: "printf background", cwd: dir, env: {} });
  await expect.poll(async () => (await executor.readBackground(jobId, {})).running, { timeout: 5000 }).toBe(false);
  expect(existsSync(logDir)).toBe(true);
});
