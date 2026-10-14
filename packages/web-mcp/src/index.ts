import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  webfetch,
  webfetchToolDefinition,
  makeSessionCache,
  type WebFetchSessionConfig,
} from "@agent-sh/harness-webfetch";
import {
  websearch,
  websearchToolDefinition,
  type WebSearchSessionConfig,
} from "@agent-sh/harness-websearch";

export const SERVER_NAME = "harness-web";
declare const __PACKAGE_VERSION__: string;

/** package.json version, injected at build time by tsup. */
export const SERVER_VERSION: string = __PACKAGE_VERSION__;

export interface WebMcpOptions {
  /** Brave Search API key; Brave then leads the search chain. */
  readonly braveApiKey?: string;
  /** Tavily API key; Tavily then joins the head of the search chain. */
  readonly tavilyApiKey?: string;
  /** Raises Exa's keyless rate limit. */
  readonly exaApiKey?: string;
  /** Raises Parallel's keyless rate limit. */
  readonly parallelApiKey?: string;
  /** Self-hosted SearXNG base URL, preferred at the head of the chain. */
  readonly searxngUrl?: string;
  /** Let webfetch reach localhost (off by default: SSRF defense). */
  readonly fetchAllowLoopback?: boolean;
  /** Let webfetch reach RFC 1918 / private networks (off by default). */
  readonly fetchAllowPrivateNetworks?: boolean;
}

/** Reads the documented environment variables (see README). */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): WebMcpOptions {
  const flag = (name: string) => env[name] === "1" || env[name] === "true";
  return withoutUndefined({
    braveApiKey: env.BRAVE_API_KEY || undefined,
    tavilyApiKey: env.TAVILY_API_KEY || undefined,
    exaApiKey: env.EXA_API_KEY || undefined,
    parallelApiKey: env.PARALLEL_API_KEY || undefined,
    searxngUrl: env.SEARXNG_URL || undefined,
    fetchAllowLoopback: flag("HARNESS_WEB_FETCH_ALLOW_LOOPBACK"),
    fetchAllowPrivateNetworks: flag("HARNESS_WEB_FETCH_ALLOW_PRIVATE"),
  });
}

type WithoutUndefined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drops unset keys; the session types use exactOptionalPropertyTypes. */
function withoutUndefined<T extends object>(obj: T): WithoutUndefined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as WithoutUndefined<T>;
}

// The MCP client (Claude Code, Codex, ...) already asks the user before each
// tool call, so the tools' own permission hook is intentionally opted out.
const CLIENT_GATED = { roots: [], sensitivePatterns: [] } as const;

export function createWebMcpServer(options: WebMcpOptions = {}): Server {
  const keyed = Boolean(options.braveApiKey || options.tavilyApiKey);
  const searchSession: WebSearchSessionConfig = withoutUndefined({
    permissions: { ...CLIENT_GATED, unsafeAllowSearchWithoutHook: true },
    braveApiKey: options.braveApiKey,
    tavilyApiKey: options.tavilyApiKey,
    exaApiKey: options.exaApiKey,
    parallelApiKey: options.parallelApiKey,
    searxngUrl: options.searxngUrl,
    // A self-hosted SearXNG usually lives on localhost.
    allowLoopback: Boolean(options.searxngUrl),
    // A keyed engine is exclusive by default; keep the keyless chain as backstop.
    fallbackToKeyless: keyed || Boolean(options.searxngUrl),
  });
  const fetchSession: WebFetchSessionConfig = withoutUndefined({
    permissions: { ...CLIENT_GATED, unsafeAllowFetchWithoutHook: true },
    allowLoopback: options.fetchAllowLoopback,
    allowPrivateNetworks: options.fetchAllowPrivateNetworks,
    cache: makeSessionCache(),
  });

  const tools = {
    [websearchToolDefinition.name]: {
      definition: websearchToolDefinition,
      run: (args: unknown) => websearch(args as never, searchSession),
    },
    [webfetchToolDefinition.name]: {
      definition: webfetchToolDefinition,
      run: (args: unknown) => webfetch(args as never, fetchSession),
    },
  };

  // Low-level Server on purpose: the tools ship their own JSON Schema and
  // validate their own input, so McpServer's Zod-based registration would
  // only duplicate (and risk drifting from) the published contracts.
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(tools).map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = tools[request.params.name];
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }] };
    }
    try {
      const result = (await tool.run(request.params.arguments ?? {})) as {
        kind: string;
        output?: string;
        error?: { code: string; message: string };
      };
      if (result.kind === "error") {
        const text = result.error ? `${result.error.code}: ${result.error.message}` : JSON.stringify(result);
        return { isError: true, content: [{ type: "text", text }] };
      }
      return { content: [{ type: "text", text: result.output ?? JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String((error as Error)?.message ?? error) }] };
    }
  });

  return server;
}
