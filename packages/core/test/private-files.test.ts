import { lstatSync, realpathSync, type Stats } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ensurePrivateDirectory } from "../src/private-files.js";

vi.mock("node:fs", { spy: true });
afterEach(() => vi.restoreAllMocks());

it.skipIf(!process.getuid)("does not carry private-parent trust across a symlink into a public tree", () => {
  const uid = process.getuid!();
  const tree = new Map<string, [number, number, boolean]>([
    ["/", [0, 0o755, false]], ["/private", [uid, 0o700, false]],
    ["/private/alias", [uid, 0o777, true]], ["/tmp", [0, 0o1777, false]],
    ["/tmp/shared", [uid, 0o777, false]], ["/tmp/shared/logs", [uid, 0o700, false]],
  ]);
  vi.mocked(lstatSync).mockImplementation((input) => {
    const name = String(input).replace(/^\/private\/alias\//, "/tmp/");
    const entry = tree.get(name);
    if (!entry) throw new Error(`Unexpected path ${name}`);
    const [owner, mode, symlink] = entry;
    return { uid: owner, mode, isSymbolicLink: () => symlink, isDirectory: () => !symlink } as Stats;
  });
  vi.mocked(realpathSync).mockReturnValue("/tmp");
  expect(() => ensurePrivateDirectory("/tmp/shared/logs")).toThrow("Unsafe output directory");
  expect(() => ensurePrivateDirectory("/private/alias/shared/logs")).toThrow("Unsafe output directory");
});
