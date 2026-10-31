/**
 * First-turn warmup for Ollama.
 *
 * Ollama lazy-loads models. The first call after `ollama stop` can take
 * 10-60s to return while the model is copied to VRAM. That latency is
 * model-load, not inference, and it pollutes any timing measurement from
 * the first real test.
 *
 * `warmupOllama` sends a one-token "ok" prompt, discards the response,
 * and returns the measured latency. Call it from `beforeAll` in any
 * timing-sensitive suite.
 *
 * Bedrock has no analogous model-load cost, so no warmup is provided for
 * it — `bedrockAvailable` already serves as the probe.
 */

import { ollamaChat, ollamaModelAvailable } from "./ollama.js";

export interface WarmupResult {
  readonly available: boolean;
  readonly latencyMs: number;
  readonly skipped: boolean;
  readonly reason?: string;
}

export interface WarmupOptions {
  readonly model: string;
  readonly baseUrl?: string;
  /** Max time we're willing to wait for warmup before giving up. */
  readonly timeoutMs?: number;
  /** If true, throw when model is unavailable. Default false (returns
   *  `{ available: false }` so the caller can skip). */
  readonly throwOnUnavailable?: boolean;
}

export async function warmupOllama(
  opts: WarmupOptions,
): Promise<WarmupResult> {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const available = await ollamaModelAvailable(opts.model, baseUrl);
  if (!available) {
    const reason = `model "${opts.model}" not found at ${baseUrl}`;
    if (opts.throwOnUnavailable) throw new Error(reason);
    return { available: false, latencyMs: 0, skipped: true, reason };
  }

  const start = Date.now();
  try {
    await Promise.race([
      ollamaChat({
        model: opts.model,
        baseUrl,
        messages: [
          { role: "system", content: "Reply with a single word." },
          { role: "user", content: "Say: ok" },
        ],
        think: true,
        temperature: 0.6,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`warmup timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  } catch (e) {
    const reason = (e as Error).message;
    if (opts.throwOnUnavailable) throw e;
    return { available: true, latencyMs: Date.now() - start, skipped: true, reason };
  }
  const latencyMs = Date.now() - start;
  return { available: true, latencyMs, skipped: false };
}
