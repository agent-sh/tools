use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::types::GrepOutputMode;

/// Parsed + validated input params. Mirrors `GrepParams` in TS — all
/// fields optional except `pattern`. The camelCase→snake_case rename at
/// the wire boundary is handled by serde `rename_all`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrepParams {
    pub pattern: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mode: Option<GrepOutputMode>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_insensitive: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiline: Option<bool>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_before: Option<usize>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_after: Option<usize>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<usize>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_limit: Option<usize>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
}

/// Errors produced by the parsing/validation layer. These always end up
/// as `INVALID_PARAM` with the `.message()` rendered into the tool error.
#[derive(Debug, Clone, thiserror::Error)]
pub enum GrepParseError {
    #[error("{0}")]
    Message(String),
}

/// Aliases we've observed models send when they meant a different
/// parameter. Mirrors the TS `KNOWN_PARAM_ALIASES` table — same coverage,
/// same wording so the LLM sees identical hints regardless of language
/// binding.
fn known_alias_hint(key: &str) -> Option<&'static str> {
    match key {
        "content" => Some(
            "unknown parameter 'content'. Did you mean 'context' (lines around a match)? If you wanted matching lines back, set output_mode: 'content' instead.",
        ),
        "regex" => Some("unknown parameter 'regex'. Use 'pattern' instead."),
        "query" => Some("unknown parameter 'query'. Use 'pattern' instead."),
        "mode" => Some("unknown parameter 'mode'. Use 'output_mode' instead."),
        "output" => Some("unknown parameter 'output'. Use 'output_mode' instead."),
        "filter" => Some("unknown parameter 'filter'. Use 'glob' or 'type' instead."),
        "file_type" => Some("unknown parameter 'file_type'. Use 'type' instead."),
        "glob_pattern" => Some("unknown parameter 'glob_pattern'. Use 'glob' instead."),
        "pattern_glob" => Some("unknown parameter 'pattern_glob'. Use 'glob' instead."),
        "ignore_case" => Some("unknown parameter 'ignore_case'. Use 'case_insensitive' instead."),
        "insensitive" => Some("unknown parameter 'insensitive'. Use 'case_insensitive' instead."),
        "cwd" => Some("unknown parameter 'cwd'. Use 'path' instead."),
        "dir" => Some("unknown parameter 'dir'. Use 'path' instead."),
        "directory" => Some("unknown parameter 'directory'. Use 'path' instead."),
        "max_results" => Some(
            "unknown parameter 'max_results'. Use 'head_limit' instead (default 250).",
        ),
        "max_count" => Some(
            "unknown parameter 'max_count'. Use 'head_limit' instead (default 250).",
        ),
        "limit" => Some("unknown parameter 'limit'. Use 'head_limit' instead (default 250)."),
        "skip" => Some("unknown parameter 'skip'. Use 'offset' instead."),
        "before" => Some("unknown parameter 'before'. Use 'context_before' instead."),
        "after" => Some("unknown parameter 'after'. Use 'context_after' instead."),
        _ => None,
    }
}

/// Accepted (canonical) field names. Any key not in this set AND not in
/// the alias table bubbles up as a generic `unknown field` error via
/// serde's `deny_unknown_fields`.
fn canonical_fields() -> HashSet<&'static str> {
    [
        "pattern",
        "path",
        "glob",
        "type",
        "output_mode",
        "case_insensitive",
        "multiline",
        "context_before",
        "context_after",
        "context",
        "head_limit",
        "offset",
    ]
    .into_iter()
    .collect()
}

pub fn safe_parse_grep_params(
    input: &Value,
) -> Result<GrepParams, GrepParseError> {
    // Pre-check: scan the input object for known aliases and return a
    // targeted hint rather than the generic `unknown field` serde error.
    if let Some(obj) = input.as_object() {
        let canonical = canonical_fields();
        let mut alias_hints: Vec<String> = Vec::new();
        let mut unknown_unhinted: Vec<String> = Vec::new();
        for key in obj.keys() {
            if canonical.contains(key.as_str()) {
                continue;
            }
            if let Some(hint) = known_alias_hint(key.as_str()) {
                alias_hints.push(hint.to_string());
            } else {
                unknown_unhinted.push(format!("unknown parameter '{}'.", key));
            }
        }
        if !alias_hints.is_empty() || !unknown_unhinted.is_empty() {
            let mut msgs = alias_hints;
            msgs.extend(unknown_unhinted);
            return Err(GrepParseError::Message(msgs.join("; ")));
        }
    }

    // Delegate to serde for type/value validation.
    let parsed: GrepParams = serde_json::from_value(input.clone())
        .map_err(|e| GrepParseError::Message(normalize_serde_error(&e.to_string())))?;

    // Minimal post-parse invariants.
    if parsed.pattern.is_empty() {
        return Err(GrepParseError::Message("pattern is required".to_string()));
    }
    if let Some(hl) = parsed.head_limit {
        if hl == 0 {
            return Err(GrepParseError::Message(
                "head_limit must be >= 1".to_string(),
            ));
        }
    }
    Ok(parsed)
}

pub fn parse_grep_params(input: &Value) -> Result<GrepParams, GrepParseError> {
    safe_parse_grep_params(input)
}

/// Rust's serde errors on enum mismatch look like `unknown variant
/// `foo`, expected one of ...`. Rewrite to the wording the TS tool
/// emits so models don't have to learn a second dialect.
fn normalize_serde_error(msg: &str) -> String {
    if msg.contains("unknown variant")
        && msg.contains("output_mode")
        && msg.contains("files_with_matches")
    {
        return "output_mode must be one of: files_with_matches, content, count".to_string();
    }
    msg.to_string()
}

// ---- Tool definition strings (for MCP / OpenAI function-schema wiring) ----

pub const GREP_TOOL_NAME: &str = "grep";

pub const GREP_TOOL_DESCRIPTION: &str =
    "Search file contents with a ripgrep-compatible regex and return structured results.\n\n\
    Choose the output mode before writing the pattern:\n\
    - Discovery starts with files_with_matches (the default) or count. This applies even when locating a definition rather than a call. Put the distinguishing syntax in the pattern, e.g. pattern: \"function\\\\s+handleRequest\\\\b\", output_mode: \"files_with_matches\". Inspect matching lines in a follow-up only if needed.\n\
    - Existence and file-count questions end with the paths/counts. Match comment syntax in the pattern when asked about comments, e.g. pattern: \"//.*TODO\", output_mode: \"count\". Count the returned files. Do not fetch content just to quote examples the user did not request.\n\
    - Use content for a request to show matching lines or surrounding code. Keep context small.\n\n\
    Usage:\n\
    - pattern is required. Regex syntax is ripgrep's (Rust regex). Escape literal metacharacters: use 'interface\\\\{\\\\}' to match 'interface{}'. '.' does not match newlines unless multiline: true.\n\
    - path defaults to the session cwd. Absolute paths preferred; relative paths resolve against cwd.\n\
    - Filter by the 'glob' parameter (e.g. '*.ts', '*.{js,tsx}') or by 'type' (e.g. 'js', 'py', 'rust'). 'type' takes ONE name only — for multiple extensions, use 'glob' with a brace list like '*.{ts,tsx,js}'. 'type' is more efficient for standard languages.\n\
    - Default output_mode is 'files_with_matches' — cheap path-only results. Use this first to decide whether to pay for content.\n\
    - output_mode 'content' returns matching lines grouped by file, newest-first. Context lines come from context_before / context_after / context (-C sets both). Context is only valid with content mode.\n\
    - output_mode 'count' returns per-file match counts, alphabetical path order.\n\
    - Results are capped at head_limit (default 250). Use offset to page: next_offset = previous_offset + returned_count.\n\
    - .gitignore, .ignore, and .rgignore are respected. Hidden files are skipped. node_modules, .git, and other ignored paths will not appear.\n\
    - Binary files are skipped. Files larger than 5 MB are skipped.\n\
    - Call in parallel for independent searches. Prefer this tool over Bash(grep/rg).";
