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

/// Resolve the Node.js binary path for the Extension Host process.
///
/// Resolution order:
/// 1. `VSCODEEE_NODE_PATH` environment variable (explicit override)
/// 2. Bundled sidecar binary next to the current executable (production builds)
/// 3. System `node` from PATH (development)
///
/// In production, `tauri build` bundles Node.js via `externalBin` into the same
/// directory as the main executable. Tauri strips the target-triple suffix during
/// bundling, so the binary is named simply `node` (or `node.exe` on Windows).
fn resolve_node_binary() -> String {
    // 1. Explicit override via environment variable
    if let Ok(path) = std::env::var("VSCODEEE_NODE_PATH") {
        log::info!(
            target: "vscodeee::exthost::sidecar",
            "Using Node.js from VSCODEEE_NODE_PATH: {path}"
        );
        return path;
    }

    // 2. Bundled sidecar binary (production Tauri build)
    // Tauri's externalBin strips the target-triple suffix when bundling,
    // so `binaries/node-aarch64-apple-darwin` becomes `Contents/MacOS/node`.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let sidecar_name = if cfg!(target_os = "windows") {
                "node.exe"
            } else {
                "node"
            };
            let sidecar_path = exe_dir.join(sidecar_name);
            if sidecar_path.exists() {
                log::info!(
                    target: "vscodeee::exthost::sidecar",
                    "Using bundled Node.js sidecar: {}",
                    sidecar_path.display()
                );
                return sidecar_path.to_string_lossy().to_string();
            }
        }
    }

    // 3. System node (development fallback)
    log::info!(
        target: "vscodeee::exthost::sidecar",
        "Using system Node.js from PATH"
    );
    "node".to_string()
}

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
            "/opt/homebrew/bin", // Apple Silicon Homebrew
            "/opt/homebrew/sbin",
            "/usr/local/bin", // Intel Homebrew / manual installs
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
/// the Unix socket file and any augmented product.json are cleaned up.
pub struct ExtHostSidecar {
    /// Handle to the spawned Node.js child process.
    pub child: Child,
    /// Path to the Unix domain socket used for IPC with the Extension Host.
    pub pipe_path: String,
    /// Original content of `product.json` before augmentation, if modified.
    /// Used by [`Drop`] to restore the file when the sidecar is cleaned up.
    original_product_json: Option<(std::path::PathBuf, String)>,
}

/// Best-effort cleanup: removes the Unix socket file and restores the
/// original `product.json` when the sidecar is dropped.
impl Drop for ExtHostSidecar {
    fn drop(&mut self) {
        // Best-effort cleanup of the socket file
        let _ = std::fs::remove_file(&self.pipe_path);

        // Restore original product.json if we augmented it
        if let Some((ref path, ref original)) = self.original_product_json {
            if let Err(e) = std::fs::write(path, original) {
                log::warn!(
                    target: "vscodeee::exthost::sidecar",
                    "Failed to restore original product.json: {e}"
                );
            } else {
                log::info!(
                    target: "vscodeee::exthost::sidecar",
                    "Restored original product.json"
                );
            }
        }
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

/// Augment `product.json` with `commit` and `version` fields at runtime.
///
/// Extensions like `open-remote-ssh` read `product.json` directly from disk
/// (via `fs.readFile(path.join(vscode.env.appRoot, "product.json"))`), so the
/// file must contain `commit` and `version` fields that match the running
/// instance. The Rust `get_product_json()` command injects these at runtime
/// for the webview, but extensions bypass that and read the file directly.
///
/// Returns `Some((path, original_content))` if the file was modified, or
/// `None` if no modification was needed.
fn augment_product_json(app_root: &Path) -> Option<(std::path::PathBuf, String)> {
    let product_path = app_root.join("product.json");
    let original = match std::fs::read_to_string(&product_path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                target: "vscodeee::exthost::sidecar",
                "Cannot read product.json for augmentation: {e}"
            );
            return None;
        }
    };

    let mut product: serde_json::Value = match serde_json::from_str(&original) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                target: "vscodeee::exthost::sidecar",
                "Cannot parse product.json: {e}"
            );
            return None;
        }
    };

    let mut modified = false;

    // Inject commit hash from git if not already set
    if product
        .get("commit")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        if let Ok(output) = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(app_root)
            .output()
        {
            if output.status.success() {
                let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Some(obj) = product.as_object_mut() {
                    obj.insert(
                        "commit".to_string(),
                        serde_json::Value::String(commit.clone()),
                    );
                    modified = true;
                    log::info!(
                        target: "vscodeee::exthost::sidecar",
                        "Injected commit={commit} into product.json"
                    );
                }
            }
        }
    }

    // Inject version from package.json if not already set
    if product
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        let package_path = app_root.join("package.json");
        if let Ok(pkg_str) = std::fs::read_to_string(&package_path) {
            if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&pkg_str) {
                if let Some(ver) = pkg.get("version").and_then(|v| v.as_str()) {
                    if let Some(obj) = product.as_object_mut() {
                        obj.insert(
                            "version".to_string(),
                            serde_json::Value::String(ver.to_string()),
                        );
                        modified = true;
                        log::info!(
                            target: "vscodeee::exthost::sidecar",
                            "Injected version={ver} into product.json"
                        );
                    }
                }
            }
        }
    }

    if !modified {
        return None;
    }

    // Write augmented product.json (pretty-printed to preserve readability)
    match serde_json::to_string_pretty(&product) {
        Ok(augmented) => {
            // Add trailing newline to match typical JSON formatting
            let augmented = augmented + "\n";
            if let Err(e) = std::fs::write(&product_path, &augmented) {
                log::warn!(
                    target: "vscodeee::exthost::sidecar",
                    "Failed to write augmented product.json: {e}"
                );
                return None;
            }
            log::info!(
                target: "vscodeee::exthost::sidecar",
                "Wrote augmented product.json with commit and version"
            );
            Some((product_path, original))
        }
        Err(e) => {
            log::warn!(
                target: "vscodeee::exthost::sidecar",
                "Failed to serialize augmented product.json: {e}"
            );
            None
        }
    }
}

/// Spawn the Extension Host as a Node.js sidecar, returning the connected stream.
///
/// This replicates the pattern from `extensionHostConnection.ts:247-327`:
/// 1. Augment `product.json` with `commit`/`version` for extensions
/// 2. Create Unix domain socket server
/// 3. Spawn `node out/bootstrap-fork.js --type=extensionHost`
/// 4. Wait for the ExtHost to connect back to our socket (30s timeout)
///
/// # Arguments
/// * `app_root` — Repository root containing `out/bootstrap-fork.js` and `product.json`
///
/// # Returns
/// A tuple of the sidecar handle and the connected Unix stream.
pub async fn spawn(
    app_root: &Path,
) -> Result<(ExtHostSidecar, tokio::net::UnixStream), ExtHostError> {
    // Augment product.json with commit/version before spawning the ExtHost.
    // Extensions (e.g., open-remote-ssh) read this file directly from disk.
    let augmented = augment_product_json(app_root);

    let pipe_path = create_random_ipc_handle();

    // Step 1: Create the Unix domain socket server
    // Mirrors _listenOnPipe() at extensionHostConnection.ts:337-348
    let listener = UnixListener::bind(&pipe_path).map_err(ExtHostError::PipeCreation)?;

    log::info!(target: "vscodeee::exthost::sidecar", "Listening on pipe: {pipe_path}");

    // Step 2: Spawn the Node.js process
    // If spawn or accept fails, clean up the socket file before returning.
    let result = spawn_and_connect(app_root, &pipe_path, &listener, augmented).await;
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
/// * `augmented` — Original product.json content if the file was augmented
async fn spawn_and_connect(
    app_root: &Path,
    pipe_path: &str,
    listener: &UnixListener,
    augmented: Option<(std::path::PathBuf, String)>,
) -> Result<(ExtHostSidecar, tokio::net::UnixStream), ExtHostError> {
    // Resolve the Node.js binary: bundled sidecar in production, system node in dev.
    // See resolve_node_binary() for the full resolution order.
    let node_bin = resolve_node_binary();

    // Enrich PATH so child processes (e.g., `git` extension calling `which git`)
    // can find tools installed in non-default locations. This is critical on
    // macOS where app bundles inherit a minimal PATH from launchd.
    let enriched_path = build_exthost_path();
    log::debug!(
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
        original_product_json: augmented,
    };
    Ok((sidecar, stream))
}
