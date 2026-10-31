/**
 * Wiring regression test for the shared per-process ledger in pi-extension.ts.
 *
 * The pi extension registers `read` and `edit` (plus write/multiedit) against a
 * SINGLE InMemoryLedger created inside harnessToolsExtension(). Read records into
 * that ledger; Edit reads it back through getLatest(). Before the fix the
 * sessions carried NO ledger, so the read-before-edit gate (NOT_READ_THIS_SESSION)
 * fired even right after a successful Read and the model would shell out to
 * cat/sed instead of using Edit.
 *
 * This is a fast unit-style test (no model, no Ollama/Bedrock). It drives the
 * REAL extension wiring via a minimal fake ExtensionAPI that captures each
 * registered tool, then runs read -> edit and asserts the gate composes.
 *
 * Not a model-driven e2e (those live in packages/harness-e2e). Safe to run once
 * the GPU is free.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import harnessToolsExtension from "../src/pi-extension.js";
import { batchToolDefinition } from "@agent-sh/harness-batch";
import { grepToolDefinition } from "@agent-sh/harness-grep";

type AnyTool = ToolDefinition<any, any, any>;

/** Capture every tool the extension registers; stub everything else. */
function buildExtension(): Map<string, AnyTool> {
  const tools = new Map<string, AnyTool>();
  const fakePi = {
    registerTool(tool: AnyTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  // ONE call -> read + edit close over the same in-scope shared ledger.
  harnessToolsExtension(fakePi);
  return tools;
}

/** Minimal ExtensionContext: only ctx.cwd is read by the execute wrapper. */
function makeCtx(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

/** Extract the flattened text from a pi tool result. */
function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("");
}

describe("pi-extension shared ledger — read composes with edit", () => {
  it("registers the canonical Batch and Grep model schemas", () => {
    const tools = buildExtension();
    expect(tools.get("batch")?.parameters).toMatchObject(batchToolDefinition.inputSchema);
    expect(tools.get("grep")?.parameters).toMatchObject(grepToolDefinition.inputSchema);
  });
  it("edit succeeds after read because both share one ledger", async () => {
    const tools = buildExtension();
    const readTool = tools.get("read");
    const editTool = tools.get("edit");
    expect(readTool, "read tool registered").toBeTruthy();
    expect(editTool, "edit tool registered").toBeTruthy();

    const dir = mkdtempSync(path.join(tmpdir(), "pi-ledger-"));
    const target = path.join(dir, "greeting.ts");
    writeFileSync(target, "export const greeting = 'hello';\n");
    const ctx = makeCtx(dir);

    // 1. Read records the file into the shared ledger.
    const readResult = await readTool!.execute("id1", { path: target }, undefined, undefined, ctx);
    const readText = resultText(readResult);
    expect(readText).toContain("greeting");
    expect(readText).not.toContain("NOT_READ_THIS_SESSION");

    // 2. Edit reads the SAME ledger via getLatest() -> gate passes, write applies.
    const editResult = await editTool!.execute(
      "id2",
      { path: target, old_string: "hello", new_string: "hi" },
      undefined,
      undefined,
      ctx,
    );
    const editText = resultText(editResult);
    expect(editText).not.toContain("NOT_READ_THIS_SESSION");
    // Edit success surface: "Edited <path>: 1 replacement (...)".
    expect(editText).toContain("Edited");
    expect(editText).toContain(target);

    expect(readFileSync(target, "utf8")).toBe("export const greeting = 'hi';\n");
  });

  it("edit on a never-read file FAILS OPEN: proceeds with a warning (D11), not a hard deny", async () => {
    // The read-before-edit gate fails OPEN when no permission hook is wired
    // (Read spec D11 / AGENTS.md #6 tool-as-friction): a model with no prior
    // Read must not be hard-blocked into shelling out to Bash. It overwrites
    // with a warning instead. (A wired deny-hook is the way to actually block —
    // see the deny-hook unit tests in packages/write.)
    const tools = buildExtension();
    const editTool = tools.get("edit");
    expect(editTool, "edit tool registered").toBeTruthy();

    const dir = mkdtempSync(path.join(tmpdir(), "pi-ledger-"));
    const unread = path.join(dir, "unread.ts");
    writeFileSync(unread, "export const x = 1;\n");
    const ctx = makeCtx(dir);

    const editResult = await editTool!.execute(
      "id3",
      { path: unread, old_string: "1", new_string: "2" },
      undefined,
      undefined,
      ctx,
    );
    const text = resultText(editResult);
    // Not a hard deny.
    expect(text).not.toContain("NOT_READ_THIS_SESSION");
    // The edit went through and disk reflects the change.
    expect(readFileSync(unread, "utf8")).toBe("export const x = 2;\n");
  });
});
