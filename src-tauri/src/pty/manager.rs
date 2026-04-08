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
use std::sync::Mutex;

use super::instance::{PtyConfig, PtyInstance};

/// Manages the lifecycle of multiple PTY instances.
///
/// Each instance is identified by a unique `u32` ID, assigned monotonically.
/// This is registered as Tauri managed state and accessed via
/// `app_handle.state::<PtyManager>()` in command handlers.
pub struct PtyManager {
    instances: Mutex<HashMap<u32, PtyInstance>>,
    next_id: AtomicU32,
}

impl PtyManager {
    /// Create a new, empty PTY manager.
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }

    /// Create a new PTY instance and return its ID.
    ///
    /// Spawns a shell process in a pseudo-terminal and starts a background
    /// reader thread that emits output via Tauri events.
    pub fn create(
        &self,
        shell: String,
        cwd: String,
        cols: u16,
        rows: u16,
        app_handle: tauri::AppHandle,
    ) -> Result<u32, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let config = PtyConfig {
            shell,
            cwd,
            cols,
            rows,
            id,
        };

        let instance = PtyInstance::spawn(config, app_handle)?;

        let mut instances = self
            .instances
            .lock()
            .map_err(|_| "PtyManager lock poisoned".to_string())?;
        instances.insert(id, instance);

        log::info!(target: "vscodeee::pty::manager", "Created PTY instance {id}");
        Ok(id)
    }

    /// Write data to a PTY instance.
    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let instances = self
            .instances
            .lock()
            .map_err(|_| "PtyManager lock poisoned".to_string())?;

        let instance = instances
            .get(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;

        instance.write(data)
    }

    /// Resize a PTY instance.
    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let instances = self
            .instances
            .lock()
            .map_err(|_| "PtyManager lock poisoned".to_string())?;

        let instance = instances
            .get(&id)
            .ok_or_else(|| format!("PTY {id} not found"))?;

        instance.resize(cols, rows)
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
}
