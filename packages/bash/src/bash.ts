import path from "node:path";
import { toolError, type ToolError } from "@agent-sh/harness-core";
import {
  BACKGROUND_MAX_JOBS,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_WALLCLOCK_BACKSTOP_MS,
  MAX_OUTPUT_BYTES_FILE,
  MAX_OUTPUT_BYTES_INLINE,
  SENSITIVE_ENV_PREFIXES,
} from "./constants.js";
import { createLocalBashExecutor } from "./executor.js";
import { askPermission, fenceBash, resolveCwd, resolveOps } from "./fence.js";
import {
  HeadTailBuffer,
  defaultSpillDir,
  formatBackgroundStartedText,
  formatBashKillText,
  formatBashOutputText,
  formatResultText,
  formatTimeoutText,
} from "./format.js";
import {
  safeParseBashKillParams,
  safeParseBashOutputParams,
  safeParseBashParams,
} from "./schema.js";
import type {
  BashExecutor,
  BashKillResult,
  BashOutputResult,
  BashResult,
  BashSessionConfig,
} from "./types.js";

// Session-scoped tracking of background jobs. The executor owns the
// runtime state (streams, pids); we keep a counter here to enforce the
// per-session cap.
const jobCountBySession = new WeakMap<BashSessionConfig, number>();

function incJobCount(session: BashSessionConfig): void {
  jobCountBySession.set(session, (jobCountBySession.get(session) ?? 0) + 1);
}

function jobCount(session: BashSessionConfig): number {
  return jobCountBySession.get(session) ?? 0;
}

function err(error: ToolError): { kind: "error"; error: ToolError } {
  return { kind: "error", error };
}

function resolveExecutor(session: BashSessionConfig): BashExecutor {
  if (session.executor) return session.executor;
  // Default local executor only works if the session explicitly opted into
  // the fail-closed bypass. Otherwise core refuses.
  if (session.permissions.unsafeAllowBashWithoutHook !== true) {
    // The caller will hit fail-closed in askPermission — but we still need
    // an executor object to let things reach that gate cleanly.
  }
  return createLocalBashExecutor();
}

/**
 * Top-level `cd` detector for session cwd-carry.
 *
 * Matches a single top-level `cd` invocation only — NOT inside pipelines
 * (`cd x | true`), command lists (`cd x && y`), subshells (`(cd x)`),
 * or with trailing arguments. This deliberately covers 95% of model
 * intent without hand-parsing the full bash grammar.
 *
 * Returns the path argument if detected, else null.
 */
export function detectTopLevelCd(command: string): string | null {
  // Strip leading whitespace. Reject if any shell metacharacter appears.
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  // Grammar: ^cd\s+<path>$  where <path> has no whitespace, no &, |, ;, `, $, (, ).
  const match = trimmed.match(/^cd\s+([^\s&|;`$()]+)$/);
  if (!match) return null;
  const arg = match[1];
  if (arg === undefined) return null;
  // Strip matching single or double quotes if present.
  if (
    (arg.startsWith('"') && arg.endsWith('"')) ||
    (arg.startsWith("'") && arg.endsWith("'"))
  ) {
    return arg.slice(1, -1);
  }
  return arg;
}

function checkEnv(env: Readonly<Record<string, string>>): string | null {
  for (const key of Object.keys(env)) {
    for (const prefix of SENSITIVE_ENV_PREFIXES) {
      if (
        key === prefix ||
        (prefix.endsWith("_") && key.startsWith(prefix))
      ) {
        return `env may not set sensitive-prefix variable '${key}' (prefix '${prefix}').`;
      }
    }
  }
  return null;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export async function bash(
  input: unknown,
  session: BashSessionConfig,
): Promise<BashResult> {
  const parsed = safeParseBashParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  if (
    params.background === true &&
    params.timeout_ms !== undefined
  ) {
    return err(
      toolError(
        "INVALID_PARAM",
        "timeout_ms does not apply to background jobs; they have their own lifecycle (bash_kill). Drop timeout_ms or set background: false.",
      ),
    );
  }

  const envParam = params.env ?? {};
  const envError = checkEnv(envParam);
  if (envError) {
    return err(toolError("INVALID_PARAM", envError));
  }

  const ops = resolveOps(session);
  const resolvedCwd = await resolveCwd(ops, session, params.cwd);

  // Workspace + sensitive-path fence.
  const fenceError = await fenceBash(session, resolvedCwd);
  if (fenceError) return err(fenceError);

  // cwd must actually exist and be a directory.
  const stat = await ops.stat(resolvedCwd).catch(() => undefined);
  if (!stat) {
    return err(
      toolError("NOT_FOUND", `cwd does not exist: ${resolvedCwd}`, {
        meta: { cwd: resolvedCwd },
      }),
    );
  }
  if (stat.type !== "directory") {
    return err(
      toolError(
        "IO_ERROR",
        `cwd is not a directory: ${resolvedCwd}`,
        { meta: { cwd: resolvedCwd } },
      ),
    );
  }

  // Permission hook (autonomous: allow or deny, never ask).
  const effectiveTimeout =
    params.timeout_ms ??
    session.defaultInactivityTimeoutMs ??
    DEFAULT_INACTIVITY_TIMEOUT_MS;
  const decision = await askPermission(session, {
    command: params.command,
    cwd: resolvedCwd,
    background: params.background ?? false,
    timeoutMs: effectiveTimeout,
    envKeys: Object.keys(envParam),
  });
  if (decision.decision === "deny") {
    const echo = params.command.length > 200
      ? params.command.slice(0, 200) + "..."
      : params.command;
    return err(
      toolError(
        "PERMISSION_DENIED",
        `${decision.reason}\nCommand: ${echo}`,
        { meta: { command: params.command, cwd: resolvedCwd } },
      ),
    );
  }

  const execEnv: Record<string, string> = {
    ...(session.env ?? process.env),
    ...envParam,
  } as Record<string, string>;
  // Node's process.env has `string | undefined`; filter undefineds.
  for (const [k, v] of Object.entries(execEnv)) {
    if (v === undefined) delete execEnv[k];
  }

  try {
    const executor = resolveExecutor(session);
    if (params.background === true) {
      return await runBackground(
        session,
        executor,
        params.command,
        resolvedCwd,
        execEnv,
      );
    }
    return await runForeground(
      session,
      executor,
      params.command,
      resolvedCwd,
      execEnv,
      effectiveTimeout,
    );
  } catch (error) {
    return err(toolError("IO_ERROR", `Cannot run command: ${(error as Error).message}`));
  }
}

async function runBackground(
  session: BashSessionConfig,
  executor: BashExecutor,
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<BashResult> {
  if (!executor.spawnBackground) {
    return err(
      toolError(
        "INVALID_PARAM",
        "background: true is not supported by this executor adapter.",
      ),
    );
  }
  const maxJobs = session.maxBackgroundJobs ?? BACKGROUND_MAX_JOBS;
  if (jobCount(session) >= maxJobs) {
    return err(
      toolError(
        "IO_ERROR",
        `Background job limit reached (${maxJobs}). Kill an existing job first with bash_kill.`,
      ),
    );
  }
  const { jobId } = await executor.spawnBackground({ command, cwd, env });
  incJobCount(session);
  return {
    kind: "background_started",
    output: formatBackgroundStartedText({ command, jobId }),
    jobId,
  };
}

async function runForeground(
  session: BashSessionConfig,
  executor: BashExecutor,
  command: string,
  cwd: string,
  env: Record<string, string>,
  inactivityTimeoutMs: number,
): Promise<BashResult> {
  const wallclockMs =
    session.wallclockBackstopMs ?? DEFAULT_WALLCLOCK_BACKSTOP_MS;
  const maxInline = session.maxOutputBytesInline ?? MAX_OUTPUT_BYTES_INLINE;
  const maxFile = session.maxOutputBytesFile ?? MAX_OUTPUT_BYTES_FILE;
  const spillDir = defaultSpillDir();

  const stdoutBuf = new HeadTailBuffer(maxInline, maxFile, "out", spillDir);
  const stderrBuf = new HeadTailBuffer(maxInline, maxFile, "err", spillDir);

  const controller = new AbortController();
  const abortOnOuter = () => controller.abort();
  if (session.signal) {
    if (session.signal.aborted) controller.abort();
    else session.signal.addEventListener("abort", abortOnOuter, { once: true });
  }

  let timedOut: "inactivity timeout" | "wall-clock backstop" | null = null;
  let inactivityTimer: NodeJS.Timeout | null = null;
  const resetInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = "inactivity timeout";
      controller.abort();
    }, inactivityTimeoutMs);
  };
  resetInactivity();

  const wallclockTimer = setTimeout(() => {
    timedOut = "wall-clock backstop";
    controller.abort();
  }, wallclockMs);

  const start = Date.now();
  let result: Awaited<ReturnType<BashExecutor["run"]>>;
  try {
    result = await executor.run({
      command,
      cwd,
      env,
      signal: controller.signal,
      onStdout: (chunk) => {
        stdoutBuf.write(chunk);
        resetInactivity();
      },
      onStderr: (chunk) => {
        stderrBuf.write(chunk);
        resetInactivity();
      },
    });
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    clearTimeout(wallclockTimer);
    if (session.signal) {
      session.signal.removeEventListener("abort", abortOnOuter);
    }
  }

  const durationMs = Date.now() - start;
  const stdoutRender = stdoutBuf.render();
  const stderrRender = stderrBuf.render();

  if (timedOut !== null) {
    const logPath = stdoutRender.logPath ?? stderrRender.logPath;
    return {
      kind: "timeout",
      output: formatTimeoutText({
        command,
        stdout: stdoutRender.text,
        stderr: stderrRender.text,
        reason: timedOut,
        durationMs,
        partialBytes: stdoutBuf.bytesTotal() + stderrBuf.bytesTotal(),
        logPath,
      }),
      stdout: stdoutRender.text,
      stderr: stderrRender.text,
      reason: timedOut,
      durationMs,
      ...(logPath ? { logPath } : {}),
    };
  }

  const exitCode = result.exitCode ?? -1;
  const kind: "ok" | "nonzero_exit" = exitCode === 0 ? "ok" : "nonzero_exit";
  const logPath = stdoutRender.logPath ?? stderrRender.logPath;
  const byteCap = stdoutRender.byteCap || stderrRender.byteCap;

  return {
    kind,
    output: formatResultText({
      command,
      exitCode,
      stdout: stdoutRender.text,
      stderr: stderrRender.text,
      durationMs,
      byteCap,
      logPath,
      kind,
    }),
    exitCode,
    stdout: stdoutRender.text,
    stderr: stderrRender.text,
    durationMs,
    ...(logPath ? { logPath } : {}),
    byteCap,
  };
}

export async function bashOutput(
  input: unknown,
  session: BashSessionConfig,
): Promise<BashOutputResult> {
  const parsed = safeParseBashOutputParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages));
  }
  const executor = session.executor ?? createLocalBashExecutor();
  if (!executor.readBackground) {
    return err(
      toolError(
        "INVALID_PARAM",
        "bash_output is not supported by this executor adapter.",
      ),
    );
  }
  try {
    const read = await executor.readBackground(parsed.value.job_id, {
      ...(parsed.value.since_byte !== undefined
        ? { since_byte: parsed.value.since_byte }
        : {}),
      ...(parsed.value.head_limit !== undefined
        ? { head_limit: parsed.value.head_limit }
        : {}),
    });
    const sinceByte = parsed.value.since_byte ?? 0;
    const returnedBytes =
      byteLength(read.stdout) + byteLength(read.stderr);
    const totalBytes = read.totalBytesStdout + read.totalBytesStderr;
    return {
      kind: "output",
      output: formatBashOutputText({
        jobId: parsed.value.job_id,
        running: read.running,
        exitCode: read.exitCode,
        stdout: read.stdout,
        stderr: read.stderr,
        sinceByte,
        returnedBytes,
        totalBytes,
      }),
      running: read.running,
      exitCode: read.exitCode,
      stdout: read.stdout,
      stderr: read.stderr,
      totalBytesStdout: read.totalBytesStdout,
      totalBytesStderr: read.totalBytesStderr,
      nextSinceByte: sinceByte + returnedBytes,
    };
  } catch (e) {
    return err(
      toolError(
        "NOT_FOUND",
        (e as Error).message || `Unknown job_id: ${parsed.value.job_id}`,
      ),
    );
  }
}

export async function bashKill(
  input: unknown,
  session: BashSessionConfig,
): Promise<BashKillResult> {
  const parsed = safeParseBashKillParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages));
  }
  const executor = session.executor ?? createLocalBashExecutor();
  if (!executor.killBackground) {
    return err(
      toolError(
        "INVALID_PARAM",
        "bash_kill is not supported by this executor adapter.",
      ),
    );
  }
  const signal = parsed.value.signal ?? "SIGTERM";
  await executor.killBackground(parsed.value.job_id, signal);
  return {
    kind: "killed",
    output: formatBashKillText({ jobId: parsed.value.job_id, signal }),
    jobId: parsed.value.job_id,
    signal,
  };
}

/**
 * Apply cwd-carry: if the command is a top-level `cd <path>` and the
 * destination resolves inside the workspace, mutate session.logicalCwd.
 * Called AFTER the command executes with exit 0 (caller's responsibility).
 *
 * Exposed separately so tests can exercise the logic directly AND so a
 * harness wrapper can call it at the right point in the lifecycle. In
 * core, the orchestrator does NOT auto-call this — we keep cwd-carry
 * out of the hot path for correctness; the caller opts in by invoking
 * applyCwdCarry after a successful bash() result.
 *
 * Rationale: cwd-carry mutates session state which has observable
 * implications for concurrent calls. Making it explicit is safer.
 */
export function applyCwdCarry(
  session: BashSessionConfig,
  command: string,
  exitCode: number | null,
): { changed: boolean; newCwd: string | null; escaped: boolean } {
  if (exitCode !== 0) {
    return { changed: false, newCwd: null, escaped: false };
  }
  const target = detectTopLevelCd(command);
  if (target === null) {
    return { changed: false, newCwd: null, escaped: false };
  }
  const base = session.logicalCwd?.value ?? session.cwd;
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(base, target);

  // Escape check.
  const inside = session.permissions.roots.some(
    (r) => resolved === r || resolved.startsWith(r + path.sep),
  );
  if (!inside && session.permissions.bypassWorkspaceGuard !== true) {
    return { changed: false, newCwd: resolved, escaped: true };
  }

  if (session.logicalCwd) {
    session.logicalCwd.value = resolved;
  }
  return { changed: true, newCwd: resolved, escaped: false };
}
