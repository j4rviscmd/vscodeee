/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Named pipe creation and Node.js Extension Host process spawning.
//!
//! Replicates the pattern from `src/vs/server/node/extensionHostConnection.ts:247-335`:
//! 1. Create Unix domain socket server (`_listenOnPipe()`)
//! 2. Spawn `node out/bootstrap-fork.js --type=extensionHost` with correct env vars
//! 3. Wait for the ExtHost to connect back to our socket
//!
//! # TODO: Production (Phase 1-2)
//!
//! Replace this with a `SidecarManager` that:
//! - Manages multiple ExtHost instances (multi-window support)
//! - Tracks state via a state machine (Starting→PipeReady→Connected→Running→Stopped)
//! - Supports bundled Node.js binary (not just system `node`)
//! - Integrates with Tauri managed state for WebView access

use std::path::Path;

use tokio::net::UnixListener;
use tokio::process::{Child, Command};

use super::ExtHostError;

/// A running Extension Host sidecar process with its named pipe path.
pub struct ExtHostSidecar {
    pub child: Child,
    pub pipe_path: String,
}

impl Drop for ExtHostSidecar {
    fn drop(&mut self) {
        // Best-effort cleanup of the socket file
        let _ = std::fs::remove_file(&self.pipe_path);
    }
}

/// Create a Unix domain socket path matching VS Code's convention.
///
/// Mirrors `createRandomIPCHandle()` at `ipc.net.ts:889-904`.
/// macOS has a 104-char limit for socket paths; UUID-based paths in /tmp/
/// are ~55 chars, well within that limit.
fn create_random_ipc_handle() -> String {
    let id = uuid::Uuid::new_v4();
    if cfg!(windows) {
        format!("\\\\.\\pipe\\vscode-ipc-{id}-sock")
    } else {
        format!("{}/vscode-ipc-{id}.sock", std::env::temp_dir().display())
    }
}

/// Spawn the Extension Host as a Node.js sidecar, returning the connected stream.
///
/// This replicates the pattern from `extensionHostConnection.ts:247-327`:
/// 1. Create Unix domain socket server
/// 2. Spawn `node out/bootstrap-fork.js --type=extensionHost`
/// 3. Wait for the ExtHost to connect back to our socket (30s timeout)
///
/// # Arguments
/// * `app_root` — Repository root containing `out/bootstrap-fork.js` and `product.json`
///
/// # Returns
/// A tuple of the sidecar handle and the connected Unix stream.
pub async fn spawn(
    app_root: &Path,
) -> Result<(ExtHostSidecar, tokio::net::UnixStream), ExtHostError> {
    let pipe_path = create_random_ipc_handle();

    // Step 1: Create the Unix domain socket server
    // Mirrors _listenOnPipe() at extensionHostConnection.ts:337-348
    let listener = UnixListener::bind(&pipe_path).map_err(ExtHostError::PipeCreation)?;

    log::info!(target: "vscodeee::exthost::sidecar", "Listening on pipe: {pipe_path}");

    // Step 2: Spawn the Node.js process
    // If spawn or accept fails, clean up the socket file before returning.
    let result = spawn_and_connect(app_root, &pipe_path, &listener).await;
    if result.is_err() {
        let _ = std::fs::remove_file(&pipe_path);
    }
    // Drop the listener — we only need one connection
    drop(listener);

    result
}

async fn spawn_and_connect(
    app_root: &Path,
    pipe_path: &str,
    listener: &UnixListener,
) -> Result<(ExtHostSidecar, tokio::net::UnixStream), ExtHostError> {
    // Mirrors extensionHostConnection.ts:272-288
    let node_bin = "node"; // PoC: use system node

    let child = Command::new(node_bin)
        .arg("--dns-result-order=ipv4first")
        .arg("out/bootstrap-fork.js")
        .arg("--type=extensionHost")
        .current_dir(app_root)
        .env("VSCODE_EXTHOST_IPC_HOOK", pipe_path)
        .env(
            "VSCODE_ESM_ENTRYPOINT",
            "vs/workbench/api/node/extensionHostProcess",
        )
        .env("VSCODE_HANDLES_UNCAUGHT_ERRORS", "true")
        .env("VSCODE_PARENT_PID", std::process::id().to_string())
        .env("VSCODE_DEV", "1")
        .env(
            "VSCODE_NLS_CONFIG",
            r#"{"locale":"en","osLocale":"en","availableLanguages":{}}"#,
        )
        // NOT set (selecting wrong transport):
        // VSCODE_WILL_SEND_MESSAGE_PORT — Electron MessagePort path
        // VSCODE_EXTHOST_WILL_SEND_SOCKET — process.send() socket path
        // PoC: inherit stdio so ExtHost output goes to Tauri console.
        // Without reading piped stdout/stderr, the pipe buffer could fill up
        // and block the child process, causing deadlock.
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(ExtHostError::Spawn)?;

    let pid = child.id().unwrap_or(0);
    log::info!(target: "vscodeee::exthost::sidecar", "Spawned Node.js ExtHost process (PID: {pid})");

    // Step 3: Wait for the ExtHost to connect back (30s timeout)
    // Mirrors extensionHostConnection.ts:313-316
    let timeout = tokio::time::Duration::from_secs(30);
    let (stream, _addr) = tokio::time::timeout(timeout, listener.accept())
        .await
        .map_err(|_| ExtHostError::Timeout)?
        .map_err(ExtHostError::PipeCreation)?;

    log::info!(target: "vscodeee::exthost::sidecar", "ExtHost connected to pipe");

    let sidecar = ExtHostSidecar {
        child,
        pipe_path: pipe_path.to_owned(),
    };
    Ok((sidecar, stream))
}
