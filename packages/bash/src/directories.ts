import { tmpdir, userInfo } from "node:os";
import path from "node:path";

/** Stable per-user storage also works for services without a writable home. */
export function defaultBashDirectory(kind: "logs" | "spill"): string {
  const user = process.getuid?.() ?? userInfo().username;
  return path.join(tmpdir(), `agent-sh-bash-${encodeURIComponent(String(user))}`, kind);
}
