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

const ENGINE_NAME = "wikipedia";

/**
 * Wikipedia / MediaWiki search API — keyless JSON, encyclopedic only.
 * Rock-solid (it never anti-bot-challenges with a descriptive User-Agent),
 * so it's the always-available tail of the fallback chain: best for factual
 * / entity queries and as a "never returns a transport error" backstop.
 *
 *   GET https://{lang}.wikipedia.org/w/api.php
 *       ?action=query&list=search&srsearch={q}&srlimit={n}&format=json
 *   → { query: { search: [{ title, pageid, snippet (html), ... }] } }
 *
 * Maps title←title, url←https://{lang}.wikipedia.org/?curid={pageid},
 * snippet←strip-tags(snippet). `language: "auto"`/unset → "en".
 *
 * @param opts.baseUrl override the API origin for tests (fixture server).
 *   In production the origin is derived from the request language.
 */
export function createWikipediaEngine(
  opts: { baseUrl?: string } = {},
): NamedWebSearchEngine {
  return {
    name: ENGINE_NAME,
    engineClass: "vertical",
    async search(
      input: WebSearchEngineInput,
    ): Promise<WebSearchEngineResult> {
      const lang = normalizeLang(input.language);
      const origin = opts.baseUrl ?? `https://${lang}.wikipedia.org`;
      const url = new URL(origin);
      url.pathname = joinPath(url.pathname, ["w", "api.php"]);
      const p = url.searchParams;
      p.set("action", "query");
      p.set("list", "search");
      p.set("srsearch", input.query);
      p.set("srlimit", String(input.count));
      p.set("format", "json");

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
          `wikipedia: could not parse response as JSON: ${(e as Error).message}`,
          { engine: ENGINE_NAME },
        );
      }

      const results = mapResults(parsed, lang, origin);
      return {
        results,
        backendHost: res.host,
        elapsedMs: res.elapsedMs,
        // Wikipedia search ignores recency filtering.
        ...(input.timeRange === "all" ? {} : { timeRangeApplied: false }),
      };
    },
  };
}

function mapResults(
  parsed: unknown,
  _lang: string,
  origin: string,
): WebSearchResultItem[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const query = (parsed as { query?: unknown }).query;
  if (query === null || typeof query !== "object") return [];
  const raw = (query as { search?: unknown }).search;
  if (!Array.isArray(raw)) return [];
  const out: WebSearchResultItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      pageid?: unknown;
      snippet?: unknown;
      timestamp?: unknown;
    };
    const title = typeof e.title === "string" ? e.title : "";
    if (title.length === 0) continue;
    let url = "";
    if (typeof e.pageid === "number") {
      url = `${stripTrailingSlashes(origin)}/?curid=${e.pageid}`;
    } else {
      url = `${stripTrailingSlashes(origin)}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    }
    const snippet = typeof e.snippet === "string" ? stripTags(e.snippet) : "";
    // `timestamp` is the article's last-edit time; surface the date portion
    // as `age` (NB: last-edit, not first-publication).
    const age =
      typeof e.timestamp === "string" ? isoDate(e.timestamp) : undefined;
    out.push(
      age !== undefined
        ? { title, url, snippet, age }
        : { title, url, snippet },
    );
  }
  return out;
}

function normalizeLang(language: string): string {
  if (language === "" || language === "auto") return "en";
  // Take the primary subtag: "en-US" → "en".
  const primary = language.split(/[-_]/)[0] ?? "en";
  // Wikipedia language codes are lowercase ascii; reject anything weird.
  return /^[a-z]{2,3}$/.test(primary.toLowerCase())
    ? primary.toLowerCase()
    : "en";
}

function joinPath(basePath: string, segments: string[]): string {
  const trimmed = stripTrailingSlashes(basePath);
  return `${trimmed}/${segments.join("/")}`;
}

/** Extract the YYYY-MM-DD date portion from an ISO timestamp; null if unparseable. */
export function isoDate(ts: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts.trim());
  return m ? m[1] : undefined;
}
