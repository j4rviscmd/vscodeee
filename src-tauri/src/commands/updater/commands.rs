/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands for the application update lifecycle.
//!
//! Wraps [`tauri_plugin_updater`] with four IPC commands:
//! - [`updater_check_for_updates`] — query the endpoint for a new version
//! - [`updater_download_and_install`] — download, stage, and stream progress
//! - [`updater_restart_and_update`] — persist session and restart
//! - [`updater_get_current_version`] — report the running version

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

use super::error::UpdateError;

// ── Types shared with the WebView ──────────────────────────────────────────

/// Update metadata returned by [`updater_check_for_updates`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// Single progress event streamed through the [`Channel`] during download.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub phase: DownloadPhase,
    pub downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

/// Phase labels matching the VS Code `StateType.Downloading` lifecycle.
#[derive(Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum DownloadPhase {
    Started,
    Progress,
    Finished,
}

// ── Shared state ───────────────────────────────────────────────────────────

/// Holds the cached [`tauri_plugin_updater::Update`] between check and download.
///
/// The `Option` is `take()`n by [`updater_download_and_install`] to prevent
/// stale updates from being applied.
#[derive(Default)]
pub struct UpdaterState {
    pending: tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>,
}

type Result<T> = std::result::Result<T, UpdateError>;

// ── Commands ───────────────────────────────────────────────────────────────

/// Query the configured endpoint for an available update.
///
/// Returns `Some(UpdateInfo)` when a newer version exists, `None` otherwise.
/// The result is cached in [`UpdaterState`] for the subsequent
/// [`updater_download_and_install`] call.
#[tauri::command]
pub async fn updater_check_for_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdaterState>,
) -> Result<Option<UpdateInfo>> {
    log::info!(target: "vscodeee::updater", "Checking for updates");

    let update = app
        .updater_builder()
        .build()
        .map_err(|e| UpdateError::NotAvailable(e.to_string()))?
        .check()
        .await
        .map_err(|e| {
            log::warn!(target: "vscodeee::updater", "Update check failed: {e}");
            UpdateError::CheckFailed(e.to_string())
        })?;

    match update {
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                date: u.date.map(|d| {
                    d.format(&time::format_description::well_known::Rfc3339)
                        .unwrap_or_else(|_| d.to_string())
                }),
                body: u.body.clone(),
            };
            log::info!(
                target: "vscodeee::updater",
                "Update available: {} (current: {})",
                info.version,
                info.current_version
            );
            *state.pending.lock().await = Some(u);
            Ok(Some(info))
        }
        None => {
            log::info!(target: "vscodeee::updater", "No update available");
            *state.pending.lock().await = None;
            Ok(None)
        }
    }
}

/// Download and stage the pending update, streaming progress to the WebView.
///
/// The update is applied on next restart. Call [`updater_restart_and_update`]
/// to persist the session and trigger the actual restart.
#[tauri::command]
pub async fn updater_download_and_install(
    state: tauri::State<'_, UpdaterState>,
    on_progress: Channel<DownloadProgress>,
) -> Result<()> {
    // Take ownership of the pending update (prevents double-download).
    let update = {
        let mut guard = state.pending.lock().await;
        guard.take().ok_or(UpdateError::NoPendingUpdate)?
    };

    log::info!(target: "vscodeee::updater", "Starting download and install");

    // Clone the channel handles for the two closures.
    let ch_progress = on_progress.clone();
    let ch_finished = on_progress.clone();

    // Signal download start.
    let _ = on_progress.send(DownloadProgress {
        phase: DownloadPhase::Started,
        downloaded_bytes: 0,
        total_bytes: None,
    });

    update
        .download_and_install(
            {
                let mut cumulative: u64 = 0;
                move |chunk_length: usize, content_length: Option<u64>| {
                    cumulative += chunk_length as u64;
                    let _ = ch_progress.send(DownloadProgress {
                        phase: DownloadPhase::Progress,
                        downloaded_bytes: cumulative,
                        total_bytes: content_length,
                    });
                }
            },
            move || {
                let _ = ch_finished.send(DownloadProgress {
                    phase: DownloadPhase::Finished,
                    downloaded_bytes: 0,
                    total_bytes: None,
                });
            },
        )
        .await
        .map_err(|e| {
            log::error!(target: "vscodeee::updater", "Download failed: {e}");
            UpdateError::DownloadFailed(e.to_string())
        })?;

    log::info!(target: "vscodeee::updater", "Update downloaded and staged");
    Ok(())
}

/// Persist session state and restart the application to apply the staged update.
#[tauri::command]
pub async fn updater_restart_and_update(
    app: tauri::AppHandle,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<()> {
    log::info!(target: "vscodeee::updater", "Restarting to apply update");

    crate::window::events::save_session_snapshot(&window_manager).await;
    tauri::process::restart(&app.env());

    #[allow(unreachable_code)]
    Ok(())
}

/// Return the currently running application version.
#[tauri::command]
pub fn updater_get_current_version(app: tauri::AppHandle) -> String {
    app.config().version.clone().unwrap_or_default()
}
