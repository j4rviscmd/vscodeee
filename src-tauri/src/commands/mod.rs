/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands — the Rust equivalent of VS Code's `ICommonNativeHostService`.
//! These are exposed to the WebView via `window.__TAURI__.invoke()`.

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
    /// OS名 (例: `"macos"`, `"linux"`, `"windows"`)。`std::env::consts::OS` から取得。
    pub platform: String,
    /// CPUアーキテクチャ (例: `"aarch64"`, `"x86_64"`)。`std::env::consts::ARCH` から取得。
    pub arch: String,
    /// マシンのホスト名。取得に失敗した場合は `"unknown"` を返す。
    pub hostname: String,
    /// ユーザーのホームディレクトリパス。取得に失敗した場合は空文字列を返す。
    pub home_dir: String,
    /// OSの一時ディレクトリパス。
    pub tmp_dir: String,
}

/// Window configuration passed to the workbench on startup.
/// Minimal subset for the PoC — will grow as more features are migrated.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowConfiguration {
    /// ウィンドウの一意な識別子。Phase 0 PoCでは固定値 `1` を使用。
    pub window_id: u32,
    /// ログレベル (`0` = Trace, `1` = Info, `2` = Warning, `3` = Error)。
    pub log_level: u32,
    /// The filesystem path to the app's resource directory (Tauri resource_dir).
    pub resource_dir: String,
    /// The filesystem path to the frontend dist directory (where HTML/CSS/JS live).
    pub frontend_dist: String,
    /// Application data directory for user settings and state.
    /// e.g., `~/Library/Application Support/vscodeee` on macOS.
    pub app_data_dir: String,
}

/// ネイティブホスト環境の情報を取得する。
///
/// WebView側のワークベンチ起動時に、OS・アーキテクチャ・ホスト名・
/// ホームディレクトリ・一時ディレクトリなどのプラットフォーム情報を返す。
/// Electron版における `ICommonNativeHostService.getHostInfo()` に相当する。
///
/// # Returns
///
/// 現在の実行環境を表す [`NativeHostInfo`]。
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

/// ウィンドウの起動設定を取得する。
///
/// ワークベンチの初期化に必要な最小限のウィンドウ設定を返す。
/// Phase 0 PoCでは固定値を返すが、今後マルチウィンドウ対応で動的に変更される。
///
/// # Returns
///
/// 現在のウィンドウ設定を表す [`WindowConfiguration`]。
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
            dist.canonicalize().unwrap_or(dist)
        })
        .map(|p| p.to_string_lossy().to_string())
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
