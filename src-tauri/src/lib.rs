/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// Tauri commands exposed to the WebView via `invoke()`
mod commands;

/// Custom protocol handlers for vscode-file:// etc.
mod protocol;

/// Tauriアプリケーションを構築して実行する。
///
/// 以下のセットアップを行い、イベントループに入る:
///
/// 1. **プラグイン登録** — shell, dialog, os, fs の各Tauriプラグインを初期化
/// 2. **カスタムプロトコル** — `vscode-file://` スキームを登録し、ローカルファイルへの
///    安全なアクセスを提供 ([`protocol::handle_vscode_file_protocol`])
/// 3. **コマンドハンドラ** — WebViewから `invoke()` で呼び出せるTauriコマンドを登録
///
/// # Panics
///
/// Tauriアプリケーションの実行中にエラーが発生した場合にパニックする。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .register_uri_scheme_protocol("vscode-file", protocol::handle_vscode_file_protocol)
        .invoke_handler(tauri::generate_handler![
            commands::get_native_host_info,
            commands::get_window_configuration,
        ])
        .setup(|_app| {
            println!("[vscodee] Tauri app started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
