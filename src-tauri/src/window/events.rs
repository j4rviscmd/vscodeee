/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window event forwarding — bridges Tauri's native window events to the WebView.
//!
//! Tauri fires window lifecycle events (focus, blur, resize, close, etc.) on the
//! Rust side. This module provides a handler for `Builder::on_window_event()` that
//! updates the `WindowManager` state and emits scoped Tauri events that the
//! TypeScript `ITauriWindowService` / `TauriNativeHostService` listens on.

use std::sync::Arc;
use tauri::{Emitter, Manager};

use super::manager::WindowManager;

/// Event name constants emitted to the WebView.
///
/// These string constants define the Tauri event channels used to communicate
/// window lifecycle changes from Rust to the TypeScript layer. The TypeScript
/// `TauriWindowService` and `TauriNativeHostService` subscribe to these events
/// via `listen()`.
pub mod event_names {
    /// Emitted when a window gains OS-level focus.
    pub const WINDOW_FOCUS: &str = "vscodeee:window:focus";
    /// Emitted when a window loses OS-level focus.
    pub const WINDOW_BLUR: &str = "vscodeee:window:blur";
    /// Emitted when a window enters the maximized state.
    pub const WINDOW_MAXIMIZE: &str = "vscodeee:window:maximize";
    /// Emitted when a window leaves the maximized state.
    pub const WINDOW_UNMAXIMIZE: &str = "vscodeee:window:unmaximize";
    /// Emitted when a window enters fullscreen mode.
    pub const WINDOW_ENTER_FULLSCREEN: &str = "vscodeee:window:enter-fullscreen";
    /// Emitted when a window leaves fullscreen mode.
    pub const WINDOW_LEAVE_FULLSCREEN: &str = "vscodeee:window:leave-fullscreen";
    /// Emitted when a window is about to close (close requested).
    pub const WINDOW_CLOSE: &str = "vscodeee:window:close";
    /// Emitted when a new window has been opened and registered.
    pub const WINDOW_OPENED: &str = "vscodeee:window:opened";
}

/// Handle a single window event — called from `Builder::on_window_event()`.
///
/// Updates `WindowManager` state and emits scoped events to the WebView.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label().to_string();
    let handle = window.app_handle().clone();

    match event {
        tauri::WindowEvent::Focused(focused) => {
            let wm = handle.state::<Arc<WindowManager>>();
            let wm = wm.inner().clone();
            let label_c = label.clone();
            let handle_c = handle.clone();
            let focused = *focused;
            tauri::async_runtime::spawn(async move {
                wm.set_focused(&label_c, focused).await;
                if let Some(id) = wm.id_for_label(&label_c).await {
                    let event_name = if focused {
                        event_names::WINDOW_FOCUS
                    } else {
                        event_names::WINDOW_BLUR
                    };
                    let _ = handle_c.emit_to(&label_c, event_name, id);
                    let _ = handle_c.emit(event_name, id);
                }
            });
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            let wm = handle.state::<Arc<WindowManager>>();
            let wm = wm.inner().clone();
            let label_c = label.clone();
            let handle_c = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(id) = wm.id_for_label(&label_c).await {
                    let _ = handle_c.emit(event_names::WINDOW_CLOSE, id);
                }
                wm.unregister(&label_c).await;
            });
        }
        tauri::WindowEvent::Resized(_) => {
            let is_maximized = window.is_maximized().unwrap_or(false);
            let wm = handle.state::<Arc<WindowManager>>();
            let wm = wm.inner().clone();
            let label_c = label.clone();
            let handle_c = handle.clone();
            tauri::async_runtime::spawn(async move {
                let old_info = wm.get_by_label(&label_c).await;
                let was_maximized = old_info.as_ref().map_or(false, |i| i.is_maximized);
                wm.set_maximized(&label_c, is_maximized).await;

                if let Some(id) = wm.id_for_label(&label_c).await {
                    if is_maximized && !was_maximized {
                        let _ = handle_c.emit_to(&label_c, event_names::WINDOW_MAXIMIZE, id);
                        let _ = handle_c.emit(event_names::WINDOW_MAXIMIZE, id);
                    } else if !is_maximized && was_maximized {
                        let _ = handle_c.emit_to(&label_c, event_names::WINDOW_UNMAXIMIZE, id);
                        let _ = handle_c.emit(event_names::WINDOW_UNMAXIMIZE, id);
                    }
                }
            });
        }
        _ => {}
    }
}
