import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import type {
  BatchParams,
  BatchTargetSubdirs,
  BatchTargetGlob,
  BatchTargetExplicit,
} from "./types.js";

// Target schemas

export const BatchTargetSubdirsSchema = v.strictObject({
  kind: v.literal("subdirs"),
  path: v.pipe(v.string(), v.minLength(1, "path is required")),
  name_filter: v.optional(v.string()),
});

export const BatchTargetGlobSchema = v.strictObject({
  kind: v.literal("glob"),
  pattern: v.pipe(v.string(), v.minLength(1, "pattern is required")),
});

export const BatchTargetExplicitSchema = v.strictObject({
  kind: v.literal("explicit"),
  paths: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1, "path must not be empty"))),
    v.minLength(1, "paths must contain at least one entry"),
  ),
});

export const BatchTargetSchema = v.union([
  BatchTargetSubdirsSchema,
  BatchTargetGlobSchema,
  BatchTargetExplicitSchema,
]);

export type ParsedBatchTarget =
  | v.InferOutput<typeof BatchTargetSubdirsSchema>
  | v.InferOutput<typeof BatchTargetGlobSchema>
  | v.InferOutput<typeof BatchTargetExplicitSchema>;

export const BatchParamsSchema = v.strictObject({
  command: v.pipe(
    v.string(),
    v.minLength(1, "command is required"),
    v.maxLength(16384, "command exceeds 16384 bytes"),
  ),
  targets: BatchTargetSchema,
  mode: v.optional(v.picklist(["sequential", "parallel"])),
  max_concurrent: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "max_concurrent must be >= 1")),
  ),
  timeout_secs: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1, "timeout_secs must be >= 1"),
      v.maxValue(3600, "timeout_secs must be <= 3600 (1 hour)"),
    ),
  ),
  fail_fast: v.optional(v.boolean()),
  summary_only: v.optional(v.boolean()),
});

export type ParsedBatchParams = v.InferOutput<typeof BatchParamsSchema>;

/**
 * Alias table for common model mistakes.
 */
const KNOWN_PARAM_ALIASES: Record<string, string> = {
  repos:
    "unknown parameter 'repos'. Use 'targets' instead (e.g. targets: { kind: 'subdirs', path: '/home/avifenesh/projects' }).",
  directories:
    "unknown parameter 'directories'. Use 'targets' instead.",
  dirs: "unknown parameter 'dirs'. Use 'targets' instead.",
  paths:
    "unknown parameter 'paths'. Use 'targets: { kind: 'explicit', paths: [...] }' instead.",
  git_cmd: "unknown parameter 'git_cmd'. Use 'command' instead.",
  git_command: "unknown parameter 'git_command'. Use 'command' instead.",
  cmd: "unknown parameter 'cmd'. Use 'command' instead.",
  shell_cmd: "unknown parameter 'shell_cmd'. Use 'command' instead.",
  parallel:
    "unknown parameter 'parallel'. Use 'mode: 'parallel'' instead.",
  concurrent:
    "unknown parameter 'concurrent'. Use 'max_concurrent' instead.",
  timeout:
    "unknown parameter 'timeout'. Use 'timeout_secs' instead (seconds, not milliseconds).",
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
        kind: "validation" as const,
        type: "custom" as const,
        input: undefined,
        expected: null,
        received: "unknown",
        message: m,
      }) as unknown as v.BaseIssue<unknown>,
  );
}

export function safeParseBatchParams(input: unknown):
  | { ok: true; value: BatchParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const aliases = checkAliases(input);
  if (aliases.length > 0) {
    return { ok: false, issues: makeAliasIssues(aliases) };
  }
  const result = v.safeParse(BatchParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  if (input !== null && typeof input === "object" && "targets" in input) {
    const targetResult = v.safeParse(BatchTargetSchema, input.targets);
    if (!targetResult.success) {
      return { ok: false, issues: [...result.issues, ...makeAliasIssues([
        'targets must be an object, not a JSON string. Use targets: { kind: "explicit", paths: ["/workspace/a", "/workspace/b"] }, { kind: "subdirs", path: "/workspace" }, or { kind: "glob", pattern: "/workspace/*" }. The discriminator is kind; mode is only for sequential/parallel execution.',
      ])] };
    }
  }
  return { ok: false, issues: result.issues };
}

// Tool definition exposed to the LLM.

export const BATCH_TOOL_NAME = "batch";

export const BATCH_TOOL_DESCRIPTION = `Run the same command in multiple directories. Prefer this tool over a shell loop or one shell command combining several directories. Each target gets its own working directory and separately reported status/output. This includes inspecting the same marker, config or version file across workspaces, as well as Git operations and builds.

Supports three target modes:
- targets: { kind: "subdirs", path: "/workspace" } runs in each immediate subdirectory
- targets: { kind: "glob", pattern: "/workspace/*" } runs in each matching directory
- targets: { kind: "explicit", paths: ["/workspace/a", "/workspace/b"] } runs in the listed directories
targets is an object, never a JSON-encoded string. Its discriminator is kind. The separate mode field controls execution, not target selection.

Execution modes:
- sequential: run one at a time, accumulate results
- parallel: run concurrently (max_concurrent controls concurrency)

Use $TARGET in the command to reference the current directory.
Use fail_fast to stop on first failure.
Use summary_only to get counts instead of per-target output.`;

export const batchToolDefinition: ToolDefinition = {
  name: BATCH_TOOL_NAME,
  description: BATCH_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Shell command to run in each target. Use $TARGET to reference the current directory.",
      },
      targets: {
        type: "object",
        description: "Target selector object, not a JSON string. Set kind to subdirs, glob or explicit, with the corresponding path, pattern or paths field.",
        properties: {
          kind: { type: "string", enum: ["subdirs", "glob", "explicit"], description: "Target selection: subdirs uses path, glob uses pattern, explicit uses paths." },
          path: { type: "string", description: "Root directory when kind is subdirs." },
          name_filter: { type: "string", description: "Optional subdirectory name glob for kind subdirs." },
          pattern: { type: "string", description: "Directory glob when kind is glob." },
          paths: { type: "array", items: { type: "string" }, description: "Directory paths when kind is explicit." },
        },
        required: ["kind"],
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "subdirs" },
              path: {
                type: "string",
                description: "Root directory to scan for subdirectories.",
              },
              name_filter: {
                type: "string",
                description: "Optional name filter (glob pattern for subdirectory names).",
              },
            },
            required: ["kind", "path"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "glob" },
              pattern: {
                type: "string",
                description: "Glob pattern for target directories.",
              },
            },
            required: ["kind", "pattern"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "explicit" },
              paths: {
                type: "array",
                items: { type: "string" },
                description: "Explicit list of directory paths.",
              },
            },
            required: ["kind", "paths"],
          },
        ],
      },
      mode: {
        type: "string",
        enum: ["sequential", "parallel"],
        description: "Execution mode. Default: sequential.",
      },
      max_concurrent: {
        type: "integer",
        minimum: 1,
        description: "Max concurrent commands for parallel mode (default 4).",
      },
      timeout_secs: {
        type: "integer",
        minimum: 1,
        maximum: 3600,
        description: "Timeout per command in seconds (default 120).",
      },
      fail_fast: {
        type: "boolean",
        description: "Stop on first failure (default false).",
      },
      summary_only: {
        type: "boolean",
        description: "Return only summary counts, not per-target output (default false).",
      },
    },
    required: ["command", "targets"],
    additionalProperties: false,
  },
};
