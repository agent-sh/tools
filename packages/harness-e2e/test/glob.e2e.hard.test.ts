import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type { GlobSessionConfig } from "@agent-sh/harness-glob";
import {
  bedrockAvailable,
  loadDotEnv,
  makeGlobExecutor,
  makeGlobExecutorRust,
  makeShellExecutor,
  modelLabel,
  ollamaModelAvailable,
  passAtK,
  resolveBackend,
  resolveModel,
  runE2E,
  warmupOllama,
  type AgentTraceEvent,
} from "../src/index.js";

/**
 * Engine-swap for Rust-port parity testing. Mirrors the pattern used
 * in grep.e2e.hard.test.ts. HARNESS_GLOB_ENGINE=rust routes every
 * `makeGlobExecutor` call through the spawned `harness-glob-cli`
 * binary instead of the in-process TS orchestrator.
 */
const ENGINE = (process.env.HARNESS_GLOB_ENGINE ?? "ts").toLowerCase();
const pickGlobExecutor: typeof makeGlobExecutor =
  ENGINE === "rust"
    ? ((session) => {
        const r = makeGlobExecutorRust(session);
        return { tool: r.tool, execute: r.execute };
      })
    : makeGlobExecutor;

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are a coding agent with a single tool: `glob`, which finds files by name pattern.",
  "Prefer `glob` over anything else for finding files by path/name.",
  "Glob syntax is bash-style: `*` matches within one path segment, `**` matches any number of segments.",
  "To search recursively across subdirectories, include `**/` in the pattern (e.g. `**/*.ts`). A bare `*.ts` matches ONLY top-level files.",
  "The result is sorted by modification time, newest first, so the top of the list is usually the most-relevant anchor.",
  "If the tool returns 'No files matched', re-read the hint — it tells you what to try next (often: add '**/' for recursive).",
  "If results are truncated at head_limit, narrow the pattern or page with the Next offset hint.",
  "When the task is done, answer in a short plain-text sentence.",
].join(" ");

const SYSTEM_PROMPT_WITH_SHELL =
  SYSTEM_PROMPT +
  " A `shell` tool is also available, but you MUST prefer the dedicated `glob` tool for finding files by name. Only use `shell` for tasks glob cannot do.";

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-glob-hard-")));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  const parent = path.dirname(p);
  if (parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content);
  return p;
}

function makeSession(
  root: string,
  overrides: Partial<GlobSessionConfig> = {},
): GlobSessionConfig {
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ...overrides,
  };
}

interface TraceSummary {
  turns: number;
  toolsByName: Record<string, number>;
  toolSeq: string[];
  toolArgs: Array<{ name: string; args: Record<string, unknown> }>;
  finalContent: string;
  events: AgentTraceEvent[];
}

let currentTrace: TraceSummary | null = null;

function collectTrace(): {
  trace: TraceSummary;
  onTrace: (e: AgentTraceEvent) => void;
} {
  const trace: TraceSummary = {
    turns: 0,
    toolsByName: {},
    toolSeq: [],
    toolArgs: [],
    finalContent: "",
    events: [],
  };
  currentTrace = trace;
  const onTrace = (e: AgentTraceEvent) => {
    trace.events.push(e);
    if (e.kind === "tool_call") {
      trace.toolsByName[e.name] = (trace.toolsByName[e.name] ?? 0) + 1;
      trace.toolSeq.push(e.name);
      trace.toolArgs.push({ name: e.name, args: e.args ?? {} });
    }
    if (e.kind === "final") {
      trace.turns = e.turns;
      trace.finalContent = e.content;
    }
  };
  return { trace, onTrace };
}

function runOpts(
  systemPrompt: string,
  userPrompt: string,
  tools: Parameters<typeof runE2E>[0]["tools"],
  maxTurns: number,
  onTrace: (e: AgentTraceEvent) => void,
): Parameters<typeof runE2E>[0] {
  const opts: Parameters<typeof runE2E>[0] = {
    backend: BACKEND,
    model: MODEL,
    tools,
    systemPrompt,
    userPrompt,
    maxTurns,
    onTrace,
  };
  if (BACKEND === "ollama") {
    (opts as { baseUrl: string }).baseUrl = OLLAMA_BASE_URL;
  }
  return opts;
}

function globCallsIn(trace: TraceSummary): Array<Record<string, unknown>> {
  return trace.toolArgs.filter((c) => c.name === "glob").map((c) => c.args);
}

/**
 * Combined text surface for evidence checks: final answer + the body of
 * every glob tool_result the model received. Weak models (gemma:e2b)
 * correctly locate files via glob but summarize ("I found 3 files")
 * instead of echoing filenames in the final reply. Asserting only on
 * the final reply produces false negatives; tool_result contents are
 * ground truth that the model *saw* the right paths.
 */
function combinedTextSurface(
  trace: TraceSummary,
  finalContent: string,
): string {
  const toolOutputs = trace.events
    .filter((e): e is AgentTraceEvent & { kind: "tool_result"; content: string } =>
      e.kind === "tool_result" && typeof (e as { content?: unknown }).content === "string",
    )
    .map((e) => e.content)
    .join("\n");
  return `${finalContent}\n${toolOutputs}`;
}

const TRACE_DIR = process.env.E2E_TRACE_DIR;

describe(`glob e2e hard [${LABEL}]`, () => {
  let available = false;

  afterEach((ctx) => {
    if (!TRACE_DIR || !currentTrace) {
      currentTrace = null;
      return;
    }
    try {
      mkdirSync(TRACE_DIR, { recursive: true });
      const testName = ctx.task?.name ?? "unknown";
      const safeName = testName.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 120);
      const file = path.join(
        TRACE_DIR,
        `${LABEL.replace(/[^a-zA-Z0-9]+/g, "_")}__${safeName}.json`,
      );
      writeFileSync(
        file,
        JSON.stringify(
          {
            label: LABEL,
            testName,
            state: ctx.task?.result?.state ?? "unknown",
            trace: currentTrace,
          },
          null,
          2,
        ),
      );
    } catch {
      // best-effort trace dump
    }
    currentTrace = null;
  });

  beforeAll(async () => {
    if (BACKEND === "bedrock") {
      available = await bedrockAvailable(process.env.AWS_REGION);
      if (!available) {
        console.warn(
          `[skip] Bedrock not reachable (region=${process.env.AWS_REGION ?? "us-east-1"}) or AWS_BEARER_TOKEN_BEDROCK missing`,
        );
      }
    } else {
      available = await ollamaModelAvailable(MODEL, OLLAMA_BASE_URL);
      if (!available) {
        console.warn(
          `[skip] Ollama model "${MODEL}" not available at ${OLLAMA_BASE_URL}`,
        );
        return;
      }
      const w = await warmupOllama({ model: MODEL, baseUrl: OLLAMA_BASE_URL });
      console.log(
        `[warmup ${LABEL}] latencyMs=${w.latencyMs} skipped=${w.skipped}${
          w.reason ? ` reason=${w.reason}` : ""
        }`,
      );
    }
  });

  // G1: Golden — find a specific file with a clear pattern.
  it(
    "G1 golden: locates a uniquely named file via recursive pattern",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      writeFile(root, "src/UserService.ts", "export class UserService {}\n");
      writeFile(root, "src/AuthService.ts", "export class AuthService {}\n");
      writeFile(root, "src/util.ts", "export const x = 1;\n");

      const tools = [pickGlobExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `The project is at ${root}. Find the file containing the UserService class and tell me its path.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G1 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.glob ?? 0).toBeGreaterThanOrEqual(1);
      expect(res.finalContent).toMatch(/UserService\.ts/);
    },
    300_000,
  );

  // G2: Refine — a too-broad pattern truncates, model narrows.
  it(
    "G2 refine: narrows after a truncated result set",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      for (let i = 0; i < 400; i++) {
        writeFile(root, `pkg/f${i}.ts`, `export const x${i} = ${i};\n`);
      }
      writeFile(
        root,
        "pkg/SpecialWidget.tsx",
        "export const SpecialWidget = () => null;\n",
      );

      const tools = [pickGlobExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, find the TSX file named 'SpecialWidget'. If your first search returns too many results, narrow the pattern.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[G2 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.glob ?? 0).toBeGreaterThanOrEqual(1);
      expect(res.finalContent).toMatch(/SpecialWidget\.tsx/);
    },
    300_000,
  );

  // G3: Forgotten **. Stochastic — wrapped in pass@k.
  it(
    "G3 forgot-**: recovers from bare '*.ts' via the zero-match hint",
    async (ctx) => {
      if (!available) ctx.skip();
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "G3",
        run: async () => {
          const root = mkRoot();
          // Only nested .ts files — top-level has nothing.
          writeFile(root, "src/deep/a.ts", "x");
          writeFile(root, "src/deep/b.ts", "x");
          writeFile(root, "pkg/nested/c.ts", "x");
          // Top-level has a non-matching file
          writeFile(root, "README.md", "# project\n");

          const tools = [pickGlobExecutor(makeSession(root))];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, list all TypeScript files in the project.`,
              tools,
              6,
              onTrace,
            ),
          );

          // Evidence = final reply OR any glob tool_result the model saw.
          // Weak models summarize ("I found 3 TS files") in the final reply
          // but DID see the filenames via the tool — which is what the
          // test is actually measuring (did glob return nested files?).
          const surface = combinedTextSurface(trace, res.finalContent);
          const sawNested =
            /a\.ts/.test(surface) ||
            /b\.ts/.test(surface) ||
            /c\.ts/.test(surface);
          return {
            ok: sawNested,
            detail: {
              turns: trace.turns,
              seq: trace.toolSeq,
              patterns: globCallsIn(trace).map((a) => a.pattern),
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // G4: Bash-decoy — shell available, glob is the right tool.
  it(
    "G4 bash-decoy: prefers glob over shell for filename search",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      writeFile(root, "src/UniqueWidget.tsx", "x");
      writeFile(root, "src/other.ts", "x");

      const tools = [
        pickGlobExecutor(makeSession(root)),
        makeShellExecutor({ cwd: root }),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT_WITH_SHELL,
          `In ${root}, find a file named UniqueWidget (any extension). Use the best available tool.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G4 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.glob ?? 0).toBeGreaterThanOrEqual(1);
      expect(trace.toolsByName.shell ?? 0).toBe(0);
      expect(res.finalContent).toMatch(/UniqueWidget/);
    },
    300_000,
  );

  // G5: gitignore respect — node_modules has matches but must not appear in output.
  it(
    "G5 gitignore: returns only source hits, not node_modules",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      writeFile(root, ".gitignore", "node_modules\n");
      writeFile(root, "src/app.ts", "x");
      writeFile(root, "node_modules/lib/index.js", "x");

      const tools = [pickGlobExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, list all project source files. Exclude any vendored / dependency files.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G5 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 200),
        }),
      );

      // Accept evidence from final reply OR tool_result — the tool
      // enforces gitignore; what we're actually testing is that the model
      // did not ask the tool to bypass it AND that the final reply doesn't
      // promote vendored files. A terse summary from the model is fine.
      const surface = combinedTextSurface(trace, res.finalContent);
      expect(surface).toMatch(/app\.ts/);
      expect(trace.toolsByName.glob ?? 0).toBeGreaterThanOrEqual(1);
      // Explaining that node_modules was excluded is not a returned vendored file.
      expect(res.finalContent).not.toMatch(/node_modules[\\/]lib[\\/]index\.js/);
      // Tool should also never have returned a node_modules path.
      const toolOutputs = trace.events
        .filter(
          (e): e is AgentTraceEvent & { kind: "tool_result"; content: string } =>
            e.kind === "tool_result" &&
            typeof (e as { content?: unknown }).content === "string",
        )
        .map((e) => e.content)
        .join("\n");
      expect(toolOutputs).not.toMatch(/node_modules/);
    },
    300_000,
  );

  // G6: Brace expansion — multi-extension pattern.
  // Stochastic: some weak models write '*.ts,*.tsx' which we now reject
  // with a schema hint; the model should pivot to '*.{ts,tsx}'.
  it(
    "G6 brace-expansion: handles multi-extension filter",
    async (ctx) => {
      if (!available) ctx.skip();
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "G6",
        run: async () => {
          const root = mkRoot();
          writeFile(root, "src/App.tsx", "x");
          writeFile(root, "src/util.ts", "x");
          writeFile(root, "src/index.js", "x");
          writeFile(root, "README.md", "x");

          const tools = [pickGlobExecutor(makeSession(root))];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, find all .ts and .tsx files (TypeScript source).`,
              tools,
              6,
              onTrace,
            ),
          );

          // Evidence from final reply OR tool_result. What matters is
          // that the glob call returned both extensions; a terse model
          // summary shouldn't fail the test.
          const surface = combinedTextSurface(trace, res.finalContent);
          const hasTs =
            /util\.ts(?!x)/.test(surface) ||
            /util\.ts\b/.test(surface);
          const hasTsx = /App\.tsx/.test(surface);
          return {
            ok: hasTs && hasTsx,
            detail: {
              turns: trace.turns,
              patterns: globCallsIn(trace).map((a) => a.pattern),
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // G7: Pagination — 600 matching files; model must page or narrow.
  it(
    "G7 pagination: covers large result set via pagination or narrowing",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      for (let i = 0; i < 600; i++) {
        writeFile(root, `pkg/f${i}.ts`, `x`);
      }
      writeFile(
        root,
        "pkg/specialTarget_ZZZ.ts",
        "export const MARKER = 1;\n",
      );

      const tools = [pickGlobExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}, find the file whose name contains 'specialTarget'. Many files are named f{0-599}.ts — do not list those.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[G7 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          globCalls: globCallsIn(trace).length,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.glob ?? 0).toBeGreaterThanOrEqual(1);
      expect(trace.toolsByName.glob ?? 0).toBeLessThanOrEqual(6);
      expect(res.finalContent).toMatch(/specialTarget_ZZZ/);
    },
    360_000,
  );

  // G8: Typo recovery — NOT_FOUND with sibling suggestions.
  it(
    "G8 typo-recovery: uses NOT_FOUND sibling suggestion to find typo'd path",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      writeFile(root, "components/Button.tsx", "x");
      writeFile(root, "components/Input.tsx", "x");

      const tools = [pickGlobExecutor(makeSession(root))];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `Find all .tsx files under ${root}/componets (note: I may have typo'd the directory). Tell me the file paths.`,
          tools,
          6,
          onTrace,
        ),
      );

      console.log(
        `[G8 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(res.finalContent).toMatch(/Button\.tsx|Input\.tsx/);
    },
    300_000,
  );

  // G9: Oversize steer — broad pattern + truncated hint should push the
  // model toward narrowing (directory scope or specific extension),
  // not blindly paginating through 600 files. Stochastic on weak models
  // so wrapped in pass@k.
  it(
    "G9 oversize-steer: narrows instead of paging through a broad truncated result",
    async (ctx) => {
      if (!available) ctx.skip();
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "G9",
        run: async () => {
          const root = mkRoot();
          // 300 TS files at the top and 300 under src/ — enough to blow
          // past head_limit=250 and make '**/*.ts' clearly too broad, but
          // the specific target ('src/UniqueAuthHandler.ts') is findable
          // with either narrowing OR page walk. We want narrowing.
          for (let i = 0; i < 300; i++) writeFile(root, `pkg/f${i}.ts`, "x");
          for (let i = 0; i < 300; i++) writeFile(root, `src/g${i}.ts`, "x");
          writeFile(
            root,
            "src/UniqueAuthHandler.ts",
            "export function handle() {}\n",
          );

          const tools = [pickGlobExecutor(makeSession(root))];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, find the file named 'UniqueAuthHandler'. Do not list unrelated files.`,
              tools,
              6,
              onTrace,
            ),
          );

          const calls = trace.toolArgs.filter((c) => c.name === "glob");
          const patterns = calls.map((c) => String(c.args?.pattern ?? ""));
          const offsets = calls.map((c) => Number(c.args?.offset ?? 0));
          // Paginated = progressive offset walk on the same broad pattern
          // without narrowing. This is the anti-pattern we're steering
          // against: the model took our truncation hint as "keep paging"
          // rather than "narrow the pattern."
          const paginated =
            calls.length >= 2 &&
            offsets.some((o) => o > 0) &&
            patterns.every((p) => p === patterns[0]);
          // Narrowed = at least one call scoped the search (specific filename
          // substring OR subdirectory prefix). Single-call-preempt counts —
          // a model that narrows on the first try is the IDEAL outcome.
          const narrowed = patterns.some(
            (p) => p.includes("UniqueAuth") || p.startsWith("src/"),
          );
          const foundTarget = /UniqueAuthHandler/.test(res.finalContent);
          return {
            ok: foundTarget && narrowed && !paginated,
            detail: {
              turns: trace.turns,
              patterns,
              offsets,
              narrowed,
              paginated,
              foundTarget,
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );
});
