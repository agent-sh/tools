/**
 * Minimal Bedrock Converse client. Uses the Bedrock API-Key Bearer token
 * (AWS_BEARER_TOKEN_BEDROCK), so no SigV4 signing is needed — just POST JSON
 * with Authorization: Bearer <token>.
 *
 * Converse API reference:
 *   POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse
 */

export type BedrockRole = "user" | "assistant";

export type BedrockTextBlock = { text: string };
export type BedrockToolUseBlock = {
  toolUse: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
};
export type BedrockToolResultBlock = {
  toolResult: {
    toolUseId: string;
    content: { text: string }[];
    status?: "success" | "error";
  };
};

export type BedrockContentBlock =
  | BedrockTextBlock
  | BedrockToolUseBlock
  | BedrockToolResultBlock;

export interface BedrockMessage {
  role: BedrockRole;
  content: BedrockContentBlock[];
}

export interface BedrockToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export interface BedrockConverseRequest {
  modelId: string;
  region?: string;
  system?: { text: string }[];
  messages: BedrockMessage[];
  tools?: BedrockToolSpec[];
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

export interface BedrockConverseResponse {
  output: {
    message: BedrockMessage;
  };
  stopReason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | "content_filtered"
    | "guardrail_intervened"
    | string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface BedrockConverseOptions {
  readonly token?: string;
  readonly region?: string;
  readonly modelId: string;
  readonly system?: string;
  readonly messages: readonly BedrockMessage[];
  readonly tools?: readonly BedrockToolSpec[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Override the fetch implementation (for VCR / testing). */
  readonly fetchImpl?: typeof fetch;
}

function resolveToken(): string {
  const t = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!t) {
    throw new Error(
      "AWS_BEARER_TOKEN_BEDROCK is not set. Export it, or store it in the keyring as bedrock-bearer (cred-get).",
    );
  }
  return t;
}

function resolveRegion(override?: string): string {
  return override ?? process.env.AWS_REGION ?? "us-east-1";
}

export async function bedrockConverse(
  opts: BedrockConverseOptions,
): Promise<BedrockConverseResponse> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const token = opts.token ?? resolveToken();
  const region = resolveRegion(opts.region);
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(
    opts.modelId,
  )}/converse`;

  const inferenceConfig: Record<string, unknown> = {
    maxTokens: opts.maxTokens ?? 4096,
  };
  // Claude Opus 4.7 deprecates temperature/top_p; only send them on models
  // that still accept them.
  const sendSampling = !/opus-4-7/.test(opts.modelId);
  if (sendSampling && opts.temperature !== undefined) {
    inferenceConfig.temperature = opts.temperature;
  }
  const body: Record<string, unknown> = {
    messages: opts.messages,
    inferenceConfig,
  };
  if (opts.system !== undefined) {
    body.system = [{ text: opts.system }];
  }
  if (opts.tools !== undefined && opts.tools.length > 0) {
    body.toolConfig = { tools: opts.tools };
  }

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Bedrock Converse ${opts.modelId} failed: ${res.status} ${res.statusText} — ${text}`,
    );
  }
  return (await res.json()) as BedrockConverseResponse;
}

export async function bedrockAvailable(region?: string): Promise<boolean> {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) return false;
  // Minimal connectivity probe: list foundation models (AuthZ will fail fast
  // if the token is bad, but we just care that the region/endpoint resolves).
  const r = resolveRegion(region);
  try {
    const res = await fetch(
      `https://bedrock.${r}.amazonaws.com/foundation-models?byProvider=anthropic`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    // 200 or 403 both prove we can reach the endpoint with creds.
    return res.status < 500;
  } catch {
    return false;
  }
}
