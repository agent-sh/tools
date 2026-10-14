pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
pub const MIN_TIMEOUT_MS: u64 = 2_000;
pub const SESSION_BACKSTOP_MS: u64 = 30_000;

pub const DEFAULT_COUNT: usize = 5;
pub const MIN_COUNT: usize = 1;
pub const MAX_COUNT: usize = 20;

pub const DEFAULT_LANGUAGE: &str = "auto";
pub const DEFAULT_CATEGORIES: &[&str] = &["general"];

pub const MAX_QUERY_LENGTH: usize = 512;
pub const SNIPPET_CAP: usize = 240; // per-result snippet trim (default; session-tunable)
pub const MIN_SNIPPET_CAP: usize = 80;
pub const MAX_SNIPPET_CAP: usize = 600;

/// Default User-Agent. Harnesses can override via session.default_headers.
/// Identifies as an agent tool with a contact URL — verified accepted (no
/// anti-bot challenge) by Mojeek and the MediaWiki API.
pub const DEFAULT_USER_AGENT: &str =
    "agent-sh-harness-websearch/0.2.0 (+https://github.com/agent-sh/tools)";
