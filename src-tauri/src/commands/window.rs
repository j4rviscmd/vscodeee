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
/// Matches the subset of `INativeWindowConfiguration` used by `desktop.tauri.main.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendedWindowConfiguration {
    pub window_id: u32,
    pub log_level: u32,
    pub resource_dir: String,
    pub frontend_dist: String,
    pub home_dir: String,
    pub tmp_dir: String,
    pub platform: String,
    pub arch: String,
    pub hostname: String,
    pub fullscreen: bool,
    pub maximized: bool,
}

/// Retrieve extended window configuration including OS info.
///
/// Combines window state and native host info into a single round-trip,
/// reducing the number of `invoke` calls needed during workbench bootstrap.
#[tauri::command]
pub fn get_extended_window_configuration(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
) -> Result<ExtendedWindowConfiguration, String> {
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
        window_id: 1,
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
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindowOptions {
    #[serde(default)]
    pub folder_uri: Option<String>,
    #[serde(default)]
    pub force_new_window: bool,
}

/// Open a new Tauri window.
///
/// Creates a new WebviewWindow with the same entry point as the main window,
/// optionally opening a specific folder.
#[tauri::command]
pub async fn open_new_window(
    app_handle: tauri::AppHandle,
    options: OpenWindowOptions,
) -> Result<(), String> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    // Generate a unique label for the new window
    let window_count = app_handle.webview_windows().len();
    let label = format!("main_{}", window_count + 1);

    // Build URL with optional folder query param
    let mut url_str = String::from("vs/code/tauri-browser/workbench/workbench-tauri.html");
    if let Some(ref folder) = options.folder_uri {
        // Simple percent-encoding for the folder URI
        let encoded: String = folder
            .chars()
            .map(|c| match c {
                ' ' => "%20".to_string(),
                '#' => "%23".to_string(),
                '&' => "%26".to_string(),
                _ => c.to_string(),
            })
            .collect();
        url_str = format!(
            "vs/code/tauri-browser/workbench/workbench-tauri.html?folder={}",
            encoded
        );
    }

    let url = WebviewUrl::App(url_str.into());

    WebviewWindowBuilder::new(&app_handle, &label, url)
        .title("VS Codeee")
        .inner_size(1200.0, 800.0)
        .min_inner_size(400.0, 270.0)
        .decorations(true)
        .build()
        .map_err(|e| format!("Failed to create window: {e}"))?;

    log::info!(
        target: "vscodeee::commands::window",
        "Opened new window: {} (folder: {:?})",
        label,
        options.folder_uri
    );

    Ok(())
}
