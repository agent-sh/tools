import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader for non-secret settings (E2E_BACKEND, AWS_REGION,
 * BEDROCK_MODEL_ID). Walks up from cwd looking for a .env, parses KEY=VALUE
 * pairs, and populates process.env for any key that isn't already set. Then
 * fills credentials that are still unset from the OS keyring (see
 * loadKeyringCredentials), so tokens never need to sit in .env. No third-party
 * dependency so the harness stays light.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  const found = loadFirstDotEnv(startDir);
  loadKeyringCredentials();
  return found;
}

/** Environment variable -> keyring credential name (`cred-get NAME`). */
const KEYRING_CREDENTIALS: ReadonlyArray<readonly [string, string]> = [
  ["AWS_BEARER_TOKEN_BEDROCK", "bedrock-bearer"],
];

/**
 * For each credential variable that is still unset, ask `cred-get NAME` (the
 * machine's keyring helper; CRED_GET overrides the path). Where the helper is
 * absent, as in CI, nothing changes. The value is never logged.
 */
export function loadKeyringCredentials(): void {
  const helper = process.env["CRED_GET"] ?? "cred-get";
  for (const [envVar, name] of KEYRING_CREDENTIALS) {
    if (process.env[envVar] !== undefined) continue;
    try {
      const value = execFileSync(helper, [name], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      })
        .toString()
        .trim();
      if (value) process.env[envVar] = value;
    } catch {
      /* no helper or no such credential: leave it unset */
    }
  }
}

function loadFirstDotEnv(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
