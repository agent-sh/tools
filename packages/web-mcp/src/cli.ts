import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWebMcpServer, optionsFromEnv, SERVER_VERSION } from "./index.js";

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  process.stdout.write(`${SERVER_VERSION}\n`);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  process.stdout.write(`harness-web-mcp ${SERVER_VERSION}: MCP stdio server with websearch + webfetch.

Register it with your agent:
  claude mcp add -s user harness-web -- npx -y @agent-sh/harness-web-mcp
  codex mcp add harness-web -- npx -y @agent-sh/harness-web-mcp

Optional environment: BRAVE_API_KEY, TAVILY_API_KEY, EXA_API_KEY, PARALLEL_API_KEY,
SEARXNG_URL, HARNESS_WEB_FETCH_ALLOW_LOOPBACK=1, HARNESS_WEB_FETCH_ALLOW_PRIVATE=1.
`);
  process.exit(0);
}

createWebMcpServer(optionsFromEnv())
  .connect(new StdioServerTransport())
  .catch((error: unknown) => {
    process.stderr.write(`harness-web-mcp: ${String((error as Error)?.stack ?? error)}\n`);
    process.exit(1);
  });
