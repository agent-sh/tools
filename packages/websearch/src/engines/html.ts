/**
 * Minimal, dependency-free HTML text utilities for the scrape-based engines
 * (Mojeek) and tagged-snippet APIs (Wikipedia's `<span class=searchmatch>`).
 *
 * We deliberately do NOT pull in jsdom/readability here (unlike webfetch):
 * websearch parses a small, known result-list structure, not arbitrary
 * article bodies, so a targeted entity-decode + tag-strip keeps the package
 * light and the parse fast. The Mojeek block parser lives in its engine.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsaquo: "\u203a",
  lsaquo: "\u2039",
  raquo: "\u00bb",
  laquo: "\u00ab",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
  middot: "\u00b7",
  deg: "\u00b0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  eacute: "\u00e9",
  egrave: "\u00e8",
  agrave: "\u00e0",
  ccedil: "\u00e7",
  uuml: "\u00fc",
  ouml: "\u00f6",
  auml: "\u00e4",
};

/** Decode the HTML entities that actually occur in SERP markup. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    const b = body as string;
    if (b.charAt(0) === "#") {
      const isHex = b.charAt(1) === "x" || b.charAt(1) === "X";
      const code = Number.parseInt(b.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const named = NAMED_ENTITIES[b.toLowerCase()];
    return named ?? m;
  });
}

/** Strip HTML tags, decode entities, and collapse whitespace. */
export function stripTags(html: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    const end = html.indexOf(">", start + 1);
    if (end < 0) break;
    parts.push(html.slice(cursor, start), " ");
    cursor = end + 1;
  }
  parts.push(html.slice(cursor));
  return decodeEntities(parts.join("")).replace(/\s+/g, " ").trim();
}

/** Unlike an unanchored /\/+$/ match, a backward scan never retries a suffix. */
export function stripTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input[end - 1] === "/") end--;
  return input.slice(0, end);
}

/** Scan each opening tag once, including malformed markup with no closing tag. */
export function findElement(html: string, tag: string, matches: (opening: string) => boolean): { opening: string; body: string } | null {
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf(`<${tag}`, cursor);
    if (start < 0) return null;
    const end = html.indexOf(">", start + tag.length + 1);
    if (end < 0) return null;
    cursor = end + 1;
    const opening = html.slice(start, cursor);
    if (!matches(opening)) continue;
    const close = html.indexOf(`</${tag}>`, cursor);
    if (close < 0) return null;
    return { opening, body: html.slice(cursor, close) };
  }
  return null;
}

export function attributeValue(opening: string, name: string): string | null {
  let cursor = 1;
  while (cursor < opening.length && !/[\s/>]/.test(opening[cursor]!)) cursor++;
  while (cursor < opening.length) {
    while (cursor < opening.length && /[\s/]/.test(opening[cursor]!)) cursor++;
    if (opening[cursor] === ">") break;
    const start = cursor;
    while (cursor < opening.length && !/[\s=/>]/.test(opening[cursor]!)) cursor++;
    const attribute = opening.slice(start, cursor);
    while (cursor < opening.length && /\s/.test(opening[cursor]!)) cursor++;
    if (opening[cursor] !== "=") { if (cursor === start) cursor++; continue; }
    cursor++;
    while (cursor < opening.length && /\s/.test(opening[cursor]!)) cursor++;
    const quote = opening[cursor];
    let value: string;
    if (quote === '"' || quote === "'") {
      const end = opening.indexOf(quote, cursor + 1);
      if (end < 0) return null;
      value = opening.slice(cursor + 1, end);
      cursor = end + 1;
    } else {
      const valueStart = cursor;
      while (cursor < opening.length && !/[\s>]/.test(opening[cursor]!)) cursor++;
      value = opening.slice(valueStart, cursor);
    }
    if (attribute === name) return value;
  }
  return null;
}
