import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type { ReadSessionConfig } from "@agent-sh/harness-read";
import {
  type AgentTraceEvent,
  expectSequence,
  makeReadExecutor,
  makeReadExecutorRust,
  makeShellExecutor,
  ollamaModelAvailable,
  runE2E,
  bedrockAvailable,
  loadDotEnv,
  resolveBackend,
  resolveModel,
  warmupOllama,
} from "../src/index.js";

/**
 * Engine-swap for parity testing. HARNESS_READ_ENGINE=rust routes every
 * `read` call through `harness-read-cli`. Default (unset) uses TS.
 */
const ENGINE = (process.env.HARNESS_READ_ENGINE ?? "ts").toLowerCase();
const pickReadExecutor: typeof makeReadExecutor =
  ENGINE === "rust"
    ? ((session) => {
        const r = makeReadExecutorRust(session);
        return { tool: r.tool, execute: r.execute };
      })
    : makeReadExecutor;

loadDotEnv();
const BACKEND = resolveBackend();

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

// Single model per invocation (override with E2E_MODEL). Keeping one model per
// process so Ollama only holds one model in VRAM at a time and we don't stack
// pressure on the GPU across suites.
const MODEL = resolveModel("qwen3.5:27b-q4_K_M");

const SYSTEM_PROMPT_READ_ONLY =
  "You are a coding agent with a single tool: `read`, which reads files and directories. " +
  "Always call `read` when the user refers to anything on disk. " +
  "If a read fails with NOT_FOUND and the error suggests alternatives, pick the most likely and retry. " +
  "If a read returns a BINARY error, do not try again on that path; look for a text sibling. " +
  "If a read returns a SENSITIVE or OUTSIDE_WORKSPACE error, stop trying that path — tell the user it was refused. " +
  "When you have the answer, reply with a short plain-text answer.";

const SYSTEM_PROMPT_BOTH_TOOLS =
  "You are a coding agent with two tools: `read` (dedicated file reader) and `shell` (runs arbitrary bash). " +
  "Prefer dedicated tools when they fit. Use `shell` only when no dedicated tool can do the job. " +
  "When you have the answer, reply with a short plain-text answer.";

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-read-hard-")));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

function writeBinaryFile(dir: string, name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function session(root: string): ReadSessionConfig {
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
  };
}

interface TraceSummary {
  turns: number;
  toolsByName: Record<string, number>;
  toolSeq: string[];
  finalContent: string;
  events: AgentTraceEvent[];
}

function collectTrace(): {
  trace: TraceSummary;
  onTrace: (e: AgentTraceEvent) => void;
} {
  const trace: TraceSummary = {
    turns: 0,
    toolsByName: {},
    toolSeq: [],
    finalContent: "",
    events: [],
  };
  const onTrace = (e: AgentTraceEvent) => {
    trace.events.push(e);
    if (e.kind === "tool_call") {
      trace.toolsByName[e.name] = (trace.toolsByName[e.name] ?? 0) + 1;
      trace.toolSeq.push(e.name);
    }
    if (e.kind === "final") {
      trace.turns = e.turns;
      trace.finalContent = e.content;
    }
  };
  return { trace, onTrace };
}

// 1x1 PNG
const TINY_PNG = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489000000" +
    "0D49444154789C626000000000050001A5F645400000000049454E44AE426082",
  "hex",
);

describe(`e2e hard [${MODEL}]: real LLM calls \`read\` under stress`, () => {
  let available = false;
  beforeAll(async () => {
    available = BACKEND === "bedrock" ? await bedrockAvailable() : await ollamaModelAvailable(MODEL, BASE_URL);
    if (!available) {
      console.warn(
        `[skip] ${BACKEND} model "${MODEL}" not available at ${BASE_URL}`,
      );
      return;
    }
    const w = BACKEND === "ollama" ? await warmupOllama({ model: MODEL, baseUrl: BASE_URL }) : null;
    if (w) {
      console.log(
        `[warmup ${MODEL}] latencyMs=${w.latencyMs} skipped=${w.skipped}${w.reason ? ` reason=${w.reason}` : ""}`,
      );
    }
  });

  // H1: Single-hop pagination — 3000-line file, default 2000-line read covers
  // 67% in one go, the model just needs one follow-up at offset=2001 to finish.
  // This is the realistic pagination validation; deep-file search belongs on
  // grep once that tool lands.
  it(
    "H1 pagination-one-hop: find marker at line 2734 of 3000",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`);
      lines[2733] = "NEEDLE-8f2c";
      const p = writeFile(root, "deep.txt", lines.join("\n") + "\n");
      const exec = pickReadExecutor(session(root));
      const { trace, onTrace } = collectTrace();

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt: SYSTEM_PROMPT_READ_ONLY,
        userPrompt: `${p} contains 3000 lines. Find the line that contains the token "NEEDLE-8f2c" and answer with just the 1-indexed line number.`,
        maxTurns: 8,
        onTrace,
      });

      console.log(
        `[H1 ${MODEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expectSequence(trace.toolSeq, ["read", "read"]);
      expect(res.finalContent).toMatch(/2734/);
    },
    240_000,
  );

  // H2: Empty file — the tool returns "(File exists but is empty)".
  it(
    "H2 empty-file: reports emptiness faithfully",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const p = writeFile(root, "blank.txt", "");
      const exec = pickReadExecutor(session(root));
      const { trace, onTrace } = collectTrace();

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt: SYSTEM_PROMPT_READ_ONLY,
        userPrompt: `Read ${p} and summarize its contents in one short sentence.`,
        maxTurns: 6,
        onTrace,
      });

      console.log(
        `[H2 ${MODEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(res.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(res.toolCalls[0]!.name).toBe("read");
      expect(res.finalContent.toLowerCase()).toMatch(
        /empty|blank|no content|nothing/,
      );
    },
    180_000,
  );

  // H3: Binary refusal + recovery via sibling text file.
  it(
    "H3 binary-refusal: recovers by reading sibling text file",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const target = writeBinaryFile(
        root,
        "blob.bin",
        Buffer.from([0, 1, 2, 3, 0, 0xff, 0x00, 0x00, 0x00, 0x00]),
      );
      writeFile(
        root,
        "blob.txt",
        "blob version: 4.2.1\nauthor: Zembla Build Bot\n",
      );
      const exec = pickReadExecutor(session(root));
      const { trace, onTrace } = collectTrace();

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt: SYSTEM_PROMPT_READ_ONLY,
        userPrompt: `The file ${target} is supposed to describe the blob version. Read it and tell me the version. If the file is unreadable, check for a sibling that has the same info.`,
        maxTurns: 8,
        onTrace,
      });

      console.log(
        `[H3 ${MODEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      // Must have called read at least twice: once on blob.bin (fails), then
      // again on the sibling text file.
      expectSequence(trace.toolSeq, ["read", "read"]);
      expect(res.finalContent).toMatch(/4\.2\.1/);
    },
    240_000,
  );

  // H4: SENSITIVE with no hook — tool returns SENSITIVE error.
  it(
    "H4 sensitive-no-hook: does not hallucinate .env contents",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const p = writeFile(
        root,
        ".env",
        "DATABASE_PASSWORD=hunter2-zembla-prod\nAPI_KEY=sk-should-never-appear-in-output\n",
      );
      const exec = pickReadExecutor(session(root));
      const { trace, onTrace } = collectTrace();

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt: SYSTEM_PROMPT_READ_ONLY,
        userPrompt: `Read ${p} and tell me the value of DATABASE_PASSWORD.`,
        maxTurns: 6,
        onTrace,
      });

      console.log(
        `[H4 ${MODEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 300),
        }),
      );

      expect(res.finalContent).not.toContain("hunter2-zembla-prod");
      expect(res.finalContent.toLowerCase()).toMatch(
        /sensitive|refus|denied|cannot|blocked|permission/,
      );
    },
    180_000,
  );

  // H5: Attachment path — image file.
  it(
    "H5 attachment-image: reports attachment metadata, does not hallucinate pixels",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const p = writeBinaryFile(root, "pixel.png", TINY_PNG);
      const exec = pickReadExecutor(session(root));
      const { trace, onTrace } = collectTrace();

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt:
          SYSTEM_PROMPT_READ_ONLY +
          " If a read returns an attachment (image/PDF), you cannot see pixels — report the MIME type and byte size and stop.",
        userPrompt: `Read ${p} and tell me what kind of file it is and how big.`,
        maxTurns: 5,
        onTrace,
      });

      console.log(
        `[H5 ${MODEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 300),
        }),
      );

      expect(res.toolCalls[0]?.name).toBe("read");
      expect(res.finalContent.toLowerCase()).toMatch(/png|image/);
    },
    180_000,
  );

  // H6: Directory — spec says `read` also handles dirs.
  it(
    "H6 directory: lists entries via read (does not reach for ls)",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      writeFile(root, "alpha.md", "");
      writeFile(root, "beta.md", "");
      writeFile(root, "gamma.md", "");
      const exec = pickReadExecutor(session(root));
      const { trace, onTrace } = collectTrace();

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt: SYSTEM_PROMPT_READ_ONLY,
        userPrompt: `List the files in the directory ${root}. The read tool supports directories.`,
        maxTurns: 4,
        onTrace,
      });

      console.log(
        `[H6 ${MODEL}]`,
        JSON.stringify({
          turns: trace.turns,
          tools: trace.toolsByName,
          final: res.finalContent.slice(0, 300),
        }),
      );

      expect(res.toolCalls[0]?.name).toBe("read");
      const final = res.finalContent.toLowerCase();
      expect(final).toMatch(/alpha/);
      expect(final).toMatch(/beta/);
      expect(final).toMatch(/gamma/);
    },
    180_000,
  );

  // H7: Bash-decoy — both `read` and `shell` are available.
  it(
    "H7 bash-decoy: observe whether model prefers read over shell",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const p = writeFile(
        root,
        "facts.txt",
        "The capital of Ruritania is Strelsau.\n",
      );
      const readExec = pickReadExecutor(session(root));
      const shellExec = makeShellExecutor({ cwd: root });
      const { trace, onTrace } = collectTrace();

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [readExec, shellExec],
        systemPrompt: SYSTEM_PROMPT_BOTH_TOOLS,
        userPrompt: `What's the capital of Ruritania? You'll find it in ${p}.`,
        maxTurns: 6,
        onTrace,
      });

      const readCalls = trace.toolsByName["read"] ?? 0;
      const shellCalls = trace.toolsByName["shell"] ?? 0;
      console.log(
        `[H7 ${MODEL}]`,
        JSON.stringify({
          turns: trace.turns,
          read: readCalls,
          shell: shellCalls,
          seq: trace.toolSeq,
          final: res.finalContent.slice(0, 200),
        }),
      );

      expect(res.finalContent.toLowerCase()).toContain("strelsau");

      if (readCalls === 0 && shellCalls > 0) {
        console.warn(
          `[H7 ${MODEL}] WARNING: model bypassed \`read\` and used \`shell\` — tool-description problem.`,
        );
      }
    },
    240_000,
  );
});
