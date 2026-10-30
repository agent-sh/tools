import type { AgentRunResult, AgentTraceEvent, ProviderRefusal, ToolExecutor } from "./agent.js";
import {
  bedrockConverse,
  type BedrockContentBlock,
  type BedrockMessage,
  type BedrockToolSpec,
} from "./bedrock.js";

export interface BedrockAgentRunOptions {
  readonly modelId: string;
  readonly region?: string;
  readonly tools: readonly ToolExecutor[];
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTurns?: number;
  readonly temperature?: number;
  readonly onTrace?: (event: AgentTraceEvent) => void;
}

/**
 * Runs a tool-call loop against Amazon Bedrock's Converse API. Converts each
 * ToolExecutor's JSON-Schema-shaped tool definition into Bedrock's `toolSpec`
 * format. Returns the same shape as the Ollama `runAgent` so tests can treat
 * backends interchangeably.
 */
export async function runBedrockAgent(
  opts: BedrockAgentRunOptions,
): Promise<AgentRunResult> {
  const maxTurns = opts.maxTurns ?? 8;
  const toolMap = new Map<string, ToolExecutor>();
  for (const t of opts.tools) toolMap.set(t.tool.function.name, t);

  const tools: BedrockToolSpec[] = opts.tools.map((t) => ({
    toolSpec: {
      name: t.tool.function.name,
      description: t.tool.function.description,
      inputSchema: {
        json: t.tool.function.parameters,
      },
    },
  }));

  const messages: BedrockMessage[] = [
    { role: "user", content: [{ text: opts.userPrompt }] },
  ];
  const toolCallLog: { name: string; args: Record<string, unknown> }[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const converseOpts: Parameters<typeof bedrockConverse>[0] = {
      modelId: opts.modelId,
      system: opts.systemPrompt,
      messages,
      tools,
    };
    if (opts.temperature !== undefined) {
      (converseOpts as { temperature: number }).temperature = opts.temperature;
    }
    if (opts.region !== undefined) {
      (converseOpts as { region: string }).region = opts.region;
    }
    const res = await bedrockConverse(converseOpts);

    const assistantMsg = res.output.message;
    const blocks = assistantMsg.content;
    const toolUses = blocks.filter(
      (b): b is Extract<BedrockContentBlock, { toolUse: unknown }> =>
        "toolUse" in b,
    );
    const textContent = blocks
      .filter((b): b is { text: string } => "text" in b)
      .map((b) => b.text)
      .join("");

    opts.onTrace?.({
      kind: "assistant",
      content: textContent,
      toolCalls: toolUses.map((b) => ({
        function: { name: b.toolUse.name, arguments: b.toolUse.input },
      })),
    });

    // Always persist the assistant turn so tool_result messages have a
    // matching tool_use in the preceding message (Converse API requirement).
    messages.push(assistantMsg);

    if (res.stopReason === "content_filtered" || res.stopReason === "guardrail_intervened") {
      const providerRefusal: ProviderRefusal = { provider: "bedrock", reason: res.stopReason };
      opts.onTrace?.({ kind: "final", content: textContent, turns: turn, providerRefusal });
      return {
        finalContent: textContent,
        turns: turn,
        toolCalls: toolCallLog,
        messages: messages as unknown as AgentRunResult["messages"],
        providerRefusal,
      };
    }

    if (toolUses.length === 0) {
      opts.onTrace?.({ kind: "final", content: textContent, turns: turn });
      return {
        finalContent: textContent,
        turns: turn,
        toolCalls: toolCallLog,
        messages: messages as unknown as AgentRunResult["messages"],
      };
    }

    const userToolResults: BedrockContentBlock[] = [];

    for (const block of toolUses) {
      const { toolUseId, name, input } = block.toolUse;
      const args = (input ?? {}) as Record<string, unknown>;
      toolCallLog.push({ name, args });
      opts.onTrace?.({ kind: "tool_call", name, args });

      const exec = toolMap.get(name);
      let resultContent: string;
      let status: "success" | "error" = "success";
      if (!exec) {
        resultContent = JSON.stringify({ error: `Unknown tool: ${name}` });
        status = "error";
      } else {
        try {
          resultContent = await exec.execute(args);
        } catch (e) {
          resultContent = JSON.stringify({
            error: `Tool "${name}" threw: ${(e as Error).message}`,
          });
          status = "error";
        }
      }

      opts.onTrace?.({ kind: "tool_result", name, content: resultContent });
      userToolResults.push({
        toolResult: {
          toolUseId,
          content: [{ text: resultContent }],
          status,
        },
      });
    }

    messages.push({ role: "user", content: userToolResults });
  }

  return {
    finalContent: "(max turns reached)",
    turns: maxTurns,
    toolCalls: toolCallLog,
    messages: messages as unknown as AgentRunResult["messages"],
  };
}
