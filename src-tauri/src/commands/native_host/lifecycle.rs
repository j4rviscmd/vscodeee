/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Lifecycle commands — quit, exit, relaunch, close, session management.

use tauri::Manager;

use super::error::NativeHostError;

// ─── Existing commands (moved from native_host.rs) ──────────────────────

/// Notify the backend that the workbench has finished loading.
#[tauri::command]
pub fn notify_ready() {
    log::info!(target: "vscodeee::commands::native_host", "Workbench notified ready");
}

/// Close the current window.
#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), NativeHostError> {
    window
        .close()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Confirm window close after the TypeScript lifecycle handshake completes.
#[tauri::command]
pub async fn lifecycle_close_confirmed(
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
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Signal that a window close was vetoed by the TypeScript layer.
#[tauri::command]
pub fn lifecycle_close_vetoed(
    window: tauri::Window,
    pending_closes: tauri::State<'_, std::sync::Arc<crate::window::events::PendingCloses>>,
) -> Result<(), NativeHostError> {
    let label = window.label().to_string();
    log::info!(target: "vscodeee::lifecycle", "Close vetoed for window '{label}'");

    pending_closes.cancel(&label);
    Ok(())
}

/// Quit the application gracefully, saving the session first.
#[tauri::command]
pub async fn quit_app(
    app: tauri::AppHandle,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), NativeHostError> {
    crate::window::events::save_session_snapshot(&window_manager).await;
    app.exit(0);
    Ok(())
}

/// Exit the application with a specific code, saving the session first.
#[tauri::command]
pub async fn exit_app(
    app: tauri::AppHandle,
    code: i32,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), NativeHostError> {
    crate::window::events::save_session_snapshot(&window_manager).await;
    app.exit(code);
    Ok(())
}

/// Explicitly save the current session (all windows + workspaces) to disk.
#[tauri::command]
pub async fn save_session(
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), NativeHostError> {
    crate::window::events::save_session_snapshot(&window_manager).await;
    Ok(())
}

/// Relaunch the application.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) -> Result<(), NativeHostError> {
    tauri::process::restart(&app.env());
}
