import { beforeEach, expect, it, vi } from "vitest";
import { bedrockConverse } from "../src/bedrock.js";
import { runBedrockAgent } from "../src/bedrockAgent.js";
import { runE2E } from "../src/runner.js";

vi.mock("../src/bedrock.js", () => ({ bedrockConverse: vi.fn() }));
beforeEach(() => vi.mocked(bedrockConverse).mockReset());

const options = { modelId: "test", tools: [], systemPrompt: "test", userPrompt: "test" };
const normalTask = { backend: "bedrock" as const, model: "test", tools: [], systemPrompt: "test", userPrompt: "test" };

it.each(["content_filtered", "guardrail_intervened", "end_turn"])("requires a completed normal task rather than an empty %s result", async (stopReason) => {
  vi.mocked(bedrockConverse).mockResolvedValue({ output: { message: { role: "assistant", content: [] } }, stopReason });
  await expect(runE2E(normalTask)).rejects.toThrow(/completion|refus/i);
});

it("rejects normal task refusal after successful tool output even with matching final text", async () => {
  const execute = vi.fn(async () => "fixture fact: 42");
  vi.mocked(bedrockConverse)
    .mockResolvedValueOnce({ output: { message: { role: "assistant", content: [
      { toolUse: { toolUseId: "fact", name: "lookup", input: {} } },
    ] } }, stopReason: "tool_use" })
    .mockResolvedValueOnce({ output: { message: { role: "assistant", content: [{ text: "fixture fact: 42" }] } }, stopReason: "content_filtered" });
  await expect(runE2E({ ...normalTask, tools: [{ tool: {
    type: "function", function: { name: "lookup", description: "test", parameters: {} },
  }, execute }] })).rejects.toThrow(/refus/i);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("retains raw provider provenance for an explicitly expected refusal", async () => {
  vi.mocked(bedrockConverse).mockResolvedValue({ output: { message: { role: "assistant", content: [] } }, stopReason: "content_filtered" });
  const result = await runE2E({ ...normalTask, expectedOutcome: "refusal" });
  expect(result.providerRefusal).toEqual({ provider: "bedrock", reason: "content_filtered" });
  expect(result.finalContent).toBe("");
  expect(result.toolCalls).toEqual([]);
});

it("accepts an ordinary completed normal task", async () => {
  vi.mocked(bedrockConverse).mockResolvedValue({ output: { message: { role: "assistant", content: [{ text: "fixture fact: 42" }] } }, stopReason: "end_turn" });
  await expect(runE2E(normalTask)).resolves.toHaveProperty("finalContent", "fixture fact: 42");
});

it("rejects max-turn exhaustion as normal task completion", async () => {
  const execute = vi.fn(async () => "fixture fact: 42");
  vi.mocked(bedrockConverse).mockResolvedValue({ output: { message: { role: "assistant", content: [
    { toolUse: { toolUseId: "fact", name: "lookup", input: {} } },
  ] } }, stopReason: "tool_use" });
  await expect(runE2E({ ...normalTask, maxTurns: 1, tools: [{ tool: {
    type: "function", function: { name: "lookup", description: "test", parameters: {} },
  }, execute }] })).rejects.toThrow(/completion/i);
});

it.each(["content_filtered", "guardrail_intervened"] as const)("retains explicit Bedrock %s without inventing a text response", async (stopReason) => {
  vi.mocked(bedrockConverse).mockResolvedValue({ output: { message: { role: "assistant", content: [] } }, stopReason });
  const result = await runBedrockAgent(options);
  expect(result).toHaveProperty("providerRefusal", { provider: "bedrock", reason: stopReason });
  expect(result.finalContent).toBe("");
  expect(result.toolCalls).toEqual([]);
});

it.each(["end_turn", "max_tokens", "unexpected_stop"])("does not classify an arbitrary empty %s completion as a refusal", async (stopReason) => {
  vi.mocked(bedrockConverse).mockResolvedValue({ output: { message: { role: "assistant", content: [] } }, stopReason });
  const result = await runBedrockAgent(options);
  expect(result).not.toHaveProperty("providerRefusal");
  expect(result.finalContent).toBe("");
});

it("does not execute tool blocks on a provider-refused response", async () => {
  const execute = vi.fn(async () => "must not run");
  vi.mocked(bedrockConverse).mockResolvedValue({ output: { message: { role: "assistant", content: [
    { toolUse: { toolUseId: "blocked", name: "webfetch", input: { url: "http://169.254.169.254/" } } },
  ] } }, stopReason: "content_filtered" });
  const result = await runBedrockAgent({ ...options, maxTurns: 1, tools: [{ tool: {
    type: "function", function: { name: "webfetch", description: "test", parameters: {} },
  }, execute }] });
  expect(execute).not.toHaveBeenCalled();
  expect(result.toolCalls).toEqual([]);
  expect(result).toHaveProperty("providerRefusal.reason", "content_filtered");
});

it("retains completed tool calls when a later response is refused", async () => {
  const execute = vi.fn(async () => "Error [SSRF_BLOCKED]");
  vi.mocked(bedrockConverse)
    .mockResolvedValueOnce({ output: { message: { role: "assistant", content: [
      { toolUse: { toolUseId: "call", name: "webfetch", input: { url: "http://169.254.169.254/" } } },
    ] } }, stopReason: "tool_use" })
    .mockResolvedValueOnce({ output: { message: { role: "assistant", content: [] } }, stopReason: "content_filtered" });
  const result = await runBedrockAgent({ ...options, tools: [{ tool: {
    type: "function", function: { name: "webfetch", description: "test", parameters: {} },
  }, execute }] });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.toolCalls).toEqual([{ name: "webfetch", args: { url: "http://169.254.169.254/" } }]);
  expect(result).toHaveProperty("providerRefusal.reason", "content_filtered");
});
