/**
 * The language server died, or lost a pipe, while a call was using it.
 * The `lsp` tool reports it as SERVER_CRASHED for that call; the next call
 * starts a new server. Any LspClient adapter may throw it.
 */
export class LspServerCrashedError extends Error {
  override readonly name: string = "LspServerCrashedError";

  constructor(
    readonly language: string,
    /** What happened, as one sentence. */
    summary: string,
    /** Last bytes the server wrote to stderr, bounded; empty when none. */
    readonly stderrTail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `${summary} The next call starts it again.` +
        (stderrTail ? `\nLast stderr output:\n${stderrTail}` : ""),
      options,
    );
  }
}

/** The language-server process exited while a call was waiting on it. */
export class LspServerExitedError extends LspServerCrashedError {
  override readonly name: string = "LspServerExitedError";

  constructor(
    language: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    stderrTail: string,
  ) {
    const how =
      signal !== null ? `was killed by ${signal}` : `exited with code ${exitCode}`;
    super(language, `Language server for ${language} ${how}.`, stderrTail);
  }
}
