/**
 * Vitest global setup shared by every package. The run gets a fresh
 * directory under the temp dir it inherited (TMPDIR, or the OS default),
 * TMPDIR points at it while the tests run, and the directory is removed
 * when the run ends. So everything a test creates through os.tmpdir(), or
 * through a library that honors TMPDIR, is gone after the run, including
 * files a test does not clean up itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export default function setup(): () => void {
  const inherited = process.env.TMPDIR;
  const dir = mkdtempSync(path.join(tmpdir(), "agent-sh-test-"));
  process.env.TMPDIR = dir;
  return () => {
    if (inherited === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = inherited;
    rmSync(dir, { recursive: true, force: true });
  };
}
