/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window-related commands.
//!
//! Provides the extended window configuration needed by the Tauri workbench
//! beyond the basic `get_window_configuration` in `mod.rs`.

use serde::Serialize;
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
