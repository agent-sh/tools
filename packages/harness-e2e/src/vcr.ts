/**
 * VCR-style record/replay for LLM transport calls.
 *
 * Use case: you want to exercise the *harness* (runAgent / runBedrockAgent /
 * tool executors / trace plumbing) under CI without burning tokens or
 * requiring a live GPU. Record once against real inference, replay the
 * same JSON on every CI run.
 *
 * Modes, chosen via `VCR_MODE` env (or `makeVcrFetch({ mode })`):
 *   - "off"     — use the real fetch (default)
 *   - "record"  — call real fetch, write response JSON to cassette file
 *   - "replay"  — read from cassette; fail if cassette is missing
 *
 * Cassettes are matched by a hash of (url, method, body). We don't store
 * timestamps or any non-deterministic fields.
 *
 * This is *not* a regression gate for the model — replaying a cassette
 * always "passes" because you're replaying yesterday's success. It's a
 * regression gate for the harness code that wraps model calls.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, replacePrivateFile } from "@agent-sh/harness-core";

export type VcrMode = "off" | "record" | "replay";

export interface VcrOptions {
  readonly mode?: VcrMode;
  readonly cassetteDir: string;
  /** Prefix used for cassette filenames; helps group a single test's calls. */
  readonly cassetteName: string;
}

export interface CassetteEntry {
  readonly hash: string;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly bodyHash: string;
  };
  readonly response: {
    readonly status: number;
    readonly statusText: string;
    readonly body: string;
  };
}

export function resolveVcrMode(): VcrMode {
  const m = (process.env.VCR_MODE ?? "off").toLowerCase();
  if (m === "record" || m === "replay") return m;
  return "off";
}

function canonicalBody(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  // We don't support streams / Blob / FormData — the harness only sends
  // JSON strings, so throw loudly if we get something else.
  throw new Error(`VCR: unsupported body type: ${typeof body}`);
}

function hashRequest(url: string, method: string, body: string): string {
  return createHash("sha256")
    .update(`${method} ${url}\n${body}`)
    .digest("hex")
    .slice(0, 16);
}

function cassettePath(dir: string, name: string, hash: string): string {
  return path.join(dir, `${name}.${hash}.json`);
}

/**
 * Build a fetch-compatible function. Pass it to `ollamaChat({ fetchImpl })`
 * or `bedrockConverse({ fetchImpl })`.
 */
export function makeVcrFetch(opts: VcrOptions): typeof fetch {
  const mode = opts.mode ?? resolveVcrMode();
  if (mode === "off") return fetch;

  if (!opts.cassetteName || /[\\/\0]/.test(opts.cassetteName)) {
    throw new Error("VCR: cassetteName must be a filename prefix, without path separators");
  }
  if (mode === "record") {
    ensurePrivateDirectory(opts.cassetteDir);
  }

  const vcrFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "POST").toUpperCase();
    const body = canonicalBody(init?.body);
    const bodyHash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const hash = hashRequest(url, method, body);
    const file = cassettePath(opts.cassetteDir, opts.cassetteName, hash);

    if (mode === "replay") {
      if (!existsSync(file)) {
        throw new Error(
          `VCR replay: no cassette at ${file} for ${method} ${url} (bodyHash=${bodyHash})`,
        );
      }
      const entry = JSON.parse(readFileSync(file, "utf8")) as CassetteEntry;
      return new Response(entry.response.body, {
        status: entry.response.status,
        statusText: entry.response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    }

    // record
    const res = await fetch(input, init);
    const text = await res.text();
    const entry: CassetteEntry = {
      hash,
      request: { url, method, bodyHash },
      response: {
        status: res.status,
        statusText: res.statusText,
        body: text,
      },
    };
    replacePrivateFile(file, JSON.stringify(entry, null, 2));
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: { "Content-Type": "application/json" },
    });
  };

  return vcrFetch;
}
