import type { OllamaMessage, OllamaTool, OllamaToolCall } from "./ollama.js";
import { ollamaChat } from "./ollama.js";
import { openaiChat } from "./openai.js";

// Chat client selector. The agent loop is transport-agnostic; E2E_BACKEND=openai
// routes to an OpenAI /v1 server (e.g. local llama.cpp on :8001) instead of
// Ollama /api/chat. Both return the same OllamaChatResponse shape.
const chatClient =
  (process.env.E2E_BACKEND ?? "").toLowerCase() === "openai"
    ? openaiChat
    : ollamaChat;

export interface ToolExecutor {
  readonly tool: OllamaTool;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface AgentRunOptions {
  readonly baseUrl?: string;
  readonly model: string;
  readonly tools: readonly ToolExecutor[];
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTurns?: number;
  readonly think?: boolean;
  readonly temperature?: number;
  readonly onTrace?: (event: AgentTraceEvent) => void;
}

export interface ProviderRefusal {
  readonly provider: "bedrock";
  readonly reason: "content_filtered" | "guardrail_intervened";
}

export type AgentTraceEvent =
  | { kind: "assistant"; content: string; toolCalls: readonly OllamaToolCall[] }
  | { kind: "tool_call"; name: string; args: Record<string, unknown> }
  | { kind: "tool_result"; name: string; content: string }
  | { kind: "final"; content: string; turns: number; providerRefusal?: ProviderRefusal };

export interface AgentRunResult {
  readonly finalContent: string;
  readonly turns: number;
  readonly toolCalls: readonly { name: string; args: Record<string, unknown> }[];
  readonly messages: readonly OllamaMessage[];
  readonly providerRefusal?: ProviderRefusal;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const maxTurns = opts.maxTurns ?? 8;
  const toolMap = new Map<string, ToolExecutor>();
  for (const t of opts.tools) toolMap.set(t.tool.function.name, t);

  const messages: OllamaMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userPrompt },
  ];
  const toolCallLog: { name: string; args: Record<string, unknown> }[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const chatOpts: Parameters<typeof ollamaChat>[0] = {
      model: opts.model,
      messages,
      tools: opts.tools.map((t) => t.tool),
      // Qwen3/3.5 are tuned for sampling, not greedy decoding; T=0 collapses
      // thinking and tool-selection quality. Pass through caller override.
      temperature: opts.temperature ?? 0.6,
      think: opts.think ?? true,
    };
    if (opts.baseUrl !== undefined) {
      (chatOpts as { baseUrl: string }).baseUrl = opts.baseUrl;
    }
    const res = await chatClient(chatOpts);
    const msg = res.message;
    const calls = msg.tool_calls ?? [];

    opts.onTrace?.({ kind: "assistant", content: msg.content, toolCalls: calls });

    if (calls.length === 0) {
      opts.onTrace?.({ kind: "final", content: msg.content, turns: turn });
      return {
        finalContent: msg.content,
        turns: turn,
        toolCalls: toolCallLog,
        messages,
      };
    }

    const assistantMsg: OllamaMessage = {
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: calls,
    };
    messages.push(assistantMsg);

    for (const call of calls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      toolCallLog.push({ name, args });
      opts.onTrace?.({ kind: "tool_call", name, args });

      const exec = toolMap.get(name);
      let resultContent: string;
      if (!exec) {
        resultContent = JSON.stringify({
          error: `Unknown tool: ${name}`,
        });
      } else {
        try {
          resultContent = await exec.execute(args);
        } catch (e) {
          resultContent = JSON.stringify({
            error: `Tool "${name}" threw: ${(e as Error).message}`,
          });
        }
      }

      opts.onTrace?.({ kind: "tool_result", name, content: resultContent });
      messages.push({ role: "tool", content: resultContent, tool_name: name });
    }
  }

  return {
    finalContent: "(max turns reached)",
    turns: maxTurns,
    toolCalls: toolCallLog,
    messages,
  };
}
