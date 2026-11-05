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
import type {
  LspManifest,
  LspSessionConfig,
} from "@agent-sh/harness-lsp";
import { createSpawnLspClient } from "@agent-sh/harness-lsp";
import {
  bedrockAvailable,
  loadDotEnv,
  makeLspExecutor,
  makeLspExecutorRust,
  modelLabel,
  ollamaModelAvailable,
  passAtK,
  resolveBackend,
  resolveModel,
  runE2E,
  warmupOllama,
  type AgentTraceEvent,
  type ToolExecutor,
} from "../src/index.js";

/**
 * Engine-swap for parity testing. HARNESS_LSP_ENGINE=rust routes every
 * lsp call through `harness-lsp-cli`. Default (unset) uses TS.
 */
const LSP_ENGINE = (process.env.HARNESS_LSP_ENGINE ?? 'ts').toLowerCase();

/**
 * Cleanups for what a test started: each session's client and each Rust
 * runner. afterEach runs them, so no language server outlives its test.
 */
const cleanups: Array<() => Promise<void>> = [];

/**
 * One executor per session, so the warmup and the test drive the same
 * language server (in Rust mode, the same `harness-lsp-cli`).
 */
const executors = new WeakMap<LspSessionConfig, ToolExecutor>();

function pickLspExecutor(session: LspSessionConfig): ToolExecutor {
  const existing = executors.get(session);
  if (existing) return existing;
  let exec: ToolExecutor;
  if (LSP_ENGINE === 'rust') {
    const r = makeLspExecutorRust(session);
    cleanups.push(() => r.close());
    exec = { tool: r.tool, execute: r.execute };
  } else {
    exec = makeLspExecutor(session);
  }
  executors.set(session, exec);
  return exec;
}


loadDotEnv();

const BACKEND = resolveBackend();
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const LABEL = modelLabel(MODEL);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

const SYSTEM_PROMPT = [
  "You are an autonomous coding agent with an `lsp` tool for language-server operations.",
  "Available operations: hover, definition, references, documentSymbol, workspaceSymbol, implementation.",
  "Positions are 1-INDEXED. Line 1 is the first line; character 1 is the first column.",
  "If the tool returns server_starting, wait the suggested milliseconds and retry (this is normal on the first call for a language).",
  "If the tool returns no_results or SERVER_NOT_AVAILABLE, report that and stop \u2014 do not try to bypass.",
  "Answer in a short plain-text sentence.",
].join(" ");

// Resolve the path to the locally-installed typescript-language-server.
const LSP_BIN = path.resolve(
  process.cwd(),
  "node_modules/.bin/typescript-language-server",
);

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-lsp-")));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  const parent = path.dirname(p);
  if (parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content);
  return p;
}

function makeTsFixture(): string {
  const root = mkRoot();
  writeFile(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
  );
  writeFile(root, "package.json", JSON.stringify({ name: "fixture" }));
  writeFile(
    root,
    "src/UserService.ts",
    [
      "export class UserService {",
      "  constructor(public readonly email: string) {}",
      "  greet(): string {",
      "    return `hello, ${this.email}`;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/api.ts",
    [
      "import { UserService } from './UserService.js';",
      "",
      "export function handleRequest(email: string): string {",
      "  const svc = new UserService(email);",
      "  return svc.greet();",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    root,
    "src/util.ts",
    [
      "export function logInfo(msg: string): void {",
      "  console.log(`[info] ${msg}`);",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function manifestFor(_root: string): LspManifest {
  return {
    servers: {
      typescript: {
        language: "typescript",
        extensions: [".ts", ".tsx", ".js"],
        command: [LSP_BIN, "--stdio"],
        rootPatterns: ["tsconfig.json", "package.json"],
      },
    },
  };
}

function makeSession(
  root: string,
  overrides: Partial<LspSessionConfig> = {},
): LspSessionConfig {
  const session: LspSessionConfig = {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
      unsafeAllowLspWithoutHook: true,
    },
    client: createSpawnLspClient(),
    manifest: manifestFor(root),
    ...overrides,
  };
  const { client } = session;
  if (client) cleanups.push(() => client.closeSession());
  return session;
}

/**
 * Warm up typescript-language-server by issuing a documentSymbol on
 * every .ts file under the root so cross-file indexing completes before
 * the model's first call. Without this, ts-server returns partial
 * results (just the local import binding) on cold cross-file
 * definition lookups.
 */
async function warmupLsp(
  session: LspSessionConfig,
  filePaths: readonly string[],
): Promise<void> {
  if (LSP_ENGINE === "rust") {
    // When running against the Rust CLI, warm up THAT server (not TS's).
    const exec = pickLspExecutor(session);
    for (const p of filePaths) {
      await exec.execute({ operation: "documentSymbol", path: p });
    }
  } else {
    const { lsp } = await import("@agent-sh/harness-lsp");
    for (const p of filePaths) {
      await lsp({ operation: "documentSymbol", path: p }, session);
    }
  }
  // Give ts-server's cross-file indexing a moment to finish.
  await new Promise((r) => setTimeout(r, 1500));
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

describe(`lsp e2e hard [${LABEL}]`, () => {
  let available = false;

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

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

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
      // best-effort
    }
    currentTrace = null;
  });

  // LSP1: Golden \u2014 definition lookup.
  it(
    "LSP1 golden: finds the definition of UserService",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = makeTsFixture();
      const session = makeSession(root);
      await warmupLsp(session, [
        path.join(root, "src/api.ts"),
        path.join(root, "src/UserService.ts"),
      ]);
      const tools = [pickLspExecutor(session)];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}/src/api.ts, line 4 reads: '  const svc = new UserService(email);'. The identifier 'UserService' starts at character 19. Use the lsp tool with operation: 'definition', path, line: 4, character: 19 to find where UserService is defined. Tell me the file path reported as the definition target.`,
          tools,
          8,
          onTrace,
        ),
      );

      console.log(
        `[LSP1 ${LABEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(trace.toolsByName.lsp ?? 0).toBeGreaterThanOrEqual(1);
      const surface = combinedSurface(trace, res.finalContent);
      expect(surface).toMatch(/UserService\.ts/);
    },
    300_000,
  );

  // LSP2: References.
  it(
    "LSP2 references: lists references to UserService across files",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = makeTsFixture();
      const session = makeSession(root);
      await warmupLsp(session, [
        path.join(root, "src/api.ts"),
        path.join(root, "src/UserService.ts"),
      ]);
      const tools = [pickLspExecutor(session)];
      const { trace, onTrace } = collectTrace();

      await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}/src/UserService.ts at line 1, character 14, the class 'UserService' is declared. Use the lsp tool with operation: 'references' to list every place UserService is referenced across the workspace. Show the file paths.`,
          tools,
          8,
          onTrace,
        ),
      );

      const surface = combinedSurface(trace, "");
      expect(trace.toolsByName.lsp ?? 0).toBeGreaterThanOrEqual(1);
      expect(surface).toMatch(/api\.ts/);
    },
    300_000,
  );

  // LSP3: Hover.
  it(
    "LSP3 hover: returns type info for a symbol",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = makeTsFixture();
      const session = makeSession(root);
      const tools = [pickLspExecutor(session)];
      const { trace, onTrace } = collectTrace();

      await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}/src/UserService.ts, line 2 has 'constructor(public readonly email: string) {}'. Use the lsp tool with operation: 'hover' at line 2, character 31 (on the identifier 'email') to get the type.`,
          tools,
          6,
          onTrace,
        ),
      );

      const surface = combinedSurface(trace, "");
      expect(trace.toolsByName.lsp ?? 0).toBeGreaterThanOrEqual(1);
      expect(surface).toMatch(/string/i);
    },
    300_000,
  );

  // LSP4: documentSymbol.
  it(
    "LSP4 documentSymbol: lists symbols in a file",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = makeTsFixture();
      const session = makeSession(root);
      const tools = [pickLspExecutor(session)];
      const { trace, onTrace } = collectTrace();

      await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}/src/UserService.ts, use lsp documentSymbol to list the classes and methods defined. Tell me the name of the class and at least one method.`,
          tools,
          6,
          onTrace,
        ),
      );

      const surface = combinedSurface(trace, "");
      expect(surface).toMatch(/UserService/);
      expect(surface).toMatch(/greet|constructor/);
    },
    300_000,
  );

  // LSP5: workspaceSymbol. Stochastic.
  it(
    "LSP5 workspaceSymbol: finds symbols by query across the workspace",
    async (ctx) => {
      if (!available) ctx.skip();
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "LSP5",
        run: async () => {
          const root = makeTsFixture();
          const session = makeSession(root);
          await warmupLsp(session, [
            path.join(root, "src/api.ts"),
            path.join(root, "src/UserService.ts"),
            path.join(root, "src/util.ts"),
          ]);
          const tools = [pickLspExecutor(session)];
          const { trace, onTrace } = collectTrace();

          await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}, use lsp workspaceSymbol with query "handleRequest" and tell me the file it's defined in.`,
              tools,
              6,
              onTrace,
            ),
          );

          const surface = combinedSurface(trace, "");
          return {
            ok: /api\.ts/.test(surface),
            detail: {
              seq: trace.toolSeq,
              final: surface.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );

  // LSP6: SERVER_NOT_AVAILABLE for unknown extension.
  it(
    "LSP6 server_not_available: reports when no server is configured for a language",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = makeTsFixture();
      writeFile(root, "src/main.rs", "fn main() { println!(\"hi\"); }\n");
      const session = makeSession(root);
      const tools = [pickLspExecutor(session)];
      const { trace, onTrace } = collectTrace();

      const res = await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}/src/main.rs, use lsp documentSymbol. If the server isn't available, report that plainly.`,
          tools,
          6,
          onTrace,
        ),
      );

      const surface = combinedSurface(trace, res.finalContent);
      expect(trace.toolsByName.lsp ?? 0).toBeGreaterThanOrEqual(1);
      expect(surface).toMatch(/SERVER_NOT_AVAILABLE|not configured|no language server/i);
    },
    300_000,
  );

  // LSP7: 1-indexed position handling.
  it(
    "LSP7 position-1-indexed: uses 1-indexed lines and characters",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = makeTsFixture();
      const session = makeSession(root);
      await warmupLsp(session, [path.join(root, "src/UserService.ts")]);
      const tools = [pickLspExecutor(session)];
      const { trace, onTrace } = collectTrace();

      await runE2E(
        runOpts(
          SYSTEM_PROMPT,
          `In ${root}/src/UserService.ts, go to the definition at line 1, character 14 (which is on "UserService"). Remember: positions are 1-indexed.`,
          tools,
          6,
          onTrace,
        ),
      );

      const calls = trace.toolArgs.filter((c) => c.name === "lsp");
      const used1indexed = calls.some(
        (c) =>
          typeof c.args.line === "number" &&
          (c.args.line as number) >= 1 &&
          typeof c.args.character === "number" &&
          (c.args.character as number) >= 1,
      );
      expect(used1indexed).toBe(true);
    },
    300_000,
  );

  // LSP8: basic lsp usage (replaces generic alias pushback \u2014 hard to force naturally).
  it(
    "LSP8 hover-on-method: returns type for a method",
    async (ctx) => {
      if (!available) ctx.skip();
      const r = await passAtK({
        n: 3,
        k: 2,
        label: "LSP8",
        run: async () => {
          const root = makeTsFixture();
          const session = makeSession(root);
          const tools = [pickLspExecutor(session)];
          const { trace, onTrace } = collectTrace();

          await runE2E(
            runOpts(
              SYSTEM_PROMPT,
              `In ${root}/src/UserService.ts at line 3, character 3, use the lsp tool to get hover information on 'greet'.`,
              tools,
              6,
              onTrace,
            ),
          );

          const surface = combinedSurface(trace, "");
          return {
            ok:
              (trace.toolsByName.lsp ?? 0) >= 1 &&
              (surface.includes("greet") || surface.includes("string")),
            detail: {
              seq: trace.toolSeq,
              final: surface.slice(0, 200),
            },
          };
        },
      });
      expect(r.successes).toBeGreaterThanOrEqual(2);
    },
    600_000,
  );
});
