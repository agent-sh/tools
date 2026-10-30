/**
 * Cross-tool e2e hard suite.
 *
 * Per-tool suites (read.e2e.hard, grep.e2e.hard, glob.e2e.hard, write.e2e.hard)
 * validate each tool in isolation: description quality, error recovery,
 * parameter handling. They DO NOT validate that the tools compose cleanly.
 *
 * Two things only cross-tool tests catch:
 *   1. Path-handoff semantics. Glob returns absolute paths; Read accepts
 *      absolute paths. But do the models actually copy cleanly? Quoting,
 *      trailing whitespace, "here is the file: X" prose — any of these
 *      can break the chain.
 *   2. Permission + ledger composition. The read-before-edit gate relies
 *      on Read recording into the shared ledger; the cross-tool suite is
 *      the only place that exercises the full pipeline (Glob finds →
 *      Read opens → Edit mutates) in one agent session.
 *
 * Four cases (CT1-CT4) — minimal, realistic, each covers one chain:
 *   CT1  Glob → Read              (find + open)
 *   CT2  Glob → Grep              (narrow + search)
 *   CT3  Read → Edit              (read-before-edit gate, with Glob+Read+Edit
 *                                  all in scope so the model must pick Read)
 *   CT4  Grep → Read → Edit       (three-step refactor)
 *
 * Shared infrastructure mirrors grep.e2e.hard / glob.e2e.hard:
 * collectTrace, runOpts, afterEach trace dump, beforeAll availability probe.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  InMemoryLedger,
} from "@agent-sh/harness-core";
import type { GlobSessionConfig } from "@agent-sh/harness-glob";
import type { GrepSessionConfig } from "@agent-sh/harness-grep";
import type { ReadSessionConfig } from "@agent-sh/harness-read";
import type { WriteSessionConfig } from "@agent-sh/harness-write";
import {
  bedrockAvailable,
  loadDotEnv,
  makeEditExecutor,
  makeGlobExecutor,
  makeGlobExecutorRust,
  makeGrepExecutor,
  makeGrepExecutorRust,
  makeReadExecutor,
  makeReadExecutorRust,
  makeWriteExecutorsRust,
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
 * Engine-swap for parity testing. HARNESS_ENGINE=rust routes every tool
 * through its harness-*-cli binary. Cross-tool specifically needs the
 * Rust write ledger to see TS-read events (or have Rust read forward
 * them), so when rust-mode is on we use Rust read + a post-read ledger
 * forward into the Rust write runner.
 */
const ENGINE = (process.env.HARNESS_ENGINE ?? "ts").toLowerCase();

loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are a coding agent with four tools: `glob`, `grep`, `read`, `edit`.",
  "Use `glob` to find files by name pattern.",
  "Use `grep` to search file contents.",
  "Use `read` to open and view a file's contents.",
  "Use `edit` to make targeted changes to a file. You MUST `read` an existing file before you `edit` it.",
  "Prefer `glob` over `grep` when you only need a filename. Prefer `grep` over `read` when you only need to find matching lines.",
  "When you chain tools, use the exact absolute paths returned by the previous tool — do not re-type or paraphrase them.",
  "When the task is done, reply with a short plain-text answer.",
].join(" ");

function mkRoot(prefix = "e2e-cross-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  const parent = path.dirname(p);
  if (parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content);
  return p;
}

function readUtf8(p: string): string {
  return readFileSync(p, "utf8");
}

/**
 * Build coherent glob/grep/read/write sessions that share a single ledger
 * and the same workspace fence. Sharing the ledger is critical for CT3/CT4:
 * without it, Edit would see "file not read this session" even after Read
 * succeeded (two separate ledgers can't talk).
 */
function makeSessions(root: string): {
  glob: GlobSessionConfig;
  grep: GrepSessionConfig;
  read: ReadSessionConfig;
  write: WriteSessionConfig & { ledger: InMemoryLedger };
} {
  const permissions = {
    roots: [root],
    sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
  };
  const ledger = new InMemoryLedger();
  return {
    glob: { cwd: root, permissions },
    grep: { cwd: root, permissions },
    read: { cwd: root, permissions, ledger },
    write: { cwd: root, permissions, ledger } as WriteSessionConfig & {
      ledger: InMemoryLedger;
    },
  };
}

/**
 * Engine-aware executor factories. In TS mode these delegate straight to
 * the TS makers. In Rust mode they spawn the CLIs and forward read events
 * from Rust read → Rust write so the read-before-edit gate works.
 */
function pickGlobExecutor(session: GlobSessionConfig) {
  if (ENGINE !== "rust") return makeGlobExecutor(session);
  const r = makeGlobExecutorRust(session);
  return { tool: r.tool, execute: r.execute };
}

function pickGrepExecutor(session: GrepSessionConfig) {
  if (ENGINE !== "rust") return makeGrepExecutor(session);
  const r = makeGrepExecutorRust(session);
  return { tool: r.tool, execute: r.execute };
}

const crossRustWriteRunners = new WeakMap<
  object,
  ReturnType<typeof makeWriteExecutorsRust>
>();
function getWriteRunner(
  ws: WriteSessionConfig,
): ReturnType<typeof makeWriteExecutorsRust> {
  const k = ws as unknown as object;
  let r = crossRustWriteRunners.get(k);
  if (!r) {
    r = makeWriteExecutorsRust(ws);
    crossRustWriteRunners.set(k, r);
  }
  return r;
}

function pickReadExecutorCross(
  readSession: ReadSessionConfig,
  writeSession: WriteSessionConfig,
) {
  const tsRead = makeReadExecutor(readSession);
  if (ENGINE !== "rust") return tsRead;
  // Use Rust read via CLI; also forward successful reads to the Rust write ledger.
  const rustRead = makeReadExecutorRust(readSession);
  const writeRunner = getWriteRunner(writeSession);
  return {
    tool: rustRead.tool,
    async execute(args: Record<string, unknown>) {
      const result = await rustRead.execute(args);
      if (typeof args.path === "string") {
        try {
          const bytes = readFileSync(args.path);
          await writeRunner.registerRead(args.path, bytes);
        } catch {
          // non-fatal
        }
      }
      return result;
    },
  };
}

function pickEditExecutor(session: WriteSessionConfig) {
  if (ENGINE !== "rust") return makeEditExecutor(session);
  return getWriteRunner(session).edit;
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

/**
 * Combined text surface: final assistant reply + every tool_result the
 * model received. Mirrors the glob suite's helper; same rationale —
 * weak models summarize in the final but the tool_result contents are
 * ground truth for "did the tool return what we expected."
 */
function combinedSurface(trace: TraceSummary, finalContent: string): string {
  const toolOutputs = trace.events
    .filter(
      (e): e is AgentTraceEvent & { kind: "tool_result"; content: string } =>
        e.kind === "tool_result" &&
        typeof (e as { content?: unknown }).content === "string",
    )
    .map((e) => e.content)
    .join("\n");
  return `${finalContent}\n${toolOutputs}`;
}

const TRACE_DIR = process.env.E2E_TRACE_DIR;

describe(`cross-tool e2e hard [${LABEL}]`, () => {
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

  // CT1: Glob → Read. The model must hand off an absolute path cleanly.
  it(
    "CT1 glob->read: finds a file and reads its content",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      writeFile(
        root,
        "src/UserService.ts",
        [
          "export class UserService {",
          "  constructor(readonly name: string) {}",
          "  greet() { return `hello, ${this.name}`; }",
          "}",
          "",
        ].join("\n"),
      );
      writeFile(root, "src/other.ts", "export const x = 1;\n");

      const sessions = makeSessions(root);
      const tools = [
        pickGlobExecutor(sessions.glob),
        pickReadExecutorCross(sessions.read, sessions.write),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `The project is at ${root}. Find the file containing the UserService class, then open it and tell me the body of its greet() method.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[CT1 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.glob ?? 0).toBeGreaterThanOrEqual(1);
      expect(trace.toolsByName.read ?? 0).toBeGreaterThanOrEqual(1);
      // Sequence check: glob must come before read — if read comes first,
      // the model didn't use glob to find the file.
      const globIdx = trace.toolSeq.indexOf("glob");
      const readIdx = trace.toolSeq.indexOf("read");
      expect(globIdx).toBeLessThan(readIdx);
      // Content check: the greet() body mentions `hello, ${this.name}`.
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toMatch(/hello.*name|this\.name/);
    },
    300_000,
  );

  // CT2: directory-scoped search. Accepts two correct shapes:
  //   (a) model scopes grep directly via `path: "<root>/src"` — cheapest;
  //   (b) model globs src/ first then greps the results.
  // The original strict-chain assertion was a false negative: all three
  // Qwen + gemma:e2b reached the right answer via (a), which is what we
  // actually want. CT2 now tests "model respects the src/-only scope AND
  // doesn't leak vendor results", which is the real contract.
  // Stochastic — wrapped in pass@k.
  it(
    "CT2 scoped-search: respects directory scope via grep path or glob+grep chain",
    async (ctx) => {
      if (!available) ctx.skip();
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "CT2",
        run: async () => {
          const root = mkRoot();
          // Two TODO comments in src/, none elsewhere — glob narrows to
          // src/, grep finds both.
          writeFile(root, "src/a.ts", "// TODO: write docs\nexport const a = 1;\n");
          writeFile(root, "src/b.ts", "const b = 2; // TODO: refactor\n");
          writeFile(root, "src/c.ts", "export const c = 3;\n");
          writeFile(root, "vendor/lib.ts", "// TODO: this should not count\n");

          const sessions = makeSessions(root);
          const tools = [
            pickGlobExecutor(sessions.glob),
            pickGrepExecutor(sessions.grep),
          ];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, how many TODO comments are there in the src/ directory? List each file that contains one.`,
              tools,
              8,
              onTrace,
            ),
          );

          const saidSrcA = /src\/a\.ts|\ba\.ts/.test(
            combinedSurface(trace, res.finalContent),
          );
          const saidSrcB = /src\/b\.ts|\bb\.ts/.test(
            combinedSurface(trace, res.finalContent),
          );
          // Scoped correctly: vendor must NOT appear.
          const didNotLeakVendor = !/vendor\/lib\.ts/.test(res.finalContent);
          // Tool choice: accept either a two-step (glob narrows, grep
          // searches) OR a single-grep that used path scoping. Both are
          // correct. The test's real contract is "model respects the
          // src/-only scope"; requiring a glob step when grep alone
          // suffices would be prescriptive, not contract-testing.
          const scopedGrep =
            (trace.toolsByName.grep ?? 0) >= 1 &&
            trace.toolArgs.some(
              (c) =>
                c.name === "grep" &&
                typeof c.args.path === "string" &&
                /\/src\/?$/.test(c.args.path as string),
            );
          const globThenGrep =
            (trace.toolsByName.glob ?? 0) >= 1 &&
            (trace.toolsByName.grep ?? 0) >= 1;
          const toolUseOk = scopedGrep || globThenGrep;
          return {
            ok: toolUseOk && saidSrcA && saidSrcB && didNotLeakVendor,
            detail: {
              turns: trace.turns,
              seq: trace.toolSeq,
              final: res.finalContent.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // CT3: Read → Edit with the read-before-edit gate exercised via the
  // shared ledger. Glob+Read+Edit are all available; model must pick Read.
  it(
    "CT3 read->edit: read-before-edit gate holds when tools share a ledger",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const target = writeFile(
        root,
        "greet.ts",
        "export function greet(name: string) {\n  return `hello, ${name}`;\n}\n",
      );

      const sessions = makeSessions(root);
      const tools = [
        pickGlobExecutor(sessions.glob),
        pickReadExecutorCross(sessions.read, sessions.write),
        pickEditExecutor(sessions.write),
      ];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${target}, change the greeting from 'hello, ' to 'Hi there, '. Read the file first if you haven't.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[CT3 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      // Read must precede edit.
      const readIdx = trace.toolSeq.indexOf("read");
      const editIdx = trace.toolSeq.indexOf("edit");
      expect(readIdx).toBeGreaterThanOrEqual(0);
      expect(editIdx).toBeGreaterThan(readIdx);
      // File state changed.
      const after = readUtf8(target);
      expect(after).toContain("Hi there, ");
      expect(after).not.toContain("hello, ");
    },
    300_000,
  );

  // CT4: Grep → Read → Edit. Multi-step refactor. Stochastic, wrapped in pass@k.
  it(
    "CT4 grep->read->edit: three-step rename via content search",
    async (ctx) => {
      if (!available) ctx.skip();
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "CT4",
        run: async () => {
          const root = mkRoot();
          // Only one file defines the symbol; several others reference
          // unrelated names with substring overlap to make sure grep
          // narrows correctly.
          const target = writeFile(
            root,
            "src/api.ts",
            [
              "export function handleRequest(req: Request) {",
              "  return new Response('ok');",
              "}",
              "",
            ].join("\n"),
          );
          writeFile(
            root,
            "src/util.ts",
            "export const requestId = 'abc';\n",
          );
          writeFile(
            root,
            "src/client.ts",
            "import { handleRequest } from './api';\n",
          );

          const sessions = makeSessions(root);
          const tools = [
            pickGrepExecutor(sessions.grep),
            pickReadExecutorCross(sessions.read, sessions.write),
            pickEditExecutor(sessions.write),
          ];
          const { trace, onTrace } = collectTrace();

          const res = await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, use grep to find where the function 'handleRequest' is DEFINED (not just imported). Then use read to inspect that whole file before using edit to rename the definition to 'routeRequest' in that file only. A grep snippet is not a full-file read for this check. Do not touch import statements elsewhere.`,
              tools,
              10,
              onTrace,
            ),
          );

          // All three tools used, in order.
          const grepIdx = trace.toolSeq.indexOf("grep");
          const readIdx = trace.toolSeq.indexOf("read");
          const editIdx = trace.toolSeq.indexOf("edit");
          const orderedOk =
            grepIdx >= 0 &&
            readIdx > grepIdx &&
            editIdx > readIdx;
          // File state: only api.ts renamed; client.ts import unchanged.
          const api = readUtf8(target);
          const client = readUtf8(`${root}/src/client.ts`);
          const apiRenamed =
            /export function routeRequest/.test(api) &&
            !/export function handleRequest/.test(api);
          const clientUntouched = /import \{ handleRequest \}/.test(client);
          return {
            ok: orderedOk && apiRenamed && clientUntouched,
            detail: {
              turns: trace.turns,
              seq: trace.toolSeq,
              api: api.slice(0, 150),
              client: client.slice(0, 150),
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
