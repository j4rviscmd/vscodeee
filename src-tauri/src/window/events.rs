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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

use super::manager::WindowManager;

/// Tracks pending close handshakes so that a safety-net timeout can be
/// cancelled when the TypeScript layer confirms or vetoes the close.
///
/// Each window label maps to a [`oneshot::Sender`] that, when dropped or
/// sent, cancels the corresponding timeout task.
pub struct PendingCloses {
    inner: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl PendingCloses {
    /// Creates a new empty `PendingCloses` tracker.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Register a pending close for the given window label.
    /// Returns the receiver that the timeout task should await.
    pub fn register(&self, label: &str) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        let mut map = self.inner.lock().unwrap();
        // If a previous pending close exists for this label (unlikely but
        // possible if the user clicks close twice quickly), the old sender
        // is dropped which cancels the old timeout.
        map.insert(label.to_string(), tx);
        rx
    }

    /// Cancel a pending close for the given window label.
    /// Returns `true` if a pending close was found and cancelled.
    pub fn cancel(&self, label: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        if let Some(tx) = map.remove(label) {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }
}

/// Safety-net timeout for the close handshake.
/// If TS does not respond within this duration, the window is force-destroyed.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Payload for the unified fullscreen change event.
///
/// Emitted on the `vscodeee:window:fullscreen` channel whenever a window
/// transitions into or out of fullscreen mode.
#[derive(Clone, serde::Serialize)]
struct FullscreenPayload {
    /// The unique ID of the window whose fullscreen state changed.
    window_id: u32,
    /// `true` if the window entered fullscreen, `false` if it left.
    fullscreen: bool,
}

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
    /// Unified fullscreen change event with `{ window_id, fullscreen }` payload.
    pub const WINDOW_FULLSCREEN: &str = "vscodeee:window:fullscreen";
    /// Emitted when a window is about to close (close requested).
    pub const WINDOW_CLOSE: &str = "vscodeee:window:close";
    /// Emitted when a new window has been opened and registered.
    pub const WINDOW_OPENED: &str = "vscodeee:window:opened";

    /// Emitted to the TypeScript layer when the OS requests a window close.
    /// The TypeScript `TauriLifecycleService` handles veto logic and responds
    /// with either `lifecycle_close_confirmed` or `lifecycle_close_vetoed`.
    pub const LIFECYCLE_CLOSE_REQUESTED: &str = "vscodeee:lifecycle:close-requested";
}

/// Handle a single window event — called from `Builder::on_window_event()`.
///
/// Updates `WindowManager` state and emits scoped events to the WebView.
/// Handles the following event types:
///
/// - **Focused**: Updates focus state, emits `WINDOW_FOCUS` / `WINDOW_BLUR`.
/// - **CloseRequested**: Saves the session snapshot, unregisters the window,
///   and emits `WINDOW_CLOSE`.
/// - **Resized**: Detects maximize/unmaximize and fullscreen transitions,
///   emits the corresponding events with the window ID.
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
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // Prevent the window from closing immediately — the TypeScript
            // layer must complete its shutdown handshake first (flush storage,
            // run onWillShutdown joiners, etc.).
            api.prevent_close();

            let wm = handle.state::<Arc<WindowManager>>();
            let wm = wm.inner().clone();
            let pending = handle.state::<Arc<PendingCloses>>();
            let pending = pending.inner().clone();
            let label_c = label.clone();
            let handle_c = handle.clone();

            // Register a cancel channel for the safety-net timeout.
            let cancel_rx = pending.register(&label_c);

            tauri::async_runtime::spawn(async move {
                if let Some(id) = wm.id_for_label(&label_c).await {
                    // Notify the TypeScript lifecycle service.
                    let _ = handle_c.emit_to(&label_c, event_names::LIFECYCLE_CLOSE_REQUESTED, id);
                } else {
                    // Unknown window — force-destroy immediately.
                    log::warn!(
                        "CloseRequested for unknown window label '{label_c}', force-destroying"
                    );
                    if let Some(w) = handle_c.get_webview_window(&label_c) {
                        let _ = w.destroy();
                    }
                    return;
                }

                // Safety-net timeout: if the TypeScript layer does not respond
                // within CLOSE_TIMEOUT, force-destroy the window. This only
                // fires when TS is unresponsive (crash / hang).
                tokio::select! {
                    _ = cancel_rx => {
                        // TS responded (confirmed or vetoed) — nothing to do.
                    }
                    _ = tokio::time::sleep(CLOSE_TIMEOUT) => {
                        log::warn!(
                            "Close handshake timed out for window '{label_c}' after {}s — force-destroying",
                            CLOSE_TIMEOUT.as_secs()
                        );
                        save_session_snapshot(&wm).await;
                        wm.unregister(&label_c).await;
                        if let Some(w) = handle_c.get_webview_window(&label_c) {
                            let _ = w.destroy();
                        }
                    }
                }
            });
        }
        tauri::WindowEvent::Resized(_) => {
            let is_maximized = window.is_maximized().unwrap_or(false);
            let is_fullscreen = window.is_fullscreen().unwrap_or(false);
            let wm = handle.state::<Arc<WindowManager>>();
            let wm = wm.inner().clone();
            let label_c = label.clone();
            let handle_c = handle.clone();
            tauri::async_runtime::spawn(async move {
                let old_info = wm.get_by_label(&label_c).await;
                let was_maximized = old_info.as_ref().map_or(false, |i| i.is_maximized);
                let was_fullscreen = old_info.as_ref().map_or(false, |i| i.is_fullscreen);
                wm.set_maximized(&label_c, is_maximized).await;
                wm.set_fullscreen(&label_c, is_fullscreen).await;

                if let Some(id) = wm.id_for_label(&label_c).await {
                    if is_maximized && !was_maximized {
                        let _ = handle_c.emit_to(&label_c, event_names::WINDOW_MAXIMIZE, id);
                        let _ = handle_c.emit(event_names::WINDOW_MAXIMIZE, id);
                    } else if !is_maximized && was_maximized {
                        let _ = handle_c.emit_to(&label_c, event_names::WINDOW_UNMAXIMIZE, id);
                        let _ = handle_c.emit(event_names::WINDOW_UNMAXIMIZE, id);
                    }

                    if is_fullscreen && !was_fullscreen {
                        let payload = FullscreenPayload {
                            window_id: id,
                            fullscreen: true,
                        };
                        let _ =
                            handle_c.emit_to(&label_c, event_names::WINDOW_ENTER_FULLSCREEN, id);
                        let _ = handle_c.emit(event_names::WINDOW_ENTER_FULLSCREEN, id);
                        let _ = handle_c.emit(event_names::WINDOW_FULLSCREEN, payload);
                    } else if !is_fullscreen && was_fullscreen {
                        let payload = FullscreenPayload {
                            window_id: id,
                            fullscreen: false,
                        };
                        let _ =
                            handle_c.emit_to(&label_c, event_names::WINDOW_LEAVE_FULLSCREEN, id);
                        let _ = handle_c.emit(event_names::WINDOW_LEAVE_FULLSCREEN, id);
                        let _ = handle_c.emit(event_names::WINDOW_FULLSCREEN, payload);
                    }
                }
            });
        }
        _ => {}
    }
}

/// Take a snapshot of all current windows and save to `sessions.json`.
///
/// Called from event handlers (close, quit) to persist the session.
pub async fn save_session_snapshot(wm: &WindowManager) {
    let entries = wm.snapshot_for_session().await;
    let session = super::session::SessionStore { entries };
    session.save();
}
