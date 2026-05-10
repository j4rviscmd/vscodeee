/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands for Extension Host sidecar lifecycle.
//!
//! The Extension Host is spawned as a Bun child process that starts its own
//! WebSocket server. The WebView connects directly — no Rust relay is needed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;
use tokio::sync::Mutex;

/// Result of spawning an Extension Host with a direct WebSocket connection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtHostSpawnResult {
    /// Unique identifier for this Extension Host instance, used for later cleanup.
    pub instance_id: u32,
    /// WebSocket port where the Bun Extension Host is listening.
    pub ws_port: u16,
    /// PID of the spawned Bun Extension Host child process.
    pub ext_host_pid: u32,
    /// Absolute path to the application root directory (where `out/` lives).
    pub app_root: String,
}

/// A running Extension Host instance tracked by [`ExtHostState`].
struct ExtHostInstance {
    /// The sidecar owning the child process.
    sidecar: crate::exthost::sidecar::ExtHostSidecar,
    /// Handle to the background watchdog task that polls the child process.
    watchdog_task: tokio::task::JoinHandle<()>,
}

/// Managed state for tracking multiple running Extension Host instances.
pub struct ExtHostState {
    /// Map of instance_id → running ExtHost instance.
    instances: Mutex<HashMap<u32, ExtHostInstance>>,
    /// Monotonically increasing counter for generating unique instance IDs.
    next_id: AtomicU32,
}

impl ExtHostState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            instances: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        })
    }

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
            let _ = inst.sidecar.child.kill().await;
            let _ = inst.sidecar.child.wait().await;
        }
        log::info!(
            target: "vscodeee::commands::spawn_exthost",
            "All {count} ExtHost instances terminated (shutdown_all)"
        );
    }

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
            if let Some(pid) = inst.sidecar.child.id() {
                #[cfg(unix)]
                {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
                #[cfg(windows)]
                {
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

/// Spawn an Extension Host with a direct WebSocket connection.
#[tauri::command]
pub async fn spawn_exthost(
    app_handle: tauri::AppHandle,
    exthost_state: tauri::State<'_, Arc<ExtHostState>>,
) -> Result<ExtHostSpawnResult, String> {
    use crate::exthost;

    let (app_root, _resource_dir, cache_dir) = resolve_app_root_and_resource_dir(&app_handle)?;
    log::info!(target: "vscodeee::commands::spawn_exthost", "Spawning ExtHost, app root: {}", app_root.display());

    let bootstrap_path = app_root.join("out/bootstrap-fork.js");
    if !bootstrap_path.exists() {
        return Err(format!(
            "out/bootstrap-fork.js not found at {}. Run `npm run compile` first.",
            bootstrap_path.display()
        ));
    }

    let instance_id = exthost_state.next_id.fetch_add(1, Ordering::Relaxed);

    // Spawn Bun ExtHost — it starts its own WebSocket server
    let (mut sidecar, stdout, stderr_buf) =
        exthost::sidecar::spawn(&app_root, &_resource_dir, &cache_dir)
            .await
            .map_err(|e| format!("ExtHost spawn failed: {e}"))?;

    let pid = sidecar.child.id().unwrap_or(0);

    let ws_port = exthost::sidecar::read_ws_port(stdout, &stderr_buf, &mut sidecar.child)
        .await
        .map_err(|e| format!("Failed to read WS port from ExtHost: {e}"))?;

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
                            if let Some(dead) = instances.remove(&instance_id) {
                                dead.watchdog_task.abort();
                            }
                            break;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            log::error!(
                                target: "vscodeee::commands::spawn_exthost",
                                "Failed to check ExtHost instance {instance_id} status: {e}"
                            );
                            break;
                        }
                    }
                } else {
                    break;
                }
            }
        })
    };

    {
        let mut instances = exthost_state.instances.lock().await;
        instances.insert(
            instance_id,
            ExtHostInstance {
                sidecar,
                watchdog_task,
            },
        );
    }

    log::info!(
        target: "vscodeee::commands::spawn_exthost",
        "ExtHost running: instance_id={instance_id}, PID={pid}, WS port={ws_port}"
    );

    Ok(ExtHostSpawnResult {
        instance_id,
        ws_port,
        ext_host_pid: pid,
        app_root: app_root.to_string_lossy().into_owned(),
    })
}

/// Kill a specific Extension Host instance by its instance ID.
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
/// Resolve the VS Code repository root and Tauri resource directory.
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

    if let Ok(cwd) = std::env::current_dir() {
        let cwd = strip_unc_prefix(&cwd);
        if cwd.join("out/bootstrap-fork.js").exists() {
            return Ok((cwd, resource_dir, cache_dir));
        }
    }

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
fn strip_unc_prefix(path: &std::path::Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}
