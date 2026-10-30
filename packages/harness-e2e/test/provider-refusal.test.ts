import { beforeEach, expect, it, vi } from "vitest";
import { bedrockConverse } from "../src/bedrock.js";
import { runBedrockAgent } from "../src/bedrockAgent.js";

vi.mock("../src/bedrock.js", () => ({ bedrockConverse: vi.fn() }));
beforeEach(() => vi.mocked(bedrockConverse).mockReset());

const options = { modelId: "test", tools: [], systemPrompt: "test", userPrompt: "test" };

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
