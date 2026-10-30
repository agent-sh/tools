import { spawn } from "node:child_process";
import { closeSync, constants, createWriteStream, existsSync, fstatSync, openSync, readSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { ensurePrivateDirectory, openPrivateFile, replacePrivateFile } from "@agent-sh/harness-core";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KILL_GRACE_MS } from "./constants.js";
import { defaultBashDirectory } from "./directories.js";
import type {
  BackgroundReadResult,
  BashExecutor,
  BashRunInput,
  BashRunResult,
} from "./types.js";

/** Job metadata persisted to disk for cross-session restoration. */
interface JobMeta {
  outPath: string;
  errPath: string;
  running: boolean;
  exitCode: number | null;
  createdAt: number; // epoch seconds
  childPid: number | undefined; // PID for liveness check on restore
}

/** In-memory job state. */
interface Job {
  id: string;
  logDir: string;
  outPath: string;
  errPath: string;
  running: boolean;
  exitCode: number | null;
  killed: boolean;
  proc: ReturnType<typeof spawn> | null;
}

/** Treat persisted paths as data: a job may only reference its own output files. */
function readJobMeta(logDir: string, jobId: string): JobMeta {
  ensurePrivateDirectory(logDir);
  ensurePrivateDirectory(path.join(logDir, "job-meta"));
  const file = path.join(logDir, "job-meta", `${jobId}.json`);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
      throw new Error(`Unsafe job metadata: ${file}`);
    }
    const data = JSON.parse(readFileSync(fd, "utf8")) as JobMeta;
    if (typeof data.outPath !== "string" || typeof data.errPath !== "string" ||
        path.resolve(data.outPath) !== path.resolve(logDir, `${jobId}.out`) ||
        path.resolve(data.errPath) !== path.resolve(logDir, `${jobId}.err`) ||
        typeof data.running !== "boolean" || typeof data.createdAt !== "number") {
      throw new Error(`Invalid job metadata: ${file}`);
    }
    return data;
  } finally { closeSync(fd); }
}

/** Write job metadata to disk. Idempotent — safe to call multiple times. */
function persistJobMeta(logDir: string, jobId: string, meta: JobMeta): void {
  const metaDir = path.join(logDir, "job-meta");
  try {
    ensurePrivateDirectory(metaDir);
  } catch {
    // real error (e.g. permission denied); mkdirSync({recursive:true})
    // does NOT throw on EEXIST, so this only fires on genuine failures
    return;
  }
  try {
    replacePrivateFile(
      path.join(metaDir, `${jobId}.json`),
      JSON.stringify(meta),
    );
  } catch {
    // ignore — non-fatal
  }
}

/** Load completed jobs from disk and restore them into the jobs map. */
function loadJobsFromDisk(
  logDir: string,
  jobs: Map<string, Job>,
): void {
  const metaDir = path.join(logDir, "job-meta");
  if (!existsSync(metaDir)) return;
  const now = Date.now() / 1000;
  const TTL_SECS = 7 * 24 * 60 * 60; // 7 days
  try {
    for (const fname of readdirSync(metaDir)) {
      if (!fname.endsWith(".json")) continue;
      const metaPath = path.join(metaDir, fname);
      try {
        const jobId = fname.slice(0, -5);
        const data = readJobMeta(logDir, jobId);
        // Prune expired jobs
        if (now - data.createdAt > TTL_SECS) {
          try { unlinkSync(metaPath); } catch {}
          continue;
        }
        // Only restore jobs not already in memory
        if (!jobs.has(jobId) && !data.running) {
          jobs.set(jobId, {
            id: jobId,
            logDir,
            outPath: data.outPath,
            errPath: data.errPath,
            running: false,
            exitCode: data.exitCode,
            killed: false,
            proc: null,
          });
        }
      } catch {
        // skip corrupt entries
      }
    }
  } catch {
    // meta dir doesn't exist or unreadable
  }
}

/**
 * Default local-subprocess executor.
 *
 * Launches the bash binary with `-c <command>` via the argv form of
 * node:child_process.spawn — NEVER the string-based shell-eval entry
 * point. The command string is passed as a single argument to the bash
 * binary, not interpolated into our own spawn args. All shell parsing
 * happens inside the child bash process.
 *
 * This executor ships unsandboxed; sandboxing is the job of adapter
 * packages that implement the same BashExecutor interface. See
 * packages/bash/src/types.ts.
 */
export function createLocalBashExecutor(opts?: {
  bashPath?: string;
  logDir?: string;
}): BashExecutor {
  const bashPath = opts?.bashPath ?? "/bin/bash";
  const logDir = opts?.logDir ?? defaultBashDirectory("logs");
  const legacyLogDir = opts?.logDir === undefined ? path.join(tmpdir(), "agent-sh-bash-logs") : null;
  if (opts?.logDir !== undefined) {
    ensurePrivateDirectory(logDir);
    ensurePrivateDirectory(path.join(logDir, "job-meta"));
  }

  const jobs = new Map<string, Job>();

  // Restore completed jobs from disk (persisted across executor restarts).
  loadJobsFromDisk(logDir, jobs);

  async function runForeground(input: BashRunInput): Promise<BashRunResult> {
    const child = spawn(bashPath, ["-c", input.command], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let killedBySignal = false;
    const onAbort = () => {
      killedBySignal = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS).unref();
      } catch {
        // best effort
      }
    };
    if (input.signal.aborted) {
      onAbort();
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    return new Promise((resolve, reject) => {
      let outputError: unknown;
      const forward = (callback: (chunk: Buffer) => void, chunk: Buffer) => {
        if (outputError !== undefined) return;
        try { callback(chunk); } catch (error) {
          outputError = error;
          onAbort();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => forward(input.onStdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => forward(input.onStderr, chunk));
      child.on("close", (code, signal) => {
        input.signal.removeEventListener("abort", onAbort);
        if (outputError !== undefined) { reject(outputError); return; }
        resolve({
          exitCode: code,
          killed: killedBySignal,
          signal: signal ?? null,
        });
      });
      child.on("error", () => {
        input.signal.removeEventListener("abort", onAbort);
        resolve({ exitCode: null, killed: killedBySignal, signal: null });
      });
    });
  }

  async function spawnBackground(args: {
    command: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
  }): Promise<{ jobId: string }> {
    const jobId = randomUUID();
    const outPath = path.join(logDir, `${jobId}.out`);
    const errPath = path.join(logDir, `${jobId}.err`);
    const outFd = openPrivateFile(outPath);
    let errFd: number;
    try { errFd = openPrivateFile(errPath); } catch (error) {
      closeSync(outFd);
      unlinkSync(outPath);
      throw error;
    }
    const outStream = createWriteStream(outPath, { fd: outFd, autoClose: true });
    const errStream = createWriteStream(errPath, { fd: errFd, autoClose: true });

    const child = spawn(bashPath, ["-c", args.command], {
      cwd: args.cwd,
      env: { ...args.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.stdout.pipe(outStream);
    child.stderr.pipe(errStream);

    const job: Job = {
      id: jobId,
      logDir,
      outPath,
      errPath,
      running: true,
      exitCode: null,
      killed: false,
      proc: child,
    };
    jobs.set(jobId, job);

    // Persist metadata immediately so in-flight jobs survive executor restart.
    persistJobMeta(logDir, jobId, {
      outPath,
      errPath,
      running: true,
      exitCode: null,
      createdAt: Math.floor(Date.now() / 1000),
      childPid: child.pid,
    });

    child.on("close", (code) => {
      job.running = false;
      job.exitCode = code;
      job.proc = null;
      // Persist final state for cross-session queries.
      persistJobMeta(logDir, jobId, {
        outPath,
        errPath,
        running: false,
        exitCode: code,
        createdAt: Math.floor(Date.now() / 1000),
        childPid: undefined,
      });
    });
    child.on("error", () => {
      job.running = false;
      job.proc = null;
      // Persist error state.
      persistJobMeta(logDir, jobId, {
        outPath,
        errPath,
        running: false,
        exitCode: null,
        createdAt: Math.floor(Date.now() / 1000),
        childPid: undefined,
      });
    });

    return { jobId };
  }

  async function readBackground(
    jobId: string,
    opts: { since_byte?: number; head_limit?: number },
  ): Promise<BackgroundReadResult> {
    let job = jobs.get(jobId);

    // If the job isn't in memory, try to restore it from disk.
    if (!job) {
      // Reject path separators in job IDs to prevent directory traversal.
      if (jobId.includes("/") || jobId.includes("\\") || jobId.includes("\0")) {
        throw new Error(`Invalid job_id: ${jobId}`);
      }
      let sourceDir = logDir;
      if (!existsSync(path.join(logDir, "job-meta", `${jobId}.json`)) && legacyLogDir &&
          existsSync(path.join(legacyLogDir, "job-meta", `${jobId}.json`))) {
        sourceDir = legacyLogDir;
      }
      try {
        const data = readJobMeta(sourceDir, jobId);
        job = {
          id: jobId,
          logDir: sourceDir,
          outPath: data.outPath,
          errPath: data.errPath,
          running: data.running,
          exitCode: data.exitCode,
          killed: false,
          proc: null,
        };
        jobs.set(jobId, job);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        throw new Error(`Unknown job_id: ${jobId}`);
      }
    }

    // For restored jobs with no child handle, re-read metadata from disk
    // and check liveness so we detect completion after the old executor died.
    if (job.running && !job.proc) {
      try {
        const data = readJobMeta(job.logDir, jobId);
        if (!data.running) {
          // Metadata was updated by the waiter — job is done.
          job.running = false;
          job.exitCode = data.exitCode;
        } else if (data.childPid != null) {
          // Metadata still says running — check if the PID is actually alive.
          // process.kill(pid, 0) throws if the process doesn't exist.
          let stillAlive = true;
          try {
            process.kill(data.childPid, 0);
          } catch {
            stillAlive = false;
          }
          if (!stillAlive) {
            // Child is gone but metadata was never updated (executor died
            // before the close handler fired). Mark as done with inferred exit.
            job.running = false;
            job.exitCode = 0; // best guess; output files still readable
          }
        }
        // If no childPid and no metadata update, we can't determine liveness;
        // fall through with cached state. The job may have already exited.
      } catch {
        // Metadata may not exist or may be stale; fall through with cached state.
      }
    }
    const since = opts.since_byte ?? 0;
    const limit = opts.head_limit ?? 30_720;
    const stdout = readSlice(job.outPath, since, limit);
    const stderr = readSlice(job.errPath, since, limit);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      running: job.running,
      exitCode: job.exitCode,
      totalBytesStdout: stdout.totalBytes,
      totalBytesStderr: stderr.totalBytes,
    };
  }

  async function killBackground(
    jobId: string,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ): Promise<void> {
    const job = jobs.get(jobId);
    if (!job || !job.proc) return;
    job.killed = true;
    try {
      job.proc.kill(signal);
      if (signal === "SIGTERM") {
        setTimeout(() => {
          if (job.running && job.proc) {
            try {
              job.proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, KILL_GRACE_MS).unref();
      }
    } catch {
      // ignore
    }
  }

  async function closeSession(): Promise<void> {
    for (const job of jobs.values()) {
      if (job.running && job.proc) {
        try {
          job.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    run: runForeground,
    spawnBackground,
    readBackground,
    killBackground,
    closeSession,
  };
}

function readSlice(
  filePath: string,
  since: number,
  limit: number,
): { text: string; totalBytes: number } {
  let fd: number;
  try { fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", totalBytes: 0 };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
      throw new Error(`Unsafe background output: ${filePath}`);
    }
    const totalBytes = stat.size;
    if (since >= totalBytes) return { text: "", totalBytes };
    const buf = Buffer.alloc(Math.min(limit, totalBytes - since));
    const bytesRead = readSync(fd, buf, 0, buf.length, since);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), totalBytes };
  } finally { closeSync(fd); }
}
