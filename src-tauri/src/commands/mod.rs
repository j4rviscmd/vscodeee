/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands — the Rust equivalent of VS Code's `ICommonNativeHostService`.
//! These are exposed to the WebView via `window.__TAURI__.invoke()`.

pub mod file_watcher;
pub mod filesystem;
pub mod ipc_channel;
pub mod native_host;
pub mod spawn_exthost;
pub mod terminal;
pub mod window;

use serde::Serialize;
use std::path::Path;

/// Basic native host information for the workbench bootstrap.
/// This replaces the subset of `INativeWindowConfiguration` needed at startup.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHostInfo {
    /// OS name (e.g. `"macos"`, `"linux"`, `"windows"`). Retrieved from `std::env::consts::OS`.
    pub platform: String,
    /// CPU architecture (e.g. `"aarch64"`, `"x86_64"`). Retrieved from `std::env::consts::ARCH`.
    pub arch: String,
    /// Machine hostname. Returns `"unknown"` if retrieval fails.
    pub hostname: String,
    /// User's home directory path. Returns an empty string if retrieval fails.
    pub home_dir: String,
    /// OS temporary directory path.
    pub tmp_dir: String,
}

/// Window configuration passed to the workbench on startup.
/// Minimal subset for the PoC — will grow as more features are migrated.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfiguration {
    /// Unique window identifier. Uses a fixed value of `1` in the Phase 0 PoC.
    pub window_id: u32,
    /// Log level (`0` = Trace, `1` = Info, `2` = Warning, `3` = Error).
    pub log_level: u32,
    /// The filesystem path to the app's resource directory (Tauri resource_dir).
    pub resource_dir: String,
    /// The filesystem path to the frontend dist directory (where HTML/CSS/JS live).
    pub frontend_dist: String,
    /// Application data directory for user settings and state.
    /// e.g., `~/Library/Application Support/vscodeee` on macOS.
    pub app_data_dir: String,
}

/// Retrieve native host environment information.
///
/// Called during workbench bootstrap from the WebView to obtain platform
/// details such as OS, architecture, hostname, home directory, and
/// temporary directory. Equivalent to the Electron version's
/// `ICommonNativeHostService.getHostInfo()`.
///
/// # Returns
///
/// A [`NativeHostInfo`] representing the current runtime environment.
#[tauri::command]
pub fn get_native_host_info() -> NativeHostInfo {
    NativeHostInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
        home_dir: dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        tmp_dir: std::env::temp_dir().to_string_lossy().to_string(),
    }
}

/// Retrieve window startup configuration.
///
/// Returns the minimal window settings needed for workbench initialization.
/// In the Phase 0 PoC this returns fixed values, but it will be updated
/// dynamically as multi-window support is implemented.
///
/// # Returns
///
/// A [`WindowConfiguration`] representing the current window settings.
#[tauri::command]
pub fn get_window_configuration(app_handle: tauri::AppHandle) -> WindowConfiguration {
    use tauri::Manager;

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // In dev mode, frontendDist is "../out" relative to src-tauri/.
    // This matches tauri.conf.json and is where transpiled output lives.
    let frontend_dist = std::env::current_dir()
        .ok()
        .map(|cwd| {
            let dist = cwd.join("../out");
            dist.canonicalize()
                .unwrap_or(dist)
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default();

    // Application data directory for user settings/state.
    // Uses Tauri's path resolver which maps to platform-specific locations:
    //   macOS:   ~/Library/Application Support/vscodeee
    //   Windows: %APPDATA%/vscodeee
    //   Linux:   ~/.config/vscodeee
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .or_else(|_| {
            // Fallback: use dirs crate to build a path manually
            dirs::data_dir()
                .map(|d| d.join("vscodeee"))
                .ok_or(tauri::Error::UnknownPath)
        })
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            // Last resort: use home dir + .vscodeee
            dirs::home_dir()
                .map(|h| h.join(".vscodeee").to_string_lossy().to_string())
                .unwrap_or_default()
        });

    WindowConfiguration {
        window_id: 1,
        log_level: 1, // Info
        resource_dir,
        frontend_dist,
        app_data_dir,
    }
}

/// Recursively collect `.css` file paths under a directory.
fn collect_css_files(dir: &Path, root: &Path, result: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_css_files(&path, root, result);
        } else if path.extension().map_or(false, |ext| ext == "css") {
            if let Ok(rel) = path.strip_prefix(root) {
                result.push(rel.to_string_lossy().to_string());
            }
        }
    }
}

/// List all CSS module paths for the CSS import map.
///
/// Scans the transpiled output directory (`out/`) for `.css` files and returns
/// paths relative to `out/` (e.g., `vs/base/browser/ui/widget.css`).
/// The bootstrap uses these to create a CSS import map, mirroring the
/// Electron `cssModules` mechanism.
#[tauri::command]
pub fn list_css_modules() -> Vec<String> {
    let out_dir = std::env::current_dir()
        .ok()
        .map(|cwd| {
            let dir = cwd.join("../out");
            dir.canonicalize().unwrap_or(dir)
        })
        .unwrap_or_default();

    let mut modules = Vec::new();
    collect_css_files(&out_dir, &out_dir, &mut modules);
    modules.sort();
    modules
}
