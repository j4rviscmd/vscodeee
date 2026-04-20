/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window restore strategy — computes which windows to create at launch.
//!
//! Implements the Strategy pattern for VS Code's 5 `window.restoreWindows` modes:
//! `preserve`, `all`, `folders`, `one`, `none`.
//!
//! Called from `setup()` before the event loop starts, using the session store
//! and user settings to produce a list of [`RestoreEntry`] structs that the
//! window manager uses to create windows.

use super::session::SessionStore;
use super::state::{RestoreWindowsMode, WindowSessionEntry};

/// A planned window to create during restore.
///
/// Contains all the information needed to create a WebviewWindow and
/// configure it with the correct workspace.
#[derive(Debug, Clone)]
pub struct RestoreEntry {
    /// Window label for `tauri-plugin-window-state` compatibility.
    pub label: String,
    /// Folder URI to open, if any.
    pub folder_uri: Option<String>,
    /// Workspace (.code-workspace) URI to open, if any.
    pub workspace_uri: Option<String>,
    /// Whether this was the last active window (should receive focus).
    // TODO(Phase 3): Remove allow(dead_code) when this is wired up
    #[allow(dead_code)]
    pub is_last_active: bool,
    /// Whether to restore fullscreen state.
    pub is_fullscreen: bool,
}

/// Compute the list of windows to restore based on settings and saved session.
///
/// # Arguments
///
/// * `mode` — The `window.restoreWindows` setting value.
/// * `restore_fullscreen` — Whether `window.restoreFullscreen` is enabled.
/// * `session` — The loaded session store with previous window entries.
///
/// # Returns
///
/// A `Vec<RestoreEntry>` — at least one entry is always returned (the "main"
/// window), even if `mode` is `None` (which creates a fresh empty window).
pub fn compute_restore_plan(
    mode: RestoreWindowsMode,
    restore_fullscreen: bool,
    session: &SessionStore,
) -> Vec<RestoreEntry> {
    if session.entries.is_empty() {
        return vec![empty_main_window()];
    }

    match mode {
        RestoreWindowsMode::Preserve | RestoreWindowsMode::All => {
            restore_all(&session.entries, restore_fullscreen)
        }
        RestoreWindowsMode::Folders => restore_folders(&session.entries, restore_fullscreen),
        RestoreWindowsMode::One => restore_one(&session.entries, restore_fullscreen),
        RestoreWindowsMode::None => {
            vec![empty_main_window()]
        }
    }
}

/// Restore all windows from the session, including empty ones.
///
/// Sorts entries by their saved `order` field and maps each to a
/// [`RestoreEntry`] with a deterministic label. Fullscreen state is
/// only restored when `restore_fullscreen` is `true`.
fn restore_all(entries: &[WindowSessionEntry], restore_fullscreen: bool) -> Vec<RestoreEntry> {
    let mut sorted = entries.to_vec();
    sorted.sort_by_key(|e| e.order);

    let result: Vec<RestoreEntry> = sorted
        .iter()
        .enumerate()
        .map(|(i, entry)| RestoreEntry {
            label: SessionStore::next_label(i),
            folder_uri: entry.folder_uri.clone(),
            workspace_uri: entry.workspace_uri.clone(),
            is_last_active: entry.is_last_active,
            is_fullscreen: restore_fullscreen && entry.is_fullscreen,
        })
        .collect();

    if result.is_empty() {
        vec![empty_main_window()]
    } else {
        result
    }
}

/// Restore only windows that had a folder or workspace open.
///
/// Filters out entries without a `folder_uri` or `workspace_uri`, then
/// sorts by `order`. Falls back to a single empty window if no qualifying
/// entries exist.
fn restore_folders(entries: &[WindowSessionEntry], restore_fullscreen: bool) -> Vec<RestoreEntry> {
    let with_workspace: Vec<&WindowSessionEntry> = entries
        .iter()
        .filter(|e| e.folder_uri.is_some() || e.workspace_uri.is_some())
        .collect();

    if with_workspace.is_empty() {
        return vec![empty_main_window()];
    }

    let mut sorted = with_workspace;
    sorted.sort_by_key(|e| e.order);

    sorted
        .iter()
        .enumerate()
        .map(|(i, entry)| RestoreEntry {
            label: SessionStore::next_label(i),
            folder_uri: entry.folder_uri.clone(),
            workspace_uri: entry.workspace_uri.clone(),
            is_last_active: entry.is_last_active,
            is_fullscreen: restore_fullscreen && entry.is_fullscreen,
        })
        .collect()
}

/// Restore only the last active window.
///
/// Finds the entry marked as `is_last_active`, falling back to the
/// last entry in the list. Always produces exactly one `RestoreEntry`
/// with the label `"main"`.
fn restore_one(entries: &[WindowSessionEntry], restore_fullscreen: bool) -> Vec<RestoreEntry> {
    let last_active = entries
        .iter()
        .find(|e| e.is_last_active)
        .or_else(|| entries.last());

    match last_active {
        Some(entry) => vec![RestoreEntry {
            label: "main".to_string(),
            folder_uri: entry.folder_uri.clone(),
            workspace_uri: entry.workspace_uri.clone(),
            is_last_active: true,
            is_fullscreen: restore_fullscreen && entry.is_fullscreen,
        }],
        None => vec![empty_main_window()],
    }
}

/// Create a restore entry for a fresh empty "main" window.
///
/// Used as the fallback when no session data is available, or when
/// the `restoreWindows` mode is `None`.
fn empty_main_window() -> RestoreEntry {
    RestoreEntry {
        label: "main".to_string(),
        folder_uri: None,
        workspace_uri: None,
        is_last_active: true,
        is_fullscreen: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(
        id: u32,
        folder: Option<&str>,
        order: u32,
        is_last_active: bool,
    ) -> WindowSessionEntry {
        WindowSessionEntry {
            id,
            label: format!("main_{id}"),
            workspace_uri: None,
            folder_uri: folder.map(String::from),
            is_fullscreen: false,
            is_maximized: false,
            order,
            is_last_active,
        }
    }

    #[test]
    fn empty_session_returns_single_window() {
        let session = SessionStore::new();
        let plan = compute_restore_plan(RestoreWindowsMode::All, false, &session);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].label, "main");
    }

    #[test]
    fn none_mode_ignores_session() {
        let session = SessionStore {
            entries: vec![make_entry(1, Some("file:///a"), 0, true)],
        };
        let plan = compute_restore_plan(RestoreWindowsMode::None, false, &session);
        assert_eq!(plan.len(), 1);
        assert!(plan[0].folder_uri.is_none());
    }

    #[test]
    fn all_mode_restores_everything() {
        let session = SessionStore {
            entries: vec![
                make_entry(1, Some("file:///a"), 0, false),
                make_entry(2, None, 1, false),
                make_entry(3, Some("file:///b"), 2, true),
            ],
        };
        let plan = compute_restore_plan(RestoreWindowsMode::All, false, &session);
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].folder_uri.as_deref(), Some("file:///a"));
        assert!(plan[1].folder_uri.is_none()); // empty window restored
        assert_eq!(plan[2].folder_uri.as_deref(), Some("file:///b"));
    }

    #[test]
    fn folders_mode_skips_empty() {
        let session = SessionStore {
            entries: vec![
                make_entry(1, Some("file:///a"), 0, false),
                make_entry(2, None, 1, false),
                make_entry(3, Some("file:///b"), 2, true),
            ],
        };
        let plan = compute_restore_plan(RestoreWindowsMode::Folders, false, &session);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].folder_uri.as_deref(), Some("file:///a"));
        assert_eq!(plan[1].folder_uri.as_deref(), Some("file:///b"));
    }

    #[test]
    fn one_mode_restores_last_active() {
        let session = SessionStore {
            entries: vec![
                make_entry(1, Some("file:///a"), 0, false),
                make_entry(2, Some("file:///b"), 1, true),
            ],
        };
        let plan = compute_restore_plan(RestoreWindowsMode::One, false, &session);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].folder_uri.as_deref(), Some("file:///b"));
        assert_eq!(plan[0].label, "main");
    }
}
