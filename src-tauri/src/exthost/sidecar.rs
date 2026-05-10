/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Bun Extension Host process spawning.
//!
//! Spawns `bun out/bootstrap-fork.js --type=extensionHost` with the correct
//! environment variables. The Bun process starts a WebSocket server via
//! `Bun.serve({ port: 0 })` and reports the allocated port via stdout.
//! No IPC pipe or Rust-side relay is needed — the WebView connects directly.

use std::path::Path;
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::Mutex;

use super::ExtHostError;

// ── product.json augmentation mtime cache ────────────────────────────────

/// Cache record indicating that `product.json` already contains both `commit`
/// and `version` fields and does not need augmentation.
///
/// Stored in `{cache_dir}/product-augment-cache.json` alongside the app data.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ProductAugmentCache {
    /// Modification time of `product.json` (seconds since UNIX epoch).
    product_json_mtime: f64,
    /// `false` = no augmentation was needed. `true` = augmentation was performed.
    needed: bool,
}

/// Check whether `augment_product_json()` can be skipped via the mtime cache.
///
/// Returns `true` when the cached mtime matches the file's current mtime and
/// `needed` is `false`, meaning the file already had both fields last time.
fn is_augmentation_cached(product_path: &Path, cache_dir: &Path) -> bool {
    let cache_path = cache_dir.join("product-augment-cache.json");

    let cache: ProductAugmentCache = match std::fs::read_to_string(&cache_path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => return false,
    };

    // If augmentation was needed last time, always re-check
    if cache.needed {
        return false;
    }

    let current_mtime = match std::fs::metadata(product_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    {
        Some(d) => d.as_secs_f64(),
        None => return false,
    };

    let cache_hit = (cache.product_json_mtime - current_mtime).abs() < f64::EPSILON;
    if cache_hit {
        log::debug!(
            target: "vscodeee::exthost::sidecar",
            "product.json cache hit (mtime={current_mtime}), skipping augmentation"
        );
    }
    cache_hit
}

/// Persist the augmentation cache after a check completes.
fn write_augmentation_cache(product_path: &Path, cache_dir: &Path, needed: bool) {
    let cache_path = cache_dir.join("product-augment-cache.json");

    let current_mtime = match std::fs::metadata(product_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    {
        Some(d) => d.as_secs_f64(),
        None => return,
    };

    let cache = ProductAugmentCache {
        product_json_mtime: current_mtime,
        needed,
    };
    if let Ok(json) = serde_json::to_string(&cache) {
        if let Some(parent) = cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&cache_path, json) {
            log::warn!(
                target: "vscodeee::exthost::sidecar",
                "Failed to write product augment cache: {e}"
            );
        }
    }
}

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
    let bun_name = if cfg!(target_os = "windows") {
        "bun.exe"
    } else {
        "bun"
    };
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .as_ref()
        .and_then(|exe| exe.parent())
    {
        let sidecar_path = exe_dir.join(bun_name);
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
    #[cfg(windows)]
    let resolve_result = std::process::Command::new("where")
        .arg("bun")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    #[cfg(not(windows))]
    let resolve_result = std::process::Command::new("which").arg("bun").output();

    if let Ok(output) = resolve_result {
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
fn build_exthost_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let separator = if cfg!(windows) { ';' } else { ':' };
    let existing: std::collections::HashSet<&str> = current.split(separator).collect();

    let extra_dirs: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
        ]
    } else if cfg!(target_os = "windows") {
        // Windows: Common tool locations that may not be in PATH.
        // Most tools are found via the system PATH, but some (e.g., Git for Windows)
        // install to non-standard locations.
        &[]
    } else {
        &["/usr/local/bin", "/usr/local/sbin"]
    };

    let mut parts: Vec<&str> = Vec::new();
    for dir in extra_dirs {
        if !existing.contains(dir) {
            parts.push(dir);
        }
    }

    if parts.is_empty() {
        return current;
    }
    // Prepend extra dirs so they take priority
    parts.push(&current);
    parts.join(&separator.to_string())
}

/// A running Extension Host sidecar process.
///
/// Owns the child process handle. When dropped, any augmented `product.json`
/// is restored.
pub struct ExtHostSidecar {
    /// Handle to the spawned Bun child process.
    pub child: Child,
    /// Original content of `product.json` before augmentation, if modified.
    original_product_json: Option<(std::path::PathBuf, String)>,
}

/// Best-effort cleanup: restores the original `product.json` when the sidecar
/// is dropped.
impl Drop for ExtHostSidecar {
    fn drop(&mut self) {
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
fn augment_product_json(app_root: &Path, cache_dir: &Path) -> Option<(std::path::PathBuf, String)> {
    let product_path = app_root.join("product.json");

    // Fast path: skip augmentation if cached mtime matches and no augmentation
    // was needed last time.
    if is_augmentation_cached(&product_path, cache_dir) {
        return None;
    }

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

    if product
        .get("commit")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        let mut git_cmd = std::process::Command::new("git");
        git_cmd.args(["rev-parse", "HEAD"]).current_dir(app_root);
        #[cfg(windows)]
        git_cmd.creation_flags(0x08000000);

        if let Ok(output) = git_cmd.output() {
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
        // product.json already has commit+version — cache the mtime so the
        // next spawn can skip reading and parsing this file entirely.
        write_augmentation_cache(&product_path, cache_dir, false);
        return None;
    }

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
    // Cache that augmentation was needed so the next spawn re-checks after
    // the Drop impl restores the original content (which changes the mtime).
    write_augmentation_cache(&product_path, cache_dir, true);
    Some((product_path, original))
}

/// Spawn the Extension Host as a Bun sidecar.
///
/// The Bun process starts its own WebSocket server (`Bun.serve({ port: 0 })`)
/// and reports the port via stdout. No IPC pipe or Rust relay is needed —
/// the WebView connects directly to Bun's WebSocket server.
///
/// # Arguments
/// * `app_root` — Repository root containing `out/bootstrap-fork.js` and `product.json`
/// * `resource_dir` — Tauri resource directory containing bundled `node_modules/`
/// * `cache_dir` — Application data directory for the augmentation mtime cache
///
/// # Returns
/// A tuple of the sidecar handle and the child's stdout (for reading the
/// WebSocket port line).
pub async fn spawn(
    app_root: &Path,
    resource_dir: &Path,
    cache_dir: &Path,
) -> Result<(ExtHostSidecar, ChildStdout, Arc<Mutex<String>>), ExtHostError> {
    // Augment product.json with commit/version before spawning the ExtHost.
    // Extensions (e.g., open-remote-ssh) read this file directly from disk.
    let augmented = augment_product_json(app_root, cache_dir);

    let (child, stdout, stderr_buf) = spawn_child_process(app_root, resource_dir)?;

    log::info!(target: "vscodeee::exthost::sidecar", "ExtHost spawned, waiting for WS port...");

    let sidecar = ExtHostSidecar {
        child,
        original_product_json: augmented,
    };
    Ok((sidecar, stdout, stderr_buf))
}

/// Spawn the Bun Extension Host child process with the correct environment.
///
/// Returns the child process handle, piped stdout (for reading the WS port),
/// and a shared stderr buffer for diagnostics.
fn spawn_child_process(
    app_root: &Path,
    resource_dir: &Path,
) -> Result<(Child, ChildStdout, Arc<Mutex<String>>), ExtHostError> {
    let runtime_bin = resolve_runtime_binary();

    let enriched_path = build_exthost_path();
    log::debug!(
        target: "vscodeee::exthost::sidecar",
        "ExtHost PATH: {enriched_path}"
    );

    let ext_nm_paths = build_ext_node_modules_paths(app_root, resource_dir);

    let mut cmd = Command::new(&runtime_bin);
    cmd.arg("out/bootstrap-fork.js")
        .arg("--type=extensionHost")
        .current_dir(app_root)
        .env("PATH", &enriched_path)
        .env("NODE_PATH", &ext_nm_paths)
        .env("VSCODEEE_EXT_NODE_MODULES_PATHS", &ext_nm_paths)
        .env(
            "VSCODE_ESM_ENTRYPOINT",
            "vs/workbench/api/node/extensionHostProcess",
        )
        .env("VSCODE_PARENT_PID", std::process::id().to_string())
        .env("VSCODE_DEV", "1")
        .env(
            "VSCODE_NLS_CONFIG",
            r#"{"locale":"en","osLocale":"en","availableLanguages":{}}"#,
        )
        .env("VSCODEEE_RUNTIME", "bun")
        // Signal to the TypeScript layer that Bun should start a WS server
        // and report the port via stdout instead of connecting to an IPC pipe.
        .env("VSCODEEE_EXTHOST_WS_PORT", "0")
        // Pipe stdout so Rust can read the WS port line.
        // CREATE_NO_WINDOW prevents console flashing on Windows.
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(ExtHostError::Spawn)?;

    let pid = child.id().unwrap_or(0);
    log::info!(
        target: "vscodeee::exthost::sidecar",
        "Spawned Bun ExtHost process (PID: {pid})"
    );

    let stdout = child.stdout.take().ok_or_else(|| {
        ExtHostError::Spawn(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "child stdout not available",
        ))
    })?;

    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    // Background task: read ExtHost stderr for diagnostics
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

    Ok((child, stdout, stderr_buf))
}

/// Read the WebSocket port from the ExtHost child's stdout.
///
/// The Bun process writes `EXTHOST_WS_PORT:<port>` to stdout when its
/// WebSocket server starts. This function reads lines from stdout until
/// finding that line, with a 30-second timeout.
pub async fn read_ws_port(
    stdout: ChildStdout,
    stderr_buf: &Arc<Mutex<String>>,
    child: &mut Child,
) -> Result<u16, ExtHostError> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let result = tokio::time::timeout(tokio::time::Duration::from_secs(30), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(port_str) = line.strip_prefix("EXTHOST_WS_PORT:") {
                let port: u16 = port_str.trim().parse().map_err(|e| {
                    ExtHostError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("Invalid WS port number: {port_str}: {e}"),
                    ))
                })?;
                log::info!(
                    target: "vscodeee::exthost::sidecar",
                    "ExtHost WS port: {port}"
                );
                return Ok(port);
            }
            log::debug!(
                target: "vscodeee::exthost::sidecar",
                "ExtHost stdout (non-port): {line}"
            );
        }
        Err(ExtHostError::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "ExtHost stdout closed without sending WS port",
        )))
    })
    .await;

    match result {
        Ok(port_result) => port_result,
        Err(_) => {
            // Timeout
            match child.try_wait() {
                Ok(Some(status)) => {
                    let stderr_output = stderr_buf.lock().await;
                    Err(ExtHostError::ChildExited {
                        status: format!("{status}"),
                        stderr: stderr_output.clone(),
                    })
                }
                _ => Err(ExtHostError::Io(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Timeout waiting for WS port from ExtHost (30s)",
                ))),
            }
        }
    }
}
