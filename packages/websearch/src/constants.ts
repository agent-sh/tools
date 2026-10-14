export const DEFAULT_TIMEOUT_MS = 15_000;
export const MIN_TIMEOUT_MS = 2_000;
export const SESSION_BACKSTOP_MS = 30_000;

export const DEFAULT_COUNT = 5;
export const MIN_COUNT = 1;
export const MAX_COUNT = 20;

export const DEFAULT_TIME_RANGE = "all" as const;
export const DEFAULT_LANGUAGE = "auto";
export const DEFAULT_SAFE_SEARCH = "moderate" as const;
export const DEFAULT_CATEGORIES: readonly string[] = ["general"];

export const MAX_QUERY_LENGTH = 512;
export const SNIPPET_CAP = 240; // per-result snippet trim (default; session-tunable)
export const MIN_SNIPPET_CAP = 80;
export const MAX_SNIPPET_CAP = 600;

/**
 * Default User-Agent. Harnesses can override via session.defaultHeaders.
 * We deliberately identify as an agent tool with a contact URL — backends
 * that want to gate bots can do so cleanly, and Wikipedia's API etiquette
 * asks for a descriptive UA. Verified to be accepted (no anti-bot challenge)
 * by Mojeek and the MediaWiki API.
 */
export const DEFAULT_USER_AGENT =
  "agent-sh-harness-websearch/0.4.0 (+https://github.com/agent-sh/tools)";
