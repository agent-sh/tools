import { stripTrailingSlashes } from "./html.js";
import type {
  NamedWebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
} from "../types.js";
import { stripTags } from "./html.js";
import { httpGet } from "./http.js";
import { SearchError } from "./searchError.js";

const DEFAULT_BASE = "https://api.marginalia.nu";
const ENGINE_NAME = "marginalia";

/**
 * Marginalia public search API — keyless JSON, the cleanest ToS-wise of the
 * bundled keyless engines (a documented public API, not a scraped SERP).
 *
 *   GET https://api.marginalia.nu/public/search/{query}?count={n}
 *   → { license, query, results: [{ url, title, description, quality, ... }] }
 *
 * Maps title←title, url←url, snippet←description. The index is "small web"
 * (blogs, forums, docs) — excellent for technical/indie queries, weak on
 * mainstream and very-recent results. Results are CC-BY-NC-SA 4.0.
 *
 * @param opts.baseUrl override the API host (tests point this at a fixture
 *   server; production uses the default public host).
 */
export function createMarginaliaEngine(
  opts: { baseUrl?: string } = {},
): NamedWebSearchEngine {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  return {
    name: ENGINE_NAME,
    engineClass: "niche",
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      const url = new URL(base);
      url.pathname = joinPath(url.pathname, [
        "public",
        "search",
        encodeURIComponent(input.query),
      ]);
      // Marginalia caps at ~100; ask for the model's count directly.
      url.searchParams.set("count", String(input.count));

      const res = await httpGet(url, input, {
        accept: "application/json",
        engine: ENGINE_NAME,
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch (e) {
        throw new SearchError(
          "IO_ERROR",
          `marginalia: could not parse response as JSON: ${(e as Error).message}`,
          { engine: ENGINE_NAME },
        );
      }

      const results = mapResults(parsed);
      return {
        results,
        backendHost: res.host,
        elapsedMs: res.elapsedMs,
        // Marginalia's public API has no recency filter.
        ...(input.timeRange === "all" ? {} : { timeRangeApplied: false }),
      };
    },
  };
}

function mapResults(parsed: unknown): WebSearchResultItem[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const raw = (parsed as { results?: unknown }).results;
  if (!Array.isArray(raw)) return [];
  const out: WebSearchResultItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
      quality?: unknown;
    };
    const title = typeof e.title === "string" ? e.title : "";
    const url = typeof e.url === "string" ? e.url : "";
    if (title.length === 0 || url.length === 0) continue;
    const snippet =
      typeof e.description === "string" ? stripTags(e.description) : "";
    const score = typeof e.quality === "number" ? e.quality : undefined;
    out.push(
      score !== undefined
        ? { title, url, snippet, score }
        : { title, url, snippet },
    );
  }
  return out;
}

function joinPath(basePath: string, segments: string[]): string {
  const trimmed = stripTrailingSlashes(basePath);
  return `${trimmed}/${segments.join("/")}`;
}
