import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import type { GrepParams } from "./types.js";

const OutputModeSchema = v.picklist(
  ["files_with_matches", "content", "count"],
  "output_mode must be one of: files_with_matches, content, count",
);

export const GrepParamsSchema = v.strictObject({
  pattern: v.pipe(v.string(), v.minLength(1, "pattern is required")),
  path: v.optional(v.pipe(v.string(), v.minLength(1, "path must not be empty"))),
  glob: v.optional(v.string()),
  type: v.optional(
    v.pipe(
      v.string(),
      v.check(
        (s) => !/[,\s]/.test(s),
        "type takes a single ripgrep file-type name (e.g. 'js', 'py', 'rust'), not a list. For multiple extensions, use this tool's glob parameter instead, e.g. glob: '*.{ts,tsx,js}'.",
      ),
    ),
  ),
  output_mode: v.optional(OutputModeSchema),
  case_insensitive: v.optional(v.boolean()),
  multiline: v.optional(v.boolean()),
  fixed_strings: v.optional(v.boolean()),
  context_before: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0, "context_before must be >= 0")),
  ),
  context_after: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0, "context_after must be >= 0")),
  ),
  context: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0, "context must be >= 0")),
  ),
  head_limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "head_limit must be >= 1")),
  ),
  offset: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0, "offset must be >= 0")),
  ),
});

export type ParsedGrepParams = v.InferOutput<typeof GrepParamsSchema>;

export function parseGrepParams(input: unknown): ParsedGrepParams {
  return v.parse(GrepParamsSchema, input);
}

/**
 * Unknown keys we've observed models send when they meant a different
 * parameter. strictObject rejects them with a generic "Unknown key: X"
 * issue; we pre-check and return a targeted hint instead so the model
 * can self-correct in one turn.
 *
 * Keep this list short — only keys with clear, unambiguous redirects.
 * `content` is special: it is a legitimate output_mode VALUE, so the
 * hint mentions both plausible intents.
 */
const KNOWN_PARAM_ALIASES: Record<string, string> = {
  content:
    "unknown parameter 'content'. Did you mean 'context' (lines around a match)? If you wanted matching lines back, set output_mode: 'content' instead.",
  regex: "unknown parameter 'regex'. Use 'pattern' instead.",
  query: "unknown parameter 'query'. Use 'pattern' instead.",
  mode: "unknown parameter 'mode'. Use 'output_mode' instead.",
  output: "unknown parameter 'output'. Use 'output_mode' instead.",
  filter: "unknown parameter 'filter'. Use 'glob' or 'type' instead.",
  file_type: "unknown parameter 'file_type'. Use 'type' instead.",
  glob_pattern: "unknown parameter 'glob_pattern'. Use 'glob' instead.",
  pattern_glob: "unknown parameter 'pattern_glob'. Use 'glob' instead.",
  ignore_case:
    "unknown parameter 'ignore_case'. Use 'case_insensitive' instead.",
  insensitive:
    "unknown parameter 'insensitive'. Use 'case_insensitive' instead.",
  cwd: "unknown parameter 'cwd'. Use 'path' instead.",
  dir: "unknown parameter 'dir'. Use 'path' instead.",
  directory: "unknown parameter 'directory'. Use 'path' instead.",
  max_results:
    "unknown parameter 'max_results'. Use 'head_limit' instead (default 250).",
  max_count:
    "unknown parameter 'max_count'. Use 'head_limit' instead (default 250).",
  limit: "unknown parameter 'limit'. Use 'head_limit' instead (default 250).",
  skip: "unknown parameter 'skip'. Use 'offset' instead.",
  before: "unknown parameter 'before'. Use 'context_before' instead.",
  after: "unknown parameter 'after'. Use 'context_after' instead.",
};

function checkAliases(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const hints: string[] = [];
  for (const key of Object.keys(input as Record<string, unknown>)) {
    const hint = KNOWN_PARAM_ALIASES[key];
    if (hint) hints.push(hint);
  }
  return hints;
}

function makeAliasIssues(messages: string[]): v.BaseIssue<unknown>[] {
  return messages.map(
    (m) =>
      ({
        kind: "validation",
        type: "custom",
        input: undefined,
        expected: null,
        received: "unknown",
        message: m,
      }) as unknown as v.BaseIssue<unknown>,
  );
}

export function safeParseGrepParams(input: unknown):
  | { ok: true; value: GrepParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const aliases = checkAliases(input);
  if (aliases.length > 0) {
    return { ok: false, issues: makeAliasIssues(aliases) };
  }
  const result = v.safeParse(GrepParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues };
}

export const GREP_TOOL_NAME = "grep";

export const GREP_TOOL_DESCRIPTION = `Search file contents with a ripgrep-compatible regex and return structured results.

Choose the output mode before writing the pattern:
- Discovery starts with files_with_matches (the default) or count. This applies even when locating a definition rather than a call. Put the distinguishing syntax in the pattern, e.g. pattern: "function\\\\s+handleRequest\\\\b", output_mode: "files_with_matches". Inspect matching lines in a follow-up only if needed.
- Existence and file-count questions end with the paths/counts. Match comment syntax in the pattern when asked about comments, e.g. pattern: "//.*TODO", output_mode: "count". Count the returned files. Do not fetch content just to quote examples the user did not request.
- Use content for a request to show matching lines or surrounding code. Keep context small.

Usage:
- pattern is required. Regex syntax is ripgrep's (Rust regex). Escape literal metacharacters: use 'interface\\\\{\\\\}' to match 'interface{}'. '.' does not match newlines unless multiline: true. To search an EXACT string with regex metacharacters like ( ) . * { } treated as plain text, set fixed_strings: true instead of escaping (e.g. fixed_strings: true with pattern foo(bar) or a.b.c).
- path defaults to the session cwd. Absolute paths preferred; relative paths resolve against cwd.
- Filter by the 'glob' parameter (e.g. '*.ts', '*.{js,tsx}') or by 'type' (e.g. 'js', 'py', 'rust'). 'type' takes ONE name only — for multiple extensions, use 'glob' with a brace list like '*.{ts,tsx,js}'. 'type' is more efficient for standard languages.
- Default output_mode is 'files_with_matches' — cheap path-only results. Use this first to decide whether to pay for content.
- output_mode 'content' returns matching lines grouped by file, newest-first. Context lines come from context_before / context_after / context (-C sets both). Context is only valid with content mode.
- output_mode 'count' returns per-file match counts, alphabetical path order.
- Results are capped at head_limit (default 250). Use offset to page: next_offset = previous_offset + returned_count.
- .gitignore, .ignore, and .rgignore are respected. Hidden files are skipped. node_modules, .git, and other ignored paths will not appear.
- Binary files are skipped. Files larger than 5 MB are skipped.
- Call in parallel for independent searches. Prefer this tool over Bash(grep/rg).`;

export const grepToolDefinition: ToolDefinition = {
  name: GREP_TOOL_NAME,
  description: GREP_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Ripgrep regex. Escape literal metacharacters.",
      },
      path: {
        type: "string",
        description:
          "Directory or file to search. Absolute preferred; relative resolves against cwd. Defaults to cwd.",
      },
      glob: {
        type: "string",
        description: "Glob filter, e.g. \"*.{ts,tsx}\".",
      },
      type: {
        type: "string",
        description:
          "Ripgrep file-type filter — ONE name only (js, py, rust, go, ...). For multiple extensions, use this tool's 'glob' parameter with a brace list, e.g. glob: \"*.{ts,tsx,js}\".",
      },
      output_mode: {
        type: "string",
        enum: ["files_with_matches", "content", "count"],
        default: "files_with_matches",
        description:
          "Start discovery with files_with_matches (default) or count, including definition searches. End existence/count tasks with those results. Use content for requested matching lines, or follow-up inspection after discovery.",
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive match. Default false.",
      },
      multiline: {
        type: "boolean",
        description:
          "Allow . to match newlines and patterns to cross lines. Default false.",
      },
      fixed_strings: {
        type: "boolean",
        description:
          "Treat pattern as an exact literal string, not a regex (ripgrep -F). Use to search strings with metacharacters like ( ) . * { } as plain text without escaping. Default false.",
      },
      context_before: {
        type: "integer",
        minimum: 0,
        description: "Lines of context before each match. Content mode only.",
      },
      context_after: {
        type: "integer",
        minimum: 0,
        description: "Lines of context after each match. Content mode only.",
      },
      context: {
        type: "integer",
        minimum: 0,
        description: "Sets both context_before and context_after. Content mode only.",
      },
      head_limit: {
        type: "integer",
        minimum: 1,
        description: "Max entries (files for files_with_matches/count, matches for content). Default 250.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Skip first N entries. Use the next_offset from a previous call to page.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};
