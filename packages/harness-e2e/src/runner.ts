import { runAgent, type AgentRunResult, type AgentTraceEvent, type ToolExecutor } from "./agent.js";
import { runBedrockAgent } from "./bedrockAgent.js";

export type E2EBackend = "ollama" | "bedrock";

export interface E2ERunOptions {
  readonly backend: E2EBackend;
  readonly model: string;
  readonly region?: string;
  readonly baseUrl?: string;
  readonly tools: readonly ToolExecutor[];
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTurns?: number;
  readonly temperature?: number;
  readonly think?: boolean;
  readonly onTrace?: (e: AgentTraceEvent) => void;
  /** Refusal tests inspect the raw result and must assert their own denial contract. */
  readonly expectedOutcome?: "completion" | "refusal";
}

function checkedOutcome(result: AgentRunResult, opts: E2ERunOptions): AgentRunResult {
  if (opts.expectedOutcome === "refusal") return result;
  if (result.providerRefusal) {
    throw new Error(`Expected task completion; provider refusal: ${result.providerRefusal.provider}/${result.providerRefusal.reason}`);
  }
  if (!result.finalContent.trim() || result.finalContent === "(max turns reached)") {
    throw new Error("Expected task completion; model returned no completed final answer");
  }
  return result;
}

export function resolveBackend(): E2EBackend {
  const b = (process.env.E2E_BACKEND ?? "ollama").toLowerCase();
  if (b === "bedrock") return "bedrock";
  return "ollama";
}

export function resolveModel(defaultOllama: string): string {
  const backend = resolveBackend();
  if (backend === "bedrock") {
    return process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-opus-4-7";
  }
  return process.env.E2E_MODEL ?? defaultOllama;
}

export function modelLabel(model: string): string {
  return `${resolveBackend()}:${model}`;
}

export async function runE2E(opts: E2ERunOptions): Promise<AgentRunResult> {
  if (opts.backend === "bedrock") {
    const bedrockOpts: Parameters<typeof runBedrockAgent>[0] = {
      modelId: opts.model,
      tools: opts.tools,
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
    };
    if (opts.region !== undefined) {
      (bedrockOpts as { region: string }).region = opts.region;
    }
    if (opts.maxTurns !== undefined) {
      (bedrockOpts as { maxTurns: number }).maxTurns = opts.maxTurns;
    }
    if (opts.temperature !== undefined) {
      (bedrockOpts as { temperature: number }).temperature = opts.temperature;
    }
    if (opts.onTrace !== undefined) {
      (bedrockOpts as { onTrace: typeof opts.onTrace }).onTrace = opts.onTrace;
    }
    return checkedOutcome(await runBedrockAgent(bedrockOpts), opts);
  }

  const agentOpts: Parameters<typeof runAgent>[0] = {
    model: opts.model,
    tools: opts.tools,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
  };
  if (opts.baseUrl !== undefined) {
    (agentOpts as { baseUrl: string }).baseUrl = opts.baseUrl;
  }
  if (opts.maxTurns !== undefined) {
    (agentOpts as { maxTurns: number }).maxTurns = opts.maxTurns;
  }
  if (opts.temperature !== undefined) {
    (agentOpts as { temperature: number }).temperature = opts.temperature;
  }
  if (opts.think !== undefined) {
    (agentOpts as { think: boolean }).think = opts.think;
  }
  if (opts.onTrace !== undefined) {
    (agentOpts as { onTrace: typeof opts.onTrace }).onTrace = opts.onTrace;
  }
  return checkedOutcome(await runAgent(agentOpts), opts);
}
