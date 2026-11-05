use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use crate::constants::{
    DEFAULT_HEAD_LIMIT, DEFAULT_TIMEOUT_MS, MAX_HOVER_MARKDOWN_BYTES, MAX_PREVIEW_LINE_LENGTH,
    SERVER_STARTING_RETRY_BASE_MS, SERVER_STARTING_RETRY_MAX_MS, SESSION_BACKSTOP_MS,
};
use crate::fence::{ask_permission, fence_lsp, AskArgs, PermissionOutcome};
use crate::format::{
    cap_hover_markdown, cap_preview, format_document_symbols, format_hover, format_locations,
    format_no_results, format_server_starting, format_workspace_symbols, no_results_hint,
    FormatDocSymbolsArgs, FormatHoverArgs, FormatLocationsArgs, FormatNoResultsArgs,
    FormatServerStartingArgs, FormatWorkspaceSymbolsArgs,
};
use crate::manifest::{find_lsp_root, load_manifest, profile_for_path};
use crate::schema::safe_parse_lsp_params;
use crate::types::{
    LspClientError, LspDefinitionOk, LspDocumentSymbolOk, LspError, LspHoverOk,
    LspImplementationOk, LspLocation, LspManifest, LspNoResults, LspOperation, LspReferencesOk,
    LspResult, LspServerProfile, LspServerStarting, LspSessionConfig, LspSymbolInfo,
    LspWorkspaceSymbolOk, Position1, ServerState,
};

fn err(error: ToolError) -> LspResult {
    LspResult::Error(LspError { error })
}

pub async fn lsp(input: Value, session: &LspSessionConfig) -> LspResult {
    let params = match safe_parse_lsp_params(&input) {
        Ok(p) => p,
        Err(e) => return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    let resolved_path = resolve_path_opt(&session.cwd, params.path.as_deref()).await;

    if let Some(p) = &resolved_path {
        match tokio::fs::metadata(p).await {
            Ok(m) => {
                if m.is_dir() {
                    return err(ToolError::new(
                        ToolErrorCode::InvalidParam,
                        format!(
                            "LSP operations need a file, not a directory: {}",
                            p.display()
                        ),
                    )
                    .with_meta(serde_json::json!({ "path": p.display().to_string() })));
                }
            }
            Err(_) => {
                return err(ToolError::new(
                    ToolErrorCode::NotFound,
                    format!("File does not exist: {}", p.display()),
                )
                .with_meta(serde_json::json!({ "path": p.display().to_string() })));
            }
        }
    }

    if let Some(e) = fence_lsp(session, resolved_path.as_deref()) {
        return err(e);
    }

    // Manifest
    let manifest: Option<LspManifest> = if session.manifest.is_some() {
        session.manifest.clone()
    } else {
        match load_manifest(session.manifest_path.as_deref(), &session.cwd).await {
            Ok(m) => m,
            Err(e) => {
                return err(ToolError::new(
                    ToolErrorCode::IoError,
                    format!("Failed to load .lsp.json manifest: {}", e),
                ));
            }
        }
    };

    let (profile, language): (Option<LspServerProfile>, Option<String>) =
        if params.operation == LspOperation::WorkspaceSymbol {
            if let Some(m) = &manifest {
                if let Some(first) = m.servers.values().next() {
                    (Some(first.clone()), Some(first.language.clone()))
                } else {
                    (None, None)
                }
            } else {
                (None, None)
            }
        } else if let Some(p) = resolved_path.as_ref() {
            let prof = profile_for_path(&p.to_string_lossy(), manifest.as_ref());
            let lang = prof.as_ref().map(|x| x.language.clone());
            (prof, lang)
        } else {
            (None, None)
        };

    let Some(profile) = profile else {
        let ext = resolved_path
            .as_ref()
            .map(|p| {
                Path::new(&*p.to_string_lossy())
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| format!(".{}", s))
                    .unwrap_or_else(|| "(no extension)".to_string())
            })
            .unwrap_or_else(|| "(no path)".to_string());
        let hint = if resolved_path.is_some() {
            format!(
                "No language server configured for {}. Configure one in .lsp.json at your workspace root (or session.manifest).",
                ext
            )
        } else {
            "workspaceSymbol needs at least one server in .lsp.json to pick a primary language."
                .to_string()
        };
        return err(
            ToolError::new(ToolErrorCode::ServerNotAvailable, hint).with_meta(serde_json::json!({
                "extension": ext,
                "path": resolved_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            })),
        );
    };

    // Permission hook
    let path_str_opt = resolved_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let ask = AskArgs {
        operation: params.operation,
        path: path_str_opt.as_deref(),
        language: language.as_deref(),
        line: params.line,
        character: params.character,
        query: params.query.as_deref(),
    };
    match ask_permission(session, ask).await {
        PermissionOutcome::Allow => {}
        PermissionOutcome::Deny { reason } => {
            return err(
                ToolError::new(ToolErrorCode::PermissionDenied, reason).with_meta(
                    serde_json::json!({
                        "operation": params.operation.as_str(),
                        "path": path_str_opt,
                    }),
                ),
            );
        }
    }

    // Resolve LSP root + ensure server
    let lsp_root = match resolved_path.as_ref() {
        Some(p) => find_lsp_root(&p.to_string_lossy(), &profile, &session.cwd).await,
        None => session.cwd.clone(),
    };

    // One budget for the whole call, starting the server included
    // (design spec section 8).
    let timeout_ms = session.default_timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let backstop_ms = session.session_backstop_ms.unwrap_or(SESSION_BACKSTOP_MS);
    let effective_timeout = timeout_ms.min(backstop_ms);
    if session.signal.as_ref().is_some_and(|s| *s.borrow()) {
        return err(ToolError::new(
            ToolErrorCode::Timeout,
            format!(
                "LSP {} was cancelled before it started. Nothing was sent to the {} server.",
                params.operation.as_str(),
                profile.language
            ),
        ));
    }
    let (cancel_tx, cancel_rx) = watch::channel(false);
    // Tell our own timeout apart from the caller cancelling, for the message.
    let timed_out = AtomicBool::new(false);
    let ctx = CallCtx {
        op: params.operation,
        budget_ms: effective_timeout,
        timed_out: &timed_out,
    };

    let whole = async {
        let handle = match session
            .client
            .ensure_server(&profile.language, &lsp_root, &profile, cancel_rx.clone())
            .await
        {
            Ok(h) => h,
            Err(e) => return Outcome::StartFailed(e),
        };
        if handle.state == ServerState::Starting {
            return Outcome::Starting;
        }
        let handle = &handle;
        Outcome::Done(match params.operation {
            LspOperation::Hover => {
                let path = resolved_path.as_ref().unwrap();
                let pos = Position1 {
                    line: params.line.unwrap(),
                    character: params.character.unwrap(),
                };
                run_hover(session, handle, path, pos, cancel_rx.clone(), &ctx).await
            }
            LspOperation::Definition => {
                let path = resolved_path.as_ref().unwrap();
                let pos = Position1 {
                    line: params.line.unwrap(),
                    character: params.character.unwrap(),
                };
                run_locations_op(
                    LspOperation::Definition,
                    session,
                    handle,
                    path,
                    pos,
                    cancel_rx.clone(),
                    &ctx,
                )
                .await
            }
            LspOperation::References => {
                let path = resolved_path.as_ref().unwrap();
                let pos = Position1 {
                    line: params.line.unwrap(),
                    character: params.character.unwrap(),
                };
                run_locations_op(
                    LspOperation::References,
                    session,
                    handle,
                    path,
                    pos,
                    cancel_rx.clone(),
                    &ctx,
                )
                .await
            }
            LspOperation::Implementation => {
                let path = resolved_path.as_ref().unwrap();
                let pos = Position1 {
                    line: params.line.unwrap(),
                    character: params.character.unwrap(),
                };
                run_locations_op(
                    LspOperation::Implementation,
                    session,
                    handle,
                    path,
                    pos,
                    cancel_rx.clone(),
                    &ctx,
                )
                .await
            }
            LspOperation::DocumentSymbol => {
                let path = resolved_path.as_ref().unwrap();
                run_document_symbol(session, handle, path, cancel_rx.clone(), &ctx).await
            }
            LspOperation::WorkspaceSymbol => {
                let query = params.query.as_deref().unwrap();
                let head_limit = params
                    .head_limit
                    .unwrap_or(session.default_head_limit.unwrap_or(DEFAULT_HEAD_LIMIT));
                run_workspace_symbol(session, handle, query, head_limit, cancel_rx.clone(), &ctx)
                    .await
            }
        })
    };
    tokio::pin!(whole);
    let session_cancelled = async {
        match session.signal.clone() {
            Some(mut s) => {
                if s.wait_for(|c| *c).await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
            None => std::future::pending::<()>().await,
        }
    };
    // On a timeout or a cancel, signal the call and let it wind down on its
    // own, so no write is cut off midway.
    let outcome = tokio::select! {
        o = &mut whole => o,
        _ = tokio::time::sleep(Duration::from_millis(effective_timeout)) => {
            timed_out.store(true, Ordering::SeqCst);
            let _ = cancel_tx.send(true);
            (&mut whole).await
        }
        _ = session_cancelled => {
            let _ = cancel_tx.send(true);
            (&mut whole).await
        }
    };

    match outcome {
        Outcome::Done(r) => r,
        Outcome::Starting => {
            let retry_ms = compute_retry_ms(session, &profile.language).await;
            LspResult::ServerStarting(LspServerStarting {
                output: format_server_starting(FormatServerStartingArgs {
                    operation: params.operation,
                    language: &profile.language,
                    retry_ms,
                }),
                language: profile.language.clone(),
                retry_ms,
            })
        }
        Outcome::StartFailed(LspClientError::Aborted) => err(ToolError::new(
            ToolErrorCode::Timeout,
            if timed_out.load(Ordering::SeqCst) {
                format!(
                    "LSP {} exceeded {}ms while the {} server was starting. The start goes on in the background; retry.",
                    params.operation.as_str(),
                    effective_timeout,
                    profile.language
                )
            } else {
                format!(
                    "LSP {} was cancelled while the {} server was starting. The start goes on in the background.",
                    params.operation.as_str(),
                    profile.language
                )
            },
        )),
        Outcome::StartFailed(e) => err(ToolError::new(
            ToolErrorCode::ServerNotAvailable,
            format!("Failed to start {} server: {}", profile.language, e),
        )),
    }
}

enum Outcome {
    StartFailed(LspClientError),
    Starting,
    Done(LspResult),
}

/// What an operation's error mapping needs to know about the call.
struct CallCtx<'a> {
    op: LspOperation,
    budget_ms: u64,
    timed_out: &'a AtomicBool,
}

async fn run_hover(
    session: &LspSessionConfig,
    handle: &crate::types::ServerHandle,
    path: &Path,
    pos: Position1,
    cancel: crate::types::CancelSignal,
    ctx: &CallCtx<'_>,
) -> LspResult {
    let res = match session
        .client
        .hover(handle, &path.to_string_lossy(), pos, cancel)
        .await
    {
        Ok(r) => r,
        Err(e) => return translate_client_error(e, ctx),
    };
    let hover = match res {
        Some(h) if !h.contents.trim().is_empty() => h,
        _ => {
            return LspResult::NoResults(LspNoResults {
                output: format_no_results(FormatNoResultsArgs {
                    operation: LspOperation::Hover,
                    hint: no_results_hint(LspOperation::Hover),
                }),
                operation: LspOperation::Hover,
            });
        }
    };
    let cap = session
        .max_hover_markdown_bytes
        .unwrap_or(MAX_HOVER_MARKDOWN_BYTES);
    let (contents, _) = cap_hover_markdown(&hover.contents, cap);
    LspResult::Hover(LspHoverOk {
        output: format_hover(FormatHoverArgs {
            path: &path.to_string_lossy(),
            line: pos.line,
            character: pos.character,
            contents: &contents,
        }),
        path: path.to_string_lossy().into_owned(),
        line: pos.line,
        character: pos.character,
        contents,
        is_markdown: hover.is_markdown,
    })
}

async fn run_locations_op(
    op: LspOperation,
    session: &LspSessionConfig,
    handle: &crate::types::ServerHandle,
    path: &Path,
    pos: Position1,
    cancel: crate::types::CancelSignal,
    ctx: &CallCtx<'_>,
) -> LspResult {
    let path_str = path.to_string_lossy();
    let raw_res = match op {
        LspOperation::Definition => {
            session
                .client
                .definition(handle, &path_str, pos, cancel)
                .await
        }
        LspOperation::References => {
            session
                .client
                .references(handle, &path_str, pos, cancel)
                .await
        }
        LspOperation::Implementation => {
            session
                .client
                .implementation(handle, &path_str, pos, cancel)
                .await
        }
        _ => unreachable!(),
    };
    let raw = match raw_res {
        Ok(v) => v,
        Err(e) => return translate_client_error(e, ctx),
    };
    if raw.is_empty() {
        return LspResult::NoResults(LspNoResults {
            output: format_no_results(FormatNoResultsArgs {
                operation: op,
                hint: no_results_hint(op),
            }),
            operation: op,
        });
    }
    let preview_cap = session
        .max_preview_line_length
        .unwrap_or(MAX_PREVIEW_LINE_LENGTH);
    let mut capped: Vec<LspLocation> = raw
        .into_iter()
        .map(|l| LspLocation {
            preview: cap_preview(&l.preview, preview_cap),
            ..l
        })
        .collect();
    capped.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then_with(|| a.line.cmp(&b.line))
            .then_with(|| a.character.cmp(&b.character))
    });
    let head_limit = session.default_head_limit.unwrap_or(DEFAULT_HEAD_LIMIT);
    let truncated = capped.len() > head_limit;
    let total = capped.len();
    let window: Vec<LspLocation> = if truncated {
        capped.into_iter().take(head_limit).collect()
    } else {
        capped
    };

    let output = format_locations(FormatLocationsArgs {
        operation: op,
        path: &path_str,
        line: pos.line,
        character: pos.character,
        locations: &window,
        total: if truncated { Some(total) } else { None },
        truncated,
    });

    match op {
        LspOperation::References => LspResult::References(LspReferencesOk {
            output,
            path: path_str.into_owned(),
            line: pos.line,
            character: pos.character,
            locations: window,
            total,
            truncated,
        }),
        LspOperation::Implementation => LspResult::Implementation(LspImplementationOk {
            output,
            path: path_str.into_owned(),
            line: pos.line,
            character: pos.character,
            locations: window,
        }),
        LspOperation::Definition => LspResult::Definition(LspDefinitionOk {
            output,
            path: path_str.into_owned(),
            line: pos.line,
            character: pos.character,
            locations: window,
        }),
        _ => unreachable!(),
    }
}

async fn run_document_symbol(
    session: &LspSessionConfig,
    handle: &crate::types::ServerHandle,
    path: &Path,
    cancel: crate::types::CancelSignal,
    ctx: &CallCtx<'_>,
) -> LspResult {
    let path_str = path.to_string_lossy().into_owned();
    let symbols = match session
        .client
        .document_symbol(handle, &path_str, cancel)
        .await
    {
        Ok(v) => v,
        Err(e) => return translate_client_error(e, ctx),
    };
    if symbols.is_empty() {
        return LspResult::NoResults(LspNoResults {
            output: format_no_results(FormatNoResultsArgs {
                operation: LspOperation::DocumentSymbol,
                hint: no_results_hint(LspOperation::DocumentSymbol),
            }),
            operation: LspOperation::DocumentSymbol,
        });
    }
    LspResult::DocumentSymbol(LspDocumentSymbolOk {
        output: format_document_symbols(FormatDocSymbolsArgs {
            path: &path_str,
            symbols: &symbols,
        }),
        path: path_str,
        symbols,
    })
}

async fn run_workspace_symbol(
    session: &LspSessionConfig,
    handle: &crate::types::ServerHandle,
    query: &str,
    head_limit: usize,
    cancel: crate::types::CancelSignal,
    ctx: &CallCtx<'_>,
) -> LspResult {
    let symbols = match session.client.workspace_symbol(handle, query, cancel).await {
        Ok(v) => v,
        Err(e) => return translate_client_error(e, ctx),
    };
    if symbols.is_empty() {
        return LspResult::NoResults(LspNoResults {
            output: format_no_results(FormatNoResultsArgs {
                operation: LspOperation::WorkspaceSymbol,
                hint: no_results_hint(LspOperation::WorkspaceSymbol),
            }),
            operation: LspOperation::WorkspaceSymbol,
        });
    }
    let truncated = symbols.len() > head_limit;
    let total = symbols.len();
    let window: Vec<LspSymbolInfo> = if truncated {
        symbols.into_iter().take(head_limit).collect()
    } else {
        symbols
    };
    LspResult::WorkspaceSymbol(LspWorkspaceSymbolOk {
        output: format_workspace_symbols(FormatWorkspaceSymbolsArgs {
            query,
            symbols: &window,
            total,
            truncated,
        }),
        query: query.to_string(),
        symbols: window,
        total,
        truncated,
    })
}

async fn resolve_path_opt(cwd: &str, input: Option<&str>) -> Option<PathBuf> {
    let input = input?;
    let abs: PathBuf = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        Path::new(cwd).join(input)
    };
    let canonical = tokio::fs::canonicalize(&abs).await.unwrap_or(abs);
    Some(canonical)
}

async fn compute_retry_ms(session: &LspSessionConfig, language: &str) -> u64 {
    let mut counter = session.retry_counter.lock().await;
    let prior = counter.get(language).copied().unwrap_or(0);
    counter.insert(language.to_string(), prior + 1);
    let base = SERVER_STARTING_RETRY_BASE_MS;
    let cap = SERVER_STARTING_RETRY_MAX_MS;
    let next = base.saturating_mul(1u64 << prior.min(8));
    next.min(cap)
}

fn translate_client_error(e: LspClientError, ctx: &CallCtx<'_>) -> LspResult {
    let msg = match e {
        LspClientError::Aborted => {
            let message = if ctx.timed_out.load(Ordering::SeqCst) {
                format!("LSP {} exceeded {}ms.", ctx.op.as_str(), ctx.budget_ms)
            } else {
                format!("LSP {} was cancelled.", ctx.op.as_str())
            };
            return err(ToolError::new(ToolErrorCode::Timeout, message));
        }
        LspClientError::Crashed(message) => {
            return err(ToolError::new(ToolErrorCode::ServerCrashed, message));
        }
        LspClientError::Other(msg) => msg,
    };
    let lower = msg.to_lowercase();
    if lower.contains("position") && (lower.contains("invalid") || lower.contains("out of range")) {
        return err(ToolError::new(ToolErrorCode::PositionInvalid, msg));
    }
    err(ToolError::new(
        ToolErrorCode::IoError,
        format!("LSP error: {}", msg),
    ))
}

// Unused re-exports silencers.
#[allow(dead_code)]
fn _unused_arc(_: Arc<()>) {}
