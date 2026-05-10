/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands for Extension Host sidecar lifecycle.
//!
//! Provides two modes:
//! 1. **PoC mode** (`spawn_extension_host`): Spawn + handshake + kill (for testing)
//! 2. **Production mode** (`spawn_exthost_with_relay`): Spawn + WS relay
//!    Returns a WebSocket port for TypeScript to connect and run the protocol.
//!
//! Multiple Extension Host instances can run concurrently (e.g., VS Code places
//! certain extensions like vscode-neovim on a separate host). Each instance is
//! tracked by a unique `instance_id` in [`ExtHostState`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use tokio::sync::Mutex;

/// Result of the Extension Host spawn + handshake operation (PoC mode).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtHostHandshakeResult {
    /// Whether the handshake completed successfully.
    pub success: bool,
    /// The named pipe / Unix socket path used for communication.
    pub pipe_path: String,
    /// PID of the spawned Bun Extension Host process.
    pub ext_host_pid: u32,
    /// Time taken for the handshake in milliseconds.
    pub handshake_duration_ms: u64,
    /// Human-readable log of each protocol message exchanged.
    pub messages_exchanged: Vec<String>,
    /// Error message if the handshake failed.
    pub error: Option<String>,
}

/// Result of spawning an Extension Host with a WebSocket relay (production mode).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtHostSpawnResult {
    /// Unique identifier for this Extension Host instance, used for later cleanup.
    pub instance_id: u32,
    /// WebSocket port for the TypeScript side to connect.
    pub ws_port: u16,
    /// PID of the spawned Bun Extension Host process.
    pub ext_host_pid: u32,
    /// The named pipe / Unix socket path.
    pub pipe_path: String,
    /// Absolute path to the application root directory (where `out/` lives).
    /// Used by the TypeScript side to set `vscode.env.appRoot` in the
    /// extension host init data, so extensions can locate the installation.
    pub app_root: String,
}

/// A running Extension Host instance tracked by [`ExtHostState`].
///
/// Holds the sidecar process handle (for killing the child) and the
/// WebSocket relay task handle (for aborting the relay on shutdown).
struct ExtHostInstance {
    /// The sidecar owning the child process.
    sidecar: crate::exthost::sidecar::ExtHostSidecar,
    /// Handle to the WebSocket relay task.
    relay_task: tokio::task::JoinHandle<()>,
    /// Handle to the background watchdog task that polls the child process.
    watchdog_task: tokio::task::JoinHandle<()>,
}

/// Managed state for tracking multiple running Extension Host instances.
///
/// VS Code may spawn multiple Extension Host processes concurrently (e.g.,
/// when certain extensions are configured to run in a separate host via
/// `"extensions.experimental.affinity"`). Each instance is tracked by a
/// unique `instance_id` assigned by an atomic counter.
pub struct ExtHostState {
    /// Map of instance_id → running ExtHost instance.
    instances: Mutex<HashMap<u32, ExtHostInstance>>,
    /// Monotonically increasing counter for generating unique instance IDs.
    next_id: AtomicU32,
}

impl ExtHostState {
    /// Create a new [`ExtHostState`] wrapped in an `Arc` for use as Tauri managed state.
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            instances: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        })
    }

    /// Kill all running Extension Host instances.
    ///
    /// Same logic as the `kill_all_exthosts` command, but callable from
    /// non-command contexts (e.g., shutdown coordinator).
    #[allow(dead_code)]
    pub async fn shutdown_all(&self) {
        let mut instances = self.instances.lock().await;
        let count = instances.len();
        for (id, mut inst) in instances.drain() {
            log::info!(
                target: "vscodeee::commands::spawn_exthost",
                "Killing ExtHost instance {id} (shutdown)"
            );
            inst.watchdog_task.abort();
            inst.relay_task.abort();
            let _ = inst.sidecar.child.kill().await;
            let _ = inst.sidecar.child.wait().await;
        }
        log::info!(
            target: "vscodeee::commands::spawn_exthost",
            "All {count} ExtHost instances terminated (shutdown_all)"
        );
    }

    /// Kill all ExtHost processes synchronously.
    ///
    /// Used from the shutdown coordinator closure when the tokio runtime
    /// may not be available (e.g., during `RunEvent::Exit`).
    ///
    /// Drains all instances from the map and aborts their watchdog/relay tasks,
    /// then kills the child process directly.
    pub fn sync_kill_all(&self) {
        let drained: Vec<_> = match self.instances.try_lock() {
            Ok(mut instances) => instances.drain().collect(),
            Err(_) => {
                log::warn!(
                    target: "vscodeee::commands::spawn_exthost",
                    "Could not acquire ExtHost state lock for sync kill"
                );
                return;
            }
        };
        if drained.is_empty() {
            return;
        }
        let count = drained.len();
        for (id, inst) in drained {
            log::info!(
                target: "vscodeee::commands::spawn_exthost",
                "Sync-killing ExtHost instance {id}"
            );
            inst.watchdog_task.abort();
            inst.relay_task.abort();
            if let Some(pid) = inst.sidecar.child.id() {
                #[cfg(unix)]
                {
                    // Use SIGKILL (not SIGTERM) because we are in a synchronous
                    // shutdown context and cannot wait for graceful termination.
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
                #[cfg(windows)]
                {
                    // /F = force kill, /T = kill child processes too.
                    // CREATE_NO_WINDOW (0x08000000) prevents a console window from flashing.
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", pid.to_string().as_str()])
                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                }
            }
        }
        log::info!(
            target: "vscodeee::commands::spawn_exthost",
            "Sync-killed {} ExtHost instances (drained)",
            count
        );
    }
}

/// Spawn an Extension Host with a WebSocket relay for production use.
///
/// Creates an IPC pipe (Unix domain socket or Windows named pipe), spawns
/// `bun out/bootstrap-fork.js --type=extensionHost`, starts a WebSocket relay
/// on `127.0.0.1:0`, and returns the port + PID.
/// TypeScript will connect via WebSocket and run PersistentProtocol over it.
#[tauri::command]
pub async fn spawn_exthost_with_relay(
    app_handle: tauri::AppHandle,
    exthost_state: tauri::State<'_, Arc<ExtHostState>>,
) -> Result<ExtHostSpawnResult, String> {
    use crate::exthost;

    let (app_root, resource_dir, cache_dir) = resolve_app_root_and_resource_dir(&app_handle)?;
    log::info!(target: "vscodeee::commands::spawn_exthost", "Spawning ExtHost with WS relay, app root: {}", app_root.display());

    // Verify prerequisites
    let bootstrap_path = app_root.join("out/bootstrap-fork.js");
    if !bootstrap_path.exists() {
        return Err(format!(
            "out/bootstrap-fork.js not found at {}. Run `npm run compile` first.",
            bootstrap_path.display()
        ));
    }

    // Allocate a unique instance ID for this ExtHost
    let instance_id = exthost_state.next_id.fetch_add(1, Ordering::Relaxed);

    // Step 1+2: Create pipe + spawn Bun
    let (sidecar, ipc_stream) = exthost::sidecar::spawn(&app_root, &resource_dir, &cache_dir)
        .await
        .map_err(|e| format!("ExtHost spawn failed: {e}"))?;

    let pid = sidecar.child.id().unwrap_or(0);
    let pipe_path = sidecar.pipe_path.clone();

    // Step 3: Start WebSocket relay
    let relay_handle = exthost::ws_relay::start_ws_relay(ipc_stream)
        .await
        .map_err(|e| format!("WS relay failed: {e}"))?;

    let ws_port = relay_handle.port;

    // Spawn a background watchdog that polls the ExtHost process every 500ms.
    //
    // The watchdog detects unexpected Extension Host crashes (e.g., unhandled
    // exceptions) and cleans up the associated relay task. Without this, a
    // crashed ExtHost would leave a dangling WebSocket relay that silently
    // drops all messages from the renderer.
    //
    // A 2-second initial delay avoids false positives during startup, when the
    // process may not yet be fully initialized.
    let watchdog_task = {
        let state_ref = Arc::clone(&exthost_state);
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                let mut instances = state_ref.instances.lock().await;
                if let Some(ref mut inst) = instances.get_mut(&instance_id) {
                    match inst.sidecar.child.try_wait() {
                        Ok(Some(status)) => {
                            log::error!(
                                target: "vscodeee::commands::spawn_exthost",
                                "ExtHost instance {instance_id} (PID={pid}) EXITED with status: {status}"
                            );
                            // Self-remove: abort own watchdog and the relay task.
                            if let Some(dead) = instances.remove(&instance_id) {
                                dead.watchdog_task.abort();
                                dead.relay_task.abort();
                            }
                            break;
                        }
                        Ok(None) => {} // Still running — continue polling
                        Err(e) => {
                            log::error!(
                                target: "vscodeee::commands::spawn_exthost",
                                "Failed to check ExtHost instance {instance_id} status: {e}"
                            );
                            break;
                        }
                    }
                } else {
                    // Instance was already removed (e.g., by kill_exthost) — stop polling.
                    break;
                }
            }
        })
    };

    // Store instance for later cleanup
    {
        let mut instances = exthost_state.instances.lock().await;
        instances.insert(
            instance_id,
            ExtHostInstance {
                sidecar,
                relay_task: relay_handle.task,
                watchdog_task,
            },
        );
    }

    log::info!(
        target: "vscodeee::commands::spawn_exthost",
        "ExtHost running: instance_id={instance_id}, PID={pid}, WS port={ws_port}, pipe={pipe_path}"
    );

    Ok(ExtHostSpawnResult {
        instance_id,
        ws_port,
        ext_host_pid: pid,
        pipe_path,
        app_root: app_root.to_string_lossy().into_owned(),
    })
}

/// Kill a specific Extension Host instance by its instance ID.
///
/// Terminates the Bun child process, aborts the WebSocket relay task,
/// and removes the instance from managed state. This is called from TypeScript
/// when a `TauriLocalProcessExtensionHost` is disposed.
///
/// Returns `Ok(())` if the instance was found and cleaned up, or if the
/// instance was already gone (idempotent).
#[tauri::command]
pub async fn kill_exthost(
    instance_id: u32,
    exthost_state: tauri::State<'_, Arc<ExtHostState>>,
) -> Result<(), String> {
    let mut instances = exthost_state.instances.lock().await;
    if let Some(mut inst) = instances.remove(&instance_id) {
        log::info!(
            target: "vscodeee::commands::spawn_exthost",
            "Killing ExtHost instance {instance_id}"
        );
        inst.watchdog_task.abort();
        inst.relay_task.abort();
        let _ = inst.sidecar.child.kill().await;
        let _ = inst.sidecar.child.wait().await;
        log::info!(
            target: "vscodeee::commands::spawn_exthost",
            "ExtHost instance {instance_id} terminated"
        );
    } else {
        log::debug!(
            target: "vscodeee::commands::spawn_exthost",
            "ExtHost instance {instance_id} not found (already cleaned up)"
        );
    }
    Ok(())
}

/// Kill all running Extension Host instances.
///
/// Called during application shutdown to ensure all child processes are
/// properly terminated.
#[tauri::command]
pub async fn kill_all_exthosts(
    exthost_state: tauri::State<'_, Arc<ExtHostState>>,
) -> Result<(), String> {
    let mut instances = exthost_state.instances.lock().await;
    let count = instances.len();
    for (id, mut inst) in instances.drain() {
        log::info!(
            target: "vscodeee::commands::spawn_exthost",
            "Killing ExtHost instance {id} (shutdown)"
        );
        inst.watchdog_task.abort();
        inst.relay_task.abort();
        let _ = inst.sidecar.child.kill().await;
        let _ = inst.sidecar.child.wait().await;
    }
    log::info!(
        target: "vscodeee::commands::spawn_exthost",
        "All {count} ExtHost instances terminated"
    );
    Ok(())
}

/// Spawn an Extension Host process as a Bun sidecar and run the handshake (PoC mode).
///
/// Creates a named pipe, spawns `bun out/bootstrap-fork.js --type=extensionHost`,
/// and executes the Ready→InitData→Initialized handshake protocol.
/// After a successful handshake, the ExtHost process is killed (PoC cleanup).
#[tauri::command]
pub async fn spawn_extension_host(
    app_handle: tauri::AppHandle,
) -> Result<ExtHostHandshakeResult, String> {
    // TODO: Add Windows named pipe support via tokio::net::windows::named_pipe.
    #[cfg(not(unix))]
    {
        let _ = app_handle;
        Err(
            "Extension Host sidecar is only supported on Unix (macOS/Linux) in the PoC.".into(),
        )
    }

    #[cfg(unix)]
    {
        spawn_extension_host_unix(app_handle).await
    }
}

/// Unix-specific implementation of [`spawn_extension_host`] (PoC mode).
///
/// Resolves the application root, verifies prerequisites, spawns the Extension
/// Host, runs the Ready→InitData→Initialized handshake, and kills the process
/// after verification.
#[cfg(unix)]
async fn spawn_extension_host_unix(
    app_handle: tauri::AppHandle,
) -> Result<ExtHostHandshakeResult, String> {
    let (app_root, resource_dir, cache_dir) = resolve_app_root_and_resource_dir(&app_handle)?;
    log::info!(target: "vscodeee::commands::spawn_exthost", "App root: {}", app_root.display());

    // Verify prerequisites
    let bootstrap_path = app_root.join("out/bootstrap-fork.js");
    if !bootstrap_path.exists() {
        return Err(format!(
            "out/bootstrap-fork.js not found at {}. Run `npm run compile` first.",
            bootstrap_path.display()
        ));
    }

    match spawn_and_handshake(&app_root, &resource_dir, &cache_dir).await {
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

/// Spawn the Extension Host sidecar and run the full handshake protocol (PoC).
///
/// After a successful handshake, the child process is killed and reaped to
/// avoid zombie processes. This is intended for testing only.
#[cfg(unix)]
async fn spawn_and_handshake(
    app_root: &std::path::Path,
    resource_dir: &std::path::Path,
    cache_dir: &std::path::Path,
) -> Result<ExtHostHandshakeResult, crate::exthost::ExtHostError> {
    use crate::exthost;
    // Step 1+2: Create pipe + spawn Bun
    let (mut sidecar, mut stream) =
        exthost::sidecar::spawn(app_root, resource_dir, cache_dir).await?;

    let pid = sidecar.child.id().unwrap_or(0);
    let pipe_path = sidecar.pipe_path.clone();

    // Step 3: Run handshake
    let handshake = exthost::handshake::run_handshake(&mut stream).await?;

    // PoC: Kill the child process after successful handshake and reap it
    // to avoid zombie processes.
    let _ = sidecar.child.kill().await;
    let _ = sidecar.child.wait().await;
    log::info!(target: "vscodeee::commands::spawn_exthost", "ExtHost process terminated (PoC cleanup)");

    Ok(ExtHostHandshakeResult {
        success: true,
        pipe_path,
        ext_host_pid: pid,
        handshake_duration_ms: handshake.duration_ms,
        messages_exchanged: handshake.messages,
        error: None,
    })
}

/// Resolve the VS Code repository root (where `out/` and `product.json` live)
/// and the Tauri resource directory (where bundled `node_modules/` lives).
///
/// Searches up to 5 parent directories from the Tauri resource directory,
/// then falls back to the current working directory, and finally checks
/// Tauri's `_up_` resource mapping for production builds.
/// Returns the first directory that contains `out/bootstrap-fork.js`.
fn resolve_app_root_and_resource_dir(
    app_handle: &tauri::AppHandle,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    use tauri::Manager;

    let resource_dir = strip_unc_prefix(
        &app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to resolve resource dir: {e}"))?,
    );

    let cache_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    // Walk up from resource dir to find the repo root
    let mut candidate = resource_dir.as_path();
    for _ in 0..5 {
        if candidate.join("out/bootstrap-fork.js").exists() {
            return Ok((candidate.to_path_buf(), resource_dir.clone(), cache_dir));
        }
        if let Some(parent) = candidate.parent() {
            candidate = parent;
        } else {
            break;
        }
    }

    // Fallback: try current working directory
    if let Ok(cwd) = std::env::current_dir() {
        let cwd = strip_unc_prefix(&cwd);
        if cwd.join("out/bootstrap-fork.js").exists() {
            return Ok((cwd, resource_dir, cache_dir));
        }
    }

    // Production fallback: Tauri maps `../out` (from bundle.resources) to
    // `_up_/out` inside the resource directory. The "app root" is then
    // `{resource_dir}/_up_/` since `out/bootstrap-fork.js` lives under it.
    let up_dir = resource_dir.join("_up_");
    if up_dir.join("out/bootstrap-fork.js").exists() {
        return Ok((up_dir, resource_dir, cache_dir));
    }

    Err(format!(
        "Cannot find repo root with out/bootstrap-fork.js. Searched from: {}",
        resource_dir.display()
    ))
}

/// Strip the Windows UNC extended-length path prefix (`\\?\`) from a path.
///
/// On Windows, `std::fs::canonicalize()` and Tauri's `resource_dir()` may
/// return paths with the `\\?\` prefix. Node.js handles this transparently,
/// but Bun does not — it treats the prefix as part of the file name, causing
/// module resolution failures in the Extension Host.
///
/// On non-Windows platforms this is a no-op.
fn strip_unc_prefix(path: &std::path::Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}
