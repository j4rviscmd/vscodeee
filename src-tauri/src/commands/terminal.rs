/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Tauri commands for terminal (PTY) management.
//!
//! These commands are the WebView-facing API for Phase 0-4 PTY Host PoC.
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

use tauri::State;

use crate::pty::manager::PtyManager;

/// Spawn a new terminal (PTY) instance.
///
/// Creates a pseudo-terminal running the specified shell, and starts
/// a background reader thread that emits `pty-output-{id}` events
/// with the shell's output data.
///
/// # Arguments
/// * `shell` — Shell executable path (e.g., `/bin/zsh`, `/bin/bash`)
/// * `cwd` — Working directory for the shell
/// * `cols` — Initial terminal width in columns
/// * `rows` — Initial terminal height in rows
///
/// # Returns
/// The unique ID of the created terminal instance.
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
///
/// Sends the given string as bytes to the PTY, which forwards it
/// to the shell process's stdin. This handles keyboard input,
/// control sequences, and pasted text.
#[tauri::command]
pub fn write_terminal(
    id: u32,
    data: String,
    pty_manager: State<'_, PtyManager>,
) -> Result<(), String> {
    pty_manager.write(id, data.as_bytes())
}

/// Resize a terminal to new dimensions.
///
/// Updates the PTY's window size, which sends a `SIGWINCH` signal
/// to the shell process so it can adjust its layout.
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
///
/// Drops the PTY writer (sending EOF to the shell), which causes
/// the shell to exit. The background reader thread will detect
/// EOF and emit a `pty-exit-{id}` event.
#[tauri::command]
pub fn close_terminal(id: u32, pty_manager: State<'_, PtyManager>) -> Result<(), String> {
    pty_manager.close(id)
}

/// Get the user's default shell.
///
/// Reads the `SHELL` environment variable on Unix-like systems.
/// Falls back to platform-specific defaults if the variable is not set.
///
/// # Returns
/// The path to the default shell (e.g., `/bin/zsh`, `/bin/bash`).
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
///
/// Returns all environment variables as a key-value map. Used by the
/// terminal backend to pass the environment to the VS Code terminal UI.
///
/// # Returns
/// A map of environment variable names to their values.
#[tauri::command]
pub fn get_environment() -> std::collections::HashMap<String, String> {
    std::env::vars().collect()
}
