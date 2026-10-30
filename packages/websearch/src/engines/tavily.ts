import { stripTrailingSlashes } from "./html.js";
import { request } from "undici";
import type {
  NamedWebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
} from "../types.js";
import { stripTags } from "./html.js";
import { translateTransportError } from "./http.js";
import { SearchError } from "./searchError.js";

const DEFAULT_BASE = "https://api.tavily.com";
const ENGINE_NAME = "tavily";

/**
 * Tavily Search API — keyed, results pre-cleaned for LLMs (the default of
 * gpt-researcher). Free tier ~1k credits/month. Activated when the session
 * provides `tavilyApiKey`.
 *
 *   POST https://api.tavily.com/search
 *     { api_key, query, max_results, search_depth, time_range }
 *   → { results: [{ title, url, content }] }
 *
 * Unlike the other engines this is a POST with a JSON body, so it issues its
 * own undici request rather than going through the GET-only httpGet helper —
 * but it reuses the shared SSRF check (input.checkHost) and transport-error
 * translation for parity.
 *
 * @param apiKey the Tavily API key (from session.tavilyApiKey).
 * @param opts.baseUrl override the API host for tests.
 */
export function createTavilyEngine(
  apiKey: string,
  opts: { baseUrl?: string } = {},
): NamedWebSearchEngine {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  return {
    name: ENGINE_NAME,
    engineClass: "general",
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      const url = new URL(base);
      url.pathname = joinPath(url.pathname, "search");
      await input.checkHost(url.hostname);

      const body: Record<string, unknown> = {
        api_key: apiKey,
        query: input.query,
        max_results: input.count,
        search_depth: "basic",
      };
      if (input.timeRange !== "all") body["time_range"] = input.timeRange;

      const started = Date.now();
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(url.toString(), {
          method: "POST",
          headers: {
            ...input.headers,
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: input.signal,
          bodyTimeout: input.timeoutMs,
          headersTimeout: input.timeoutMs,
        });
      } catch (e) {
        if (e instanceof SearchError) throw e;
        throw translateTransportError(e, ENGINE_NAME);
      }

      const status = res.statusCode;
      if (status >= 400) {
        await res.body.dump();
        if (status >= 500 || status === 429 || status === 401 || status === 403) {
          throw new SearchError(
            "SERVER_NOT_AVAILABLE",
            `tavily is unavailable (HTTP ${status})`,
            { status, engine: ENGINE_NAME },
          );
        }
        throw new SearchError(
          "INVALID_PARAM",
          `tavily rejected the request with HTTP ${status}`,
          { status, engine: ENGINE_NAME },
        );
      }

      let parsed: unknown;
      try {
        parsed = await res.body.json();
      } catch (e) {
        throw new SearchError(
          "IO_ERROR",
          `tavily: could not parse response as JSON: ${(e as Error).message}`,
          { engine: ENGINE_NAME },
        );
      }
      return {
        results: mapResults(parsed),
        backendHost: url.hostname,
        elapsedMs: Date.now() - started,
        // Tavily honors time_range when one was requested.
        ...(input.timeRange === "all" ? {} : { timeRangeApplied: true }),
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
      content?: unknown;
      score?: unknown;
      published_date?: unknown;
    };
    const title = typeof e.title === "string" ? e.title : "";
    const url = typeof e.url === "string" ? e.url : "";
    if (title.length === 0 || url.length === 0) continue;
    const snippet = typeof e.content === "string" ? stripTags(e.content) : "";
    const score = typeof e.score === "number" ? e.score : undefined;
    const age =
      typeof e.published_date === "string" && e.published_date.length > 0
        ? (/^(\d{4}-\d{2}-\d{2})/.exec(e.published_date.trim())?.[1] ??
          undefined)
        : undefined;
    out.push({
      title,
      url,
      snippet,
      ...(age !== undefined ? { age } : {}),
      ...(score !== undefined ? { score } : {}),
    });
  }
  return out;
}

function joinPath(basePath: string, segment: string): string {
  const trimmed = stripTrailingSlashes(basePath);
  return `${trimmed}/${segment}`;
}
