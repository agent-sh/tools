import path from "node:path";
import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  DEFAULT_HEAD_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_HOVER_MARKDOWN_BYTES,
  MAX_PREVIEW_LINE_LENGTH,
  SERVER_STARTING_RETRY_BASE_MS,
  SERVER_STARTING_RETRY_MAX_MS,
  SERVER_STARTUP_MAX_WAIT_MS,
  SESSION_BACKSTOP_MS,
} from "./constants.js";
import { LspServerExitedError } from "./errors.js";
import { askPermission, fenceLsp, resolveOps, resolvePath } from "./fence.js";
import {
  capHoverMarkdown,
  capPreview,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatNoResults,
  formatServerStarting,
  formatWorkspaceSymbols,
  noResultsHint,
} from "./format.js";
import { findLspRoot, loadManifest, profileForPath } from "./manifest.js";
import { safeParseLspParams } from "./schema.js";
import type {
  LspClient,
  LspLocation,
  LspManifest,
  LspOperation,
  LspResult,
  LspServerProfile,
  LspSessionConfig,
  LspSymbolInfo,
  Position1,
} from "./types.js";

function err(error: ToolError): { kind: "error"; error: ToolError } {
  return { kind: "error", error };
}

/**
 * Main orchestrator. Routes by operation to the client, handles
 * workspace fence, permission hook, manifest discovery, position
 * validation, server-state reporting, size caps.
 */
export async function lsp(
  input: unknown,
  session: LspSessionConfig,
): Promise<LspResult> {
  const parsed = safeParseLspParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  const ops = resolveOps(session);
  const resolvedPath = await resolvePath(ops, session, params.path);

  // NOT_FOUND with sibling suggestions for operations that take a path.
  if (resolvedPath !== undefined) {
    const stat = await ops.stat(resolvedPath).catch(() => undefined);
    if (!stat) {
      return err(
        toolError("NOT_FOUND", `File does not exist: ${resolvedPath}`, {
          meta: { path: resolvedPath },
        }),
      );
    }
    if (stat.type !== "file") {
      return err(
        toolError(
          "INVALID_PARAM",
          `LSP operations need a file, not a directory: ${resolvedPath}`,
          { meta: { path: resolvedPath } },
        ),
      );
    }
  }

  // Fence check
  const fenceError = await fenceLsp(session, resolvedPath);
  if (fenceError) return err(fenceError);

  // Manifest + profile
  let manifest: LspManifest | undefined = session.manifest;
  if (manifest === undefined) {
    try {
      manifest = await loadManifest(session.manifestPath, session.cwd);
    } catch (e) {
      return err(
        toolError(
          "IO_ERROR",
          `Failed to load .lsp.json manifest: ${(e as Error).message}`,
        ),
      );
    }
  }

  let profile: LspServerProfile | undefined;
  let language: string | undefined;
  if (params.operation === "workspaceSymbol") {
    // Pick the first profile in the manifest, or error if none.
    if (manifest && Object.keys(manifest.servers).length > 0) {
      const first = Object.values(manifest.servers)[0];
      if (first) {
        profile = first;
        language = first.language;
      }
    }
  } else if (resolvedPath !== undefined) {
    profile = profileForPath(resolvedPath, manifest);
    language = profile?.language;
  }

  if (!profile) {
    const ext = resolvedPath ? path.extname(resolvedPath) : "(no path)";
    const hint = resolvedPath
      ? `No language server configured for ${ext}. Configure one in .lsp.json at your workspace root (or session.manifest).`
      : `workspaceSymbol needs at least one server in .lsp.json to pick a primary language.`;
    return err(
      toolError("SERVER_NOT_AVAILABLE", hint, {
        meta: { extension: ext, path: resolvedPath ?? null },
      }),
    );
  }

  // Permission hook
  const decision = await askPermission(session, {
    operation: params.operation,
    path: resolvedPath,
    language,
    line: params.line,
    character: params.character,
    query: params.query,
  });
  if (decision.decision === "deny") {
    return err(
      toolError("PERMISSION_DENIED", decision.reason, {
        meta: { operation: params.operation, path: resolvedPath },
      }),
    );
  }

  // Client setup
  if (!session.client) {
    return err(
      toolError(
        "IO_ERROR",
        "No LspClient configured on the session. Pass session.client (e.g. createSpawnLspClient() or StubLspClient).",
      ),
    );
  }

  // Resolve root + ensure server
  const lspRoot = resolvedPath
    ? await findLspRoot(resolvedPath, profile, session.cwd)
    : session.cwd;
  let handle;
  try {
    handle = await session.client.ensureServer({
      language: profile.language,
      root: lspRoot,
      profile,
    });
  } catch (e) {
    return err(
      toolError(
        "SERVER_NOT_AVAILABLE",
        `Failed to spawn ${profile.language} server: ${(e as Error).message}`,
      ),
    );
  }

  if (handle.state === "crashed") {
    return err(
      toolError(
        "SERVER_CRASHED",
        `Language server for ${profile.language} crashed. It will re-spawn on the next call.`,
      ),
    );
  }

  if (handle.state === "starting") {
    const retryMs = computeRetryMs(session, profile.language);
    return {
      kind: "server_starting",
      output: formatServerStarting({
        operation: params.operation,
        language: profile.language,
        retryMs,
      }),
      language: profile.language,
      retryMs,
    };
  }

  // Happy path — dispatch
  const timeoutMs =
    session.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const backstopMs =
    session.sessionBackstopMs ?? SESSION_BACKSTOP_MS;
  const effectiveTimeout = Math.min(timeoutMs, backstopMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  if (session.signal) {
    if (session.signal.aborted) controller.abort();
    else {
      session.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
  }

  try {
    switch (params.operation) {
      case "hover":
        return await runHover(
          session.client,
          handle,
          resolvedPath!,
          { line: params.line!, character: params.character! },
          controller.signal,
          session,
        );
      case "definition":
        return await runLocations(
          "definition",
          (c, h, p, pos, s) => c.definition(h, p, pos, s),
          session.client,
          handle,
          resolvedPath!,
          { line: params.line!, character: params.character! },
          controller.signal,
          session,
        );
      case "references":
        return await runLocations(
          "references",
          (c, h, p, pos, s) => c.references(h, p, pos, s),
          session.client,
          handle,
          resolvedPath!,
          { line: params.line!, character: params.character! },
          controller.signal,
          session,
        );
      case "implementation":
        return await runLocations(
          "implementation",
          (c, h, p, pos, s) => c.implementation(h, p, pos, s),
          session.client,
          handle,
          resolvedPath!,
          { line: params.line!, character: params.character! },
          controller.signal,
          session,
        );
      case "documentSymbol":
        return await runDocumentSymbol(
          session.client,
          handle,
          resolvedPath!,
          controller.signal,
        );
      case "workspaceSymbol":
        return await runWorkspaceSymbol(
          session.client,
          handle,
          params.query!,
          params.head_limit ?? DEFAULT_HEAD_LIMIT,
          controller.signal,
        );
    }
  } catch (e) {
    if (controller.signal.aborted) {
      return err(
        toolError("TIMEOUT", `LSP ${params.operation} exceeded ${effectiveTimeout}ms.`),
      );
    }
    if (e instanceof LspServerExitedError) {
      return err(toolError("SERVER_CRASHED", e.message));
    }
    const msg = (e as Error).message;
    if (/position/i.test(msg) && /invalid|out of range/i.test(msg)) {
      return err(toolError("POSITION_INVALID", msg));
    }
    return err(toolError("IO_ERROR", `LSP error: ${msg}`));
  } finally {
    clearTimeout(timer);
  }
}

async function runHover(
  client: LspClient,
  h: Awaited<ReturnType<LspClient["ensureServer"]>>,
  p: string,
  pos: Position1,
  signal: AbortSignal,
  session: LspSessionConfig,
): Promise<LspResult> {
  const result = await client.hover(h, p, pos, signal);
  if (!result || result.contents.trim().length === 0) {
    return {
      kind: "no_results",
      output: formatNoResults({ operation: "hover", hint: noResultsHint("hover") }),
      operation: "hover",
    };
  }
  const capMax =
    session.maxHoverMarkdownBytes ?? MAX_HOVER_MARKDOWN_BYTES;
  const { contents } = capHoverMarkdown(result.contents, capMax);
  return {
    kind: "hover",
    output: formatHover({
      path: p,
      line: pos.line,
      character: pos.character,
      contents,
    }),
    path: p,
    line: pos.line,
    character: pos.character,
    contents,
    isMarkdown: result.isMarkdown,
  };
}

async function runLocations(
  operation: "definition" | "references" | "implementation",
  fn: (
    c: LspClient,
    h: Awaited<ReturnType<LspClient["ensureServer"]>>,
    p: string,
    pos: Position1,
    s: AbortSignal,
  ) => Promise<readonly LspLocation[]>,
  client: LspClient,
  h: Awaited<ReturnType<LspClient["ensureServer"]>>,
  p: string,
  pos: Position1,
  signal: AbortSignal,
  session: LspSessionConfig,
): Promise<LspResult> {
  const raw = await fn(client, h, p, pos, signal);
  if (raw.length === 0) {
    return {
      kind: "no_results",
      output: formatNoResults({ operation, hint: noResultsHint(operation) }),
      operation,
    };
  }
  const maxPreview =
    session.maxPreviewLineLength ?? MAX_PREVIEW_LINE_LENGTH;
  const capped: LspLocation[] = raw.map((l) => ({
    ...l,
    preview: capPreview(l.preview, maxPreview),
  }));
  const sorted = capped.slice().sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
  });
  const headLimit = session.defaultHeadLimit ?? DEFAULT_HEAD_LIMIT;
  const truncated = sorted.length > headLimit;
  const window = truncated ? sorted.slice(0, headLimit) : sorted;

  if (operation === "references") {
    return {
      kind: "references",
      output: formatLocations({
        operation: "references",
        path: p,
        line: pos.line,
        character: pos.character,
        locations: window,
        total: sorted.length,
        truncated,
      }),
      path: p,
      line: pos.line,
      character: pos.character,
      locations: window,
      total: sorted.length,
      truncated,
    };
  }
  if (operation === "implementation") {
    return {
      kind: "implementation",
      output: formatLocations({
        operation: "implementation",
        path: p,
        line: pos.line,
        character: pos.character,
        locations: window,
      }),
      path: p,
      line: pos.line,
      character: pos.character,
      locations: window,
    };
  }
  // definition
  return {
    kind: "definition",
    output: formatLocations({
      operation: "definition",
      path: p,
      line: pos.line,
      character: pos.character,
      locations: window,
    }),
    path: p,
    line: pos.line,
    character: pos.character,
    locations: window,
  };
}

async function runDocumentSymbol(
  client: LspClient,
  h: Awaited<ReturnType<LspClient["ensureServer"]>>,
  p: string,
  signal: AbortSignal,
): Promise<LspResult> {
  const symbols = await client.documentSymbol(h, p, signal);
  if (symbols.length === 0) {
    return {
      kind: "no_results",
      output: formatNoResults({
        operation: "documentSymbol",
        hint: noResultsHint("documentSymbol"),
      }),
      operation: "documentSymbol",
    };
  }
  return {
    kind: "documentSymbol",
    output: formatDocumentSymbols({ path: p, symbols }),
    path: p,
    symbols,
  };
}

async function runWorkspaceSymbol(
  client: LspClient,
  h: Awaited<ReturnType<LspClient["ensureServer"]>>,
  query: string,
  headLimit: number,
  signal: AbortSignal,
): Promise<LspResult> {
  const symbols = await client.workspaceSymbol(h, query, signal);
  if (symbols.length === 0) {
    return {
      kind: "no_results",
      output: formatNoResults({
        operation: "workspaceSymbol",
        hint: noResultsHint("workspaceSymbol"),
      }),
      operation: "workspaceSymbol",
    };
  }
  const truncated = symbols.length > headLimit;
  const window: readonly LspSymbolInfo[] = truncated
    ? symbols.slice(0, headLimit)
    : symbols;
  return {
    kind: "workspaceSymbol",
    output: formatWorkspaceSymbols({
      query,
      symbols: window,
      total: symbols.length,
      truncated,
    }),
    query,
    symbols: window,
    total: symbols.length,
    truncated,
  };
}

function computeRetryMs(session: LspSessionConfig, language: string): number {
  const counter = session.retryCounter ?? new Map<string, number>();
  const prior = counter.get(language) ?? 0;
  const next = prior + 1;
  counter.set(language, next);
  if (!session.retryCounter) session.retryCounter = counter;
  const base = SERVER_STARTING_RETRY_BASE_MS;
  const cap = SERVER_STARTING_RETRY_MAX_MS;
  return Math.min(cap, base * Math.pow(2, prior));
}
