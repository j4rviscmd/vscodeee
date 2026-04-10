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

    // Lifecycle — tracks pending close handshakes for safety-net timeouts
    let pending_closes = Arc::new(window::events::PendingCloses::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(logging::build_plugin().build())
        .manage(pty::manager::PtyManager::new())
        .manage(commands::file_watcher::FileWatcherState::new())
        .manage(Arc::clone(&channel_router))
        .manage(Arc::clone(&window_manager))
        .manage(Arc::clone(&pending_closes))
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
            commands::get_product_json,
            commands::extensions::list_builtin_extensions,
            commands::ipc_channel::ipc_message,
            commands::ipc_channel::ipc_handshake,
            commands::spawn_exthost::spawn_extension_host,
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            // ── Window commands ──
            commands::native_host::is_fullscreen,
            commands::native_host::toggle_fullscreen,
            commands::native_host::is_maximized,
            commands::native_host::maximize_window,
            commands::native_host::unmaximize_window,
            commands::native_host::minimize_window,
            commands::native_host::focus_window,
            commands::native_host::move_window_top,
            commands::native_host::position_window,
            commands::native_host::toggle_always_on_top,
            commands::native_host::set_always_on_top,
            commands::native_host::is_always_on_top,
            commands::native_host::set_minimum_size,
            commands::native_host::get_active_window_position,
            commands::native_host::get_cursor_screen_point,
            // ── Clipboard commands ──
            commands::native_host::read_clipboard_text,
            commands::native_host::write_clipboard_text,
            commands::native_host::write_clipboard_buffer,
            commands::native_host::read_clipboard_buffer,
            commands::native_host::has_clipboard,
            commands::native_host::read_clipboard_find_text,
            commands::native_host::write_clipboard_find_text,
            commands::native_host::read_clipboard_image,
            commands::native_host::trigger_paste,
            // ── OS commands ──
            commands::native_host::get_os_properties,
            commands::native_host::get_os_statistics,
            commands::native_host::is_admin,
            commands::native_host::is_running_under_arm64_translation,
            commands::native_host::get_os_virtual_machine_hint,
            commands::native_host::get_process_id,
            commands::native_host::get_os_color_scheme,
            commands::native_host::has_wsl_feature_installed,
            commands::native_host::windows_get_string_reg_key,
            // ── Lifecycle commands ──
            commands::native_host::notify_ready,
            commands::native_host::close_window,
            commands::native_host::lifecycle_close_confirmed,
            commands::native_host::lifecycle_close_vetoed,
            commands::native_host::quit_app,
            commands::native_host::exit_app,
            commands::native_host::save_session,
            commands::native_host::relaunch_app,
            // ── Network commands ──
            commands::native_host::is_port_free,
            commands::native_host::find_free_port,
            commands::native_host::resolve_proxy,
            commands::native_host::load_certificates,
            // ── Shell commands ──
            commands::native_host::open_external,
            commands::native_host::move_item_to_trash,
            commands::native_host::kill_process,
            commands::native_host::install_shell_command,
            commands::native_host::uninstall_shell_command,
            // ── Power commands ──
            commands::native_host::get_system_idle_state,
            commands::native_host::get_system_idle_time,
            commands::native_host::get_current_thermal_state,
            commands::native_host::is_on_battery_power,
            commands::native_host::start_power_save_blocker,
            commands::native_host::stop_power_save_blocker,
            commands::native_host::is_power_save_blocker_started,
            // ── Misc commands ──
            commands::native_host::create_zip_file,
            commands::native_host::show_toast,
            commands::native_host::clear_toast,
            commands::native_host::clear_toasts,
            commands::native_host::write_elevated,
            // ── Filesystem commands ──
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
            // ── Window management commands ──
            commands::window::get_extended_window_configuration,
            commands::window::open_new_window,
            commands::window::get_all_windows,
            commands::window::get_window_count,
            commands::window::set_workspace_uri,
            // ── File watcher commands ──
            commands::file_watcher::fs_watch_start,
            commands::file_watcher::fs_watch_stop,
            commands::file_watcher::fs_watch_stop_all,
        ])
        .setup(move |app| {
            log::info!(target: "vscodeee", "Tauri app started");

            // ── Read user settings and load session ──
            let settings = window::settings::read_window_settings();
            let session = window::session::SessionStore::load();

            // ── Compute restore plan ──
            let restore_plan = window::restore::compute_restore_plan(
                settings.restore_windows,
                settings.restore_fullscreen,
                &session,
            );

            log::info!(
                target: "vscodeee",
                "Restore plan: {} windows (mode={:?})",
                restore_plan.len(),
                settings.restore_windows
            );

            // On Windows/Linux, disable decorations at runtime so we use our custom
            // title bar. On macOS, we keep decorations=true + titleBarStyle=Overlay
            // to preserve the native traffic lights and rounded corners.
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

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

            // ── Register the initial "main" window from tauri.conf.json ──
            // The first entry in the restore plan always maps to label "main".
            let wm = Arc::clone(&window_manager);
            let first_entry = restore_plan.first().cloned();
            tauri::async_runtime::block_on(async {
                let id = wm.register_initial_window("main").await;

                // If the first restored entry has a workspace, set it on the main window
                if let Some(ref entry) = first_entry {
                    let workspace = entry
                        .folder_uri
                        .clone()
                        .or_else(|| entry.workspace_uri.clone());
                    if workspace.is_some() {
                        wm.set_workspace("main", workspace).await;
                    }
                    if entry.is_fullscreen {
                        wm.set_fullscreen("main", true).await;
                    }
                }

                log::info!(
                    target: "vscodeee",
                    "Registered initial window: id={id}"
                );
            });

            // Apply fullscreen to the main window if restored
            if let Some(ref entry) = first_entry {
                if entry.is_fullscreen {
                    use tauri::Manager;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_fullscreen(true);
                    }
                }
            }

            // ── Create additional restored windows ──
            // Windows beyond the first one need to be created programmatically.
            if restore_plan.len() > 1 {
                let wm = Arc::clone(&window_manager);
                let handle = app.handle().clone();
                let additional_entries: Vec<_> = restore_plan[1..].to_vec();

                tauri::async_runtime::block_on(async {
                    for entry in &additional_entries {
                        match wm
                            .create_restored_window(
                                &handle,
                                &entry.label,
                                entry.folder_uri.as_deref(),
                                entry.workspace_uri.as_deref(),
                                entry.is_fullscreen,
                            )
                            .await
                        {
                            Ok(id) => {
                                log::info!(
                                    target: "vscodeee",
                                    "Restored window: label={}, id={id}, folder={:?}",
                                    entry.label,
                                    entry.folder_uri
                                );
                            }
                            Err(e) => {
                                log::error!(
                                    target: "vscodeee",
                                    "Failed to restore window '{}': {e}",
                                    entry.label
                                );
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
