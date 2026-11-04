import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { webfetch, makeSessionCache } from "../src/webfetch.js";
import type { WebFetchResult } from "../src/types.js";
import { makeSession, startServer, type Handler } from "./helpers.js";

function assertKind<T extends { kind: string }>(
  r: T,
  kind: T["kind"],
): asserts r is Extract<T, { kind: typeof kind }> {
  if (r.kind !== kind) {
    throw new Error(
      `Expected kind=${kind}, got kind=${r.kind}: ${
        "output" in r
          ? (r as unknown as { output: string }).output
          : JSON.stringify(r)
      }`,
    );
  }
}

// Shared server + cleanup. Each test starts from the default handler, so
// one that relies on it does not depend on which test ran before it.
let server: Awaited<ReturnType<typeof startServer>>;
const defaultHandler: Handler = (_req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain");
  res.end("hello");
};
let handler: Handler = defaultHandler;

async function setHandler(h: Handler): Promise<void> {
  handler = h;
}

beforeEach(async () => {
  handler = defaultHandler;
  server = await startServer((req, res) => handler(req, res));
});

afterEach(async () => {
  await server.close();
});

describe("webfetch — happy path", () => {
  it("fetches text/plain and returns kind=ok", async () => {
    await setHandler((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("hello world");
    });
    const r = await webfetch({ url: server.url }, makeSession());
    assertKind(r, "ok");
    expect(r.meta.status).toBe(200);
    expect(r.bodyMarkdown).toContain("hello world");
    expect(r.output).toContain("<status>200</status>");
  });

  it("extracts markdown from HTML via readability", async () => {
    await setHandler((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!DOCTYPE html><html><head><title>T</title></head><body>
          <header>nav stuff</header>
          <article>
            <h1>Article Title</h1>
            <p>This is the first paragraph with enough length to survive readability's length threshold, which requires some minimum amount of prose content to trigger.</p>
            <p>And a second paragraph also with plenty of real sentences so the reader extractor decides there is an article worth parsing out of this DOM tree.</p>
          </article>
          <footer>footer links</footer>
        </body></html>`,
      );
    });
    const r = await webfetch({ url: server.url }, makeSession());
    assertKind(r, "ok");
    expect(r.bodyMarkdown).toContain("Article Title");
    expect(r.bodyMarkdown).toContain("first paragraph");
  });

  it("passes through JSON raw", async () => {
    await setHandler((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true,"value":42}');
    });
    const r = await webfetch({ url: server.url }, makeSession());
    assertKind(r, "ok");
    expect(r.bodyMarkdown).toContain('"value":42');
  });

  it("POST with body sends to the server", async () => {
    let receivedBody = "";
    await setHandler(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      receivedBody = Buffer.concat(chunks).toString("utf8");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ got: receivedBody }));
    });
    const r = await webfetch(
      {
        url: server.url,
        method: "POST",
        body: '{"x":1}',
        headers: { "Content-Type": "application/json" },
      },
      makeSession(),
    );
    assertKind(r, "ok");
    expect(receivedBody).toBe('{"x":1}');
  });
});

describe("webfetch — parameter validation", () => {
  it("rejects invalid url scheme", async () => {
    const r = await webfetch(
      { url: "file:///etc/passwd" },
      makeSession(),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_URL");
  });

  it("rejects POST without body", async () => {
    const r = await webfetch(
      { url: server.url, method: "POST" },
      makeSession(),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
    expect(r.error.message).toMatch(/POST requires 'body'/);
  });

  it("rejects GET with body", async () => {
    const r = await webfetch(
      { url: server.url, method: "GET", body: "x" },
      makeSession(),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("alias pushback surfaces via webfetch()", async () => {
    const r = await webfetch(
      { uri: server.url } as unknown,
      makeSession(),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
    expect(r.error.message).toMatch(/Use 'url' instead/);
  });
});

describe("webfetch — SSRF defense", () => {
  it("blocks 127.0.0.1 when loopback not allowed", async () => {
    const r = await webfetch(
      { url: server.url },
      makeSession({ allowLoopback: false }),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("SSRF_BLOCKED");
  });

  it("blocks 169.254.169.254 (metadata)", async () => {
    const r = await webfetch(
      { url: "http://169.254.169.254/latest/" },
      makeSession({ allowLoopback: true }),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("SSRF_BLOCKED");
  });

  it("allows public IP (skipping real DNS — use a synthetic permit)", async () => {
    // 127.0.0.1 is what we actually have a server on; flip the opt-in to
    // simulate "public IP allowed" behavior. A real public-IP test would
    // need network + stable target and doesn't fit unit-test scope.
    const r = await webfetch(
      { url: server.url },
      makeSession({ allowLoopback: true }),
    );
    assertKind(r, "ok");
  });
});

describe("webfetch — permission hook", () => {
  it("refuses with no hook and no unsafe flag", async () => {
    const r = await webfetch(
      { url: server.url },
      makeSession({
        permissions: {
          roots: [],
          sensitivePatterns: [],
          // No hook, no unsafe.
        },
      }),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("PERMISSION_DENIED");
  });

  it("permission hook deny → PERMISSION_DENIED with url echo", async () => {
    const r = await webfetch(
      { url: server.url },
      makeSession({
        permissions: {
          roots: [],
          sensitivePatterns: [],
          hook: async () => "deny",
        },
      }),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("PERMISSION_DENIED");
    expect(r.error.message).toContain(server.url);
  });

  it("permission hook 'ask' is treated as deny", async () => {
    const r = await webfetch(
      { url: server.url },
      makeSession({
        permissions: {
          roots: [],
          sensitivePatterns: [],
          hook: async () => "ask",
        },
      }),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("PERMISSION_DENIED");
    expect(r.error.message).toMatch(/autonomous mode/);
  });
});

describe("webfetch — redirects", () => {
  it("follows redirects up to max_redirects and reports chain", async () => {
    let hits = 0;
    await setHandler((req, res) => {
      hits++;
      const url = new URL(req.url!, server.url);
      const hop = Number(url.searchParams.get("hop") ?? "0");
      if (hop < 2) {
        res.statusCode = 302;
        res.setHeader("location", `${server.url}/?hop=${hop + 1}`);
        res.end();
        return;
      }
      res.setHeader("content-type", "text/plain");
      res.end(`final hop=${hop}`);
    });
    const r = await webfetch(
      { url: `${server.url}/?hop=0`, max_redirects: 5 },
      makeSession(),
    );
    assertKind(r, "ok");
    expect(hits).toBe(3);
    expect(r.meta.redirectChain.length).toBeGreaterThanOrEqual(3);
    expect(r.meta.finalUrl).toContain("hop=2");
  });

  it("fails with redirect_loop when max_redirects is exceeded", async () => {
    let hop = 0;
    await setHandler((req, res) => {
      hop++;
      res.statusCode = 302;
      res.setHeader("location", `${server.url}/?h=${hop}`);
      res.end();
    });
    const r = await webfetch(
      { url: server.url, max_redirects: 3 },
      makeSession(),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("REDIRECT_LOOP");
  });
});

describe("webfetch — http error surface", () => {
  it("returns http_error for 4xx with body included", async () => {
    await setHandler((_req, res) => {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      res.end("page not found");
    });
    const r = await webfetch({ url: server.url }, makeSession());
    assertKind(r, "http_error");
    expect(r.meta.status).toBe(404);
    expect(r.bodyRaw).toContain("page not found");
    expect(r.output).toMatch(/Not Found/);
  });

  it("returns http_error for 5xx", async () => {
    await setHandler((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    const r = await webfetch({ url: server.url }, makeSession());
    assertKind(r, "http_error");
    expect(r.meta.status).toBe(503);
  });

  it("spills and previews large http_error bodies", async () => {
    const big =
      "HTTP_HEAD\n" +
      "h".repeat(40 * 1024) +
      "HTTP_MIDDLE_MARKER" +
      "m".repeat(80 * 1024) +
      "t".repeat(40 * 1024) +
      "\nHTTP_TAIL";
    await setHandler((_req, res) => {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain");
      res.end(big);
    });
    const r = await webfetch(
      { url: server.url },
      makeSession({ inlineRawCap: 512 }),
    );
    assertKind(r, "http_error");
    expect(r.byteCap).toBe(true);
    expect(r.logPath).toBeTruthy();
    expect(r.bodyRaw).toContain("HTTP_HEAD");
    expect(r.bodyRaw).toContain("HTTP_TAIL");
    expect(r.bodyRaw).not.toContain("HTTP_MIDDLE_MARKER");
    expect(r.bodyRaw.length).toBeLessThan(72 * 1024);
    expect(r.output).toContain("64 KB head+tail preview");
  });
});

describe("webfetch — content-type handling", () => {
  it("rejects binary content-type with bash+curl hint", async () => {
    await setHandler((_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0xff, 0xfe, 0xfd, 0xfc]));
    });
    const r = await webfetch({ url: server.url }, makeSession());
    assertKind(r, "error");
    expect(r.error.code).toBe("UNSUPPORTED_CONTENT_TYPE");
    expect(r.error.message).toMatch(/bash\(curl/);
  });
});

describe("webfetch — size caps", () => {
  it("spills to file when body exceeds inline raw cap", async () => {
    // Server sends 10 KB payload.
    const big = "x".repeat(10 * 1024);
    await setHandler((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(big);
    });
    // Session with a tiny cap to force spill.
    const r = await webfetch(
      { url: server.url },
      makeSession({ inlineRawCap: 512, inlineMarkdownCap: 512 }),
    );
    assertKind(r, "ok");
    expect(r.byteCap).toBe(true);
    expect(r.logPath).toBeTruthy();
    expect(r.output).toContain("Full response at");
  });

  it("caps explicit raw spill output to a 64 KB head+tail preview", async () => {
    const big =
      "RAW_HEAD\n" +
      "h".repeat(40 * 1024) +
      "RAW_MIDDLE_MARKER" +
      "m".repeat(80 * 1024) +
      "t".repeat(40 * 1024) +
      "\nRAW_TAIL";
    await setHandler((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(big);
    });
    const r = await webfetch(
      { url: server.url, extract: "raw" },
      makeSession({ inlineRawCap: 512, inlineMarkdownCap: 512 }),
    );
    assertKind(r, "ok");
    expect(r.byteCap).toBe(true);
    expect(r.logPath).toBeTruthy();
    expect(r.bodyRaw).toContain("RAW_HEAD");
    expect(r.bodyRaw).toContain("RAW_TAIL");
    expect(r.bodyRaw).not.toContain("RAW_MIDDLE_MARKER");
    expect(r.bodyRaw!.length).toBeLessThan(72 * 1024);
    expect(r.output).toContain("64 KB head+tail preview");
  });

  it("uses cleaned markdown for spilled HTML unless raw HTML is requested", async () => {
    const useful = "Useful repository content explains the actual README. ";
    await setHandler((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!DOCTYPE html><html><head><title>Repository Page</title></head><body>
          <nav>GITHUB_NAV_NOISE ${"nav ".repeat(5000)}</nav>
          <article>
            <h1>Useful Repository Content</h1>
            <p>${useful.repeat(3000)}</p>
          </article>
          <script>GITHUB_SCRIPT_NOISE</script>
        </body></html>`,
      );
    });
    const r = await webfetch(
      { url: server.url },
      makeSession({ inlineRawCap: 512, inlineMarkdownCap: 512 }),
    );
    assertKind(r, "ok");
    expect(r.byteCap).toBe(true);
    expect(r.logPath).toBeTruthy();
    expect(r.bodyMarkdown).toContain("Useful Repository Content");
    expect(r.bodyMarkdown).not.toContain("GITHUB_NAV_NOISE");
    expect(r.bodyMarkdown).not.toContain("GITHUB_SCRIPT_NOISE");
    expect(r.bodyMarkdown).not.toContain("<html");
    expect(r.bodyMarkdown!.length).toBeLessThan(72 * 1024);
  });

  it("rejects response exceeding hard cap", async () => {
    const big = "x".repeat(50 * 1024);
    await setHandler((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(big);
    });
    const r = await webfetch(
      { url: server.url },
      makeSession({ spillHardCap: 10 * 1024 }),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("OVERSIZE");
  });
});

describe("webfetch — session cache", () => {
  it("serves repeated fetches from cache with age annotation", async () => {
    let hits = 0;
    await setHandler((_req, res) => {
      hits++;
      res.setHeader("content-type", "text/plain");
      res.end(`hit-${hits}`);
    });
    const cache = makeSessionCache();
    const session = makeSession({ cache });
    const r1 = await webfetch({ url: server.url }, session);
    assertKind(r1, "ok");
    expect(r1.meta.fromCache).toBe(false);
    expect(hits).toBe(1);

    const r2 = await webfetch({ url: server.url }, session);
    assertKind(r2, "ok");
    expect(r2.meta.fromCache).toBe(true);
    expect(hits).toBe(1);
    expect(r2.output).toMatch(/Served from session cache/);
  });

  it("reapplies spill preview caps on cache hits", async () => {
    const big =
      "CACHE_HEAD\n" +
      "h".repeat(40 * 1024) +
      "CACHE_MIDDLE_MARKER" +
      "m".repeat(80 * 1024) +
      "t".repeat(40 * 1024) +
      "\nCACHE_TAIL";
    let hits = 0;
    await setHandler((_req, res) => {
      hits++;
      res.setHeader("content-type", "text/plain");
      res.end(big);
    });
    const cache = makeSessionCache();
    const session = makeSession({
      cache,
      inlineRawCap: 512,
      inlineMarkdownCap: 512,
    });
    const r1 = await webfetch(
      { url: server.url, extract: "raw" },
      session,
    );
    assertKind(r1, "ok");
    const r2 = await webfetch(
      { url: server.url, extract: "raw" },
      session,
    );
    assertKind(r2, "ok");
    expect(hits).toBe(1);
    expect(r2.meta.fromCache).toBe(true);
    expect(r2.byteCap).toBe(true);
    expect(r2.bodyRaw).toContain("CACHE_HEAD");
    expect(r2.bodyRaw).toContain("CACHE_TAIL");
    expect(r2.bodyRaw).not.toContain("CACHE_MIDDLE_MARKER");
    expect(r2.bodyRaw!.length).toBeLessThan(72 * 1024);
  });

  it("cache miss after TTL expires", async () => {
    let hits = 0;
    await setHandler((_req, res) => {
      hits++;
      res.end(`hit-${hits}`);
    });
    const cache = makeSessionCache();
    const session = makeSession({
      cache,
      cacheTtlMs: 1, // 1 ms TTL so the second call always misses
    });
    await webfetch({ url: server.url }, session);
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await webfetch({ url: server.url }, session);
    assertKind(r2, "ok");
    expect(hits).toBe(2);
    expect(r2.meta.fromCache).toBe(false);
  });
});

describe("webfetch — abort signal", () => {
  it("honors session signal", async () => {
    await setHandler(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 2000));
      res.end("late");
    });
    const controller = new AbortController();
    const session = makeSession({ signal: controller.signal });
    const p = webfetch({ url: server.url }, session);
    setTimeout(() => controller.abort(), 100);
    const r: WebFetchResult = await p;
    expect(["error", "http_error"]).toContain(r.kind);
  });
});
