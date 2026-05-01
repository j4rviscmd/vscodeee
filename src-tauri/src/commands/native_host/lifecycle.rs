/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Lifecycle commands — quit, exit, relaunch, close, session management.

use tauri::Manager;

use super::error::NativeHostError;

// ─── Existing commands (moved from native_host.rs) ──────────────────────

/// Notify the backend that the workbench has finished loading.
///
/// Validates the restored window geometry against the current display
/// configuration (corrects off-screen positions), cancels the safety-net
/// show timeout, marks the window as ready, and makes it visible.
///
/// # Parameters
///
/// * `window` - The Tauri window that is now ready.
/// * `window_manager` - Shared window registry, used to mark the window as ready.
/// * `pending_shows` - Safety-net tracker, cancelled so the timeout does not fire.
///
/// # Errors
///
/// Returns [`NativeHostError::Window`] if showing or focusing the window fails.
#[tauri::command]
pub async fn notify_ready(
    window: tauri::Window,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
    pending_shows: tauri::State<'_, std::sync::Arc<crate::window::events::PendingShows>>,
) -> Result<(), NativeHostError> {
    let label = window.label().to_string();
    log::info!(target: "vscodeee::commands::native_host", "Workbench notified ready for window '{label}'");

    // Cancel the safety-net timeout
    pending_shows.cancel(&label);

    // Validate geometry before showing — corrects off-screen positions
    // when the display configuration changed since last session.
    crate::window::restore_geometry::ensure_on_screen(&window);

    // Mark as ready in the window manager
    window_manager.set_ready(&label).await;

    // Show and focus the window
    window
        .show()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;
    window
        .set_focus()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;

    Ok(())
}

/// Return whether the app was compiled in debug (development) mode.
///
/// Used by the TypeScript updater service to decide whether the
/// `update.enabled` dev-flag is required.
///
/// # Returns
///
/// `true` if the binary was compiled with `debug_assertions` enabled
/// (i.e., `cargo build` without `--release`), `false` otherwise.
#[tauri::command]
pub fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

/// Close the current window.
///
/// # Parameters
///
/// * `window` - The Tauri window to close.
///
/// # Errors
///
/// Returns [`NativeHostError::Window`] if the window close operation fails.
#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), NativeHostError> {
    window
        .close()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Confirm window close after the TypeScript lifecycle handshake completes.
///
/// Saves the session snapshot, unregisters the window from the manager,
/// cancels the safety-net close timeout, and destroys the window.
///
/// When a coordinated quit is in progress and this was the last window,
/// exits the application process via `app.exit(0)`.
///
/// # Parameters
///
/// * `window` - The Tauri window to close.
/// * `window_manager` - Shared window registry, used to save the session and unregister.
/// * `pending_closes` - Safety-net tracker, cancelled so the timeout does not force-destroy.
///
/// # Errors
///
/// Returns [`NativeHostError::Window`] if destroying the window fails.
#[tauri::command]
pub async fn lifecycle_close_confirmed(
    app: tauri::AppHandle,
    window: tauri::Window,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
    pending_closes: tauri::State<'_, std::sync::Arc<crate::window::events::PendingCloses>>,
) -> Result<(), NativeHostError> {
    let label = window.label().to_string();
    log::info!(target: "vscodeee::lifecycle", "Close confirmed for window '{label}'");

    pending_closes.cancel(&label);

    crate::window::events::save_session_snapshot(&window_manager).await;
    window_manager.unregister(&label).await;

    window
        .destroy()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;

    // If a coordinated quit is active and all windows are now closed,
    // run the shutdown sequence and exit the process.
    if let Some(quit_state) =
        app.try_state::<std::sync::Arc<crate::window::quit_state::QuitState>>()
    {
        if quit_state.is_active() && window_manager.count().await == 0 {
            log::info!(target: "vscodeee::lifecycle", "All windows closed during quit — exiting application");
            quit_state.cancel(); // Clear flag before exit

            // Run shutdown cleanup (kill child processes)
            if let Some(coordinator) =
                app.try_state::<std::sync::Arc<crate::shutdown::ShutdownCoordinator>>()
            {
                coordinator.shutdown_all();
            }

            app.exit(0);
        }
    }

    Ok(())
}

/// Signal that a window close was vetoed by the TypeScript layer.
///
/// Cancels the safety-net close timeout so the window is not force-destroyed.
/// If a coordinated quit is in progress, clears the quit flag so that other
/// windows that have already confirmed are not affected (Phase 1 behavior:
/// windows that already closed stay closed, but the vetoing window remains).
///
/// # Parameters
///
/// * `app` - The Tauri app handle, used to access QuitState.
/// * `window` - The Tauri window whose close was vetoed.
/// * `pending_closes` - Safety-net tracker, cancelled to prevent force-destroy.
#[tauri::command]
pub fn lifecycle_close_vetoed(
    app: tauri::AppHandle,
    window: tauri::Window,
    pending_closes: tauri::State<'_, std::sync::Arc<crate::window::events::PendingCloses>>,
) -> Result<(), NativeHostError> {
    let label = window.label().to_string();
    log::info!(target: "vscodeee::lifecycle", "Close vetoed for window '{label}'");

    pending_closes.cancel(&label);

    // If quit was in progress, cancel it — this window decided to stay open.
    if let Some(quit_state) =
        app.try_state::<std::sync::Arc<crate::window::quit_state::QuitState>>()
    {
        if quit_state.is_active() {
            log::info!(target: "vscodeee::lifecycle", "Quit cancelled by veto from window '{label}'");
            quit_state.cancel();
        }
    }

    Ok(())
}

/// Save session and run shutdown cleanup before exiting.
///
/// Persists the current session to disk and triggers the `ShutdownCoordinator`
/// to kill all registered child processes (extension hosts, PTY instances,
/// file watchers) in the correct order.
///
/// This helper is shared by `quit_app`, `exit_app`, and `quit_all_windows`
/// (when no windows are open) to avoid duplicating the teardown logic.
///
/// # Parameters
///
/// * `app` - The Tauri app handle, used to access managed state.
/// * `window_manager` - Shared window registry, used to create the session snapshot.
async fn save_and_shutdown(
    app: &tauri::AppHandle,
    window_manager: &tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) {
    crate::window::events::save_session_snapshot(window_manager).await;

    // Run shutdown cleanup before exiting — kills all child processes.
    if let Some(coordinator) =
        app.try_state::<std::sync::Arc<crate::shutdown::ShutdownCoordinator>>()
    {
        coordinator.shutdown_all();
    }
}

/// Quit the application gracefully, saving the session first.
///
/// **WARNING**: This bypasses the TypeScript lifecycle handshake. Prefer
/// `quit_all_windows` which gives each window a chance to veto (e.g., save
/// dirty files). This command exists for edge cases where an immediate exit
/// is required.
///
/// # Parameters
///
/// * `app` - The Tauri app handle, used to exit the process.
/// * `window_manager` - Shared window registry, used to save the session.
#[tauri::command]
pub async fn quit_app(
    app: tauri::AppHandle,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), NativeHostError> {
    save_and_shutdown(&app, &window_manager).await;
    app.exit(0);
    Ok(())
}

/// Quit the application through the proper lifecycle handshake.
///
/// Sets the quit-in-progress flag and triggers `window.close()` on all
/// registered windows. Each window will receive a `CloseRequested` event
/// with `reason: "quit"`, allowing the TypeScript lifecycle service to use
/// `ShutdownReason.QUIT` for correct dialog messages and Hot Exit behavior.
///
/// If any window vetoes (e.g., user clicks "Cancel" on a dirty-file dialog),
/// the quit is cancelled. If all windows confirm, the application exits
/// after the last window is destroyed (handled in `lifecycle_close_confirmed`).
///
/// # Parameters
///
/// * `app` - The Tauri app handle, used to iterate windows and trigger close.
/// * `window_manager` - Shared window registry, used to get all window labels.
/// * `quit_state` - Shared quit coordination state.
#[tauri::command]
pub async fn quit_all_windows(
    app: tauri::AppHandle,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
    quit_state: tauri::State<'_, std::sync::Arc<crate::window::quit_state::QuitState>>,
) -> Result<(), NativeHostError> {
    let labels = window_manager.all_labels().await;

    if labels.is_empty() {
        // No windows open — just exit directly.
        log::info!(target: "vscodeee::lifecycle", "quit_all_windows: no windows, exiting immediately");
        save_and_shutdown(&app, &window_manager).await;
        app.exit(0);
        return Ok(());
    }

    log::info!(
        target: "vscodeee::lifecycle",
        "quit_all_windows: initiating quit for {} window(s)",
        labels.len()
    );

    // Mark quit as in progress BEFORE triggering close on windows.
    // The CloseRequested handler checks this flag to set reason="quit".
    quit_state.start();

    // Trigger close on each window — this fires CloseRequested which is
    // intercepted by handle_window_event, starting the lifecycle handshake
    // with reason="quit" for each window.
    let mut any_close_triggered = false;
    for label in &labels {
        if let Some(ww) = app.get_webview_window(label) {
            if let Err(e) = ww.close() {
                log::error!(
                    target: "vscodeee::lifecycle",
                    "quit_all_windows: failed to close window '{label}': {e}"
                );
            } else {
                any_close_triggered = true;
            }
        }
    }

    // If no window close was triggered at all, cancel the quit flag
    // so subsequent individual closes don't get reason="quit".
    if !any_close_triggered {
        log::warn!(
            target: "vscodeee::lifecycle",
            "quit_all_windows: no window close triggered — cancelling quit"
        );
        quit_state.cancel();
    }

    Ok(())
}

/// Exit the application with a specific code, saving the session first.
///
/// # Parameters
///
/// * `app` - The Tauri app handle, used to exit the process.
/// * `code` - The exit code to return to the OS.
/// * `window_manager` - Shared window registry, used to save the session.
#[tauri::command]
pub async fn exit_app(
    app: tauri::AppHandle,
    code: i32,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), NativeHostError> {
    save_and_shutdown(&app, &window_manager).await;
    app.exit(code);
    Ok(())
}

/// Explicitly save the current session (all windows + workspaces) to disk.
///
/// # Parameters
///
/// * `window_manager` - Shared window registry, used to create the session snapshot.
#[tauri::command]
pub async fn save_session(
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), NativeHostError> {
    crate::window::events::save_session_snapshot(&window_manager).await;
    Ok(())
}

/// Relaunch the application.
///
/// Uses `tauri::process::restart` to spawn a new process and exit the
/// current one. The session is not explicitly saved — callers should
/// invoke `save_session` or `quit_app` beforehand if persistence is needed.
///
/// # Parameters
///
/// * `app` - The Tauri app handle, providing the environment for restart.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) -> Result<(), NativeHostError> {
    tauri::process::restart(&app.env());
}
