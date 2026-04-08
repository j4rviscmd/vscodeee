/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// Tauri commands exposed to the WebView via `invoke()`
mod commands;

/// Custom protocol handlers for vscode-file:// etc.
mod protocol;

/// IPC infrastructure — channel routing and event bus for VS Code's binary protocol.
mod ipc;

/// Extension Host sidecar management — spawn Node.js, communicate via named pipe.
/// TODO(Phase 1-2): Replace PoC direct handshake with WebSocket relay + TypeScript IExtensionHost impl
mod exthost;

/// PTY (pseudo-terminal) management — spawn shells, relay I/O to xterm.js via Tauri events.
/// Phase 0-4: Uses portable-pty for direct Rust PTY management.
mod pty;

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

    // IPC infrastructure — channel router + event bus
    let event_bus = ipc::event_bus::create_event_bus();
    let channel_router = Arc::new(ipc::channel::ChannelRouter::new(Arc::clone(&event_bus)));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty::manager::PtyManager::new())
        .manage(Arc::clone(&channel_router))
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
            commands::list_css_modules,
            commands::ipc_channel::ipc_message,
            commands::ipc_channel::ipc_handshake,
            commands::spawn_exthost::spawn_extension_host,
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::native_host::is_fullscreen,
            commands::native_host::toggle_fullscreen,
            commands::native_host::is_maximized,
            commands::native_host::maximize_window,
            commands::native_host::unmaximize_window,
            commands::native_host::minimize_window,
            commands::native_host::focus_window,
            commands::native_host::open_external,
            commands::native_host::get_os_properties,
            commands::native_host::get_os_statistics,
            commands::native_host::read_clipboard_text,
            commands::native_host::write_clipboard_text,
            commands::native_host::notify_ready,
            commands::native_host::close_window,
            commands::native_host::quit_app,
            commands::native_host::exit_app,
            commands::native_host::is_port_free,
            commands::native_host::find_free_port,
            commands::window::get_extended_window_configuration,
        ])
        .setup(move |app| {
            println!("[vscodeee] Tauri app started");

            // Open devtools in debug builds for WebView debugging
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Initialize protocol state with app root directories.
            let state = protocol::init_protocol_state(app);
            let _ = protocol_state.set(state);

            // Initialize IPC event bus with app handle.
            let app_handle = app.handle().clone();
            let eb = Arc::clone(&event_bus);
            tauri::async_runtime::spawn(async move {
                eb.init(app_handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
