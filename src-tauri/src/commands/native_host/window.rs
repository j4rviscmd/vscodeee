/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window management commands — fullscreen, maximize, minimize, focus,
//! always-on-top, position, cursor, and z-order.

use serde::{Deserialize, Serialize};

use super::error::NativeHostError;

// ─── Existing commands (moved from native_host.rs) ──────────────────────

/// Check if the current window is in fullscreen mode.
#[tauri::command]
pub fn is_fullscreen(window: tauri::Window) -> Result<bool, NativeHostError> {
    window
        .is_fullscreen()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Toggle fullscreen for the current window.
#[tauri::command]
pub fn toggle_fullscreen(window: tauri::Window) -> Result<(), NativeHostError> {
    let is_fs = window
        .is_fullscreen()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;
    window
        .set_fullscreen(!is_fs)
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Check if the current window is maximized.
#[tauri::command]
pub fn is_maximized(window: tauri::Window) -> Result<bool, NativeHostError> {
    window
        .is_maximized()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Maximize the current window.
#[tauri::command]
pub fn maximize_window(window: tauri::Window) -> Result<(), NativeHostError> {
    window
        .maximize()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Unmaximize (restore) the current window.
#[tauri::command]
pub fn unmaximize_window(window: tauri::Window) -> Result<(), NativeHostError> {
    window
        .unmaximize()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Minimize the current window.
#[tauri::command]
pub fn minimize_window(window: tauri::Window) -> Result<(), NativeHostError> {
    window
        .minimize()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Focus the current window.
#[tauri::command]
pub fn focus_window(window: tauri::Window) -> Result<(), NativeHostError> {
    window
        .set_focus()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

// ─── New commands ───────────────────────────────────────────────────────

/// Move the window to the top of the z-order by re-focusing it.
///
/// Tauri does not expose a direct z-order API, so `set_focus()` is
/// the closest equivalent (brings window to front and activates it).
#[tauri::command]
pub fn move_window_top(window: tauri::Window) -> Result<(), NativeHostError> {
    window
        .set_focus()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Position data received from TypeScript.
#[derive(Deserialize)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Position and resize the window to the given rectangle.
#[tauri::command]
pub fn position_window(
    window: tauri::Window,
    position: WindowPosition,
) -> Result<(), NativeHostError> {
    use tauri::{LogicalPosition, LogicalSize};

    window
        .set_position(LogicalPosition::new(position.x as f64, position.y as f64))
        .map_err(|e| NativeHostError::Window(e.to_string()))?;
    window
        .set_size(LogicalSize::new(
            position.width as f64,
            position.height as f64,
        ))
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Toggle the window's always-on-top state.
#[tauri::command]
pub fn toggle_always_on_top(window: tauri::Window) -> Result<bool, NativeHostError> {
    let current = window
        .is_always_on_top()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;
    let new_state = !current;
    window
        .set_always_on_top(new_state)
        .map_err(|e| NativeHostError::Window(e.to_string()))?;
    Ok(new_state)
}

/// Set the window's always-on-top state to the given value.
#[tauri::command]
pub fn set_always_on_top(
    window: tauri::Window,
    always_on_top: bool,
) -> Result<(), NativeHostError> {
    window
        .set_always_on_top(always_on_top)
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Check if the window is pinned to always-on-top.
#[tauri::command]
pub fn is_always_on_top(window: tauri::Window) -> Result<bool, NativeHostError> {
    window
        .is_always_on_top()
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Set the window's minimum size constraint.
#[tauri::command]
pub fn set_minimum_size(
    window: tauri::Window,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), NativeHostError> {
    use tauri::LogicalSize;

    let min_size = match (width, height) {
        (Some(w), Some(h)) => Some(LogicalSize::new(w, h)),
        _ => None,
    };
    window
        .set_min_size(min_size)
        .map_err(|e| NativeHostError::Window(e.to_string()))
}

/// Window rectangle (position + size) returned to TypeScript.
#[derive(Serialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Get the active window's position and size.
#[tauri::command]
pub fn get_active_window_position(window: tauri::Window) -> Result<WindowRect, NativeHostError> {
    let pos = window
        .outer_position()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;
    let size = window
        .outer_size()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;
    Ok(WindowRect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    })
}

/// Cursor position and display bounds returned to TypeScript.
#[derive(Serialize)]
pub struct CursorScreenInfo {
    pub point: Point,
    pub display: DisplayRect,
}

#[derive(Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize)]
pub struct DisplayRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Get the cursor position and primary display bounds.
///
/// Uses Tauri's `Window::cursor_position()` for cursor coords.
/// Display bounds are estimated from the window's monitor.
#[tauri::command]
pub fn get_cursor_screen_point(window: tauri::Window) -> Result<CursorScreenInfo, NativeHostError> {
    let cursor = window
        .cursor_position()
        .map_err(|e| NativeHostError::Window(e.to_string()))?;

    // Try to get current monitor bounds, fall back to reasonable defaults
    let (display_x, display_y, display_w, display_h) =
        if let Ok(Some(monitor)) = window.current_monitor() {
            let pos = monitor.position();
            let size = monitor.size();
            (
                pos.x as f64,
                pos.y as f64,
                size.width as f64,
                size.height as f64,
            )
        } else {
            (0.0, 0.0, 1920.0, 1080.0)
        };

    Ok(CursorScreenInfo {
        point: Point {
            x: cursor.x,
            y: cursor.y,
        },
        display: DisplayRect {
            x: display_x,
            y: display_y,
            width: display_w,
            height: display_h,
        },
    })
}

// ─── DevTools commands ──────────────────────────────────────────────────
// NOTE: These commands use `tauri::WebviewWindow` instead of `tauri::Window`
// because `open_devtools()` / `close_devtools()` / `is_devtools_open()` are
// webview-specific APIs in Tauri 2.0.

/// Open the developer tools for the given webview window.
///
/// Only works in debug builds or when the `devtools` feature flag is enabled.
/// On macOS this uses a private API (WKWebView._inspectElement) and is not
/// suitable for App Store distribution.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) -> Result<(), NativeHostError> {
    window.open_devtools();
    Ok(())
}

/// Close the developer tools for the given webview window.
#[tauri::command]
pub fn close_devtools(window: tauri::WebviewWindow) -> Result<(), NativeHostError> {
    window.close_devtools();
    Ok(())
}

/// Check whether the developer tools are currently open.
#[tauri::command]
pub fn is_devtools_open(window: tauri::WebviewWindow) -> Result<bool, NativeHostError> {
    Ok(window.is_devtools_open())
}

/// Toggle the developer tools open/closed state.
#[tauri::command]
pub fn toggle_devtools(window: tauri::WebviewWindow) -> Result<(), NativeHostError> {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
    Ok(())
}
