/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Terminal state persistence — file-based storage for terminal buffer state and layout info.
//!
//! Uses Tauri's `app_data_dir` for storage. Files are stored per-workspace
//! using an FNV-1a-inspired hash of the workspace ID for directory naming.

use std::fs;
use std::path::PathBuf;

/// Manages persistent terminal state on disk.
pub struct TerminalStateStore {
    base_dir: PathBuf,
}

impl TerminalStateStore {
    /// Create a new state store rooted at `app_data_dir/terminal/`.
    pub fn new(app_data_dir: &std::path::Path) -> Self {
        let base_dir = app_data_dir.join("terminal");
        let store = Self { base_dir };
        // Ensure the base directory exists
        let _ = fs::create_dir_all(&store.base_dir);
        store
    }

    /// Save terminal buffer state for a workspace.
    pub fn save_buffer_state(&self, workspace_id: &str, data: &str) -> Result<(), String> {
        let dir = self.workspace_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create state dir: {e}"))?;

        let path = dir.join("buffer_state.json");
        // Atomic write: write to temp file first, then rename
        let tmp_path = dir.join("buffer_state.json.tmp");
        fs::write(&tmp_path, data).map_err(|e| format!("Failed to write buffer state: {e}"))?;
        fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to rename buffer state: {e}"))?;

        log::debug!(target: "vscodeee::pty::state", "Saved buffer state for workspace {workspace_id}");
        Ok(())
    }

    /// Load terminal buffer state for a workspace.
    pub fn load_buffer_state(&self, workspace_id: &str) -> Result<Option<String>, String> {
        let path = self.workspace_dir(workspace_id).join("buffer_state.json");
        if !path.exists() {
            return Ok(None);
        }
        let data =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read buffer state: {e}"))?;
        log::debug!(target: "vscodeee::pty::state", "Loaded buffer state for workspace {workspace_id}");
        Ok(Some(data))
    }

    /// Save terminal layout info for a workspace.
    pub fn save_layout_info(&self, workspace_id: &str, data: &str) -> Result<(), String> {
        let dir = self.workspace_dir(workspace_id);
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create state dir: {e}"))?;

        let path = dir.join("layout_info.json");
        let tmp_path = dir.join("layout_info.json.tmp");
        fs::write(&tmp_path, data).map_err(|e| format!("Failed to write layout info: {e}"))?;
        fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to rename layout info: {e}"))?;

        log::debug!(target: "vscodeee::pty::state", "Saved layout info for workspace {workspace_id}");
        Ok(())
    }

    /// Load terminal layout info for a workspace.
    pub fn load_layout_info(&self, workspace_id: &str) -> Result<Option<String>, String> {
        let path = self.workspace_dir(workspace_id).join("layout_info.json");
        if !path.exists() {
            return Ok(None);
        }
        let data =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read layout info: {e}"))?;
        log::debug!(target: "vscodeee::pty::state", "Loaded layout info for workspace {workspace_id}");
        Ok(Some(data))
    }

    /// Clear all persisted state for a workspace.
    pub fn clear(&self, workspace_id: &str) -> Result<(), String> {
        let dir = self.workspace_dir(workspace_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("Failed to clear state: {e}"))?;
        }
        Ok(())
    }

    /// Get the workspace-specific directory path.
    fn workspace_dir(&self, workspace_id: &str) -> PathBuf {
        // Use a simple hash to create a safe directory name
        let hash = simple_hash(workspace_id);
        self.base_dir.join(hash)
    }
}

/// Simple hash function for workspace IDs.
/// Uses a basic FNV-1a-inspired hash for directory naming.
fn simple_hash(s: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in s.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_save_and_load_buffer_state() {
        let dir = std::env::temp_dir().join("vscodeee_test_state");
        let _ = fs::remove_dir_all(&dir);
        let store = TerminalStateStore::new(&dir);

        let workspace_id = "test-workspace-123";
        let data = r#"{"version":1,"state":[]}"#;

        store.save_buffer_state(workspace_id, data).unwrap();
        let loaded = store.load_buffer_state(workspace_id).unwrap();
        assert_eq!(loaded, Some(data.to_string()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_nonexistent_returns_none() {
        let dir = std::env::temp_dir().join("vscodeee_test_state_none");
        let _ = fs::remove_dir_all(&dir);
        let store = TerminalStateStore::new(&dir);

        let result = store.load_buffer_state("nonexistent").unwrap();
        assert_eq!(result, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_clear_removes_state() {
        let dir = std::env::temp_dir().join("vscodeee_test_state_clear");
        let _ = fs::remove_dir_all(&dir);
        let store = TerminalStateStore::new(&dir);

        store.save_buffer_state("ws", "data").unwrap();
        store.clear("ws").unwrap();
        let result = store.load_buffer_state("ws").unwrap();
        assert_eq!(result, None);

        let _ = fs::remove_dir_all(&dir);
    }
}
