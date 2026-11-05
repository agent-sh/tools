//! Integration tests for the Rust LSP port. Mirrors the unit-test
//! surface from `packages/lsp/test/*.test.ts`.

use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_lsp::{
    lsp, LspClient, LspHoverResult, LspLocation, LspManifest, LspPermissionPolicy, LspResult,
    LspServerProfile, LspSessionConfig, LspSymbolInfo, Position1, ServerHandle, ServerState,
    StubBehavior, StubLspClient, StubResponses,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tempfile::TempDir;

fn mk_manifest(language: &str, exts: &[&str], cmd: &[&str]) -> LspManifest {
    let mut servers = HashMap::new();
    servers.insert(
        language.to_string(),
        LspServerProfile {
            language: language.to_string(),
            extensions: exts.iter().map(|s| s.to_string()).collect(),
            command: cmd.iter().map(|s| s.to_string()).collect(),
            root_patterns: None,
            initialization_options: None,
        },
    );
    LspManifest { servers }
}

fn mk_session(dir: &Path, client: Arc<dyn LspClient>) -> LspSessionConfig {
    let root = fs::canonicalize(dir).unwrap().to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    let lsp_perms = LspPermissionPolicy::new(perms).with_unsafe_bypass(true);
    let mut cfg = LspSessionConfig::new(root, lsp_perms, client);
    cfg.manifest = Some(mk_manifest("typescript", &[".ts"], &["stub-tsserver"]));
    cfg
}

fn write_file(dir: &Path, name: &str, content: &str) -> String {
    let p = dir.join(name);
    fs::write(&p, content).unwrap();
    fs::canonicalize(&p).unwrap().to_string_lossy().into_owned()
}

fn expect_error(r: &LspResult) -> &harness_lsp::LspError {
    match r {
        LspResult::Error(e) => e,
        other => panic!("expected error, got: {:?}", other),
    }
}

// ---- Schema / alias ----

#[tokio::test]
async fn rejects_alias_file_path() {
    let tmp = TempDir::new().unwrap();
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(json!({"operation": "hover", "file_path": "x", "line": 1, "character": 1}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("'path'"));
}

#[tokio::test]
async fn rejects_alias_row_col() {
    let tmp = TempDir::new().unwrap();
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(json!({"operation": "hover", "path": "x", "row": 1, "col": 1}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("'line'") || e.error.message.contains("'character'"));
}

#[tokio::test]
async fn hover_requires_position() {
    let tmp = TempDir::new().unwrap();
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(json!({"operation": "hover", "path": "x"}), &s).await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("requires 'line' and 'character'"));
}

#[tokio::test]
async fn workspace_symbol_requires_query() {
    let tmp = TempDir::new().unwrap();
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(json!({"operation": "workspaceSymbol"}), &s).await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("non-empty 'query'"));
}

#[tokio::test]
async fn rejects_line_zero() {
    let tmp = TempDir::new().unwrap();
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(
        json!({"operation": "hover", "path": "x", "line": 0, "character": 1}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("1-indexed"));
}

// ---- Fence + NOT_FOUND ----

#[tokio::test]
async fn reports_not_found_on_missing_file() {
    let tmp = TempDir::new().unwrap();
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let missing = tmp.path().join("ghost.ts").to_string_lossy().into_owned();
    let r = lsp(
        json!({"operation": "hover", "path": missing, "line": 1, "character": 1}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotFound);
}

#[tokio::test]
async fn outside_workspace_errors() {
    let tmp = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let outside_file = write_file(other.path(), "x.ts", "const a = 1;\n");
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub); // root is tmp; other is outside
    let r = lsp(
        json!({"operation": "hover", "path": outside_file, "line": 1, "character": 1}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OutsideWorkspace);
}

// ---- Manifest / profile ----

#[tokio::test]
async fn server_not_available_for_unknown_extension() {
    let tmp = TempDir::new().unwrap();
    let file = write_file(tmp.path(), "file.rs", "fn x(){}");
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub); // manifest only has .ts
    let r = lsp(
        json!({"operation": "hover", "path": file, "line": 1, "character": 1}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::ServerNotAvailable);
}

// ---- Server state ----

#[tokio::test]
async fn returns_server_starting_while_indexing() {
    let tmp = TempDir::new().unwrap();
    let file = write_file(tmp.path(), "x.ts", "const a = 1;\n");
    let stub = Arc::new(StubLspClient::new(StubBehavior {
        starting_calls: 2,
        ..StubBehavior::default()
    }));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(
        json!({"operation": "hover", "path": file, "line": 1, "character": 1}),
        &s,
    )
    .await;
    match r {
        LspResult::ServerStarting(ss) => {
            assert_eq!(ss.language, "typescript");
            assert!(ss.retry_ms > 0);
        }
        other => panic!("expected server_starting, got {:?}", other),
    }
}

// ---- Hover / no_results ----

#[tokio::test]
async fn hover_returns_no_results_on_empty() {
    let tmp = TempDir::new().unwrap();
    let file = write_file(tmp.path(), "x.ts", "const a = 1;\n");
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(
        json!({"operation": "hover", "path": file, "line": 1, "character": 1}),
        &s,
    )
    .await;
    match r {
        LspResult::NoResults(nr) => assert_eq!(nr.operation, harness_lsp::LspOperation::Hover),
        other => panic!("expected no_results, got {:?}", other),
    }
}

#[tokio::test]
async fn hover_happy_path() {
    let tmp = TempDir::new().unwrap();
    let file = write_file(tmp.path(), "x.ts", "const a = 1;\n");
    let responses = {
        let mut r = HashMap::new();
        r.insert(
            "typescript".to_string(),
            StubResponses {
                hover: Some(Arc::new(|_path, _pos| {
                    Some(LspHoverResult {
                        contents: "const a: number = 1".to_string(),
                        is_markdown: true,
                    })
                })),
                ..StubResponses::default()
            },
        );
        r
    };
    let stub = Arc::new(StubLspClient::new(StubBehavior {
        responses,
        ..StubBehavior::default()
    }));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(
        json!({"operation": "hover", "path": file, "line": 1, "character": 7}),
        &s,
    )
    .await;
    match r {
        LspResult::Hover(h) => {
            assert!(h.contents.contains("const a"));
            assert!(h.output.contains("<operation>hover</operation>"));
        }
        other => panic!("expected hover, got {:?}", other),
    }
}

// ---- References with head_limit truncation ----

#[tokio::test]
async fn references_truncates_and_reports_total() {
    let tmp = TempDir::new().unwrap();
    let file = write_file(tmp.path(), "x.ts", "const a = 1;\n");
    let file_clone = file.clone();
    let responses = {
        let mut r = HashMap::new();
        r.insert(
            "typescript".to_string(),
            StubResponses {
                references: Some(Arc::new(move |_path, _pos| {
                    (1..=250)
                        .map(|i| LspLocation {
                            path: file_clone.clone(),
                            line: i,
                            character: 1,
                            preview: format!("ref {}", i),
                        })
                        .collect()
                })),
                ..StubResponses::default()
            },
        );
        r
    };
    let stub = Arc::new(StubLspClient::new(StubBehavior {
        responses,
        ..StubBehavior::default()
    }));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(
        json!({"operation": "references", "path": file, "line": 1, "character": 7}),
        &s,
    )
    .await;
    match r {
        LspResult::References(rr) => {
            assert_eq!(rr.total, 250);
            assert!(rr.truncated);
            assert_eq!(rr.locations.len(), 200); // DEFAULT_HEAD_LIMIT
            assert!(rr.output.contains("Showing 200 of 250"));
        }
        other => panic!("expected references, got {:?}", other),
    }
}

// ---- documentSymbol tree ----

#[tokio::test]
async fn document_symbol_formats_tree() {
    let tmp = TempDir::new().unwrap();
    let file = write_file(tmp.path(), "x.ts", "class Foo {}\n");
    let responses = {
        let mut r = HashMap::new();
        r.insert(
            "typescript".to_string(),
            StubResponses {
                document_symbol: Some(Arc::new(|_path| {
                    vec![LspSymbolInfo {
                        name: "Foo".to_string(),
                        kind: "class".to_string(),
                        path: String::new(),
                        line: 1,
                        character: 7,
                        container_name: None,
                        children: Some(vec![LspSymbolInfo {
                            name: "bar".to_string(),
                            kind: "method".to_string(),
                            path: String::new(),
                            line: 2,
                            character: 3,
                            container_name: Some("Foo".to_string()),
                            children: None,
                        }]),
                    }]
                })),
                ..StubResponses::default()
            },
        );
        r
    };
    let stub = Arc::new(StubLspClient::new(StubBehavior {
        responses,
        ..StubBehavior::default()
    }));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(
        json!({"operation": "documentSymbol", "path": file}),
        &s,
    )
    .await;
    match r {
        LspResult::DocumentSymbol(ds) => {
            assert!(ds.output.contains("1: class Foo"));
            assert!(ds.output.contains("  2: method bar"));
        }
        other => panic!("expected documentSymbol, got {:?}", other),
    }
}

// ---- Permission fail-closed ----

#[tokio::test]
async fn fails_closed_without_hook_or_bypass() {
    let tmp = TempDir::new().unwrap();
    let file = write_file(tmp.path(), "x.ts", "const a = 1;\n");
    let root = fs::canonicalize(tmp.path()).unwrap().to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    let lsp_perms = LspPermissionPolicy::new(perms); // no bypass
    let stub: Arc<dyn LspClient> = Arc::new(StubLspClient::new(StubBehavior::default()));
    let mut cfg = LspSessionConfig::new(root, lsp_perms, stub);
    cfg.manifest = Some(mk_manifest("typescript", &[".ts"], &["stub"]));
    let r = lsp(
        json!({"operation": "hover", "path": file, "line": 1, "character": 1}),
        &cfg,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::PermissionDenied);
}

// ---- Serialization shape ----

#[tokio::test]
async fn error_result_serializes_with_kind_tag() {
    let tmp = TempDir::new().unwrap();
    let stub = Arc::new(StubLspClient::new(StubBehavior::default()));
    let s = mk_session(tmp.path(), stub);
    let r = lsp(json!({"operation": "hover"}), &s).await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|x| x.as_str()), Some("error"));
}

// ---- Unused handle state smoke ----

#[tokio::test]
async fn handle_state_ready_means_ready() {
    let h = ServerHandle {
        language: "x".to_string(),
        root: "/".to_string(),
        state: ServerState::Ready,
        instance: 1,
    };
    assert_eq!(h.state, ServerState::Ready);
    let v: Value = serde_json::to_value(&Position1 { line: 5, character: 10 }).unwrap();
    assert_eq!(v.get("line").and_then(|x| x.as_u64()), Some(5));
}
