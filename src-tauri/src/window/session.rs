/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Session persistence for window state and workspace mapping.
//!
//! Stores which workspaces were open in which windows so they can be
//! restored on next launch. Saves to `sessions.json` in the app data directory.
//! The actual window position/size persistence is handled by `tauri-plugin-window-state`.

use std::path::PathBuf;

use super::state::WindowSessionEntry;
use serde::{Deserialize, Serialize};

/// Persistent session store for workspace → window mapping.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStore {
    /// Saved window entries from the previous session.
    pub entries: Vec<WindowSessionEntry>,
}

impl SessionStore {
    /// Create an empty session store with no entries.
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Locate the `sessions.json` file in the app data directory.
    ///
    /// Uses the same app data directory as VS Code's settings:
    /// - macOS: `~/Library/Application Support/vscodeee/sessions.json`
    /// - Linux: `~/.config/vscodeee/sessions.json`
    /// - Windows: `%APPDATA%\vscodeee\sessions.json`
    fn sessions_path() -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        let base = dirs::data_dir();

        #[cfg(target_os = "linux")]
        let base = dirs::config_dir();

        #[cfg(target_os = "windows")]
        let base = dirs::config_dir();

        base.map(|dir| dir.join("vscodeee").join("sessions.json"))
    }

    /// Load the session store from disk.
    ///
    /// Returns an empty store if the file doesn't exist (first launch),
    /// is corrupted, or cannot be read. Logs warnings for errors but
    /// never panics.
    pub fn load() -> Self {
        let path = match Self::sessions_path() {
            Some(p) => p,
            None => {
                log::debug!(
                    target: "vscodeee::window::session",
                    "Could not determine sessions.json path, starting fresh"
                );
                return Self::new();
            }
        };

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        target: "vscodeee::window::session",
                        "Failed to read {}: {e}", path.display()
                    );
                }
                return Self::new();
            }
        };

        match serde_json::from_str::<SessionStore>(&content) {
            Ok(store) => {
                log::info!(
                    target: "vscodeee::window::session",
                    "Loaded session with {} entries from {}",
                    store.entries.len(),
                    path.display()
                );
                store
            }
            Err(e) => {
                log::warn!(
                    target: "vscodeee::window::session",
                    "Corrupted sessions.json at {}: {e} — starting fresh",
                    path.display()
                );
                Self::new()
            }
        }
    }

    /// Save the session store to disk.
    ///
    /// Creates parent directories if they don't exist. Logs errors
    /// but never panics.
    pub fn save(&self) {
        let path = match Self::sessions_path() {
            Some(p) => p,
            None => {
                log::warn!(
                    target: "vscodeee::window::session",
                    "Could not determine sessions.json path, skipping save"
                );
                return;
            }
        };

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!(
                    target: "vscodeee::window::session",
                    "Failed to create directory {}: {e}", parent.display()
                );
                return;
            }
        }

        let content = match serde_json::to_string_pretty(self) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    target: "vscodeee::window::session",
                    "Failed to serialize session store: {e}"
                );
                return;
            }
        };

        if let Err(e) = std::fs::write(&path, content) {
            log::warn!(
                target: "vscodeee::window::session",
                "Failed to write {}: {e}", path.display()
            );
        } else {
            log::info!(
                target: "vscodeee::window::session",
                "Saved session with {} entries to {}",
                self.entries.len(),
                path.display()
            );
        }
    }

    /// Generate the next window label for restored windows.
    ///
    /// Returns "main" for the first window, "main_2", "main_3", etc.
    /// for subsequent windows. The labels must be deterministic so
    /// `tauri-plugin-window-state` can restore position/size by label.
    pub fn next_label(index: usize) -> String {
        if index == 0 {
            "main".to_string()
        } else {
            format!("main_{}", index + 1)
        }
    }
}
