import { stripTrailingSlashes } from "./html.js";
import type {
  NamedWebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
  WebSearchSafeSearch,
} from "../types.js";
import { httpGet } from "./http.js";
import { SearchError } from "./searchError.js";

const ENGINE_NAME = "searxng";

/**
 * SearXNG JSON engine — the power-user / self-hosted backend. Unchanged in
 * behavior from v1: builds the SearXNG JSON request from the declarative
 * params (the model never sees the backend DSL), re-checks SSRF on the host,
 * maps `content`→`snippet`. Now built on the shared httpGet helper so its
 * transport-error mapping matches the other engines.
 *
 * @param backendUrl the configured SearXNG base URL (session.searxngUrl).
 */
export function createSearxngEngine(
  backendUrl: string,
): NamedWebSearchEngine {
  return {
    name: ENGINE_NAME,
    engineClass: "general",
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      const base = safeParseUrl(backendUrl);
      if (!base) {
        throw new SearchError(
          "IO_ERROR",
          `Invalid backend URL: ${backendUrl}`,
          { engine: ENGINE_NAME },
        );
      }
      const url = buildSearchUrl(base, input);
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
          `Could not parse the search backend response as JSON: ${(e as Error).message}`,
          { engine: ENGINE_NAME },
        );
      }
      const results = mapResults(parsed);
      return {
        results,
        backendHost: res.host,
        elapsedMs: res.elapsedMs,
        // SearXNG applies the time_range param when one is requested.
        ...(input.timeRange === "all" ? {} : { timeRangeApplied: true }),
      };
    },
  };
}

function buildSearchUrl(base: URL, input: WebSearchEngineInput): URL {
  const url = new URL(base.toString());
  url.pathname = joinPath(url.pathname, "search");
  const p = url.searchParams;
  p.set("q", input.query);
  p.set("format", "json");
  p.set("safesearch", String(safeSearchToNumeric(input.safeSearch)));
  if (input.timeRange !== "all") {
    p.set("time_range", input.timeRange);
  }
  p.set("language", input.language);
  p.set("categories", input.categories.join(","));
  p.set("pageno", "1");
  return url;
}

function joinPath(basePath: string, segment: string): string {
  const trimmed = stripTrailingSlashes(basePath);
  return `${trimmed}/${segment}`;
}

function safeSearchToNumeric(s: WebSearchSafeSearch): 0 | 1 | 2 {
  switch (s) {
    case "off":
      return 0;
    case "moderate":
      return 1;
    case "strict":
      return 2;
  }
}

function mapResults(parsed: unknown): WebSearchResultItem[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const raw = (parsed as { results?: unknown }).results;
  if (!Array.isArray(raw)) return [];
  const out: WebSearchResultItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { title?: unknown; url?: unknown; content?: unknown };
    const title = typeof e.title === "string" ? e.title : "";
    const url = typeof e.url === "string" ? e.url : "";
    if (title.length === 0 || url.length === 0) continue;
    const snippet = typeof e.content === "string" ? e.content : "";
    out.push({ title, url, snippet });
  }
  return out;
}

function safeParseUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}
