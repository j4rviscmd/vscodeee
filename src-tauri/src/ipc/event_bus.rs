/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window-scoped event bus for sending IPC messages from Rust to WebView.
//!
//! Uses Tauri's event system to emit messages to specific windows.
//! Each window is identified by its `window_id` and receives events on
//! the `vscode:ipc_message:{window_id}` channel.

use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

/// Manages event emission from Rust backend to WebView windows.
///
/// Holds a reference to the Tauri `AppHandle` (set during `setup()`)
/// and provides methods to emit events scoped to specific windows.
pub struct EventBus {
    app_handle: RwLock<Option<AppHandle>>,
}

impl EventBus {
    /// Create a new `EventBus` with no app handle.
    ///
    /// The handle must be set later via [`init()`](Self::init) during Tauri `setup()`.
    pub fn new() -> Self {
        Self {
            app_handle: RwLock::new(None),
        }
    }

    /// Initialize the EventBus with the Tauri app handle.
    /// Must be called during `setup()`.
    pub async fn init(&self, app_handle: AppHandle) {
        let mut handle = self.app_handle.write().await;
        *handle = Some(app_handle);
    }

    /// Emit a base64-encoded message to a specific window.
    ///
    /// Uses `emit_to(label)` for window-scoped delivery. Looks up the Tauri
    /// window label from the `WindowManager` via the logical window ID.
    /// Falls back to global `emit()` if the label cannot be resolved.
    // TODO(Phase 3): Remove allow(dead_code) when IPC event routing is implemented
    #[allow(dead_code)]
    pub async fn emit_to_window(&self, window_id: u32, data: &str) {
        let handle = self.app_handle.read().await;
        if let Some(app) = handle.as_ref() {
            let event_name = format!("vscode:ipc_message:{}", window_id);

            // Resolve window label from WindowManager for scoped delivery
            let label = {
                use tauri::Manager;
                match app.try_state::<std::sync::Arc<crate::window::manager::WindowManager>>() {
                    Some(wm) => wm.label_for_id(window_id).await,
                    None => None,
                }
            };

            let result = if let Some(label) = label {
                app.emit_to(&label, &event_name, data.to_string())
            } else {
                // Fallback: global emit (for bootstrap or unregistered windows)
                app.emit(&event_name, data.to_string())
            };

            if let Err(e) = result {
                log::error!(
                    target: "vscodeee::ipc::event_bus",
                    "Failed to emit to window {window_id}: {e}"
                );
            }
        } else {
            log::warn!(
                target: "vscodeee::ipc::event_bus",
                "App handle not initialized, cannot emit to window {window_id}"
            );
        }
    }

    // TODO(Phase 3): Remove allow(dead_code) when IPC event routing is implemented
    #[allow(dead_code)]
    /// Emit a global event to all windows.
    pub async fn emit_global(&self, event: &str, data: &str) {
        let handle = self.app_handle.read().await;
        if let Some(app) = handle.as_ref() {
            if let Err(e) = app.emit(event, data.to_string()) {
                log::error!(target: "vscodeee::ipc::event_bus", "Failed to emit global event '{event}': {e}");
            }
        }
    }
}

/// Create a shared EventBus wrapped in Arc for use across Tauri state.
pub fn create_event_bus() -> Arc<EventBus> {
    Arc::new(EventBus::new())
}
