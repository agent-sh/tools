import { stripTrailingSlashes } from "./html.js";
import type {
  NamedWebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
} from "../types.js";
import { contentText, isoDate, mcpToolCall } from "./mcp.js";
import { selectPassage } from "./passage.js";
import { SearchError } from "./searchError.js";

const DEFAULT_BASE = "https://search.parallel.ai";
const ENGINE_NAME = "parallel";
const TOOL = "web_search";

/**
 * Parallel: its own web index built for agents, reached through Parallel's
 * hosted Search MCP server (`web_search`). Keyless by default ("free for
 * exploration and light use"); a Parallel API key sent as a bearer token
 * raises the limit. See Rust `engines/parallel.rs`.
 *
 *   POST https://search.parallel.ai/mcp
 *     tools/call web_search { objective, search_queries }
 *   → structuredContent: { results: [{ url, title, publish_date, excerpts[] }] }
 *     (the same JSON is also in the text content)
 *
 * The tool has no result-count input and returns ~10 results, so the engine
 * truncates to `count`.
 *
 * @param opts.apiKey optional Parallel key (session.parallelApiKey).
 * @param opts.baseUrl override the MCP host for tests.
 */
export function createParallelEngine(
  opts: { apiKey?: string; baseUrl?: string } = {},
): NamedWebSearchEngine {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const apiKey =
    opts.apiKey !== undefined && opts.apiKey.length > 0 ? opts.apiKey : undefined;
  return {
    name: ENGINE_NAME,
    engineClass: "general",
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      const url = new URL(base);
      url.pathname = `${stripTrailingSlashes(url.pathname)}/mcp`;
      const res = await mcpToolCall(url, input, {
        engine: ENGINE_NAME,
        tool: TOOL,
        arguments: { objective: input.query, search_queries: [input.query] },
        ...(apiKey !== undefined
          ? { headers: { authorization: `Bearer ${apiKey}` } }
          : {}),
      });

      // Prefer structuredContent; fall back to the JSON text content.
      let payload: unknown = res.result["structuredContent"];
      if (payload === null || typeof payload !== "object") {
        try {
          payload = JSON.parse(contentText(res.result));
        } catch (e) {
          throw new SearchError(
            "IO_ERROR",
            `parallel: could not parse the search result JSON: ${(e as Error).message}`,
            { engine: ENGINE_NAME },
          );
        }
      }
      return {
        results: mapParallelResults(payload, input.query).slice(0, input.count),
        backendHost: res.host,
        elapsedMs: res.elapsedMs,
        // The MCP tool takes no freshness filter.
        ...(input.timeRange === "all" ? {} : { timeRangeApplied: false }),
      };
    },
  };
}

export function mapParallelResults(
  payload: unknown,
  query: string,
): WebSearchResultItem[] {
  if (payload === null || typeof payload !== "object") return [];
  const raw = (payload as { results?: unknown }).results;
  if (!Array.isArray(raw)) return [];
  const out: WebSearchResultItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      excerpts?: unknown;
      publish_date?: unknown;
    };
    const title = typeof e.title === "string" ? e.title.trim() : "";
    const url = typeof e.url === "string" ? e.url.trim() : "";
    if (title.length === 0 || url.length === 0) continue;
    const excerpts = Array.isArray(e.excerpts)
      ? e.excerpts.filter((x): x is string => typeof x === "string")
      : [];
    const age = isoDate(e.publish_date);
    out.push({
      title,
      url,
      snippet: selectPassage(excerpts.join("\n"), query, title),
      ...(age !== undefined ? { age } : {}),
    });
  }
  return out;
}
