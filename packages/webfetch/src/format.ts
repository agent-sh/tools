import { appendFileSync } from "node:fs";
import { ensurePrivateDirectory, writePrivateFile } from "@agent-sh/harness-core";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FetchMetadata } from "./types.js";

/**
 * Render the <request>...</request> block that opens every ok /
 * redirect_loop / http_error result. Uniform shape across kinds so the
 * model parses the same surface regardless.
 */
export function renderRequestBlock(meta: FetchMetadata): string {
  const lines = [
    `<request>`,
    `  <url>${meta.url}</url>`,
    `  <final_url>${meta.finalUrl}</final_url>`,
    `  <method>${meta.method}</method>`,
    `  <status>${meta.status}</status>`,
    `  <content_type>${meta.contentType}</content_type>`,
    `  <redirect_chain>${meta.redirectChain.join(" -> ")}</redirect_chain>`,
    `</request>`,
  ];
  return lines.join("\n");
}

export function formatOkText(args: {
  meta: FetchMetadata;
  extractHint: "markdown" | "raw" | "both";
  markdown?: string;
  raw?: string;
  logPath?: string;
  byteCap: boolean;
  bodyClipped?: boolean;
  totalBytes: number;
}): string {
  const header = renderRequestBlock(args.meta);
  const bodyAttr = args.extractHint;
  let bodyInner: string;
  if (args.extractHint === "markdown" && args.markdown !== undefined) {
    bodyInner = args.markdown;
  } else if (args.extractHint === "raw" && args.raw !== undefined) {
    bodyInner = args.raw;
  } else if (args.extractHint === "both") {
    bodyInner = `<markdown>\n${args.markdown ?? ""}\n</markdown>\n<raw_body>\n${args.raw ?? ""}\n</raw_body>`;
  } else {
    bodyInner = "";
  }
  const bodyBlock = `<body extract="${bodyAttr}">\n${bodyInner}\n</body>`;
  let hint: string;
  if (args.byteCap && args.logPath !== undefined) {
    const shown = args.bodyClipped
      ? `showing 64 KB head+tail preview of ${args.totalBytes} bytes`
      : `showing extracted content inline from ${args.totalBytes} raw bytes`;
    hint = `(Response exceeded inline cap; ${shown}. Full response at ${args.logPath} — Read with offset/limit to paginate.)`;
  } else {
    const warn =
      args.meta.url !== args.meta.finalUrl &&
      hostOf(args.meta.url) !== hostOf(args.meta.finalUrl)
        ? ` (Final URL host differs from original: ${hostOf(args.meta.url)} -> ${hostOf(args.meta.finalUrl)}. Verify this is expected.)`
        : "";
    const cacheTag =
      args.meta.fromCache && args.meta.cacheAgeSec !== undefined
        ? ` (Served from session cache; age ${args.meta.cacheAgeSec}s.)`
        : "";
    hint = `(Response complete. ${args.totalBytes} bytes total. Content-type: ${args.meta.contentType || "unknown"}. Fetched in ${args.meta.fetchedMs}ms.${warn}${cacheTag})`;
  }
  return [header, bodyBlock, hint].join("\n");
}

export function formatRedirectLoopText(args: {
  meta: FetchMetadata;
  maxRedirects: number;
}): string {
  const header = renderRequestBlock(args.meta);
  const hint = `(Redirect limit (${args.maxRedirects}) exceeded. Chain: ${args.meta.redirectChain.join(" -> ")}. Set max_redirects higher OR pass the final URL directly.)`;
  return [header, hint].join("\n");
}

export function formatHttpErrorText(args: {
  meta: FetchMetadata;
  body: string;
  logPath?: string;
  byteCap?: boolean;
  totalBytes?: number;
}): string {
  const header = renderRequestBlock(args.meta);
  const bodyBlock = `<body>\n${args.body}\n</body>`;
  const spillHint =
    args.byteCap && args.logPath !== undefined
      ? ` Body exceeded inline cap; showing 64 KB head+tail preview of ${args.totalBytes ?? "unknown"} bytes. Full response at ${args.logPath} — Read with offset/limit to paginate.`
      : "";
  const hint = `(HTTP ${args.meta.status}. ${shortReason(args.meta.status)}.${spillHint} Retry or adjust the request per the body.)`;
  return [header, bodyBlock, hint].join("\n");
}

function shortReason(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized — check auth headers";
  if (status === 403) return "Forbidden — check permissions or auth";
  if (status === 404) return "Not Found";
  if (status === 408) return "Request Timeout";
  if (status === 410) return "Gone";
  if (status === 418) return "I'm a teapot";
  if (status === 429) return "Too Many Requests — back off";
  if (status === 500) return "Internal Server Error";
  if (status === 502) return "Bad Gateway";
  if (status === 503) return "Service Unavailable";
  if (status === 504) return "Gateway Timeout";
  if (status >= 400 && status < 500) return "Client error";
  if (status >= 500) return "Server error";
  return "Non-success status";
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// ---- spill-to-file ----

/**
 * Save the full response body to a spill file under
 * ~/.agent-sh/webfetch-cache/<session>/<uuid>.<ext>. Returns the path.
 */
export function spillToFile(args: {
  bytes: Uint8Array;
  dir: string;
  sessionId: string;
  contentType: string;
}): string {
  if (!args.sessionId || args.sessionId === "." || args.sessionId === ".." || /[\\/\0]/.test(args.sessionId)) {
    throw new Error("sessionId must be a single directory name");
  }
  ensurePrivateDirectory(args.dir);
  const dir = path.join(args.dir, args.sessionId);
  ensurePrivateDirectory(dir);
  const ext = extensionFor(args.contentType);
  const filePath = path.join(dir, `${randomUUID()}.${ext}`);
  writePrivateFile(filePath, Buffer.from(args.bytes));
  return filePath;
}

function extensionFor(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/html") || lower.includes("xhtml")) return "html";
  if (lower.includes("json")) return "json";
  if (lower.includes("xml")) return "xml";
  if (lower.includes("csv")) return "csv";
  if (lower.includes("markdown")) return "md";
  if (lower.includes("text/")) return "txt";
  return "bin";
}

/**
 * Append-only version used by future streaming implementations. Kept
 * here for symmetry with bash's stream-to-file pattern; not used by
 * the current engine (which buffers fully before deciding to spill).
 */
export function appendSpill(filePath: string, bytes: Uint8Array): void {
  appendFileSync(filePath, Buffer.from(bytes));
}

/**
 * Given a big body, return head (first N bytes) + tail (last N bytes)
 * text concatenated with an elision marker. Used for the inline view
 * when spilled.
 */
export function headAndTail(
  bytes: Uint8Array,
  headBytes: number,
  tailBytes: number,
  logPath: string,
): string {
  if (bytes.length <= headBytes + tailBytes) {
    return Buffer.from(bytes).toString("utf8");
  }
  const head = Buffer.from(bytes.subarray(0, headBytes)).toString("utf8");
  const tail = Buffer.from(
    bytes.subarray(bytes.length - tailBytes),
  ).toString("utf8");
  const elided = bytes.length - headBytes - tailBytes;
  return `${head}\n\n... (${elided} bytes elided; full response at ${logPath}) ...\n\n${tail}`;
}
