/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// Tauri commands exposed to the WebView via `invoke()`
mod commands;

/// Custom protocol handlers for vscode-file:// etc.
mod protocol;

/// Extension Host sidecar management — spawn Node.js, communicate via named pipe.
/// TODO(Phase 1-2): Replace PoC direct handshake with WebSocket relay + TypeScript IExtensionHost impl
mod exthost;

/// Tauriアプリケーションを構築して実行する。
///
/// 以下のセットアップを行い、イベントループに入る:
///
/// 1. **プラグイン登録** — shell, dialog, os, fs の各Tauriプラグインを初期化
/// 2. **カスタムプロトコル** — `vscode-file://` スキームを登録し、ローカルファイルへの
///    安全なアクセスを提供 ([`protocol::handle_vscode_file_protocol`])
/// 3. **コマンドハンドラ** — WebViewから `invoke()` で呼び出せるTauriコマンドを登録
/// 4. **セットアップ** — プロトコル状態の初期化（valid rootsの登録）
///
/// # Panics
///
/// Tauriアプリケーションの実行中にエラーが発生した場合にパニックする。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-build protocol state so the handler closure can capture it.
    // We use a OnceCell to defer actual root registration until setup(),
    // where the Tauri App handle is available.
    use std::sync::Arc;
    let protocol_state: Arc<std::sync::OnceLock<Arc<protocol::ProtocolState>>> =
        Arc::new(std::sync::OnceLock::new());
    let state_for_handler = Arc::clone(&protocol_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .register_uri_scheme_protocol("vscode-file", move |ctx, request| {
            // On first call the state will have been initialized by setup().
            // If somehow called before setup (shouldn't happen), return 503.
            match state_for_handler.get() {
                Some(state) => {
                    let handler =
                        protocol::handle_vscode_file_protocol::<tauri::Wry>(Arc::clone(state));
                    handler(ctx, request)
                }
                None => tauri::http::Response::builder()
                    .status(503)
                    .body(b"Protocol not yet initialized".to_vec())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_native_host_info,
            commands::get_window_configuration,
            commands::spawn_exthost::spawn_extension_host,
        ])
        .setup(move |app| {
            println!("[vscodee] Tauri app started");

            // Initialize protocol state with app root directories.
            let state = protocol::init_protocol_state(app);
            let _ = protocol_state.set(state);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
