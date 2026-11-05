import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { LspSessionConfig } from "@agent-sh/harness-lsp";
import { lspToolDefinition } from "@agent-sh/harness-lsp";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed LSP executor. Spawns `harness-lsp-cli` once per session
 * and proxies calls over newline-delimited JSON-RPC on stdio. The Rust
 * CLI carries its own SpawnLspClient cache across calls so language
 * servers stay warm for the lifetime of the process.
 */

export interface RustLspRunner {
  readonly tool: OllamaTool;
  execute: ToolExecutor["execute"];
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

function defaultBinPath(): string {
  const fromEnv = process.env.HARNESS_LSP_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-lsp-cli");
}

const sessionRunners = new WeakMap<object, RustLspRunner>();

export function makeLspExecutorRust(session: LspSessionConfig): RustLspRunner {
  const existing = sessionRunners.get(session as unknown as object);
  if (existing) return existing;
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: lspToolDefinition.name,
      description: lspToolDefinition.description,
      parameters: lspToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };

  const binPath = defaultBinPath();
  let proc: ChildProcess | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let buffered = "";

  function ensureProc(): ChildProcess {
    if (proc && !proc.killed && proc.exitCode === null) return proc;
    const p = spawn(binPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LD_LIBRARY_PATH: "" },
    });
    p.on("exit", () => {
      for (const [, h] of pending) {
        h.reject(new Error("harness-lsp-cli exited unexpectedly"));
      }
      pending.clear();
      proc = null;
    });
    p.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      while (true) {
        const nl = buffered.indexOf("\n");
        if (nl < 0) break;
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let parsed: {
          id?: number;
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed.id !== "number") continue;
        const handler = pending.get(parsed.id);
        if (!handler) continue;
        pending.delete(parsed.id);
        if (parsed.error) {
          handler.reject(
            new Error(
              `rust rpc error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "unknown"}`,
            ),
          );
        } else {
          handler.resolve(JSON.stringify(parsed.result ?? null));
        }
      }
    });
    p.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[harness-lsp-cli] ${chunk.toString("utf8")}`);
    });
    proc = p;
    return p;
  }

  function sessionSpec() {
    return {
      cwd: session.cwd,
      roots: session.permissions.roots,
      sensitive_patterns: session.permissions.sensitivePatterns ?? [],
      bypass_workspace_guard:
        session.permissions.bypassWorkspaceGuard ?? false,
      unsafe_allow_lsp_without_hook:
        session.permissions.unsafeAllowLspWithoutHook ?? false,
      manifest: session.manifest
        ? {
            servers: Object.fromEntries(
              Object.entries(session.manifest.servers).map(([k, v]) => [
                k,
                {
                  language: v.language,
                  extensions: v.extensions,
                  command: v.command,
                  root_patterns: v.rootPatterns ?? null,
                  initialization_options: v.initializationOptions ?? null,
                },
              ]),
            ),
          }
        : null,
      manifest_path: session.manifestPath ?? null,
      default_head_limit: session.defaultHeadLimit ?? null,
      default_timeout_ms: session.defaultTimeoutMs ?? null,
      session_backstop_ms: session.sessionBackstopMs ?? null,
      max_hover_markdown_bytes: session.maxHoverMarkdownBytes ?? null,
      max_preview_line_length: session.maxPreviewLineLength ?? null,
    };
  }

  function sendCall(params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload = {
      id,
      method: "lsp",
      params: { params, session: sessionSpec() },
    };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      p.stdin!.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async function execute(args: unknown): Promise<string> {
    const raw = await sendCall(args);
    const parsed = JSON.parse(raw) as {
      kind?: string;
      output?: string;
      error?: ToolError;
    };
    if (parsed.kind === "error" && parsed.error) {
      return formatToolError(parsed.error);
    }
    if (typeof parsed.output === "string") return parsed.output;
    return raw;
  }

  /**
   * At the end of its input the CLI stops its language servers, their
   * children included, and exits. Wait for that; send SIGTERM, which does
   * the same, only when the CLI has not exited in time. A stop takes at
   * most five 2s steps, so 15s is past any normal close.
   */
  async function close(): Promise<void> {
    const p = proc;
    proc = null;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const exited = new Promise<boolean>((resolve) => p.once("exit", () => resolve(true)));
    const after = (ms: number): Promise<boolean> =>
      new Promise((resolve) => setTimeout(() => resolve(false), ms).unref());
    p.stdin?.end();
    if (await Promise.race([exited, after(15_000)])) return;
    try {
      p.kill("SIGTERM");
    } catch {
      // ignore
    }
    await Promise.race([exited, after(15_000)]);
  }

  const runner = { tool, execute, close };
  sessionRunners.set(session as unknown as object, runner);
  return runner;
}
