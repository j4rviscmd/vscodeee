/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// Tauri commands exposed to the WebView via `invoke()`.
mod commands;

/// Shutdown coordination — ordered cleanup of child processes and threads.
///
/// Ensures that extension hosts, PTY instances, and file watchers are torn
/// down in the correct sequence during application exit.
mod shutdown;

/// Custom protocol handlers for `vscode-file://` URIs.
///
/// Implements the same security model as Electron's `ProtocolMainService`:
/// root validation, CORS, COOP/COEP, and MIME type resolution.
mod protocol;

/// IPC infrastructure — channel routing and event bus for VS Code's binary IPC protocol.
///
/// Replaces Electron's `ipcMain` / `ipcRenderer` with a Tauri-native
/// implementation supporting multiplexed named channels and event bus semantics.
mod ipc;

/// Window management — centralized registry, event forwarding, and session persistence.
///
/// Manages multi-window lifecycle including creation, close negotiation,
/// fullscreen state, and session-based window restoration.
mod window;

/// Extension Host sidecar management — spawn Node.js, communicate via named pipe.
///
/// TODO(Phase 1-2): Replace PoC direct handshake with WebSocket relay + TypeScript IExtensionHost impl
mod exthost;

/// Logging configuration — `tauri-plugin-log` with structured, AI-agent-readable format.
mod logging;

/// System event monitoring — OS-level events (suspend, resume, lock, battery)
/// forwarded to the WebView via Tauri's `app.emit()` mechanism.
mod system_events;

/// PTY (pseudo-terminal) management — spawn shells, relay I/O to xterm.js via Tauri events.
///
/// Phase 0-4: Uses `portable-pty` for direct Rust PTY management with
/// persistent state storage for terminal sessions across restarts.
mod pty;

/// CLI argument handling for the `eee` launcher command.
///
/// Public because it is shared with the single-instance plugin callback
/// to route forwarded CLI arguments from a second process instance.
pub mod cli;

/// Build and run the Tauri application.
///
/// This is the main entry point for the application. It constructs a Tauri
/// [`Builder`], registers all plugins and managed state, wires up lifecycle
/// hooks, and starts the event loop.
///
/// # Initialization sequence
///
/// 1. **Shared state** — Create `OnceLock<ProtocolState>`, `EventBus`,
///    `ChannelRouter`, `WindowManager`, `PendingCloses`, and `PendingShows`.
/// 2. **Single-instance plugin** *(release builds only)* — Register
///    `tauri_plugin_single_instance` so that a second process forwards its CLI
///    arguments to the already-running instance instead of opening a new window.
///    Disabled in debug builds to allow running production and dev builds
///    side-by-side for testing.
/// 3. **Plugin registration** — Initialize shell, dialog, os, fs, clipboard,
///    window-state, deep-link, updater, and logging plugins.
///    In debug builds, `tauri_plugin_mcp_bridge` is also registered for AI
///    agent automation via WebSocket.
/// 4. **Managed state** — Register stateful services (`PtyManager`,
///    `FileWatcherState`, `ExtHostState`, `ShutdownCoordinator`, etc.) so they
///    are accessible from Tauri command handlers.
/// 5. **Custom protocol** — Register the `vscode-file://` scheme for secure
///    access to local files ([`protocol::handle_vscode_file_protocol_async`]).
/// 6. **Command handlers** — Register all Tauri commands callable from the
///    WebView via `invoke()`.
/// 7. **Setup closure** — Executed once before the event loop starts:
///    - Initialize terminal state store from `app_data_dir`.
///    - Set up OS-level system event monitors (suspend, resume, lock, battery).
///    - Register shutdown resources with [`shutdown::ShutdownCoordinator`]
///      (extension hosts, PTY instances, file watchers).
///    - Read user window settings and load the session store.
///    - Compute the window restore plan based on settings and session data.
///    - Apply platform-specific window chrome to the initial "main" window.
///    - Initialize protocol state with app root directories.
///    - Set up deep-link forwarding from `deep-link://new-url` to the WebView.
///    - Initialize the IPC event bus with the app handle.
///    - Register the initial "main" window in the `WindowManager`.
///    - Register ready-to-show safety timeouts for all windows.
///    - Create additional restored windows from the session.
///    - Route first-instance CLI arguments to window operations.
/// 8. **Run loop** — On `RunEvent::Exit`, execute the full shutdown sequence
///    via [`shutdown::ShutdownCoordinator::shutdown_all`].
///
/// # Arguments
///
/// * `gui_args` - Parsed CLI arguments from the `eee` launcher, if any.
///   When present and non-empty, these override the session restore plan
///   (e.g., `eee /path/to/project` opens that path instead of restoring
///   previous windows).
///
/// # Panics
///
/// Panics if the Tauri application fails to build (see `.expect()` on
/// `.build()`).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(gui_args: Option<cli::dispatch::ParsedGuiArgs>) {
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

    // Ready-to-show — tracks pending show handshakes so hidden windows
    // are shown automatically if the TypeScript bootstrap crashes.
    let pending_shows = Arc::new(window::events::PendingShows::new());

    // ── Single-instance lock (release builds only) ─────────────────────
    // IMPORTANT: single-instance plugin must be registered first so the
    // second-process detection happens before any other plugin setup.
    // Release only — disabled in dev to allow running production and dev
    // builds side-by-side for testing.
    //
    // When a second instance is launched, its CLI arguments are parsed and
    // forwarded to the first instance via `cli::router::route_gui_args`,
    // which opens new windows or focuses existing ones as appropriate.
    #[cfg(not(debug_assertions))]
    let builder = {
        let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(
            |app, args, cwd| {
                use tauri::Manager;
                log::info!(
                    target: "vscodeee::single_instance",
                    "Received single-instance callback: args={args:?}, cwd={cwd}"
                );
                let wm =
                    match app.try_state::<std::sync::Arc<window::manager::WindowManager>>() {
                        Some(wm) => wm.inner().clone(),
                        None => {
                            log::error!(target: "vscodeee::single_instance", "WindowManager not available in single-instance callback");
                            return;
                        }
                    };
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let parsed = cli::dispatch::parse_gui_args(&args);
                    cli::router::route_gui_args(&handle, &wm, &parsed, &cwd).await;
                });
            },
        ));
        builder
    };
    #[cfg(debug_assertions)]
    let builder = tauri::Builder::default();

    let builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE
                        - tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(logging::build_plugin().build());

    // MCP Bridge — WebSocket server for AI agent automation (debug builds only).
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    // Quit coordination — tracks whether a multi-window quit is in progress
    let quit_state = Arc::new(window::quit_state::QuitState::new());

    builder
        .manage(pty::manager::PtyManager::new())
        .manage(commands::file_watcher::FileWatcherState::new())
        .manage(commands::spawn_exthost::ExtHostState::new())
        .manage(Arc::clone(&channel_router))
        .manage(Arc::clone(&window_manager))
        .manage(Arc::clone(&pending_closes))
        .manage(Arc::clone(&pending_shows))
        .manage(Arc::clone(&quit_state))
        .manage(commands::updater::UpdaterState::default())
        .manage(shutdown::ShutdownCoordinator::new())
        .on_window_event(window::events::handle_window_event)
        .register_asynchronous_uri_scheme_protocol("vscode-file", move |ctx, request, responder| {
            // On first call the state will have been initialized by setup().
            // If somehow called before setup (shouldn't happen), return 503.
            match state_for_handler.get() {
                Some(state) => {
                    let handler =
                        protocol::handle_vscode_file_protocol_async::<tauri::Wry>(Arc::clone(state));
                    handler(ctx, request, responder)
                }
                None => responder.respond(
                    tauri::http::Response::builder()
                        .status(503)
                        .body(b"Protocol not yet initialized".to_vec())
                        .unwrap(),
                ),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_native_host_info,
            commands::get_window_configuration,
            commands::list_css_modules,
            commands::cache_theme_colors,
            commands::get_product_json,
            commands::extensions::list_builtin_extensions,
            commands::ipc_channel::ipc_message,
            commands::ipc_channel::ipc_handshake,
            commands::spawn_exthost::spawn_extension_host,
            commands::spawn_exthost::spawn_exthost_with_relay,
            commands::spawn_exthost::kill_exthost,
            commands::spawn_exthost::kill_all_exthosts,
            commands::terminal::create_terminal,
            commands::terminal::activate_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::get_default_shell,
            commands::terminal::get_environment,
            commands::terminal::send_terminal_signal,
            commands::terminal::list_terminals,
            commands::terminal::detect_shells,
            commands::terminal::persist_terminal_state,
            commands::terminal::load_terminal_state,
            commands::terminal::persist_terminal_layout,
            commands::terminal::load_terminal_layout,
            commands::terminal::install_auto_reply,
            commands::terminal::uninstall_all_auto_replies,
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
            // ── DevTools commands ──
            commands::native_host::open_devtools,
            commands::native_host::close_devtools,
            commands::native_host::is_devtools_open,
            commands::native_host::toggle_devtools,
            // ── Clipboard commands ──
            commands::native_host::read_clipboard_text,
            commands::native_host::write_clipboard_text,
            commands::native_host::write_clipboard_buffer,
            commands::native_host::read_clipboard_buffer,
            commands::native_host::has_clipboard,
            commands::native_host::read_clipboard_find_text,
            commands::native_host::write_clipboard_find_text,
            commands::native_host::read_clipboard_image,
            commands::native_host::has_clipboard_image,
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
            commands::native_host::is_dev_build,
            commands::native_host::close_window,
            commands::native_host::lifecycle_close_confirmed,
            commands::native_host::lifecycle_close_vetoed,
            commands::native_host::quit_app,
            commands::native_host::quit_all_windows,
            commands::native_host::exit_app,
            commands::native_host::save_session,
            commands::native_host::relaunch_app,
            // ── Network commands ──
            commands::native_host::is_port_free,
            commands::native_host::find_free_port,
            commands::native_host::resolve_proxy,
            commands::native_host::load_certificates,
            commands::native_host::lookup_authorization,
            // ── Shell commands ──
            commands::native_host::open_external,
            commands::native_host::move_item_to_trash,
            commands::native_host::kill_process,
            commands::native_host::install_shell_command,
            commands::native_host::uninstall_shell_command,
            // ── Screenshot commands ──
            commands::native_host::capture_screenshot,
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
            commands::native_host::enumerate_fonts,
            // ── macOS metadata commands ──
            commands::native_host::set_represented_filename,
            commands::native_host::set_document_edited,
            commands::native_host::get_native_window_handle,
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
            // ── Storage commands (text-based, for TauriStorageService) ──
            commands::filesystem::storage_read_text_file,
            commands::filesystem::storage_write_atomic,
            // ── Window management commands ──
            commands::window::get_extended_window_configuration,
            commands::window::open_new_window,
            commands::window::get_all_windows,
            commands::window::get_window_count,
            commands::window::set_workspace_uri,
            commands::window::set_webview_zoom,
            // ── File watcher commands ──
            commands::file_watcher::fs_watch_start,
            commands::file_watcher::fs_watch_stop,
            commands::file_watcher::fs_watch_stop_all,
            // ── Extension management commands ──
            commands::extension_management::ext_extract_vsix,
            commands::extension_management::ext_read_vsix_manifest,
            commands::extension_management::ext_delete_extension,
            commands::extension_management::ext_scan_installed,
            commands::extension_management::ext_get_target_platform,
            commands::extension_management::ext_compute_extension_size,
            // ── Encryption commands (master-key approach) ──
            commands::secret_storage::encryption_is_available,
            commands::secret_storage::encryption_encrypt,
            commands::secret_storage::encryption_decrypt,
            // ── Updater commands ──
            commands::updater::updater_check_for_updates,
            commands::updater::updater_download_and_install,
            commands::updater::updater_restart_and_update,
            commands::updater::updater_get_current_version,
            // ── Transparency commands ──
            commands::transparency::set_native_transparency,
        ])
        .setup(move |app| {
            use tauri::Manager;

            log::info!(target: "vscodeee", "Tauri app started");

            // ── Initialize terminal state store ──
            {
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let store = pty::state::TerminalStateStore::new(&data_dir);
                    if let Some(mgr) = app.try_state::<pty::manager::PtyManager>() {
                        mgr.set_state_store(store);
                        log::info!(target: "vscodeee", "Terminal state store initialized at {:?}", data_dir);
                    }
                } else {
                    log::warn!(target: "vscodeee", "Could not resolve app_data_dir for terminal state store");
                }
            }

            // ── Initialize system event monitoring ──
            log::debug!(target: "vscodeee", "Setting up system event monitors");
            system_events::setup(app);

            // ── Register resources with ShutdownCoordinator ──
            {
                use shutdown::ShutdownPhase;

                let coordinator = app.state::<Arc<shutdown::ShutdownCoordinator>>();
                let coordinator = coordinator.inner();
                let handle = app.handle().clone();

                // Phase 0: Extension Hosts — kill Node.js sidecar processes
                {
                    let h = handle.clone();
                    coordinator.register(ShutdownPhase::Extensions, "Extension Hosts", Box::new(move || {
                        if let Some(state) = h.try_state::<Arc<commands::spawn_exthost::ExtHostState>>() {
                            state.inner().sync_kill_all();
                        }
                    }));
                }

                // Phase 1: PTY instances — close all shell processes
                {
                    let h = handle.clone();
                    coordinator.register(ShutdownPhase::Pty, "PTY Manager", Box::new(move || {
                        if let Some(pty) = h.try_state::<pty::manager::PtyManager>() {
                            pty.close_all();
                        }
                    }));
                }

                // Phase 2: File watchers — stop all watcher threads
                {
                    let h = handle.clone();
                    coordinator.register(ShutdownPhase::FileWatchers, "File Watchers", Box::new(move || {
                        if let Some(watchers) = h.try_state::<commands::file_watcher::FileWatcherState>() {
                            watchers.shutdown_all();
                        }
                    }));
                }

                log::info!(target: "vscodeee", "ShutdownCoordinator resources registered");
            }

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

            // Apply platform-specific window chrome to the initial window.
            // On macOS, decorations=true + Overlay title bar preserves traffic lights.
            // On Windows/Linux, decorations=false enables the custom HTML title bar.
            // This is now centralized in WindowChromeConfig — the same logic used
            // for dynamic windows (open_window) and restored windows.
            {
                let chrome = window::chrome::WindowChromeConfig::for_platform();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(chrome.decorations);
                    // Show the window immediately so the user sees the splash
                    // overlay (spinner + watermark) rendered by inline HTML/CSS.
                    // hideSplash() in workbench-tauri.ts removes the overlay
                    // after the workbench finishes loading.
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            // DevTools auto-open disabled. Uncomment to re-enable during debugging.
            // #[cfg(debug_assertions)]
            // {
            //     if let Some(window) = app.get_webview_window("main") {
            //         window.open_devtools();
            //     }
            // }

            // Initialize protocol state with app root directories.
            let state = protocol::init_protocol_state(app);
            let _ = protocol_state.set(state);

            // ── Deep-link handler ──
            // Forward deep-link URLs (vscodeee://*) to the WebView so the
            // TypeScript URI handler can process OAuth callbacks.
            {
                use tauri::{Emitter, Listener};
                let handle = app.handle().clone();
                app.listen("deep-link://new-url", move |event| {
                    // The event payload is a JSON-serialized Vec<String> of URLs.
                    if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
                        for url in &urls {
                            log::info!(
                                target: "vscodeee::deep_link",
                                "Received deep-link URL: {url}"
                            );
                            // Emit to all WebView windows so the URI handler can pick it up.
                            let _ = handle.emit("deep-link-open", url.as_str());
                        }
                    }
                });
            }

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
                        wm.set_workspace_uri("main", workspace).await;
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

            // Register ready-to-show safety timeout for the main window.
            // If the TypeScript bootstrap never calls `notify_ready`, the
            // window is shown after 30 seconds to avoid a permanently
            // invisible application.
            app.state::<Arc<window::events::PendingShows>>()
                .spawn_safety_timeout(app.handle(), "main");

            // Apply fullscreen to the main window if restored
            if let Some(ref entry) = first_entry {
                if entry.is_fullscreen {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_fullscreen(true);
                    }
                }
            }

            // ── Create additional restored windows ──
            // Windows beyond the first one need to be created programmatically.
            // Skip if CLI args override the session (user explicitly opened files/folders).
            let cli_overrides_session = gui_args
                .as_ref()
                .is_some_and(|a| !a.paths.is_empty());

            if !cli_overrides_session && restore_plan.len() > 1 {
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

                                // Register ready-to-show safety timeout
                                let ps = handle.state::<Arc<window::events::PendingShows>>();
                                ps.spawn_safety_timeout(&handle, &entry.label);
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

            // ── Route first-instance CLI arguments ──
            // When the user launches `eee /path/to/project` for the first time,
            // the CLI args need to be routed to window operations.
            if let Some(ref args) = gui_args {
                if !args.paths.is_empty() {
                    let path_count = args.paths.len();
                    let handle = app.handle().clone();
                    let wm = Arc::clone(&window_manager);
                    let args = args.clone();
                    let cwd = std::env::current_dir()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| ".".to_string());
                    tauri::async_runtime::spawn(async move {
                        cli::router::route_gui_args(&handle, &wm, &args, &cwd).await;
                    });
                    log::info!(
                        target: "vscodeee",
                        "Routed first-instance CLI args: {path_count} paths"
                    );
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On application exit, execute the ordered shutdown sequence:
            // Phase 0 — Kill extension host sidecar processes
            // Phase 1 — Close all PTY shell instances
            // Phase 2 — Stop all file watcher threads
            if let tauri::RunEvent::Exit = event {
                log::info!(target: "vscodeee", "RunEvent::Exit — running shutdown cleanup");
                use tauri::Manager;
                if let Some(coordinator) = app_handle.try_state::<Arc<shutdown::ShutdownCoordinator>>() {
                    coordinator.shutdown_all();
                }
            }
        });
}
