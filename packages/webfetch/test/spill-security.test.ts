import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { spillToFile } from "../src/format.js";

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(path.join(tmpdir(), "fetch-security-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("keeps fetched bodies private and preserves bytes", () => {
  const file = spillToFile({ dir: root(), sessionId: "session", bytes: Buffer.from("body"), contentType: "text/plain" });
  expect(readFileSync(file, "utf8")).toBe("body");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

it("rejects session traversal and planted session symlinks", () => {
  const dir = root();
  for (const sessionId of ["../escape", "..", "a/b", "a\\b"]) {
    expect(() => spillToFile({ dir, sessionId, bytes: Buffer.from("bad"), contentType: "text/plain" })).toThrow();
  }
  const outside = root();
  symlinkSync(outside, path.join(dir, "linked"), "dir");
  expect(() => spillToFile({ dir, sessionId: "linked", bytes: Buffer.from("bad"), contentType: "text/plain" })).toThrow();
});
