/**
 * pi extension bridge for @agent-sh/harness-tools.
 *
 * Registers every harness tool (read, write, edit, multiedit, grep, glob,
 * bash, bash_output, bash_kill, webfetch, websearch, lsp, skill) with the pi
 * coding agent (@earendil-works/pi-coding-agent). pi installs this package as an
 * extension via the package.json `"pi": { "extensions": [...] }` field and
 * calls the default export with an `ExtensionAPI`.
 *
 * Each tool's parameters are expressed as a TypeBox schema (pi uses `typebox`
 * for `TSchema`/`Static`). The execute() wrapper builds a per-tool harness
 * `session` from environment variables with safe defaults, invokes the
 * underlying harness function, and maps the harness result union onto pi's
 * `{ content: [{ type: "text", text }] }` shape.
 *
 * Permissions: pi is itself the permission layer, so every harness tool's
 * `unsafeAllow*WithoutHook` escape is set — otherwise the harness permission
 * fence would fail-closed (no hook supplied) and double-gate the call. Roots
 * are anchored at the execute ctx.cwd.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { formatToolError, InMemoryLedger, type Ledger, type PermissionPolicy, type ToolError } from "@agent-sh/harness-core";

// Tool functions + their definitions (for description text) + session types.
import {
  read,
  readToolDefinition,
  type ReadSessionConfig,
} from "@agent-sh/harness-read";
import {
  write,
  edit,
  multiEdit,
  writeToolDefinition,
  editToolDefinition,
  multieditToolDefinition,
  type WriteSessionConfig,
} from "@agent-sh/harness-write";
import {
  grep,
  grepToolDefinition,
  type GrepSessionConfig,
} from "@agent-sh/harness-grep";
import {
  glob,
  globToolDefinition,
  type GlobSessionConfig,
} from "@agent-sh/harness-glob";
import {
  bash,
  bashOutput,
  bashKill,
  bashToolDefinition,
  bashOutputToolDefinition,
  bashKillToolDefinition,
  type BashSessionConfig,
} from "@agent-sh/harness-bash";
import {
  webfetch,
  webfetchToolDefinition,
  makeSessionCache,
  type WebFetchSessionConfig,
} from "@agent-sh/harness-webfetch";
import {
  websearch,
  websearchToolDefinition,
  type WebSearchSessionConfig,
} from "@agent-sh/harness-websearch";
import {
  lsp,
  lspToolDefinition,
  type LspSessionConfig,
} from "@agent-sh/harness-lsp";
import {
  skill,
  skillToolDefinition,
  FilesystemSkillRegistry,
  type SkillSessionConfig,
} from "@agent-sh/harness-skill";
import {
  executeBatch,
  batchToolDefinition,
  safeParseBatchParams,
  type BatchParams,
} from "@agent-sh/harness-batch";

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

/** Harness tool results are a discriminated union on `kind`. */
type HarnessResult =
  | { readonly kind: "error"; readonly error: ToolError }
  | { readonly kind: string; readonly output?: string };

/**
 * Map a harness tool result onto pi's tool-result shape. For `kind:"error"`
 * we render the structured ToolError; every other kind (ok/empty/text/
 * directory/attachment/paths/content/count/preview/nonzero_exit/timeout/
 * background_started/redirect_loop/http_error/already_loaded/not_found/…)
 * carries an `output` string we forward verbatim.
 */
function toPiResult(result: HarnessResult) {
  let text: string;
  if (result.kind === "error" && "error" in result && result.error) {
    text = formatToolError(result.error);
  } else if (typeof (result as { output?: string }).output === "string") {
    text = (result as { output: string }).output;
  } else {
    // Defensive fallback — should not happen for known harness kinds.
    text = JSON.stringify(result);
  }
  return { content: [{ type: "text" as const, text }], details: undefined };
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

/** Filesystem permission policy anchored at cwd; pi mediates approval. */
function fsPermissions(cwd: string): PermissionPolicy {
  return {
    roots: [cwd],
    sensitivePatterns: [],
    // pi gates the call itself; allow the harness to run without its own hook.
    bypassWorkspaceGuard: true,
  };
}

// ---------------------------------------------------------------------------
// Per-tool TypeBox parameter schemas (mirror each harness tool's JSON-schema
// inputSchema / valibot schema: same names, types, enums, defaults).
// ---------------------------------------------------------------------------

const ReadParams = Type.Object({
  path: Type.String({ description: "Absolute path (or relative to cwd) of the file or directory to read." }),
  offset: Type.Optional(Type.Integer({ description: "1-indexed line to start from." })),
  limit: Type.Optional(Type.Integer({ description: "Maximum number of lines to return." })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Absolute path (or relative to cwd) of the file to create/overwrite." }),
  content: Type.String({ description: "Full file contents to write." }),
});

const EditSpecSchema = Type.Object({
  old_string: Type.String(),
  new_string: Type.String(),
  replace_all: Type.Optional(Type.Boolean()),
  ignore_whitespace: Type.Optional(Type.Boolean({ description: "Ignore leading/trailing whitespace differences when matching." })),
});

const EditParams = Type.Object({
  path: Type.String({ description: "Absolute path (or relative to cwd) of the file to edit." }),
  old_string: Type.String({ description: "Exact text to replace (must match the file content)." }),
  new_string: Type.String({ description: "Replacement text." }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness." })),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview the unified diff without writing." })),
  ignore_whitespace: Type.Optional(Type.Boolean({ description: "Ignore leading/trailing whitespace differences when matching." })),
});

const MultiEditParams = Type.Object({
  path: Type.String({ description: "Absolute path (or relative to cwd) of the file to edit." }),
  edits: Type.Array(EditSpecSchema, { description: "Ordered list of edits applied sequentially in memory." }),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview the final unified diff without writing." })),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: "ripgrep-compatible (Rust regex) pattern." }),
  path: Type.Optional(Type.String({ description: "File or directory to search; defaults to cwd." })),
  glob: Type.Optional(Type.String({ description: "Glob filter, e.g. '*.ts' or '*.{js,tsx}'." })),
  type: Type.Optional(Type.String({ description: "Single ripgrep file type, e.g. 'js', 'py', 'rust'." })),
  output_mode: Type.Optional(
    Type.Union(
      [Type.Literal("files_with_matches"), Type.Literal("content"), Type.Literal("count")],
      { description: "Output mode; default files_with_matches." },
    ),
  ),
  case_insensitive: Type.Optional(Type.Boolean()),
  multiline: Type.Optional(Type.Boolean()),
  fixed_strings: Type.Optional(
    Type.Boolean({
      description:
        "Treat pattern as an exact literal string, not a regex (ripgrep -F). Use to search strings with metacharacters like ( ) . * { } as plain text without escaping. Default false.",
    }),
  ),
  context_before: Type.Optional(Type.Integer()),
  context_after: Type.Optional(Type.Integer()),
  context: Type.Optional(Type.Integer()),
  head_limit: Type.Optional(Type.Integer({ description: "Cap on returned results; default 250." })),
  offset: Type.Optional(Type.Integer({ description: "Paging offset." })),
});

const GlobParams = Type.Object({
  pattern: Type.String({ description: "Bash-style glob, e.g. '**/*.ts'." }),
  path: Type.Optional(Type.String({ description: "Directory to search; defaults to cwd." })),
  head_limit: Type.Optional(Type.Integer({ description: "Cap on returned paths; default 250." })),
  offset: Type.Optional(Type.Integer({ description: "Paging offset." })),
});

const BashParams = Type.Object({
  command: Type.String({ description: "Shell command to run in a bash subprocess." }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this command." })),
  timeout_ms: Type.Optional(Type.Integer({ description: "Inactivity timeout in ms; default 60000." })),
  description: Type.Optional(Type.String({ description: "Short human-readable description of the command." })),
  background: Type.Optional(Type.Boolean({ description: "Run detached; returns a job_id polled via bash_output." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables." })),
});

const BashOutputParams = Type.Object({
  job_id: Type.String({ description: "Job id returned by a background bash call." }),
  since_byte: Type.Optional(Type.Integer({ description: "Byte offset to read from (for pagination)." })),
  head_limit: Type.Optional(Type.Integer()),
});

const BashKillParams = Type.Object({
  job_id: Type.String({ description: "Job id of the background job to terminate." }),
  signal: Type.Optional(
    Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL")], {
      description: "Termination signal; default SIGTERM.",
    }),
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "http:// or https:// URL to fetch." }),
  method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")], { description: "HTTP method; default GET." })),
  body: Type.Optional(Type.String({ description: "Request body for POST." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra request headers." })),
  extract: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("raw"), Type.Literal("both")], {
      description: "Extraction mode for HTML; default markdown.",
    }),
  ),
  timeout_ms: Type.Optional(Type.Integer({ description: "Request timeout in ms (>= 1000)." })),
  max_redirects: Type.Optional(Type.Integer({ description: "Max redirect hops (0-10)." })),
});

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query (1-512 chars)." }),
  count: Type.Optional(Type.Integer({ description: "Number of results, 1-20 (default 5)." })),
  time_range: Type.Optional(
    Type.Union(
      [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year"), Type.Literal("all")],
      { description: "Freshness window; default all." },
    ),
  ),
  language: Type.Optional(Type.String({ description: "Language hint, e.g. 'en'; default auto." })),
  safe_search: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("moderate"), Type.Literal("strict")], {
      description: "Safe-search level; default moderate.",
    }),
  ),
  categories: Type.Optional(Type.Array(Type.String(), { description: "SearXNG categories; default ['general']." })),
});

const LspParams = Type.Object({
  operation: Type.Union(
    [
      Type.Literal("hover"),
      Type.Literal("definition"),
      Type.Literal("references"),
      Type.Literal("documentSymbol"),
      Type.Literal("workspaceSymbol"),
      Type.Literal("implementation"),
    ],
    { description: "LSP operation to perform." },
  ),
  path: Type.Optional(Type.String({ description: "File path (required for position-based ops and documentSymbol)." })),
  line: Type.Optional(Type.Integer({ description: "1-indexed line." })),
  character: Type.Optional(Type.Integer({ description: "1-indexed character column." })),
  query: Type.Optional(Type.String({ description: "Symbol query for workspaceSymbol." })),
  head_limit: Type.Optional(Type.Integer({ description: "Cap on results; default 200." })),
});

const SkillParams = Type.Object({
  name: Type.String({ description: "Name of the installed skill to activate." }),
  arguments: Type.Optional(
    Type.Union([Type.String(), Type.Record(Type.String(), Type.String())], {
      description: "Positional string or named-argument object for the skill.",
    }),
  ),
});

// Batch target schemas (union of subdirs, glob, explicit)
const BatchTargetSubdirs = Type.Object({
  kind: Type.Literal("subdirs"),
  path: Type.String({ description: "Root directory to scan for subdirectories." }),
  name_filter: Type.Optional(Type.String({ description: "Optional name filter for subdirectory names." })),
});
const BatchTargetGlob = Type.Object({
  kind: Type.Literal("glob"),
  pattern: Type.String({ description: "Glob pattern for target directories." }),
});
const BatchTargetExplicit = Type.Object({
  kind: Type.Literal("explicit"),
  paths: Type.Array(Type.String(), { description: "Explicit list of directory paths." }),
});

const BatchParams = Type.Object({
  command: Type.String({ description: "Shell command to run in each target. Use $TARGET for the current directory." }),
  targets: Type.Union([BatchTargetSubdirs, BatchTargetGlob, BatchTargetExplicit], {
    description: "Target selection: subdirs, glob, or explicit.",
  }),
  mode: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("parallel")], {
    description: "Execution mode. Default: sequential.",
  })),
  max_concurrent: Type.Optional(Type.Integer({ minimum: 1, description: "Max concurrent commands for parallel mode (default 4)." })),
  timeout_secs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Timeout per command in seconds (default 120)." })),
  fail_fast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default false)." })),
  summary_only: Type.Optional(Type.Boolean({ description: "Return only summary counts (default false)." })),
});

// ---------------------------------------------------------------------------
// Session builders (env-resolved, pi-mediated permissions)
// ---------------------------------------------------------------------------

/** Spread an `AbortSignal` into a session object only when defined. */
function withSignal<T extends object>(base: T, signal?: AbortSignal): T {
  return signal ? { ...base, signal } : base;
}

function readSession(cwd: string, ledger: Ledger, signal?: AbortSignal): ReadSessionConfig {
  return withSignal({ cwd, permissions: fsPermissions(cwd), ledger }, signal);
}
function writeSession(cwd: string, ledger: Ledger, signal?: AbortSignal): WriteSessionConfig {
  return withSignal({ cwd, permissions: fsPermissions(cwd), ledger }, signal);
}
function grepSession(cwd: string, signal?: AbortSignal): GrepSessionConfig {
  return withSignal({ cwd, permissions: fsPermissions(cwd) }, signal);
}
function globSession(cwd: string, signal?: AbortSignal): GlobSessionConfig {
  return withSignal({ cwd, permissions: fsPermissions(cwd) }, signal);
}
function bashSession(cwd: string, signal?: AbortSignal): BashSessionConfig {
  return withSignal(
    { cwd, permissions: { ...fsPermissions(cwd), unsafeAllowBashWithoutHook: true } },
    signal,
  );
}
function lspSession(cwd: string, signal?: AbortSignal): LspSessionConfig {
  return withSignal(
    { cwd, permissions: { ...fsPermissions(cwd), unsafeAllowLspWithoutHook: true } },
    signal,
  );
}
function skillSession(cwd: string, signal?: AbortSignal): SkillSessionConfig {
  // Discover skills under the conventional ~/.claude/skills and cwd-local
  // .agent-sh/skills roots, plus an override list.
  const roots = (process.env.HARNESS_SKILL_ROOTS ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  if (roots.length === 0) {
    roots.push(`${cwd}/.agent-sh/skills`);
    const home = process.env.HOME;
    if (home) roots.push(`${home}/.claude/skills`);
  }
  return withSignal(
    {
      cwd,
      permissions: { ...fsPermissions(cwd), unsafeAllowSkillWithoutHook: true },
      registry: new FilesystemSkillRegistry(roots),
      userInitiated: true,
    },
    signal,
  );
}

function webfetchSession(signal?: AbortSignal): WebFetchSessionConfig {
  return withSignal(
    {
      permissions: { roots: [], sensitivePatterns: [], unsafeAllowFetchWithoutHook: true },
      allowLoopback: envBool("WEBFETCH_ALLOW_LOOPBACK", false),
      allowPrivateNetworks: envBool("WEBFETCH_ALLOW_PRIVATE", false),
      cache: makeSessionCache(),
    },
    signal,
  );
}

function websearchSession(signal?: AbortSignal): WebSearchSessionConfig {
  const base: WebSearchSessionConfig = {
    permissions: { roots: [], sensitivePatterns: [], unsafeAllowSearchWithoutHook: true },
    // A self-hosted SearXNG is typically local; default the SSRF opt-ins on.
    allowLoopback: envBool("SEARXNG_ALLOW_LOOPBACK", true),
    allowPrivateNetworks: envBool("SEARXNG_ALLOW_PRIVATE", true),
  };
  const searxngUrl = process.env.SEARXNG_URL;
  return withSignal(searxngUrl ? { ...base, searxngUrl } : base, signal);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function harnessToolsExtension(pi: ExtensionAPI): void {
  // Single per-process ledger shared by read + write/edit/multiedit so the
  // read-before-edit gate composes (Read records here; Edit/Write read it back).
  // harnessToolsExtension runs once at module load; the register() closures
  // capture this instance for the whole pi process.
  const ledger = new InMemoryLedger();

  const register = <T extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: T,
    run: (params: Static<T>, cwd: string, signal?: AbortSignal) => Promise<HarnessResult>,
  ): void => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        try {
          const result = await run(params, ctx.cwd, signal ?? undefined);
          return toPiResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `${name} tool error: ${message}` }], details: undefined };
        }
      },
    });
  };

  register("read", "Read", readToolDefinition.description, ReadParams, (p, cwd, signal) =>
    read(p, readSession(cwd, ledger, signal)),
  );

  register("write", "Write", writeToolDefinition.description, WriteParams, (p, cwd, signal) =>
    write(p, writeSession(cwd, ledger, signal)),
  );

  register("edit", "Edit", editToolDefinition.description, EditParams, (p, cwd, signal) =>
    edit(p, writeSession(cwd, ledger, signal)),
  );

  register("multi_edit", "MultiEdit", multieditToolDefinition.description, MultiEditParams, (p, cwd, signal) =>
    multiEdit(p, writeSession(cwd, ledger, signal)),
  );

  register("grep", "Grep", grepToolDefinition.description, GrepParams, (p, cwd, signal) =>
    grep(p, grepSession(cwd, signal)),
  );

  register("glob", "Glob", globToolDefinition.description, GlobParams, (p, cwd, signal) =>
    glob(p, globSession(cwd, signal)),
  );

  register("bash", "Bash", bashToolDefinition.description, BashParams, (p, cwd, signal) =>
    bash(p, bashSession(cwd, signal)),
  );

  register("bash_output", "BashOutput", bashOutputToolDefinition.description, BashOutputParams, (p, cwd, signal) =>
    bashOutput(p, bashSession(cwd, signal)),
  );

  register("bash_kill", "BashKill", bashKillToolDefinition.description, BashKillParams, (p, cwd, signal) =>
    bashKill(p, bashSession(cwd, signal)),
  );

  register("webfetch", "WebFetch", webfetchToolDefinition.description, WebFetchParams, (p, _cwd, signal) =>
    webfetch(p, webfetchSession(signal)),
  );

  register("websearch", "WebSearch", websearchToolDefinition.description, WebSearchParams, (p, _cwd, signal) =>
    websearch(p, websearchSession(signal)),
  );

  register("lsp", "LSP", lspToolDefinition.description, LspParams, (p, cwd, signal) =>
    lsp(p, lspSession(cwd, signal)),
  );

  register("skill", "Skill", skillToolDefinition.description, SkillParams, (p, cwd, signal) =>
    skill(p, skillSession(cwd, signal)),
  );

  // Batch: parse params with valibot, then execute with workspace fence.
  register("batch", "Batch", batchToolDefinition.description, BatchParams, async (p, cwd, _signal) => {
    const parsed = safeParseBatchParams(p);
    if (!parsed.ok) {
      return { kind: "error", error: { code: "INVALID_PARAM" as const, message: parsed.issues.map(i => i.message).join("; ") } };
    }
    // Resolve targets against cwd, canonicalize to real paths, and fence inside workspace.
    const realCwd = await fs.promises.realpath(cwd);
    const isInside = (real: string) => {
      const rel = path.relative(realCwd, real);
      // rel === "" means exactly the workspace root; startsWith("..") means escape.
      return !rel.startsWith("..");
    };

    const targets = parsed.value.targets;
    if (targets.kind === "subdirs") {
      const resolved = path.isAbsolute(targets.path) ? targets.path : path.resolve(cwd, targets.path);
      const real = await fs.promises.realpath(resolved);
      if (!isInside(real)) {
        return { kind: "error", error: { code: "INVALID_PARAM" as const, message: `subdirs path "${targets.path}" resolves outside workspace` } };
      }
      parsed.value.targets = { ...targets, path: real };
    } else if (targets.kind === "glob") {
      const resolved = path.isAbsolute(targets.pattern) ? targets.pattern : path.resolve(cwd, targets.pattern);
      // Walk up from the pattern until we find an existing directory to check.
      let checkPath = resolved;
      while (checkPath && checkPath !== path.parse(checkPath).root) {
        try {
          await fs.promises.access(checkPath);
          break;
        } catch {
          checkPath = path.dirname(checkPath);
        }
      }
      if (checkPath && !isInside(checkPath)) {
        return { kind: "error", error: { code: "INVALID_PARAM" as const, message: `glob pattern "${targets.pattern}" resolves outside workspace` } };
      }
      parsed.value.targets = { ...targets, pattern: resolved };
    } else if (targets.kind === "explicit") {
      const resolvedPaths: string[] = [];
      for (const tp of targets.paths) {
        const resolved = path.isAbsolute(tp) ? tp : path.resolve(cwd, tp);
        // Canonicalize first via realpath, then check workspace containment.
        // This prevents symlink-based bypass of the lexical check.
        const realPath = await fs.promises.realpath(resolved).catch(() => resolved);
        if (!isInside(realPath)) {
          return { kind: "error", error: { code: "INVALID_PARAM" as const, message: `explicit path "${tp}" resolves outside workspace` } };
        }
        resolvedPaths.push(realPath);
      }
      parsed.value.targets = { ...targets, paths: resolvedPaths };
    }
    const result = await executeBatch(parsed.value, cwd);
    return { kind: "ok", output: result.message + (Object.keys(result.meta).length ? `\n${JSON.stringify(result.meta, null, 2)}` : "") };
  });
}
