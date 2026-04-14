/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands for terminal (PTY) management.
//!
//! These commands are the WebView-facing API for terminal operations.
//! They delegate to [`PtyManager`] which is registered as Tauri managed state.
//!
//! # Commands
//!
//! | Command | Description |
//! |---------|-------------|
//! | `create_terminal` | Spawn a new PTY with a shell |
//! | `write_terminal` | Send input data to a PTY |
//! | `resize_terminal` | Resize a PTY's dimensions |
//! | `close_terminal` | Close and clean up a PTY |
//! | `send_terminal_signal` | Send a signal to a PTY's child process |
//! | `list_terminals` | List all running PTY processes |
//! | `detect_shells` | Detect available shells on the system |
//! | `get_default_shell` | Get the user's default shell |
//! | `get_environment` | Get the process environment |
//! | `persist_terminal_state` | Save terminal buffer state |
//! | `load_terminal_state` | Load terminal buffer state |
//! | `persist_terminal_layout` | Save terminal layout info |
//! | `load_terminal_layout` | Load terminal layout info |
//! | `install_auto_reply` | Install an auto-reply pattern |
//! | `uninstall_all_auto_replies` | Remove all auto-reply patterns |

use tauri::State;

use crate::pty::instance::ProcessSummary;
use crate::pty::manager::PtyManager;
use crate::pty::profiles::DetectedShell;

/// Spawn a new terminal (PTY) instance.
#[tauri::command]
pub fn create_terminal(
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    pty_manager: State<'_, PtyManager>,
    app_handle: tauri::AppHandle,
) -> Result<u32, String> {
    pty_manager.create(shell, cwd, cols, rows, app_handle)
}

/// Write data to a terminal's stdin.
#[tauri::command]
pub fn write_terminal(
    id: u32,
    data: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.write(id, data.as_bytes())
}

/// Resize a terminal to new dimensions.
#[tauri::command]
pub fn resize_terminal(
    id: u32,
    cols: u16,
    rows: u16,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.resize(id, cols, rows)
}

/// Close a terminal instance.
#[tauri::command]
pub fn close_terminal(id: u32, pty_manager: State<'_, PtyManager>) -> Result<(), String> {
    pty_manager.close(id)
}

/// Send a signal to a terminal's child process.
///
/// Supported signals: `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGHUP`, `SIGQUIT`.
#[tauri::command]
pub fn send_terminal_signal(
    id: u32,
    signal: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.send_signal(id, &signal)
}

/// List all running terminal processes.
///
/// Returns a summary for each active PTY instance including
/// the OS PID, shell path, and running status.
#[tauri::command]
pub fn list_terminals(pty_manager: State<'_, PtyManager>) -> Vec<ProcessSummary> {
    pty_manager.list_processes()
}

/// Detect available shells on the system.
///
/// Scans known shell paths and checks executability.
/// Returns shells sorted with the default shell first.
#[tauri::command]
pub fn detect_shells() -> Vec<DetectedShell> {
    PtyManager::detect_shells()
}

/// Get the user's default shell.
#[tauri::command]
pub fn get_default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else if cfg!(target_os = "windows") {
            "powershell.exe".to_string()
        } else {
            "/bin/bash".to_string()
        }
    })
}

/// Get the current process environment variables.
#[tauri::command]
pub fn get_environment() -> std::collections::HashMap<String, String> {
    std::env::vars().collect()
}

/// Save terminal buffer state for a workspace.
///
/// The data should be a JSON string in `ICrossVersionSerializedTerminalState` format.
#[tauri::command]
pub fn persist_terminal_state(
    workspace_id: String,
    data: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.save_buffer_state(&workspace_id, &data)
}

/// Load terminal buffer state for a workspace.
///
/// Returns the JSON string in `ICrossVersionSerializedTerminalState` format,
/// or `null` if no state exists.
#[tauri::command]
pub fn load_terminal_state(
    workspace_id: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<Option<String>, String> {
    pty_manager.load_buffer_state(&workspace_id)
}

/// Save terminal layout info for a workspace.
#[tauri::command]
pub fn persist_terminal_layout(
    workspace_id: String,
    data: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.save_layout_info(&workspace_id, &data)
}

/// Load terminal layout info for a workspace.
#[tauri::command]
pub fn load_terminal_layout(
    workspace_id: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<Option<String>, String> {
    pty_manager.load_layout_info(&workspace_id)
}

/// Install an auto-reply pattern.
///
/// When terminal output contains `match_str`, `reply` will be sent
/// back to the terminal automatically.
#[tauri::command]
pub fn install_auto_reply(match_str: String, reply: String, pty_manager: State<'_, PtyManager>) {
    pty_manager.install_auto_reply(match_str, reply);
}

/// Remove all auto-reply patterns.
#[tauri::command]
pub fn uninstall_all_auto_replies(pty_manager: State<'_, PtyManager>) {
    pty_manager.uninstall_all_auto_replies();
}
