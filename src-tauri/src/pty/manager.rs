/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! PTY Manager — manages multiple PTY instances with unique IDs.
//!
//! Registered as Tauri managed state via `app.manage(PtyManager::new())`.
//! Thread-safe through internal `Mutex` — Tauri commands can call methods
//! from any async context.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use super::autoreply::AutoReplyInterceptor;
use super::instance::{ProcessSummary, PtyConfig, PtyInstance};
use super::profiles::DetectedShell;
use super::state::TerminalStateStore;

/// Manages the lifecycle of multiple PTY instances.
///
/// Each instance is identified by a unique `u32` ID, assigned monotonically.
/// This is registered as Tauri managed state and accessed via
/// `app_handle.state::<PtyManager>()` in command handlers.
pub struct PtyManager {
    instances: Mutex<HashMap<u32, PtyInstance>>,
    next_id: AtomicU32,
    /// Shared auto-reply interceptor for all PTY instances.
    auto_reply: Arc<AutoReplyInterceptor>,
    /// Persistent state store (set after app initialization).
    state_store: Mutex<Option<TerminalStateStore>>,
}

impl PtyManager {
    /// Create a new, empty PTY manager.
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            auto_reply: Arc::new(AutoReplyInterceptor::new()),
            state_store: Mutex::new(None),
        }
    }

    /// Set the terminal state store (called once during app setup).
    pub fn set_state_store(&self, store: TerminalStateStore) {
        if let Ok(mut guard) = self.state_store.lock() {
            *guard = Some(store);
        }
    }

    /// Get a reference to the auto-reply interceptor.
    pub fn auto_reply(&self) -> Arc<AutoReplyInterceptor> {
        Arc::clone(&self.auto_reply)
    }

    /// Create a new PTY instance and return its ID.
    ///
    /// Spawns a shell process in a pseudo-terminal and starts a background
    /// reader thread that emits output via Tauri events.
    ///
    /// **Important**: The reader thread is paused until `activate()` is called.
    /// The frontend must register event listeners before activating.
    pub fn create(
        &self,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
        env: std::collections::HashMap<String, String>,
        app_handle: tauri::AppHandle,
    ) -> Result<u32, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let config = PtyConfig {
            shell,
            cwd,
            cols,
            rows,
            id,
            env,
        };

        let instance = PtyInstance::spawn(config, app_handle, Some(Arc::clone(&self.auto_reply)))?;

        let mut instances = self
            .instances
            .lock()
            .map_err(|_| "PtyManager lock poisoned".to_string())?;
        instances.insert(id, instance);

        log::info!(target: "vscodeee::pty::manager", "Created PTY instance {id}");
        Ok(id)
    }

    /// Activate a PTY instance's reader thread, starting output emission.
    ///
    /// Must be called after the frontend has registered event listeners for
    /// `pty-output-{id}` and `pty-exit-{id}`.
    pub fn activate(&self, id: u32) -> Result<(), String> {
        self.with_instance(id, |inst| inst.activate())
    }

    /// Write data to a PTY instance.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        self.with_instance(id, |inst| inst.write(data))
    }

    /// Resize a PTY instance.
    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        self.with_instance(id, |inst| inst.resize(cols, rows))
    }

    /// Close and remove a PTY instance.
    ///
    /// Dropping the `PtyInstance` will:
    /// - Close the writer (sends EOF to the shell)
    /// - The reader thread will detect EOF and exit
    pub fn close(&self, id: u32) -> Result<(), String> {
        let mut instances = self
            .instances
            .lock()
            .map_err(|_| "PtyManager lock poisoned".to_string())?;

        if instances.remove(&id).is_some() {
            log::info!(target: "vscodeee::pty::manager", "Closed PTY instance {id}");
            Ok(())
        } else {
            Err(format!("PTY {id} not found"))
        }
    }

    /// Send a signal to a PTY instance's child process.
    pub fn send_signal(&self, id: u32, signal: &str) -> Result<(), String> {
        self.with_instance(id, |inst| inst.send_signal(signal))
    }

    /// List all running PTY processes.
    pub fn list_processes(&self) -> Vec<ProcessSummary> {
        if let Ok(instances) = self.instances.lock() {
            instances
                .iter()
                .map(|(id, instance)| instance.process_summary(*id))
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Detect available shells on the system.
    pub fn detect_shells() -> Vec<DetectedShell> {
        super::profiles::detect_available_shells()
    }

    /// Save terminal buffer state for a workspace.
    pub fn save_buffer_state(&self, workspace_id: &str, data: &str) -> Result<(), String> {
        self.with_state_store(|store| store.save_buffer_state(workspace_id, data))
    }

    /// Load terminal buffer state for a workspace.
    pub fn load_buffer_state(&self, workspace_id: &str) -> Result<Option<String>, String> {
        self.with_state_store(|store| store.load_buffer_state(workspace_id))
    }

    /// Save terminal layout info for a workspace.
    pub fn save_layout_info(&self, workspace_id: &str, data: &str) -> Result<(), String> {
        self.with_state_store(|store| store.save_layout_info(workspace_id, data))
    }

    /// Load terminal layout info for a workspace.
    pub fn load_layout_info(&self, workspace_id: &str) -> Result<Option<String>, String> {
        self.with_state_store(|store| store.load_layout_info(workspace_id))
    }

    /// Install an auto-reply pattern.
    pub fn install_auto_reply(&self, match_str: String, reply: String) {
        self.auto_reply.install_reply(match_str, reply);
    }

    /// Remove all auto-reply patterns.
    pub fn uninstall_all_auto_replies(&self) {
        self.auto_reply.uninstall_all();
    }

    /// Close all running PTY instances.
    ///
    /// Called during application shutdown to ensure all child shell processes
    /// and their reader threads are cleaned up. Each `PtyInstance::Drop` kills
    /// the child process and closes the master PTY.
    pub fn close_all(&self) {
        if let Ok(mut instances) = self.instances.lock() {
            let count = instances.len();
            instances.clear();
            log::info!(target: "vscodeee::pty::manager", "Closed all {count} PTY instances");
        }
    }

    /// Acquire the instances lock, look up a PTY by ID, and apply a function to it.
    ///
    /// Reduces boilerplate for read-only operations that need a single instance.
    fn with_instance<F, R>(&self, id: u32, f: F) -> Result<R, String>
    where
        F: FnOnce(&PtyInstance) -> Result<R, String>,
    {
        let instances = self
            .instances
            .lock()
            .map_err(|_| "PtyManager lock poisoned".to_string())?;
        let instance = instances
            .get(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;
        f(instance)
    }

    /// Acquire the state store lock and apply a function to the store.
    ///
    /// Returns an error if the state store has not been initialized.
    fn with_state_store<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&TerminalStateStore) -> Result<R, String>,
    {
        let guard = self
            .state_store
            .lock()
            .map_err(|_| "Terminal state store lock poisoned".to_string())?;
        match *guard {
            Some(ref store) => f(store),
            None => Err("Terminal state store not initialized".to_string()),
        }
    }
}
