/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window-related commands.
//!
//! Provides the extended window configuration needed by the Tauri workbench
//! beyond the basic `get_window_configuration` in `mod.rs`.

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Extended window state for the workbench.
///
/// Matches the subset of `INativeWindowConfiguration` used by `desktop.tauri.main.ts`.
/// Combines window state and native host info into a single struct to reduce
/// the number of IPC round-trips during bootstrap.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendedWindowConfiguration {
    /// Unique window identifier resolved from the `WindowManager`.
    pub window_id: u32,
    /// Log level (`0` = Trace, `1` = Info, `2` = Warning, `3` = Error).
    pub log_level: u32,
    /// Filesystem path to the Tauri resource directory.
    pub resource_dir: String,
    /// Filesystem path to the transpiled frontend output (`out/`).
    pub frontend_dist: String,
    /// User's home directory path.
    pub home_dir: String,
    /// OS temporary directory path.
    pub tmp_dir: String,
    /// OS name (e.g. `"macos"`, `"linux"`, `"windows"`).
    pub platform: String,
    /// CPU architecture (e.g. `"aarch64"`, `"x86_64"`).
    pub arch: String,
    /// Machine hostname.
    pub hostname: String,
    /// Whether the window is currently in fullscreen mode.
    pub fullscreen: bool,
    /// Whether the window is currently maximized.
    pub maximized: bool,
}

/// Retrieve extended window configuration including OS info.
///
/// Combines window state and native host info into a single round-trip,
/// reducing the number of `invoke` calls needed during workbench bootstrap.
/// Resolves window ID dynamically via WindowManager.
#[tauri::command]
pub async fn get_extended_window_configuration(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<ExtendedWindowConfiguration, String> {
    let label = window.label().to_string();
    let window_id = window_manager.id_for_label(&label).await.unwrap_or(1);

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let frontend_dist = std::env::current_dir()
        .ok()
        .map(|cwd| {
            let dist = cwd.join("../out");
            dist.canonicalize().unwrap_or(dist)
        })
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let maximized = window.is_maximized().unwrap_or(false);

    Ok(ExtendedWindowConfiguration {
        window_id,
        log_level: 1,
        resource_dir,
        frontend_dist,
        home_dir: dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        tmp_dir: std::env::temp_dir().to_string_lossy().to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
        fullscreen,
        maximized,
    })
}

/// Options for opening a new window.
///
/// Deserialized from the JSON payload of the `open_new_window` command.
/// This is a command-layer type that is mapped to
/// [`window::state::OpenWindowOptions`](crate::window::state::OpenWindowOptions)
/// before delegation to `WindowManager`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindowOptions {
    /// URI of the folder to open in the new window, if any.
    #[serde(default)]
    pub folder_uri: Option<String>,
    /// When `true`, always create a new window even if the workspace is already open.
    #[serde(default)]
    pub force_new_window: bool,
}

/// Open a new Tauri window.
///
/// Delegates to `WindowManager` for label generation, workspace dedup,
/// and registry tracking. If `force_new_window` is false and a window
/// already has the requested workspace open, that window is focused instead.
#[tauri::command]
pub async fn open_new_window(
    app_handle: tauri::AppHandle,
    options: OpenWindowOptions,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), String> {
    use crate::window::state::OpenWindowOptions as WmOptions;

    let wm_opts = WmOptions {
        folder_uri: options.folder_uri.clone(),
        workspace_uri: None,
        force_new_window: options.force_new_window,
        force_reuse_window: false,
    };

    // Delegate to WindowManager — handles dedup, ID assignment, and registry
    let (window_id, label) = window_manager
        .open_window(&app_handle, &wm_opts)
        .await
        .map_err(|e| format!("Failed to open window: {e}"))?;

    log::info!(
        target: "vscodeee::commands::window",
        "Opened new window: {} (id={}, folder: {:?})",
        label,
        window_id,
        options.folder_uri
    );

    Ok(())
}

/// Return a list of all registered windows.
///
/// Used by `TauriNativeHostService.getWindows()` on the TypeScript side.
#[tauri::command]
pub async fn get_all_windows(
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<Vec<serde_json::Value>, String> {
    let windows = window_manager.get_all().await;
    let result: Vec<serde_json::Value> = windows
        .iter()
        .map(|info| {
            serde_json::json!({
                "id": info.id,
                "label": info.label,
                "workspace": info.workspace_uri,
            })
        })
        .collect();
    Ok(result)
}

/// Return the count of open windows.
#[tauri::command]
pub async fn get_window_count(
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<u32, String> {
    let windows = window_manager.get_all().await;
    Ok(windows.len() as u32)
}

/// Notify the Rust backend of the current workspace URI for session persistence.
///
/// Called by the TypeScript workbench bootstrap when a folder or workspace is
/// resolved from URL query parameters or restored URIs. This ensures the
/// `WindowManager` tracks which workspace each window has open, so it can be
/// saved in `sessions.json` on quit.
#[tauri::command]
pub async fn set_workspace_uri(
    window: tauri::Window,
    uri: Option<String>,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), String> {
    let label = window.label().to_string();
    window_manager.set_workspace_uri(&label, uri).await;
    Ok(())
}
