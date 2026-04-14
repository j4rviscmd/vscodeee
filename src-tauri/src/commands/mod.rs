/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands — the Rust equivalent of VS Code's `ICommonNativeHostService`.
//! These are exposed to the WebView via `window.__TAURI__.invoke()`.

pub mod extension_management;
pub mod extensions;
pub mod file_watcher;
pub mod filesystem;
pub mod ipc_channel;
pub mod native_host;
pub mod secret_storage;
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
    /// Folder URI restored from the previous session, if any.
    /// Used as a fallback when the URL query string doesn't contain `?folder=`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_folder_uri: Option<String>,
    /// Workspace URI restored from the previous session, if any.
    /// Used as a fallback when the URL query string doesn't contain `?workspace=`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_workspace_uri: Option<String>,
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
/// Resolves the window ID dynamically from the `WindowManager` using the
/// Tauri window label (instead of the old hardcoded value of 1).
///
/// # Returns
///
/// A [`WindowConfiguration`] representing the current window settings.
#[tauri::command]
pub async fn get_window_configuration(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<WindowConfiguration, String> {
    use tauri::Manager;

    let label = window.label().to_string();
    let window_id = window_manager.id_for_label(&label).await.unwrap_or(1); // Fallback for initial bootstrap race

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
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .or_else(|_| {
            dirs::data_dir()
                .map(|d| d.join("vscodeee"))
                .ok_or(tauri::Error::UnknownPath)
        })
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .map(|h| h.join(".vscodeee").to_string_lossy().to_string())
                .unwrap_or_default()
        });

    // Look up restored workspace/folder URI from the WindowManager state.
    // `consume_restored_uri` returns the URI on the first call after app start
    // and None on subsequent calls (e.g. after "Close Folder" page reload).
    let restored_folder_uri = window_manager.consume_restored_uri(&label).await;
    let restored_workspace_uri: Option<String> = None; // workspace files handled separately

    Ok(WindowConfiguration {
        window_id,
        log_level: 1, // Info
        resource_dir,
        frontend_dist,
        app_data_dir,
        restored_folder_uri,
        restored_workspace_uri,
    })
}

/// Recursively collect `.css` file paths under a directory.
///
/// Walks the directory tree rooted at `dir`, collecting all files with the
/// `.css` extension. Paths are stored relative to `root`.
///
/// # Arguments
///
/// * `dir` - The directory to scan (recurses into subdirectories).
/// * `root` - The base path used to compute relative paths for results.
/// * `result` - Accumulator for discovered CSS file paths (relative to `root`).
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

/// Read product.json and package.json from the project root.
///
/// Returns both files as raw JSON values so the bootstrap script can set
/// `globalThis._VSCODE_PRODUCT_JSON` and `globalThis._VSCODE_PACKAGE_JSON`
/// before any workbench modules are imported. This is critical because
/// `product.ts` checks these globals to configure services like the
/// Extension Gallery (marketplace).
///
/// The project root is resolved as `../` relative to `src-tauri/` (the
/// Tauri process working directory during `cargo tauri dev`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPackageJson {
    /// Contents of `product.json` as a raw JSON value.
    pub product: serde_json::Value,
    /// Contents of `package.json` as a raw JSON value.
    pub package: serde_json::Value,
}

#[tauri::command]
pub fn get_product_json() -> Result<ProductPackageJson, String> {
    let project_root = std::env::current_dir()
        .map_err(|e| format!("Failed to get cwd: {e}"))?
        .join("..");

    let product_path = project_root.join("product.json");
    let package_path = project_root.join("package.json");

    let product_str = std::fs::read_to_string(&product_path).map_err(|e| {
        format!(
            "Failed to read product.json at {}: {e}",
            product_path.display()
        )
    })?;
    let package_str = std::fs::read_to_string(&package_path).map_err(|e| {
        format!(
            "Failed to read package.json at {}: {e}",
            package_path.display()
        )
    })?;

    let product: serde_json::Value = serde_json::from_str(&product_str)
        .map_err(|e| format!("Failed to parse product.json: {e}"))?;
    let package: serde_json::Value = serde_json::from_str(&package_str)
        .map_err(|e| format!("Failed to parse package.json: {e}"))?;

    Ok(ProductPackageJson { product, package })
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
