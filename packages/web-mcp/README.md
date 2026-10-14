# @agent-sh/harness-web-mcp

MCP server that gives **Claude Code, Codex, and any other MCP client** two web tools:

- **`websearch`**: web search with **no API key and no setup** (Exa → Parallel → Mojeek → Marginalia → Wikipedia). Add Brave, Tavily or a self-hosted SearXNG for more coverage.
- **`webfetch`**: fetch a URL and get clean markdown back, with SSRF defense, redirect reporting, size caps and a per-session cache.

They are the [`@agent-sh/harness-websearch`](../websearch) and [`@agent-sh/harness-webfetch`](../webfetch) tools served over stdio, with their own descriptions and schemas unchanged. Part of the [`agent-sh/tools`](https://github.com/agent-sh/tools) monorepo.

## Add it to your agent

**Claude Code**

```sh
claude mcp add -s user harness-web -- npx -y @agent-sh/harness-web-mcp
```

**Codex**

```sh
codex mcp add harness-web -- npx -y @agent-sh/harness-web-mcp
```

Restart the agent (in Claude Code, `/mcp` reconnects). The tools show up as `mcp__harness-web__websearch` and `mcp__harness-web__webfetch` in Claude Code, and as `harness-web` tools in Codex.

<details>
<summary>Config files, global install, other clients</summary>

`npx -y` downloads the latest version on first start. To pin a version, or skip npx's startup cost, install it globally and point the client at the binary:

```sh
npm i -g @agent-sh/harness-web-mcp
claude mcp add -s user harness-web -- harness-web-mcp
```

Claude Code (`~/.claude.json`, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "harness-web": {
      "command": "npx",
      "args": ["-y", "@agent-sh/harness-web-mcp"],
      "env": { "BRAVE_API_KEY": "optional" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.harness-web]
command = "npx"
args = ["-y", "@agent-sh/harness-web-mcp"]

[mcp_servers.harness-web.env]
BRAVE_API_KEY = "optional"
```

Any other MCP client: run `npx -y @agent-sh/harness-web-mcp` as a stdio server.

</details>

## Configuration

Everything is optional; with no configuration you get keyless search and strict fetch.

| Variable | Effect |
|---|---|
| `BRAVE_API_KEY` | Brave leads the search chain; the keyless chain remains a fallback. Free tier at [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com). |
| `TAVILY_API_KEY` | Tavily joins the head of the search chain. |
| `EXA_API_KEY`, `PARALLEL_API_KEY` | Raise those engines' keyless rate limits. |
| `SEARXNG_URL` | Self-hosted SearXNG (e.g. `http://127.0.0.1:8888`) leads the chain. Loopback is allowed for this URL only. |
| `HARNESS_WEB_FETCH_ALLOW_LOOPBACK=1` | Let `webfetch` reach `localhost`. Off by default. |
| `HARNESS_WEB_FETCH_ALLOW_PRIVATE=1` | Let `webfetch` reach private networks (RFC 1918). Off by default. |

Pass variables with `claude mcp add -e KEY=value …`, `codex mcp add --env KEY=value …`, or the `env` block in the config file.

## Safety

- **The MCP client approves each call.** Claude Code and Codex ask before running a tool unless you allow it, so this server does not add a second permission prompt.
- **`webfetch` refuses loopback, private networks and cloud metadata endpoints by default**, resolves DNS once to block rebinding, and caps response size.
- **Treat results as data, not instructions.** Both tool descriptions tell the model so, because a fetched page or a search snippet can contain prompt-injection text.
- Search queries go to the engines in the chain (Exa, Parallel, Mojeek, Marginalia, Wikipedia, plus any keyed engine you add).

## Programmatic use

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWebMcpServer, optionsFromEnv } from "@agent-sh/harness-web-mcp";

await createWebMcpServer({ ...optionsFromEnv(), braveApiKey: process.env.MY_KEY })
  .connect(new StdioServerTransport());
```

## License

MIT © Avi Fenesh
