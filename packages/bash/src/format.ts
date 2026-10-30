import { appendPrivateFile, writePrivateFile } from "@agent-sh/harness-core";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultBashDirectory } from "./directories.js";

/**
 * Per-stream output buffer with head+tail capping and spill-to-file on
 * overflow. Models rarely need the middle of a long output — they need
 * either the setup line or the error tail. This buffer preserves both.
 */
export class HeadTailBuffer {
  private readonly chunks: Uint8Array[] = [];
  private readonly headChunks: Uint8Array[] = [];
  private headBytes = 0;
  private tail = new Uint8Array(0);
  private totalBytes = 0;
  private byteCap = false;
  private spilled = false;
  private spillPath: string | null = null;

  constructor(
    private readonly maxInline: number,
    private readonly maxFile: number,
    private readonly kind: "out" | "err",
    private readonly spillDir: string,
  ) {}

  write(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;
    this.rememberHead(chunk);
    this.rememberTail(chunk);
    if (this.totalBytes <= this.maxInline) {
      this.chunks.push(chunk);
      return;
    }
    // Overflow: spill everything past the cap to disk + remember tail.
    if (!this.spilled) {
      this.spilled = true;
      this.byteCap = true;
      this.spillPath = path.join(
        this.spillDir,
        `${randomUUID()}.${this.kind}`,
      );
      // Write whatever was buffered so far into the spill file so the
      // full log is recoverable from the file path alone.
      for (const c of this.chunks) this.appendSpill(c);
    }
    this.appendSpill(chunk);
  }

  private headLimit(): number {
    return Math.ceil(this.maxInline / 2);
  }

  private tailLimit(): number {
    return Math.floor(this.maxInline / 2);
  }

  private rememberHead(chunk: Uint8Array): void {
    const remaining = this.headLimit() - this.headBytes;
    if (remaining <= 0) return;
    const slice = chunk.subarray(0, Math.min(remaining, chunk.byteLength));
    this.headChunks.push(slice.slice());
    this.headBytes += slice.byteLength;
  }

  private rememberTail(chunk: Uint8Array): void {
    const limit = this.tailLimit();
    if (limit <= 0) {
      this.tail = new Uint8Array(0);
      return;
    }
    const combined = new Uint8Array(this.tail.byteLength + chunk.byteLength);
    combined.set(this.tail);
    combined.set(chunk, this.tail.byteLength);
    this.tail =
      combined.byteLength > limit
        ? combined.slice(combined.byteLength - limit)
        : combined;
  }

  private appendSpill(chunk: Uint8Array): void {
    if (this.spillPath === null) return;
    if (!this.spillInit) {
      writePrivateFile(this.spillPath, "");
      this.spillInit = true;
    }
    if (this.fileBytesWritten + chunk.byteLength > this.maxFile) {
      // File cap hit. Ignore further writes.
      return;
    }
    // Sync append — output sizes are in KB-to-MB range, no need for
    // async stream plumbing.
    appendPrivateFile(this.spillPath, Buffer.from(chunk));
    this.fileBytesWritten += chunk.byteLength;
  }

  private spillInit = false;
  private fileBytesWritten = 0;

  /**
   * Return the inline render:
   *   - If not capped: the full buffered text.
   *   - If capped: head (first maxInline/2 bytes) + marker + tail
   *     (last maxInline/2 bytes), with the full stream recoverable from
   *     the spill file.
   */
  render(): { text: string; byteCap: boolean; logPath: string | null } {
    if (!this.spilled) {
      const combined = Buffer.concat(this.chunks.map((c) => Buffer.from(c)));
      return {
        text: combined.toString("utf8"),
        byteCap: false,
        logPath: null,
      };
    }
    const head = Buffer.concat(
      this.headChunks.map((c) => Buffer.from(c)),
      this.headBytes,
    ).toString("utf8");
    const tail = Buffer.from(this.tail).toString("utf8");
    const elided = Math.max(
      0,
      this.totalBytes - this.headBytes - this.tail.byteLength,
    );
    const marker = `\n... (${elided} bytes elided; stream exceeded ${this.maxInline} bytes; full log at ${this.spillPath}) ...\n`;
    return {
      text: head + marker + tail,
      byteCap: true,
      logPath: this.spillPath,
    };
  }

  bytesTotal(): number {
    return this.totalBytes;
  }

  wasCapped(): boolean {
    return this.byteCap;
  }
}

export function defaultSpillDir(): string {
  return defaultBashDirectory("spill");
}

/**
 * Format the text body of an "ok" / "nonzero_exit" result.
 * Kept deliberately simple — structured fields ride on the result
 * object; `output` is the canonical text the executor returns to the
 * model at the tool_result boundary.
 */
export function formatResultText(args: {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  byteCap: boolean;
  logPath: string | null;
  kind: "ok" | "nonzero_exit";
}): string {
  const header = `<command>${args.command}</command>`;
  const exitLine = `<exit_code>${args.exitCode}</exit_code>`;
  const stdoutBlock = `<stdout>\n${args.stdout}\n</stdout>`;
  const stderrBlock = `<stderr>\n${args.stderr}\n</stderr>`;
  const curlHint =
    args.byteCap && looksLikeUrlFetchCommand(args.command)
      ? " This looks like curl/wget output; use webfetch for cleaned HTML/page content, and reserve bash for raw source or downloads."
      : "";
  const hint = args.byteCap
    ? `(Output capped; showing head+tail preview. Full log: ${args.logPath}. Read it with pagination if you need the middle.${curlHint})`
    : args.kind === "ok"
      ? `(Command completed in ${args.durationMs}ms. exit=0.)`
      : `(Command exited nonzero in ${args.durationMs}ms. Exit code: ${args.exitCode}.)`;
  return [header, exitLine, stdoutBlock, stderrBlock, hint].join("\n");
}

function looksLikeUrlFetchCommand(command: string): boolean {
  return /(^|[\s;&|()])(?:\.\/)?(?:curl|wget)(?=$|[\s;&|()])/.test(command);
}

export function formatTimeoutText(args: {
  command: string;
  stdout: string;
  stderr: string;
  reason: "inactivity timeout" | "wall-clock backstop";
  durationMs: number;
  partialBytes: number;
  logPath: string | null;
}): string {
  const header = `<command>${args.command}</command>`;
  const stdoutBlock = `<stdout>\n${args.stdout}\n</stdout>`;
  const stderrBlock = `<stderr>\n${args.stderr}\n</stderr>`;
  const logHint = args.logPath ? ` Full log: ${args.logPath}.` : "";
  const hint = `(Command hit ${args.reason} after ${args.durationMs}ms. ${args.partialBytes} bytes captured. Kill signal: SIGTERM then SIGKILL.${logHint} If the command is long-running, retry with background: true.)`;
  return [header, stdoutBlock, stderrBlock, hint].join("\n");
}

export function formatBackgroundStartedText(args: {
  command: string;
  jobId: string;
}): string {
  return [
    `<command>${args.command}</command>`,
    `<job_id>${args.jobId}</job_id>`,
    `(Background job started. Poll output with bash_output(job_id). Kill with bash_kill(job_id).)`,
  ].join("\n");
}

export function formatBashOutputText(args: {
  jobId: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sinceByte: number;
  returnedBytes: number;
  totalBytes: number;
}): string {
  const next = args.sinceByte + args.returnedBytes;
  return [
    `<job_id>${args.jobId}</job_id>`,
    `<running>${args.running}</running>`,
    `<exit_code>${args.exitCode === null ? "null" : args.exitCode}</exit_code>`,
    `<stdout>\n${args.stdout}\n</stdout>`,
    `<stderr>\n${args.stderr}\n</stderr>`,
    `(Showing bytes ${args.sinceByte}-${next} of ${args.totalBytes}. Next since_byte: ${next}. Job running: ${args.running}.)`,
  ].join("\n");
}

export function formatBashKillText(args: {
  jobId: string;
  signal: "SIGTERM" | "SIGKILL";
}): string {
  return `<job_id>${args.jobId}</job_id>\n(${args.signal} sent. Poll bash_output to confirm termination.)`;
}
