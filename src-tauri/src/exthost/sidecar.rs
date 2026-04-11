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

/// Build an enriched PATH for the Extension Host child process.
///
/// macOS app bundles inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
/// because launchd does not source shell profiles. Tools like `git` are
/// commonly installed in `/opt/homebrew/bin` (Apple Silicon), `/usr/local/bin`
/// (Intel Homebrew / manual install), or via Xcode CLT at `/usr/bin`.
///
/// This function takes the current process's PATH and prepends any
/// well-known directories that are missing, so that child processes
/// (in particular the `git` extension calling `which git`) can find them.
fn build_exthost_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let existing: std::collections::HashSet<&str> = current.split(':').collect();

    // Well-known directories where git and other developer tools live.
    // Order matters: higher-priority directories come first.
    let extra_dirs: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin",  // Apple Silicon Homebrew
            "/opt/homebrew/sbin",
            "/usr/local/bin",    // Intel Homebrew / manual installs
            "/usr/local/sbin",
        ]
    } else {
        // Linux: /usr/local/bin is the most common extra location
        &["/usr/local/bin", "/usr/local/sbin"]
    };

    let mut parts: Vec<&str> = Vec::new();
    for dir in extra_dirs {
        if !existing.contains(dir) {
            parts.push(dir);
        }
    }

    if parts.is_empty() {
        current
    } else {
        // Prepend extra dirs so they take priority
        parts.push(&current);
        parts.join(":")
    }
}

/// A running Extension Host sidecar process with its named pipe path.
///
/// Owns the child process handle and the socket path. When dropped,
/// the Unix socket file is cleaned up via [`Drop`].
pub struct ExtHostSidecar {
    /// Handle to the spawned Node.js child process.
    pub child: Child,
    /// Path to the Unix domain socket used for IPC with the Extension Host.
    pub pipe_path: String,
}

/// Best-effort cleanup: removes the Unix socket file when the sidecar is dropped.
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

/// Spawn the Node.js Extension Host process and wait for it to connect back.
///
/// This is the inner implementation called by [`spawn`] after the Unix listener
/// has been created. It handles:
/// 1. Spawning `node out/bootstrap-fork.js --type=extensionHost` with the
///    required environment variables (mirrors `extensionHostConnection.ts:272-288`)
/// 2. Draining the child's stderr to a background log task
/// 3. Waiting up to 30 seconds for the Extension Host to connect back to the pipe
///
/// # Arguments
/// * `app_root` — Repository root containing `out/bootstrap-fork.js`
/// * `pipe_path` — Path to the Unix domain socket the ExtHost should connect to
/// * `listener` — The bound Unix listener awaiting the ExtHost connection
async fn spawn_and_connect(
    app_root: &Path,
    pipe_path: &str,
    listener: &UnixListener,
) -> Result<(ExtHostSidecar, tokio::net::UnixStream), ExtHostError> {
    // Mirrors extensionHostConnection.ts:272-288
    let node_bin = "node"; // PoC: use system node

    // Enrich PATH so child processes (e.g., `git` extension calling `which git`)
    // can find tools installed in non-default locations. This is critical on
    // macOS where app bundles inherit a minimal PATH from launchd.
    let enriched_path = build_exthost_path();
    log::info!(
        target: "vscodeee::exthost::sidecar",
        "ExtHost PATH: {enriched_path}"
    );

    let mut child = Command::new(node_bin)
        .arg("--dns-result-order=ipv4first")
        // Node.js 22+ enables require(esm) by default, which uses Atomics.wait()
        // in the CJS→ESM bridge. This deadlocks with VS Code's ESM loader hooks
        // (NodeModuleESMInterceptor) that communicate via MessagePort — the main
        // thread blocks on Atomics.wait() and cannot process the port message.
        .arg("--no-experimental-require-module")
        .arg("out/bootstrap-fork.js")
        .arg("--type=extensionHost")
        .current_dir(app_root)
        .env("PATH", &enriched_path)
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
        // Capture stderr to log ExtHost errors; inherit stdout for console output.
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(ExtHostError::Spawn)?;

    let pid = child.id().unwrap_or(0);
    log::info!(target: "vscodeee::exthost::sidecar", "Spawned Node.js ExtHost process (PID: {pid})");

    // Spawn a background task to read ExtHost stderr and log it.
    // This prevents the pipe buffer from filling up (which would block the child)
    // and surfaces any errors from the ExtHost process.
    {
        use tokio::io::AsyncBufReadExt;
        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            let reader = tokio::io::BufReader::new(stderr);
            tokio::spawn(async move {
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!(
                        target: "vscodeee::exthost::stderr",
                        "[ExtHost PID={pid}] {line}"
                    );
                }
                log::info!(
                    target: "vscodeee::exthost::stderr",
                    "[ExtHost PID={pid}] stderr stream closed"
                );
            });
        }
    }

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
