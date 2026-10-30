import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createSpawnLspClient } from "@agent-sh/harness-lsp";

it("initializes a real language-server process, queries hover and shuts down", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lsp-transport-"));
  const file = path.join(root, "example.ts");
  writeFileSync(file, "export const answer = 42;\n");
  writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
  const client = createSpawnLspClient();
  try {
    const handle = await client.ensureServer({ language: "typescript", root, profile: {
      language: "typescript", extensions: [".ts"],
      command: [path.resolve("node_modules/.bin/typescript-language-server"), "--stdio"],
    } });
    expect(handle.state).toBe("ready");
    const hover = await client.hover(handle, file, { line: 1, character: 14 }, AbortSignal.timeout(10_000));
    expect(hover?.contents).toContain("answer");
  } finally { await client.closeSession(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
