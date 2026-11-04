/**
 * The language-server process exited while a request or the startup
 * handshake was waiting on it. The `lsp` tool reports it as
 * SERVER_CRASHED for the call that saw it; the next call starts a new
 * server. Any LspClient adapter may throw it.
 */
export class LspServerExitedError extends Error {
  override readonly name = "LspServerExitedError";

  constructor(
    readonly language: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    /** Last bytes the server wrote to stderr, bounded; empty when none. */
    readonly stderrTail: string,
  ) {
    const how =
      signal !== null ? `was killed by ${signal}` : `exited with code ${exitCode}`;
    super(
      `Language server for ${language} ${how}. The next call starts it again.` +
        (stderrTail ? `\nLast stderr output:\n${stderrTail}` : ""),
    );
  }
}
