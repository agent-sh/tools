import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";
import {
  type BatchParams,
  type BatchTarget,
  type BatchTargetSubdirs,
  type BatchTargetGlob,
  type BatchTargetExplicit,
  type TargetResult,
  type BatchSummary,
} from "./types.js";

const DEFAULT_TIMEOUT_SECS = 120;
const DEFAULT_MAX_CONCURRENT = 4;

/// Resolve targets from the batch params, canonicalizing each result
/// via realpath to prevent symlink escapes.
export async function resolveTargets(
  targets: BatchTarget,
): Promise<string[]> {
  let raw: string[];
  switch (targets.kind) {
    case "subdirs":
      raw = await resolveSubdirs(targets);
      break;
    case "glob":
      raw = await resolveGlob(targets);
      break;
    case "explicit":
      raw = await resolveExplicit(targets);
      break;
  }
  // Canonicalize every target to prevent symlink escapes.
  // Keep broken paths so execution can report them naturally.
  const resolved: string[] = [];
  for (const p of raw) {
    try {
      resolved.push(await fs.realpath(p));
    } catch {
      // realpath failed — keep the resolved path so the executor reports it.
      resolved.push(p);
    }
  }
  return resolved;
}

async function resolveSubdirs(t: BatchTargetSubdirs): Promise<string[]> {
  const expanded = expandTilde(t.path);
  const stat = await fs.stat(expanded).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a directory: ${expanded}`);
  }

  const entries = await fs.readdir(expanded, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    if (t.name_filter && !matchesName(name, t.name_filter)) {
      continue;
    }

    results.push(path.join(expanded, name));
  }

  results.sort();
  return results;
}

async function resolveGlob(t: BatchTargetGlob): Promise<string[]> {
  const expanded = expandTilde(t.pattern);
  const matches = await glob(expanded, {
    onlyDirectories: true,
    dot: true,
    absolute: true,
    expandDirectories: false,
  });
  matches.sort();
  return matches;
}

function resolveExplicit(t: BatchTargetExplicit): string[] {
  return t.paths.map((p) => expandTilde(p));
}

/// Glob matching for subdirectory names supporting * and ? wildcards.
/// Converts the glob pattern to a regex for proper matching.
function matchesName(name: string, pattern: string): boolean {
  // Convert glob pattern to regex: * → .*, ? → ., escape other specials.
  const regexSrc = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${regexSrc}$`, "i");
  return regex.test(name);
}

/// Expand ~ to home directory.
function expandTilde(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? "";
    return path.join(home, p.slice(1));
  }
  return p;
}

/// Run a single command in the given target directory.
async function runOne(
  command: string,
  target: string,
  timeoutMs: number,
): Promise<TargetResult> {
  const start = Date.now();

  // Pass TARGET as env var to avoid shell injection via path interpolation.
  const env = { ...process.env, TARGET: target };

  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", command],
      { cwd: target, timeout: timeoutMs, env, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const duration = Date.now() - start;
        const stdoutStr = stdout?.trim();
        const stderrStr = stderr?.trim();

        if (error) {
          // Check if it was a timeout (spawnerr: ETIMEDOUT)
          if (error.signal === "SIGTERM" || (error as any).spawnerr === "ETIMEDOUT") {
            resolve({
              path: target,
              status: "timed_out",
              duration_ms: duration,
              ...(stderrStr ? { stderr: stderrStr } : {}),
            });
          } else {
            resolve({
              path: target,
              status: "failed",
              exit_code: (error as any).status ?? -1,
              duration_ms: duration,
              ...(stdoutStr ? { stdout: stdoutStr } : {}),
              ...(stderrStr ? { stderr: stderrStr } : {}),
            });
          }
        } else {
          resolve({
            path: target,
            status: "success",
            duration_ms: duration,
            ...(stdoutStr ? { stdout: stdoutStr } : {}),
            ...(stderrStr ? { stderr: stderrStr } : {}),
          });
        }
      },
    );
  });
}

/// Run commands sequentially.
async function runSequential(
  command: string,
  targets: string[],
  timeoutSecs: number,
  failFast: boolean,
): Promise<TargetResult[]> {
  const results: TargetResult[] = [];
  const timeoutMs = timeoutSecs * 1000;

  for (const target of targets) {
    const result = await runOne(command, target, timeoutMs);
    results.push(result);

    if (failFast && result.status !== "success" && result.status !== "skipped") {
      break;
    }
  }

  return results;
}

/// Run commands in parallel with concurrency control.
async function runParallel(
  command: string,
  targets: string[],
  timeoutSecs: number,
  maxConcurrent: number,
  failFast: boolean,
): Promise<TargetResult[]> {
  const results: TargetResult[] = [];
  const timeoutMs = timeoutSecs * 1000;
  let failed = false;

  const queue = [...targets];
  const running = new Set<Promise<void>>();

  while ((queue.length > 0 || running.size > 0) && !(failFast && failed)) {
    // Fill up to max_concurrent
    while (running.size < maxConcurrent && queue.length > 0 && !(failFast && failed)) {
      const target = queue.shift()!;
      const promise = (async () => {
        const result = await runOne(command, target, timeoutMs);
        results.push(result);
        if (failFast && result.status !== "success" && result.status !== "skipped") {
          failed = true;
        }
      })();
      running.add(promise);
      promise.finally(() => running.delete(promise));
    }

    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  // Drain in-flight jobs before returning (fail-fast still waits for them).
  if (running.size > 0) {
    await Promise.all(running);
  }

  return results;
}

/// Build a summary from results.
function buildSummary(results: TargetResult[]): BatchSummary {
  const summary: BatchSummary = {
    total: results.length,
    success: 0,
    failed: 0,
    timed_out: 0,
  };

  for (const r of results) {
    switch (r.status) {
      case "success":
        summary.success++;
        break;
      case "failed":
        summary.failed++;
        break;
      case "timed_out":
        summary.timed_out++;
        break;
    }
  }

  return summary;
}

/// Main batch execution entry point.
/// If `workspaceRoot` is provided, targets outside the workspace are filtered out.
export async function executeBatch(
  params: BatchParams,
  workspaceRoot?: string,
): Promise<{
  message: string;
  meta: Record<string, unknown>;
}> {
  const targets = await resolveTargets(params.targets);

  // Filter out targets that escape the workspace (via symlinks etc.).
  let finalTargets = targets;
  if (workspaceRoot) {
    const realRoot = await fs.realpath(workspaceRoot);
    finalTargets = targets.filter((t) => {
      const rel = path.relative(realRoot, t);
      // Allow workspace root itself (rel === "") and any path inside it.
      return !rel.startsWith("..");
    });
  }

  if (finalTargets.length === 0) {
    return {
      message: "No matching targets found.",
      meta: {},
    };
  }

  const timeoutSecs = params.timeout_secs ?? DEFAULT_TIMEOUT_SECS;
  const maxConcurrent = params.max_concurrent ?? DEFAULT_MAX_CONCURRENT;
  const failFast = params.fail_fast ?? false;

  const results: TargetResult[] =
    params.mode === "parallel"
      ? await runParallel(
          params.command,
          finalTargets,
          timeoutSecs,
          maxConcurrent,
          failFast,
        )
      : await runSequential(params.command, finalTargets, timeoutSecs, failFast);

  if (params.summary_only) {
    return buildSummaryResponse(results);
  }

  return buildDetailedResponse(results);
}

function buildSummaryResponse(results: TargetResult[]): {
  message: string;
  meta: Record<string, unknown>;
} {
  const summary = buildSummary(results);
  const failedTargets = results
    .filter((r) => r.status === "failed")
    .map((r) => r.path);

  return {
    message: `Batch complete: ${summary.success}/${summary.total} succeeded, ${summary.failed} failed, ${summary.timed_out} timed out`,
    meta: {
      summary,
      failed_targets: failedTargets,
    },
  };
}

function buildDetailedResponse(results: TargetResult[]): {
  message: string;
  meta: Record<string, unknown>;
} {
  const lines: string[] = [];
  lines.push(`Batch complete: ${results.length} targets`);
  lines.push("");

  for (const r of results) {
    const statusStr =
      r.status === "success"
        ? "✓"
        : r.status === "failed"
          ? `✗ (exit ${r.exit_code ?? -1})`
          : r.status === "timed_out"
            ? "⏱ timeout"
            : "○ skipped";

    lines.push(`${statusStr} ${r.path}`);

    // Include stderr for failed jobs (up to 5 lines).
    if (r.status !== "success" && r.stderr) {
      const errLines = r.stderr.split("\n").slice(0, 5);
      for (const line of errLines) {
        lines.push(`    ${line}`);
      }
    }
  }

  const targetResults = results.map((r) => ({
    path: r.path,
    status: r.status,
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
    stdout: r.stdout
      ? r.stdout.split("\n").slice(0, 10).join("\n")
      : undefined,
  }));

  return {
    message: lines.join("\n"),
    meta: {
      targets: targetResults,
    },
  };
}
