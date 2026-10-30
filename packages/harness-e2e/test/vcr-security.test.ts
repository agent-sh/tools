import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeVcrFetch } from "../src/vcr.js";

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(path.join(tmpdir(), "vcr-security-")); roots.push(dir); return dir; }
afterEach(() => { vi.unstubAllGlobals(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("rejects cassette traversal and a symlinked recording directory", () => {
  const cassetteDir = root();
  for (const cassetteName of ["../escape", "a/b", "a\\b"]) {
    expect(() => makeVcrFetch({ mode: "record", cassetteDir, cassetteName })).toThrow();
  }
  const link = path.join(cassetteDir, "link");
  symlinkSync(root(), link, "dir");
  expect(() => makeVcrFetch({ mode: "record", cassetteDir: link, cassetteName: "sample" })).toThrow();
});

it("rerecords atomically without following a destination symlink", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"ok":true}')));
  const cassetteDir = root();
  const record = makeVcrFetch({ mode: "record", cassetteDir, cassetteName: "sample" });
  await record("https://example.invalid/");
  const file = path.join(cassetteDir, readdirSync(cassetteDir)[0]!);
  rmSync(file);
  const target = path.join(root(), "untouched");
  writeFileSync(target, "keep");
  symlinkSync(target, file);
  await record("https://example.invalid/");
  expect(readFileSync(target, "utf8")).toBe("keep");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(cassetteDir)).toHaveLength(1);
  const replay = makeVcrFetch({ mode: "replay", cassetteDir, cassetteName: "sample" });
  expect(await (await replay("https://example.invalid/")).json()).toEqual({ ok: true });
});
