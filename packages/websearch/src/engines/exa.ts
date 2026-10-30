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

const DEFAULT_BASE = "https://mcp.exa.ai";
const ENGINE_NAME = "exa";
const TOOL = "web_search_exa";

/**
 * Exa: its own neural web index, reached through Exa's hosted MCP server
 * (`web_search_exa`). Keyless by default (rate-limited free tier); an Exa API
 * key sent as `x-api-key` raises the limit. See Rust `engines/exa.rs`.
 *
 *   POST https://mcp.exa.ai/mcp  tools/call web_search_exa { query, numResults }
 *   → one text block of records:
 *       Title: … / URL: … / Published: <ISO>|N/A / Author: … / Highlights:
 *       <query-relevant passages separated by "...">
 *     with records separated by a `---` line.
 *
 * @param opts.apiKey optional Exa key (session.exaApiKey).
 * @param opts.baseUrl override the MCP host for tests.
 */
export function createExaEngine(
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
        arguments: { query: input.query, numResults: input.count },
        ...(apiKey !== undefined ? { headers: { "x-api-key": apiKey } } : {}),
      });

      const text = contentText(res.result);
      const results = parseExaText(text, input.query);
      if (results.length === 0 && text.includes("Title:")) {
        throw new SearchError(
          "IO_ERROR",
          "exa: the response had records but none could be parsed (format changed?)",
          { engine: ENGINE_NAME },
        );
      }
      return {
        results: results.slice(0, input.count),
        backendHost: res.host,
        elapsedMs: res.elapsedMs,
        // The MCP tool takes no freshness filter.
        ...(input.timeRange === "all" ? {} : { timeRangeApplied: false }),
      };
    },
  };
}

/**
 * Parse Exa's text records. A record starts at a `Title: ` line; header
 * fields run until `Highlights:` (or `Text:` / `Summary:`), and everything
 * after that is the excerpt the snippet is selected from.
 */
export function parseExaText(
  text: string,
  query: string,
): WebSearchResultItem[] {
  const records: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("Title: ")) records.push([]);
    records[records.length - 1]?.push(line);
  }
  const out: WebSearchResultItem[] = [];
  for (const rec of records) {
    let title = "";
    let url = "";
    let published = "";
    const body: string[] = [];
    let inBody = false;
    for (const line of rec) {
      if (inBody) {
        if (line.trim() === "---") break;
        body.push(line);
        continue;
      }
      if (line.startsWith("Title: ")) title = line.slice(7).trim();
      else if (line.startsWith("URL: ")) url = line.slice(5).trim();
      else if (line.startsWith("Published: ")) published = line.slice(11).trim();
      else if (["Highlights:", "Text:", "Summary:"].includes(line.trim())) {
        inBody = true;
      }
    }
    if (title.length === 0 || url.length === 0) continue;
    const age = isoDate(published);
    out.push({
      title,
      url,
      snippet: selectPassage(body.join("\n"), query, title),
      ...(age !== undefined ? { age } : {}),
    });
  }
  return out;
}
