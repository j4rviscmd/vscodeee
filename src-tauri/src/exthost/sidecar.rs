/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Named pipe creation and Bun Extension Host process spawning.
//!
//! Replicates the pattern from `src/vs/server/node/extensionHostConnection.ts:247-335`:
//! 1. Create IPC pipe (Unix domain socket or Windows named pipe)
//! 2. Spawn `bun out/bootstrap-fork.js --type=extensionHost` with correct env vars
//! 3. Wait for the ExtHost to connect back to our pipe

use std::path::Path;
use std::sync::Arc;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::{ExtHostError, IpcStream};

/// Resolve the Bun runtime binary path.
///
/// Resolution order:
/// 1. `VSCODEEE_RUNTIME_PATH` environment variable (explicit override)
/// 2. Bundled Bun sidecar next to the current executable (production)
/// 3. System `bun` from PATH (development)
fn resolve_runtime_binary() -> String {
    // 1. Explicit override via environment variable
    // VSCODEEE_NODE_PATH kept as fallback alias for backward compatibility
    if let Ok(path) =
        std::env::var("VSCODEEE_RUNTIME_PATH").or_else(|_| std::env::var("VSCODEEE_NODE_PATH"))
    {
        log::info!(
            target: "vscodeee::exthost::sidecar",
            "Using runtime from env override: {path}"
        );
        return path;
    }

    // 2. Bundled Bun sidecar (production Tauri build)
    if let Some(sidecar_path) = std::env::current_exe()
        .ok()
        .as_ref()
        .and_then(|exe| exe.parent())
        .map(|dir| {
            dir.join(if cfg!(target_os = "windows") {
                "bun.exe"
            } else {
                "bun"
            })
        })
    {
        if sidecar_path.exists() {
            log::info!(
                target: "vscodeee::exthost::sidecar",
                "Using bundled Bun sidecar: {}",
                sidecar_path.display()
            );
            return sidecar_path.to_string_lossy().to_string();
        }
    }

    // 3. System bun (development)
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    if let Ok(output) = std::process::Command::new(which_cmd).arg("bun").output() {
        if output.status.success() {
            let bun_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !bun_path.is_empty() {
                log::info!(
                    target: "vscodeee::exthost::sidecar",
                    "Using system Bun from PATH: {bun_path}"
                );
                return bun_path;
            }
        }
    }

    log::error!(
        target: "vscodeee::exthost::sidecar",
        "No Bun runtime found. Set VSCODEEE_RUNTIME_PATH or install Bun."
    );
    "bun".to_string()
}

/// Build extension node_modules paths for the Extension Host child process.
///
/// In production, modules are bundled under `{resource_dir}/node_modules/`.
/// In development, extensions live at `{app_root}/extensions/*/` with their own
/// `node_modules/` directories, but the Extension Host loads compiled code from
/// `.build/extensions/*/out/` where no `node_modules` exist. Bun walks up
/// from the extension's location and never finds the source tree's packages.
///
/// User-installed extensions at `~/.vscodeee/extensions/*/` may also ship their
/// own `node_modules/` (e.g., Prettier bundles its own `prettier` package).
///
/// This function constructs a colon/semicolon-separated list of paths that includes
/// the production resource path, built-in extension `node_modules/`, and
/// user extension `node_modules/` directories so `require('byline')` etc. resolve.
///
/// The paths are set as both `NODE_PATH` and `VSCODEEE_EXT_NODE_MODULES_PATHS`:
/// - `NODE_PATH`: Bun adds these to `Module.globalPaths` at process startup.
///   Since `removeGlobalNodeJsModuleLookupPaths()` in `bootstrap-node.ts` is skipped
///   when `VSCODEEE_EXT_NODE_MODULES_PATHS` is set, the paths survive module resolution.
/// - `VSCODEEE_EXT_NODE_MODULES_PATHS`: Triggers the skip in
///   `removeGlobalNodeJsModuleLookupPaths()` so `NODE_PATH` entries are not stripped.
fn build_ext_node_modules_paths(app_root: &Path, resource_dir: &Path) -> String {
    let separator = if cfg!(windows) { ";" } else { ":" };
    let mut paths: Vec<String> = Vec::new();

    // Always include the resource dir node_modules (production layout)
    paths.push(
        resource_dir
            .join("node_modules")
            .to_string_lossy()
            .into_owned(),
    );

    // In development, add app_root's node_modules and each extension's node_modules
    let extensions_dir = app_root.join("extensions");
    if extensions_dir.is_dir() {
        // Root node_modules (contains hoisted deps used by some extensions)
        let root_nm = app_root.join("node_modules");
        if root_nm.is_dir() {
            paths.push(root_nm.to_string_lossy().into_owned());
        }

        // Each extension's own node_modules
        paths.append(&mut collect_child_node_modules(&extensions_dir));
    }

    // User-installed extensions: ~/.vscodeee/extensions/*/node_modules
    // Extensions like Prettier bundle their own npm dependencies (e.g., prettier)
    // which must be resolvable via CJS require() in the extension host process.
    if let Some(home_dir) = dirs::home_dir() {
        let user_ext_dir = home_dir.join(".vscodeee").join("extensions");
        if user_ext_dir.is_dir() {
            paths.append(&mut collect_child_node_modules(&user_ext_dir));
        }
    }

    let paths_str = paths.join(separator);
    log::debug!(
        target: "vscodeee::exthost::sidecar",
        "ExtHost node_modules paths: {} entries",
        paths.len()
    );
    paths_str
}

/// Collect `node_modules` paths from immediate subdirectories of `dir`.
///
/// Reads the entries of `dir`, looks for `<entry>/node_modules/` directories,
/// sorts them alphabetically, and returns them as a list of paths.
fn collect_child_node_modules(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<String> = entries
        .filter_map(|e| {
            let nm = e.ok()?.path().join("node_modules");
            if nm.is_dir() {
                Some(nm.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect();
    paths.sort();
    paths
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
    let separator = if cfg!(windows) { ';' } else { ':' };
    let existing: std::collections::HashSet<&str> = current.split(separator).collect();

    // Well-known directories where git and other developer tools live.
    // Order matters: higher-priority directories come first.
    let extra_dirs: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin", // Apple Silicon Homebrew
            "/opt/homebrew/sbin",
            "/usr/local/bin", // Intel Homebrew / manual installs
            "/usr/local/sbin",
        ]
    } else if cfg!(target_os = "windows") {
        // Windows: Common tool locations that may not be in PATH
        // Most tools are found via the system PATH, but some (e.g., Git for Windows)
        // install to non-standard locations.
        &[]
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
        parts.join(&separator.to_string())
    }
}

/// A running Extension Host sidecar process with its named pipe path.
///
/// Owns the child process handle and the socket path. When dropped,
/// the Unix socket file and any augmented product.json are cleaned up.
pub struct ExtHostSidecar {
    /// Handle to the spawned Bun child process.
    pub child: Child,
    /// IPC endpoint address for communication with the Extension Host.
    /// On Unix this is a Unix domain socket path (e.g., `/tmp/vscode-ipc-*.sock`);
    /// on Windows this is a TCP address (e.g., `tcp:127.0.0.1:12345`).
    pub pipe_path: String,
    /// Original content of `product.json` before augmentation, if modified.
    /// Used by [`Drop`] to restore the file when the sidecar is cleaned up.
    original_product_json: Option<(std::path::PathBuf, String)>,
}

/// Best-effort cleanup: removes the Unix socket file and restores the
/// original `product.json` when the sidecar is dropped.
impl Drop for ExtHostSidecar {
    fn drop(&mut self) {
        // Best-effort cleanup of the socket file (Unix only — TCP sockets
        // on Windows are cleaned up by the OS when the listener is dropped)
        #[cfg(unix)]
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
///
/// Note: On Windows, TCP sockets are used instead (see `spawn()`), so
/// this function is only called on Unix platforms.
#[cfg(unix)]
fn create_random_ipc_handle() -> String {
    let id = uuid::Uuid::new_v4();
    format!("{}/vscode-ipc-{id}.sock", std::env::temp_dir().display())
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
    let augmented = match serde_json::to_string_pretty(&product) {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                target: "vscodeee::exthost::sidecar",
                "Failed to serialize augmented product.json: {e}"
            );
            return None;
        }
    };

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

/// Spawn the Extension Host as a Bun sidecar, returning the connected stream.
///
/// This replicates the pattern from `extensionHostConnection.ts:247-327`:
/// 1. Augment `product.json` with `commit`/`version` for extensions
/// 2. Create IPC endpoint (Unix domain socket or TCP socket on Windows)
/// 3. Spawn `bun out/bootstrap-fork.js --type=extensionHost`
/// 4. Wait for the ExtHost to connect back (30s timeout)
///
/// # Platform-specific IPC
///
/// - **macOS/Linux**: Uses Unix domain sockets (traditional approach).
/// - **Windows**: Uses TCP sockets on localhost instead of named pipes.
///   Bun's `net.Socket` implementation on Windows named pipes has known
///   reliability issues where data events may not fire correctly after
///   the initial handshake, causing extension RPC calls to be silently lost.
///   TCP sockets are well-tested and reliable on all platforms and runtimes.
///
/// # Arguments
/// * `app_root` — Repository root containing `out/bootstrap-fork.js` and `product.json`
/// * `resource_dir` — Tauri resource directory containing bundled `node_modules/`
///
/// # Returns
/// A tuple of the sidecar handle and the connected IPC stream.
pub async fn spawn(
    app_root: &Path,
    resource_dir: &Path,
) -> Result<(ExtHostSidecar, IpcStream), ExtHostError> {
    // Augment product.json with commit/version before spawning the ExtHost.
    // Extensions (e.g., open-remote-ssh) read this file directly from disk.
    let augmented = augment_product_json(app_root);

    // --- Platform-specific IPC setup ---
    // On Windows, use TCP sockets for Bun compatibility (named pipes have issues).
    // On Unix, use traditional Unix domain sockets.
    #[cfg(windows)]
    let (pipe_path, stream) = {
        // Bind TCP listener first to get the OS-assigned port.
        let tcp_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(ExtHostError::PipeCreation)?;
        let port = tcp_listener
            .local_addr()
            .map_err(ExtHostError::PipeCreation)?
            .port();
        // Format as "tcp:host:port" — the ExtHost TypeScript layer detects this
        // prefix and connects via TCP instead of named pipes.
        let pipe_path = format!("tcp:127.0.0.1:{port}");

        log::info!(
            target: "vscodeee::exthost::sidecar",
            "IPC endpoint (TCP): {pipe_path}"
        );

        let (mut child, stderr_buf) = spawn_child_process(app_root, resource_dir, &pipe_path)?;
        let stream = accept_ipc_connection_tcp(tcp_listener, &stderr_buf, &mut child).await?;

        // Store child in sidecar
        let sidecar_child = child;
        (pipe_path, (stream, sidecar_child))
    };

    #[cfg(unix)]
    let (pipe_path, stream) = {
        let pipe_path = create_random_ipc_handle();

        log::info!(
            target: "vscodeee::exthost::sidecar",
            "IPC endpoint (Unix socket): {pipe_path}"
        );

        let (mut child, stderr_buf) = spawn_child_process(app_root, resource_dir, &pipe_path)?;
        let result = accept_ipc_connection(&pipe_path, &stderr_buf, &mut child).await;
        if result.is_err() {
            let _ = std::fs::remove_file(&pipe_path);
        }
        let stream = result?;
        (pipe_path, (stream, child))
    };

    let (stream, child) = stream;
    log::info!(target: "vscodeee::exthost::sidecar", "ExtHost connected via IPC");

    let sidecar = ExtHostSidecar {
        child,
        pipe_path,
        original_product_json: augmented,
    };
    Ok((sidecar, stream))
}

/// Spawn the Bun Extension Host child process with the correct environment.
///
/// Returns the child process handle and a shared stderr buffer for diagnostics.
fn spawn_child_process(
    app_root: &Path,
    resource_dir: &Path,
    pipe_path: &str,
) -> Result<(Child, Arc<Mutex<String>>), ExtHostError> {
    let runtime_bin = resolve_runtime_binary();

    let enriched_path = build_exthost_path();
    log::debug!(
        target: "vscodeee::exthost::sidecar",
        "ExtHost PATH: {enriched_path}"
    );

    let ext_nm_paths = build_ext_node_modules_paths(app_root, resource_dir);

    let mut child = Command::new(&runtime_bin)
        .arg("out/bootstrap-fork.js")
        .arg("--type=extensionHost")
        .current_dir(app_root)
        .env("PATH", &enriched_path)
        // NODE_PATH for extension module resolution.
        // Bun adds NODE_PATH entries to Module.globalPaths at startup.
        // Since removeGlobalNodeJsModuleLookupPaths() is skipped when
        // VSCODEEE_EXT_NODE_MODULES_PATHS is set (see bootstrap-node.ts),
        // the globalPaths are never stripped and resolution works natively.
        .env("NODE_PATH", &ext_nm_paths)
        .env("VSCODEEE_EXT_NODE_MODULES_PATHS", &ext_nm_paths)
        .env("VSCODE_EXTHOST_IPC_HOOK", pipe_path)
        .env(
            "VSCODE_ESM_ENTRYPOINT",
            "vs/workbench/api/node/extensionHostProcess",
        )
        // NOT setting VSCODE_HANDLES_UNCAUGHT_ERRORS — let the runtime use its
        // default error handler which writes to stderr, so Rust can capture
        // and relay the actual startup error instead of failing silently.
        .env("VSCODE_PARENT_PID", std::process::id().to_string())
        .env("VSCODE_DEV", "1")
        .env(
            "VSCODE_NLS_CONFIG",
            r#"{"locale":"en","osLocale":"en","availableLanguages":{}}"#,
        )
        // Signal to the TypeScript layer that Bun is the runtime.
        // Used by bootstrap-fork.js for runtime-specific behavior.
        .env("VSCODEEE_RUNTIME", "bun")
        // NOT set (selecting wrong transport):
        // VSCODE_WILL_SEND_MESSAGE_PORT — Electron MessagePort path
        // VSCODE_EXTHOST_WILL_SEND_SOCKET — process.send() socket path
        // Capture stderr to log ExtHost errors; inherit stdout for console output.
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(ExtHostError::Spawn)?;

    let pid = child.id().unwrap_or(0);
    log::info!(
        target: "vscodeee::exthost::sidecar",
        "Spawned Bun ExtHost process (PID: {pid})"
    );
    log::info!(
        target: "vscodeee::exthost::sidecar",
        "  cwd: {}, ext_nm_paths: {ext_nm_paths}, IPC_HOOK: {pipe_path}",
        app_root.display()
    );

    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    // Spawn a background task to read ExtHost stderr.
    // Lines are logged to the Rust log framework AND written to
    // a temp directory log file for production diagnostics.
    // The shared buffer is also populated so early-exit errors can be
    // included in the ExtHostError::ChildExited message.
    {
        use tokio::io::AsyncBufReadExt;
        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            let reader = tokio::io::BufReader::new(stderr);
            let stderr_buf_clone = Arc::clone(&stderr_buf);
            let log_path = std::env::temp_dir().join(format!("vscodeee-exthost-stderr-{pid}.log"));
            tokio::spawn(async move {
                let mut lines = reader.lines();
                let mut log_file = tokio::fs::File::create(&log_path).await.ok();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!(
                        target: "vscodeee::exthost::stderr",
                        "[ExtHost PID={pid}] {line}"
                    );
                    {
                        let mut buf = stderr_buf_clone.lock().await;
                        if buf.len() < 8192 {
                            buf.push_str(&line);
                            buf.push('\n');
                        }
                    }
                    if let Some(ref mut f) = log_file {
                        use tokio::io::AsyncWriteExt;
                        let _ = f.write_all(format!("{line}\n").as_bytes()).await;
                    }
                }
                log::info!(
                    target: "vscodeee::exthost::stderr",
                    "[ExtHost PID={pid}] stderr stream closed"
                );
            });
        }
    }

    Ok((child, stderr_buf))
}

/// Accept an IPC connection from the ExtHost child process (Unix).
///
/// Creates a Unix domain socket listener, waits for the child to connect,
/// and returns the connected stream as an [`IpcStream`].
#[cfg(unix)]
async fn accept_ipc_connection(
    pipe_path: &str,
    stderr_buf: &Arc<Mutex<String>>,
    child: &mut Child,
) -> Result<IpcStream, ExtHostError> {
    use tokio::net::UnixListener;

    let listener = UnixListener::bind(pipe_path).map_err(ExtHostError::PipeCreation)?;

    tokio::select! {
        result = listener.accept() => {
            result
                .map(|(stream, _)| Box::new(stream) as IpcStream)
                .map_err(ExtHostError::PipeCreation)
        }
        _ = tokio::time::sleep(tokio::time::Duration::from_secs(30)) => {
            check_child_exit_or_timeout(child, stderr_buf).await
        }
    }
}

/// Accept an IPC connection from the ExtHost child process (Windows).
///
/// Uses a TCP socket on localhost instead of Windows named pipes for
/// reliability with the Bun runtime. Bun's named pipe implementation
/// on Windows has issues where `data` events may not fire correctly
/// after the initial protocol handshake, causing extension RPC messages
/// to be silently dropped.
///
/// TCP sockets are well-tested across all platforms and runtimes, and
/// provide reliable bidirectional byte streaming.
#[cfg(windows)]
async fn accept_ipc_connection_tcp(
    listener: tokio::net::TcpListener,
    stderr_buf: &Arc<Mutex<String>>,
    child: &mut Child,
) -> Result<IpcStream, ExtHostError> {
    tokio::select! {
        result = listener.accept() => {
            let (stream, addr) = result.map_err(ExtHostError::PipeCreation)?;
            log::info!(
                target: "vscodeee::exthost::sidecar",
                "ExtHost connected via TCP from {addr}"
            );
            // Disable Nagle's algorithm for low-latency IPC message exchange.
            // Extension host RPC messages are typically small and latency-sensitive.
            stream.set_nodelay(true).map_err(ExtHostError::Io)?;
            Ok(Box::new(stream) as IpcStream)
        }
        _ = tokio::time::sleep(tokio::time::Duration::from_secs(30)) => {
            check_child_exit_or_timeout(child, stderr_buf).await
        }
    }
}

/// Check if the child process has exited, returning an appropriate error.
async fn check_child_exit_or_timeout(
    child: &mut Child,
    stderr_buf: &Arc<Mutex<String>>,
) -> Result<IpcStream, ExtHostError> {
    match child.try_wait() {
        Ok(Some(status)) => {
            let stderr_output = stderr_buf.lock().await;
            Err(ExtHostError::ChildExited {
                status: format!("{status}"),
                stderr: stderr_output.clone(),
            })
        }
        _ => Err(ExtHostError::Timeout),
    }
}
