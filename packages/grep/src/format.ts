import type { RgCount } from "./types.js";

function kbLabel(bytes: number): string {
  return `${Math.floor(bytes / 1024)} KB`;
}

/**
 * Filters active on the call that produced a zero-result. The hint we emit
 * when nothing matched lists the cheapest retries for the model to try.
 * Included fields are suggested; omitted are ignored.
 */
export interface ZeroMatchContext {
  readonly caseInsensitive: boolean;
  readonly glob: string | undefined;
  readonly type: string | undefined;
}

function zeroMatchHint(ctx: ZeroMatchContext): string {
  const suggestions: string[] = [];
  if (!ctx.caseInsensitive) suggestions.push("case_insensitive: true");
  if (ctx.glob) suggestions.push(`remove glob='${ctx.glob}'`);
  if (ctx.type) suggestions.push(`remove type='${ctx.type}'`);
  suggestions.push("broaden the pattern");
  suggestions.push("try a different path");
  return `(No files matched. Try: ${suggestions.join("; ")}.)`;
}

export function formatFilesWithMatches(params: {
  pattern: string;
  paths: readonly string[];
  total: number;
  offset: number;
  headLimit: number;
  more: boolean;
  zeroMatchContext?: ZeroMatchContext;
}): string {
  const { pattern, paths, total, offset, more, zeroMatchContext } = params;
  const header = `<pattern>${pattern}</pattern>\n<matches>`;
  if (paths.length === 0) {
    const hint = zeroMatchContext
      ? zeroMatchHint(zeroMatchContext)
      : "(No files matched)";
    return `${header}\n${hint}\n</matches>`;
  }
  const body = paths.join("\n");
  const next = offset + paths.length;
  const hint = more
    ? `(Showing files ${offset + 1}-${next} of ${total}. Next offset: ${next}.)`
    : `(Found ${total} file(s) matching the pattern.)`;
  return `${header}\n${body}\n\n${hint}\n</matches>`;
}

interface ContentLine {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export function formatContent(params: {
  pattern: string;
  matches: readonly ContentLine[];
  totalMatches: number;
  totalFiles: number;
  offset: number;
  headLimit: number;
  more: boolean;
  byteCap: boolean;
  maxBytes: number;
  zeroMatchContext?: ZeroMatchContext;
}): string {
  const {
    pattern,
    matches,
    totalMatches,
    offset,
    more,
    byteCap,
    maxBytes,
    zeroMatchContext,
  } = params;
  const header = `<pattern>${pattern}</pattern>\n<matches>`;
  if (matches.length === 0) {
    const hint = zeroMatchContext
      ? zeroMatchHint(zeroMatchContext).replace("No files matched", "No matches")
      : "(No matches)";
    return `${header}\n${hint}\n</matches>`;
  }
  const chunks: string[] = [];
  let current = "";
  for (const m of matches) {
    if (m.path !== current) {
      if (current !== "") chunks.push("");
      chunks.push(m.path);
      current = m.path;
    }
    chunks.push(`  ${m.line}: ${m.text}`);
  }
  const body = chunks.join("\n");
  const next = offset + matches.length;
  let hint: string;
  if (byteCap) {
    hint = `(Output capped at ${kbLabel(maxBytes)}. Showing matches ${offset + 1}-${next} of ${totalMatches}. Next offset: ${next}.)`;
  } else if (more) {
    hint = `(Showing matches ${offset + 1}-${next} of ${totalMatches}. Next offset: ${next}.)`;
  } else {
    const fileCount = new Set(matches.map((m) => m.path)).size;
    hint = `(Found ${totalMatches} match(es) across ${fileCount} file(s).)`;
  }
  return `${header}\n${body}\n\n${hint}\n</matches>`;
}

export function formatCount(params: {
  pattern: string;
  counts: readonly RgCount[];
  total: number;
  offset: number;
  headLimit: number;
  more: boolean;
  zeroMatchContext?: ZeroMatchContext;
}): string {
  const { pattern, counts, total, offset, more, zeroMatchContext } = params;
  const header = `<pattern>${pattern}</pattern>\n<counts>`;
  if (counts.length === 0) {
    const hint = zeroMatchContext
      ? zeroMatchHint(zeroMatchContext).replace("No files matched", "No matches")
      : "(No matches)";
    return `${header}\n${hint}\n</counts>`;
  }
  const body = counts.map((c) => `${c.path}: ${c.count}`).join("\n");
  const next = offset + counts.length;
  const hint = more
    ? `(Showing files ${offset + 1}-${next} of ${total}. Next offset: ${next}.)`
    : `(${total} file(s) with matches.)\n(Count complete. For an existence or file-count question, answer from these counts; matching text is not needed.)`;
  return `${header}\n${body}\n\n${hint}\n</counts>`;
}
