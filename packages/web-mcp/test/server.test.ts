import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { webfetchToolDefinition } from "@agent-sh/harness-webfetch";
import { websearchToolDefinition } from "@agent-sh/harness-websearch";
import { createWebMcpServer, optionsFromEnv, SERVER_VERSION, type WebMcpOptions } from "../src/index.js";
import pkg from "../package.json" with { type: "json" };

async function connect(options: WebMcpOptions = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createWebMcpServer(options).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function text(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("");
}

let http: HttpServer;
let baseUrl: string;

beforeAll(async () => {
  http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><title>Fixture</title></head><body><main><h1>Hello MCP</h1><p>Fetched through harness-web.</p></main></body></html>");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
});

afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

describe("harness-web MCP server", () => {
  it("lists websearch and webfetch with their published schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["webfetch", "websearch"]);
    expect(client.getServerVersion()).toEqual({ name: "harness-web", version: pkg.version });
    expect(SERVER_VERSION).toBe(pkg.version);
    const search = tools.find((t) => t.name === "websearch")!;
    expect(search.description).toBe(websearchToolDefinition.description);
    expect(search.inputSchema).toEqual(websearchToolDefinition.inputSchema);
    const fetch = tools.find((t) => t.name === "webfetch")!;
    expect(fetch.inputSchema).toEqual(webfetchToolDefinition.inputSchema);
  });

  it("fetches a page as markdown when loopback is allowed", async () => {
    const client = await connect({ fetchAllowLoopback: true });
    const result = await client.callTool({ name: "webfetch", arguments: { url: baseUrl } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Hello MCP");
  });

  it("blocks loopback by default (SSRF defense) and reports it as a tool error", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "webfetch", arguments: { url: baseUrl } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^[A-Z_]+: /);
  });

  it("returns invalid arguments as a tool error, not a protocol failure", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "websearch", arguments: { query: "" } });
    expect(result.isError).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Unknown tool");
  });
});

describe("optionsFromEnv", () => {
  it("maps documented variables and ignores empty values", () => {
    expect(
      optionsFromEnv({
        BRAVE_API_KEY: "b",
        SEARXNG_URL: "http://127.0.0.1:8888",
        TAVILY_API_KEY: "",
        HARNESS_WEB_FETCH_ALLOW_LOOPBACK: "1",
      }),
    ).toEqual({
      braveApiKey: "b",
      searxngUrl: "http://127.0.0.1:8888",
      fetchAllowLoopback: true,
      fetchAllowPrivateNetworks: false,
    });
  });
});
