import type {
  NamedWebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
} from "../types.js";
import { attributeValue, findElement, stripTags, stripTrailingSlashes } from "./html.js";
import { httpGet } from "./http.js";
import { SearchError } from "./searchError.js";

const DEFAULT_BASE = "https://www.mojeek.com";
const ENGINE_NAME = "mojeek";

/**
 * Mojeek search — keyless HTML SERP parse, independent full-web crawl (not a
 * Google/Bing reseller), so it gives mainstream coverage the niche keyless
 * JSON APIs (Marginalia/Wikipedia) lack.
 *
 *   GET https://www.mojeek.com/search?q={query}
 *   → HTML; result list under <ul class="results-standard">, each result a
 *     block delimited by <!--rs--> ... <!--re--> containing
 *       <a class="title" href="URL">TITLE</a> ... <p class="s">SNIPPET</p>
 *
 * ToS note: Mojeek's robots.txt disallows /search and they sell an official
 * API — this is a scrape, a ToS gray area. It is therefore **opt-out**: the
 * fallback chain includes it by default for coverage, but a session can drop
 * it with `disableMojeek: true` (and the design doc flags it). We send our
 * honest agent User-Agent (no browser spoofing).
 *
 * @param opts.baseUrl override the host for tests (fixture server).
 */
export function createMojeekEngine(
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
      url.searchParams.set("q", input.query);

      const res = await httpGet(url, input, {
        accept: "text/html,application/xhtml+xml",
        engine: ENGINE_NAME,
      });

      // Distinguish a genuine "no hits" SERP from an anti-bot challenge.
      // A real Mojeek SERP — even with zero results — carries the result
      // scaffold (serp-results / results-count + "No pages found"); a
      // challenge/interstitial page has none of it. Only the latter should
      // fail the engine so the fallback chain moves on; a real empty SERP is
      // a legitimate `empty` outcome the chain may keep or surface.
      const results = parseMojeek(res.text).slice(0, input.count);
      if (results.length === 0 && looksChallenged(res.text)) {
        throw new SearchError(
          "SERVER_NOT_AVAILABLE",
          "mojeek returned no parseable results (likely an anti-bot challenge or interstitial from this IP)",
          { engine: ENGINE_NAME },
        );
      }
      return {
        results,
        backendHost: res.host,
        elapsedMs: res.elapsedMs,
        // Mojeek's SERP scrape has no recency filter.
        ...(input.timeRange === "all" ? {} : { timeRangeApplied: false }),
      };
    },
  };
}

/**
 * Parse Mojeek's result blocks. Exported for unit testing against a saved
 * fixture (no live network).
 */
export function parseMojeek(html: string): WebSearchResultItem[] {
  const out: WebSearchResultItem[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<!--rs-->", cursor);
    if (start < 0) break;
    const end = html.indexOf("<!--re-->", start + 9);
    if (end < 0) break;
    const block = html.slice(start + 9, end);
    cursor = end + 9;
    const titleMatch = findElement(block, "a", (opening) => attributeValue(opening, "class") === "title" && (attributeValue(opening, "href")?.length ?? 0) > 0);
    if (!titleMatch) continue;
    const url = decodeHref(attributeValue(titleMatch.opening, "href") ?? "");
    const title = stripTags(titleMatch.body);
    if (url.length === 0 || title.length === 0) continue;
    const snippetMatch = findElement(block, "p", (opening) => attributeValue(opening, "class") === "s");
    const snippet = snippetMatch ? stripTags(snippetMatch.body) : "";
    out.push({ title, url, snippet });
  }
  return out;
}

function looksChallenged(html: string): boolean {
  // A genuine Mojeek SERP (even with zero hits) carries the result scaffold:
  // the "serp-results" container, a "results-count" bar, or an explicit
  // "No pages found" message. A bot-challenge / interstitial page has none of
  // these — that's what we treat as the engine being unavailable.
  const hasScaffold =
    html.includes("results-standard") ||
    html.includes("serp-results") ||
    html.includes("results-count") ||
    /no pages found/i.test(html);
  return !hasScaffold;
}

function decodeHref(href: string): string {
  return href.replace(/&amp;/g, "&");
}

function joinPath(basePath: string, segment: string): string {
  const trimmed = stripTrailingSlashes(basePath);
  return `${trimmed}/${segment}`;
}
