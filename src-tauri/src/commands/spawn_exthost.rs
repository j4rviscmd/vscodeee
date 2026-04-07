/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri command to spawn an Extension Host sidecar and run the handshake.
//!
//! This is the WebView-facing entry point for Phase 0-2 PoC verification.
//! It creates a named pipe, spawns Node.js with the Extension Host, and
//! runs the Ready→InitData→Initialized handshake protocol.
//!
//! # TODO: Production (Phase 1-2)
//!
//! Replace this single command with a `SidecarManager` exposed via multiple
//! Tauri commands (`exthost_spawn`, `exthost_kill`, `exthost_status`) that
//! manage ExtHost lifecycle through Tauri managed state. The WebSocket relay
//! will replace direct Rust-side handshake handling.

use std::path::PathBuf;

use serde::Serialize;

/// Result of the Extension Host spawn + handshake operation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtHostHandshakeResult {
    /// Whether the handshake completed successfully.
    pub success: bool,
    /// The named pipe / Unix socket path used for communication.
    pub pipe_path: String,
    /// PID of the spawned Node.js Extension Host process.
    pub ext_host_pid: u32,
    /// Time taken for the handshake in milliseconds.
    pub handshake_duration_ms: u64,
    /// Human-readable log of each protocol message exchanged.
    pub messages_exchanged: Vec<String>,
    /// Error message if the handshake failed.
    pub error: Option<String>,
}

/// Spawn an Extension Host process as a Node.js sidecar and run the handshake.
///
/// Creates a named pipe, spawns `node out/bootstrap-fork.js --type=extensionHost`,
/// and executes the Ready→InitData→Initialized handshake protocol.
/// After a successful handshake, the ExtHost process is killed (PoC cleanup).
///
/// # Prerequisites
/// - `npm run compile` must have been run (populates `out/` directory)
/// - System `node` ≥ 18 must be on PATH
#[tauri::command]
pub async fn spawn_extension_host(
    app_handle: tauri::AppHandle,
) -> Result<ExtHostHandshakeResult, String> {
    #[cfg(not(unix))]
    {
        let _ = app_handle;
        return Err(
            "Extension Host sidecar is only supported on Unix (macOS/Linux) in the PoC.".into(),
        );
    }

    #[cfg(unix)]
    {
        spawn_extension_host_unix(app_handle).await
    }
}

#[cfg(unix)]
async fn spawn_extension_host_unix(
    app_handle: tauri::AppHandle,
) -> Result<ExtHostHandshakeResult, String> {
    let app_root = resolve_app_root(&app_handle)?;
    println!("[exthost] App root: {}", app_root.display());

    // Verify prerequisites
    let bootstrap_path = app_root.join("out/bootstrap-fork.js");
    if !bootstrap_path.exists() {
        return Err(format!(
            "out/bootstrap-fork.js not found at {}. Run `npm run compile` first.",
            bootstrap_path.display()
        ));
    }

    match spawn_and_handshake(&app_root).await {
        Ok(result) => Ok(result),
        Err(e) => Ok(ExtHostHandshakeResult {
            success: false,
            pipe_path: String::new(),
            ext_host_pid: 0,
            handshake_duration_ms: 0,
            messages_exchanged: vec![],
            error: Some(e.to_string()),
        }),
    }
}

#[cfg(unix)]
async fn spawn_and_handshake(
    app_root: &std::path::Path,
) -> Result<ExtHostHandshakeResult, crate::exthost::ExtHostError> {
    use crate::exthost;
    // Step 1+2: Create pipe + spawn Node.js
    let (mut sidecar, mut stream) = exthost::sidecar::spawn(app_root).await?;

    let pid = sidecar.child.id().unwrap_or(0);
    let pipe_path = sidecar.pipe_path.clone();

    // Step 3: Run handshake
    let handshake = exthost::handshake::run_handshake(&mut stream).await?;

    // PoC: Kill the child process after successful handshake and reap it
    // to avoid zombie processes.
    let _ = sidecar.child.kill().await;
    let _ = sidecar.child.wait().await;
    println!("[exthost] ExtHost process terminated (PoC cleanup)");

    Ok(ExtHostHandshakeResult {
        success: true,
        pipe_path,
        ext_host_pid: pid,
        handshake_duration_ms: handshake.duration_ms,
        messages_exchanged: handshake.messages,
        error: None,
    })
}

/// Resolve the VS Code repository root (where `out/` and `product.json` live).
///
/// In dev mode (`cargo tauri dev`), walks up from the resource directory to find
/// a directory containing `out/bootstrap-fork.js`. Falls back to CWD.
fn resolve_app_root(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {e}"))?;

    // Walk up from resource dir to find the repo root
    let mut candidate = resource_dir.as_path();
    for _ in 0..5 {
        if candidate.join("out/bootstrap-fork.js").exists() {
            return Ok(candidate.to_path_buf());
        }
        if let Some(parent) = candidate.parent() {
            candidate = parent;
        } else {
            break;
        }
    }

    // Fallback: try current working directory
    let cwd = std::env::current_dir().map_err(|e| format!("No CWD: {e}"))?;
    if cwd.join("out/bootstrap-fork.js").exists() {
        return Ok(cwd);
    }

    Err(format!(
        "Cannot find repo root with out/bootstrap-fork.js. Searched from: {}",
        resource_dir.display()
    ))
}
