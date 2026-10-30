import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  InMemoryLedger,
} from "@agent-sh/harness-core";
import type { ReadSessionConfig } from "@agent-sh/harness-read";
import {
  makeReadExecutor,
  ollamaModelAvailable,
  runE2E,
  bedrockAvailable,
  loadDotEnv,
  resolveBackend,
  resolveModel,
} from "../src/index.js";

loadDotEnv();
const BACKEND = resolveBackend();

const MODEL = resolveModel("qwen3.5:27b-q4_K_M");
const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const SYSTEM_PROMPT =
  "You are a coding agent with a single tool: `read`, which reads files. " +
  "Always call `read` when the user refers to a file on disk. " +
  "When you have the answer, reply with a short plain-text answer.";

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "e2e-read-")));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
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

describe("e2e: real LLM calls `read`", () => {
  let available = false;
  beforeAll(async () => {
    available = BACKEND === "bedrock" ? await bedrockAvailable() : await ollamaModelAvailable(MODEL, BASE_URL);
    if (!available) {
      console.warn(
        `[skip] ${BACKEND} model "${MODEL}" not available at ${BASE_URL}`,
      );
    }
  });

  it(
    "reads a file and answers a question about its content",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const p = writeFile(
        root,
        "facts.txt",
        "The capital of Zembla is Onhava.\n",
      );
      const exec = makeReadExecutor(session(root));
      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `Read ${p} and tell me the capital of Zembla.`,
      });
      expect(res.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(res.toolCalls[0]!.name).toBe("read");
      expect(res.finalContent.toLowerCase()).toContain("onhava");
    },
    180_000,
  );

  it(
    "paginates when the file exceeds the default window",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      const lines = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`);
      lines[2400] = "SECRETMARKER-A8B3F";
      const p = writeFile(root, "big.txt", lines.join("\n") + "\n");

      const ledger = new InMemoryLedger();
      const exec = makeReadExecutor({
        ...session(root),
        ledger,
      });

      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `The file ${p} has ~2500 lines. Find the line that contains the token "SECRETMARKER-A8B3F" and tell me the line number.`,
        maxTurns: 12,
      });

      expect(res.toolCalls.length).toBeGreaterThanOrEqual(2);
      expect(res.finalContent).toMatch(/2401/);
      const entries = ledger.getAll(p);
      expect(entries.length).toBeGreaterThanOrEqual(2);
    },
    240_000,
  );

  it(
    "handles a not-found error gracefully and retries a corrected path",
    async (ctx) => {
      if (!available) ctx.skip();
      const root = mkRoot();
      writeFile(root, "README.md", "# Project Alpha\n\nThe version is 1.2.3.\n");
      const typo = path.join(root, "readm.md");
      const exec = makeReadExecutor(session(root));
      const res = await runE2E({
        backend: BACKEND,
        baseUrl: BASE_URL,
        model: MODEL,
        tools: [exec],
        systemPrompt:
          SYSTEM_PROMPT +
          " If a read fails with NOT_FOUND and the error suggests alternatives, pick the most likely one and retry.",
        userPrompt: `Read ${typo} and tell me the project version.`,
        maxTurns: 6,
      });
      expect(res.toolCalls.length).toBeGreaterThanOrEqual(2);
      expect(res.finalContent).toMatch(/1\.2\.3/);
    },
    180_000,
  );
});
