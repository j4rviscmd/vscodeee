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

/// Window management — registry, event forwarding, and session persistence.
mod window;

/// Extension Host sidecar management — spawn Node.js, communicate via named pipe.
/// TODO(Phase 1-2): Replace PoC direct handshake with WebSocket relay + TypeScript IExtensionHost impl
mod exthost;

/// Logging configuration — tauri-plugin-log with AI-agent-readable format.
mod logging;

/// PTY (pseudo-terminal) management — spawn shells, relay I/O to xterm.js via Tauri events.
/// Phase 0-4: Uses portable-pty for direct Rust PTY management.
mod pty;

/// Build and run the Tauri application.
///
/// Performs the following setup before entering the event loop:
///
/// 1. **Plugin registration** — Initialize shell, dialog, os, fs Tauri plugins
/// 2. **Custom protocol** — Register the `vscode-file://` scheme for secure
///    access to local files ([`protocol::handle_vscode_file_protocol`])
/// 3. **Command handlers** — Register Tauri commands callable from the WebView via `invoke()`
/// 4. **Setup** — Initialize protocol state (register valid roots)
///
/// # Panics
///
/// Panics if an error occurs while running the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-build protocol state so the handler closure can capture it.
    // We use a OnceCell to defer actual root registration until setup(),
    // where the Tauri App handle is available.
    use std::sync::{Arc, OnceLock};
    let protocol_state: Arc<OnceLock<Arc<protocol::ProtocolState>>> = Arc::new(OnceLock::new());
    let state_for_handler = Arc::clone(&protocol_state);

    // IPC infrastructure — channel router + event bus
    let event_bus = ipc::event_bus::create_event_bus();
    let channel_router = Arc::new(ipc::channel::ChannelRouter::new(Arc::clone(&event_bus)));

    // Window management — centralized registry for all open windows
    let window_manager = Arc::new(window::manager::WindowManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(logging::build_plugin().build())
        .manage(pty::manager::PtyManager::new())
        .manage(commands::file_watcher::FileWatcherState::new())
        .manage(Arc::clone(&channel_router))
        .manage(Arc::clone(&window_manager))
        .on_window_event(window::events::handle_window_event)
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
            commands::native_host::move_item_to_trash,
            commands::native_host::kill_process,
            commands::native_host::relaunch_app,
            commands::native_host::install_shell_command,
            commands::native_host::uninstall_shell_command,
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
            commands::filesystem::fs_stat,
            commands::filesystem::fs_read_dir,
            commands::filesystem::fs_read_file,
            commands::filesystem::fs_write_file,
            commands::filesystem::fs_mkdir,
            commands::filesystem::fs_delete,
            commands::filesystem::fs_rename,
            commands::filesystem::fs_copy,
            commands::filesystem::fs_show_item_in_folder,
            commands::filesystem::show_message_box,
            commands::filesystem::show_save_dialog,
            commands::filesystem::show_open_dialog,
            commands::window::get_extended_window_configuration,
            commands::window::open_new_window,
            commands::window::get_all_windows,
            commands::window::get_window_count,
            commands::file_watcher::fs_watch_start,
            commands::file_watcher::fs_watch_stop,
            commands::file_watcher::fs_watch_stop_all,
        ])
        .setup(move |app| {
            log::info!(target: "vscodeee", "Tauri app started");

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

            // Register the initial window created by tauri.conf.json (label="main").
            // Use block_on here (safe: setup() runs before the event loop starts)
            // to avoid a race where early window events arrive before registration.
            let wm = Arc::clone(&window_manager);
            tauri::async_runtime::block_on(async move {
                wm.register_initial_window("main").await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
