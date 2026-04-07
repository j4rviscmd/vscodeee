/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands — the Rust equivalent of VS Code's `ICommonNativeHostService`.
//! These are exposed to the WebView via `window.__TAURI__.invoke()`.

pub mod spawn_exthost;
pub mod terminal;

use serde::Serialize;

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

    // In dev mode, frontendDist is "../src/vs/code/tauri-browser/workbench"
    // relative to src-tauri/. Resolve it from the CWD (which Tauri sets to src-tauri/).
    let frontend_dist = std::env::current_dir()
        .ok()
        .map(|cwd| {
            let dist = cwd.join("../src/vs/code/tauri-browser/workbench");
            dist.canonicalize().unwrap_or(dist)
        })
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    WindowConfiguration {
        window_id: 1,
        log_level: 1, // Info
        resource_dir,
        frontend_dist,
    }
}
