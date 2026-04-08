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
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

/// Manages event emission from Rust backend to WebView windows.
///
/// Holds a reference to the Tauri `AppHandle` (set during `setup()`)
/// and provides methods to emit events scoped to specific windows.
pub struct EventBus {
    app_handle: RwLock<Option<AppHandle>>,
}

impl EventBus {
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
    /// The event name follows the convention `vscode:ipc_message:{window_id}`
    /// which the TypeScript `TauriMessagePassingProtocol` listens on.
    pub async fn emit_to_window(&self, window_id: u32, data: &str) {
        let handle = self.app_handle.read().await;
        if let Some(app) = handle.as_ref() {
            let event_name = format!("vscode:ipc_message:{}", window_id);
            if let Err(e) = app.emit(&event_name, data.to_string()) {
                eprintln!(
                    "[EventBus] Failed to emit to window {}: {}",
                    window_id, e
                );
            }
        } else {
            eprintln!("[EventBus] App handle not initialized, cannot emit to window {}", window_id);
        }
    }

    /// Emit a global event to all windows.
    pub async fn emit_global(&self, event: &str, data: &str) {
        let handle = self.app_handle.read().await;
        if let Some(app) = handle.as_ref() {
            if let Err(e) = app.emit(event, data.to_string()) {
                eprintln!("[EventBus] Failed to emit global event '{}': {}", event, e);
            }
        }
    }
}

/// Create a shared EventBus wrapped in Arc for use across Tauri state.
pub fn create_event_bus() -> Arc<EventBus> {
    Arc::new(EventBus::new())
}
