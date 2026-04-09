/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Core types for window management.
//!
//! Defines the data structures used by [`WindowManager`](super::manager::WindowManager)
//! to track window identity, state, and lifecycle.

use serde::{Deserialize, Serialize};

/// Unique, monotonically increasing window identifier.
/// Maps 1:1 with a Tauri WebviewWindow label.
pub type WindowId = u32;

/// Describes the kind of window for future extensibility (Issue #26).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum WindowKind {
    /// Main workbench window (current scope).
    Main,
    /// Auxiliary/floating window (Issue #26, future).
    Auxiliary { parent_id: WindowId },
}

/// Runtime state of a single window.
///
/// Maintained by [`WindowManager`](super::manager::WindowManager) and serialized
/// to JSON when sent to the TypeScript layer via `get_all_windows`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// Unique monotonic identifier assigned at window creation.
    pub id: WindowId,
    /// Tauri window label (e.g. `"main"`, `"main_2"`), used for event scoping.
    pub label: String,
    /// Classification of this window for future auxiliary window support.
    pub kind: WindowKind,
    /// The workspace or folder URI currently open in this window, if any.
    pub workspace_uri: Option<String>,
    /// Whether the workbench has completed its bootstrap sequence.
    pub is_ready: bool,
    /// Whether this window currently has OS-level focus.
    pub is_focused: bool,
    /// Whether this window is in fullscreen mode.
    pub is_fullscreen: bool,
    /// Whether this window is in the maximized state.
    pub is_maximized: bool,
    /// Whether the initial restore URIs have been consumed by the first
    /// `get_window_configuration` call. Once consumed, subsequent calls
    /// (e.g. after "Close Folder" reload) will not return restored URIs.
    #[serde(skip)]
    pub restore_consumed: bool,
}

/// Options for opening a new window (received from TypeScript).
///
/// Deserialized from the JSON payload of the `open_new_window` Tauri command.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindowOptions {
    /// URI of the folder to open, if any (e.g. `"file:///Users/me/project"`).
    #[serde(default)]
    pub folder_uri: Option<String>,
    /// URI of a `.code-workspace` file to open, if any.
    #[serde(default)]
    pub workspace_uri: Option<String>,
    /// When `true`, always create a new window even if the workspace is already open.
    #[serde(default)]
    pub force_new_window: bool,
    /// When `true`, reuse the current window instead of opening a new one.
    #[serde(default)]
    pub force_reuse_window: bool,
}

/// The `window.restoreWindows` setting values from VS Code's settings.json.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RestoreWindowsMode {
    /// Restore all windows from the previous session, including their workspaces.
    Preserve,
    /// Restore all windows (same as Preserve in our implementation).
    #[default]
    All,
    /// Only restore windows that had a folder/workspace open.
    Folders,
    /// Restore only the last active window.
    One,
    /// Do not restore any windows — always open a fresh empty window.
    None,
}

impl RestoreWindowsMode {
    /// Parse a string value from settings.json into a `RestoreWindowsMode`.
    /// Returns the default (`All`) for unrecognized values.
    pub fn from_setting(value: &str) -> Self {
        match value {
            "preserve" => Self::Preserve,
            "all" => Self::All,
            "folders" => Self::Folders,
            "one" => Self::One,
            "none" => Self::None,
            _ => {
                log::warn!(
                    target: "vscodeee::window::state",
                    "Unknown restoreWindows value: {value:?}, defaulting to 'all'"
                );
                Self::All
            }
        }
    }
}

/// Serializable workspace state for session restore.
///
/// Captures the minimal information needed to reopen a window with the same
/// workspace on next launch. Used by [`SessionStore`](super::session::SessionStore).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSessionEntry {
    /// Window ID at the time the session was saved.
    pub id: WindowId,
    /// Tauri window label at the time the session was saved.
    pub label: String,
    /// The workspace URI that was open, if any.
    pub workspace_uri: Option<String>,
    /// The folder URI that was open, if any.
    pub folder_uri: Option<String>,
    /// Whether this window was in fullscreen mode.
    #[serde(default)]
    pub is_fullscreen: bool,
    /// Whether this window was maximized.
    #[serde(default)]
    pub is_maximized: bool,
    /// Display order (lower = earlier). Used to restore window stacking.
    #[serde(default)]
    pub order: u32,
    /// Whether this was the last active (focused) window before shutdown.
    #[serde(default)]
    pub is_last_active: bool,
}
