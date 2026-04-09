/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Centralized window registry — the Tauri equivalent of Electron's `WindowsMainService`.
//!
//! [`WindowManager`] tracks every open WebviewWindow with a unique monotonic ID,
//! maps Tauri labels to IDs (and back), and provides workspace deduplication.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::sync::RwLock;

use super::state::{OpenWindowOptions, WindowId, WindowInfo, WindowKind, WindowSessionEntry};

/// Central registry for all open windows.
///
/// Thread-safe via `RwLock` (for the maps) and `AtomicU32` (for the ID counter).
/// Intended to be shared as Tauri managed state via `app.manage(WindowManager::new())`.
pub struct WindowManager {
    /// Monotonically increasing counter for generating unique window IDs.
    next_id: AtomicU32,
    /// Maps window IDs to their current runtime state.
    windows: RwLock<HashMap<WindowId, WindowInfo>>,
    /// Reverse lookup: Tauri window label → logical window ID.
    label_to_id: RwLock<HashMap<String, WindowId>>,
    /// The most recently focused window ID, used for fallback targeting.
    last_active: RwLock<Option<WindowId>>,
}

impl WindowManager {
    /// Create a new, empty `WindowManager` with the ID counter starting at 1.
    pub fn new() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            windows: RwLock::new(HashMap::new()),
            label_to_id: RwLock::new(HashMap::new()),
            last_active: RwLock::new(None),
        }
    }

    /// Register the initial window created by `tauri.conf.json` (label="main").
    /// Called from `setup()` before any user interaction.
    pub async fn register_initial_window(&self, label: &str) -> WindowId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let info = WindowInfo {
            id,
            label: label.to_string(),
            kind: WindowKind::Main,
            workspace_uri: None,
            is_ready: false,
            is_focused: true,
            is_fullscreen: false,
            is_maximized: false,
            restore_consumed: false,
        };

        self.windows.write().await.insert(id, info);
        self.label_to_id.write().await.insert(label.to_string(), id);
        *self.last_active.write().await = Some(id);

        log::info!(
            target: "vscodeee::window::manager",
            "Registered initial window: label={label}, id={id}"
        );

        id
    }

    /// Create and register a new window. Returns the window ID and label.
    ///
    /// If `options.workspace_uri` or `options.folder_uri` is set and `force_new_window`
    /// is false, returns an existing window that already has that workspace open.
    pub async fn open_window(
        &self,
        app_handle: &tauri::AppHandle,
        options: &OpenWindowOptions,
    ) -> Result<(WindowId, String), String> {
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

        // Workspace deduplication: if not forcing, find existing window with same workspace
        if !options.force_new_window {
            let workspace_key = options
                .folder_uri
                .as_deref()
                .or(options.workspace_uri.as_deref());
            if let Some(key) = workspace_key {
                if let Some(existing) = self.find_by_workspace(key).await {
                    // Focus the existing window instead of creating a new one
                    if let Some(win) = app_handle.get_webview_window(&existing.label) {
                        let _ = win.set_focus();
                    }
                    log::info!(
                        target: "vscodeee::window::manager",
                        "Reusing existing window {} for workspace: {key}",
                        existing.id
                    );
                    return Ok((existing.id, existing.label));
                }
            }
        }

        // Allocate new ID and label
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let label = format!("main_{id}");

        // Build URL with optional query params
        let mut url_str = String::from("vs/code/tauri-browser/workbench/workbench-tauri.html");
        let mut has_param = false;
        if let Some(ref folder) = options.folder_uri {
            url_str.push_str("?folder=");
            url_str.push_str(&encode_uri_component(folder));
            has_param = true;
        } else if let Some(ref workspace) = options.workspace_uri {
            url_str.push_str("?workspace=");
            url_str.push_str(&encode_uri_component(workspace));
            has_param = true;
        }
        // Always pass the window label so the new window can resolve its ID
        let separator = if has_param { '&' } else { '?' };
        url_str.push(separator);
        url_str.push_str("windowLabel=");
        url_str.push_str(&label);

        let url = WebviewUrl::App(url_str.into());

        // macOS: use overlay title bar to keep native traffic lights
        #[cfg(target_os = "macos")]
        let builder = WebviewWindowBuilder::new(app_handle, &label, url)
            .title("VS Codeee")
            .inner_size(1200.0, 800.0)
            .min_inner_size(400.0, 270.0)
            .decorations(false)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);

        #[cfg(not(target_os = "macos"))]
        let builder = WebviewWindowBuilder::new(app_handle, &label, url)
            .title("VS Codeee")
            .inner_size(1200.0, 800.0)
            .min_inner_size(400.0, 270.0)
            .decorations(false);

        builder
            .build()
            .map_err(|e| format!("Failed to create window: {e}"))?;

        // Register in state
        let workspace_uri = options
            .folder_uri
            .clone()
            .or_else(|| options.workspace_uri.clone());
        let info = WindowInfo {
            id,
            label: label.clone(),
            kind: WindowKind::Main,
            workspace_uri,
            is_ready: false,
            is_focused: true,
            is_fullscreen: false,
            is_maximized: false,
            restore_consumed: false,
        };

        self.windows.write().await.insert(id, info);
        self.label_to_id.write().await.insert(label.clone(), id);
        *self.last_active.write().await = Some(id);

        // Emit the window-opened event so TypeScript listeners are notified
        use tauri::Emitter;
        let _ = app_handle.emit(super::events::event_names::WINDOW_OPENED, id);

        log::info!(
            target: "vscodeee::window::manager",
            "Opened new window: label={label}, id={id}, folder={:?}",
            options.folder_uri
        );

        Ok((id, label))
    }

    /// Unregister a window when it closes.
    pub async fn unregister(&self, label: &str) -> Option<WindowId> {
        let id = self.label_to_id.write().await.remove(label);
        if let Some(id) = id {
            self.windows.write().await.remove(&id);
            log::info!(
                target: "vscodeee::window::manager",
                "Unregistered window: label={label}, id={id}"
            );
        }
        id
    }

    /// Get the window ID for a Tauri label.
    pub async fn id_for_label(&self, label: &str) -> Option<WindowId> {
        self.label_to_id.read().await.get(label).copied()
    }

    /// Get the Tauri label for a window ID (reverse lookup).
    pub async fn label_for_id(&self, id: WindowId) -> Option<String> {
        self.windows
            .read()
            .await
            .get(&id)
            .map(|info| info.label.clone())
    }

    /// Get window info by ID.
    pub async fn get(&self, id: WindowId) -> Option<WindowInfo> {
        self.windows.read().await.get(&id).cloned()
    }

    /// Get window info by label.
    pub async fn get_by_label(&self, label: &str) -> Option<WindowInfo> {
        let id = self.id_for_label(label).await?;
        self.get(id).await
    }

    /// Get all registered windows.
    pub async fn get_all(&self) -> Vec<WindowInfo> {
        self.windows.read().await.values().cloned().collect()
    }

    /// Get the total number of registered windows.
    pub async fn count(&self) -> usize {
        self.windows.read().await.len()
    }

    /// Get the last active (focused) window ID.
    pub async fn last_active_id(&self) -> Option<WindowId> {
        *self.last_active.read().await
    }

    /// Find a window by workspace URI.
    pub async fn find_by_workspace(&self, workspace_uri: &str) -> Option<WindowInfo> {
        let windows = self.windows.read().await;
        windows
            .values()
            .find(|w| w.workspace_uri.as_deref() == Some(workspace_uri))
            .cloned()
    }

    /// Update a window's focused state.
    pub async fn set_focused(&self, label: &str, focused: bool) {
        if let Some(id) = self.id_for_label(label).await {
            if let Some(info) = self.windows.write().await.get_mut(&id) {
                info.is_focused = focused;
            }
            if focused {
                *self.last_active.write().await = Some(id);
            }
        }
    }

    /// Update a window's fullscreen state.
    pub async fn set_fullscreen(&self, label: &str, fullscreen: bool) {
        if let Some(id) = self.id_for_label(label).await {
            if let Some(info) = self.windows.write().await.get_mut(&id) {
                info.is_fullscreen = fullscreen;
            }
        }
    }

    /// Update a window's maximized state.
    pub async fn set_maximized(&self, label: &str, maximized: bool) {
        if let Some(id) = self.id_for_label(label).await {
            if let Some(info) = self.windows.write().await.get_mut(&id) {
                info.is_maximized = maximized;
            }
        }
    }

    /// Mark a window as ready (workbench bootstrap complete).
    pub async fn set_ready(&self, label: &str) {
        if let Some(id) = self.id_for_label(label).await {
            if let Some(info) = self.windows.write().await.get_mut(&id) {
                info.is_ready = true;
            }
        }
    }

    /// Update a window's workspace URI.
    ///
    /// Called when the TypeScript layer opens a folder/workspace, so the Rust
    /// side tracks which workspace each window has open for session persistence.
    pub async fn set_workspace_uri(&self, label: &str, uri: Option<String>) {
        if let Some(id) = self.id_for_label(label).await {
            if let Some(info) = self.windows.write().await.get_mut(&id) {
                info.workspace_uri = uri;
            }
        }
    }

    /// Set the workspace URI for a window.
    pub async fn set_workspace(&self, label: &str, workspace_uri: Option<String>) {
        if let Some(id) = self.id_for_label(label).await {
            if let Some(info) = self.windows.write().await.get_mut(&id) {
                info.workspace_uri = workspace_uri;
            }
        }
    }

    /// Consume the restored workspace URI for a window.
    ///
    /// Returns the workspace URI on the first call after app start, then marks
    /// the restore as consumed so subsequent calls (e.g. after "Close Folder"
    /// reload) return `None`.
    pub async fn consume_restored_uri(&self, label: &str) -> Option<String> {
        if let Some(id) = self.id_for_label(label).await {
            if let Some(info) = self.windows.write().await.get_mut(&id) {
                if !info.restore_consumed {
                    info.restore_consumed = true;
                    return info.workspace_uri.clone();
                }
            }
        }
        None
    }

    /// Create a snapshot of all windows for session persistence.
    ///
    /// Returns a list of [`WindowSessionEntry`] structs capturing the
    /// current state of all windows, suitable for saving to `sessions.json`.
    pub async fn snapshot_for_session(&self) -> Vec<WindowSessionEntry> {
        let windows = self.windows.read().await;
        let last_active = *self.last_active.read().await;
        let mut entries: Vec<WindowSessionEntry> = windows
            .values()
            .enumerate()
            .map(|(order, info)| WindowSessionEntry {
                id: info.id,
                label: info.label.clone(),
                workspace_uri: info.workspace_uri.clone(),
                folder_uri: info.workspace_uri.clone(),
                is_fullscreen: info.is_fullscreen,
                is_maximized: info.is_maximized,
                order: order as u32,
                is_last_active: last_active == Some(info.id),
            })
            .collect();
        entries.sort_by_key(|e| e.order);
        entries
    }

    /// Create and register a restored window (not the initial "main" window).
    ///
    /// Used during session restore to create additional windows beyond
    /// the first one (which is always created by `tauri.conf.json`).
    pub async fn create_restored_window(
        &self,
        app_handle: &tauri::AppHandle,
        label: &str,
        folder_uri: Option<&str>,
        workspace_uri: Option<&str>,
        is_fullscreen: bool,
    ) -> Result<WindowId, String> {
        use tauri::{WebviewUrl, WebviewWindowBuilder};

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        // Build URL with workspace/folder query params
        let mut url_str = String::from("vs/code/tauri-browser/workbench/workbench-tauri.html");
        let mut has_param = false;

        if let Some(folder) = folder_uri {
            url_str.push_str("?folder=");
            url_str.push_str(&encode_uri_component(folder));
            has_param = true;
        } else if let Some(workspace) = workspace_uri {
            url_str.push_str("?workspace=");
            url_str.push_str(&encode_uri_component(workspace));
            has_param = true;
        }

        let separator = if has_param { '&' } else { '?' };
        url_str.push(separator);
        url_str.push_str("windowLabel=");
        url_str.push_str(label);

        let url = WebviewUrl::App(url_str.into());

        #[cfg(target_os = "macos")]
        let builder = WebviewWindowBuilder::new(app_handle, label, url)
            .title("VS Codeee")
            .inner_size(1200.0, 800.0)
            .min_inner_size(400.0, 270.0)
            .decorations(false)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .fullscreen(is_fullscreen);

        #[cfg(not(target_os = "macos"))]
        let builder = WebviewWindowBuilder::new(app_handle, label, url)
            .title("VS Codeee")
            .inner_size(1200.0, 800.0)
            .min_inner_size(400.0, 270.0)
            .decorations(false)
            .fullscreen(is_fullscreen);

        builder
            .build()
            .map_err(|e| format!("Failed to create restored window '{label}': {e}"))?;

        let effective_uri = folder_uri
            .map(String::from)
            .or_else(|| workspace_uri.map(String::from));

        let info = WindowInfo {
            id,
            label: label.to_string(),
            kind: WindowKind::Main,
            workspace_uri: effective_uri,
            is_ready: false,
            is_focused: false,
            is_fullscreen,
            is_maximized: false,
            restore_consumed: false,
        };

        self.windows.write().await.insert(id, info);
        self.label_to_id.write().await.insert(label.to_string(), id);

        log::info!(
            target: "vscodeee::window::manager",
            "Created restored window: label={label}, id={id}"
        );

        Ok(id)
    }
}

/// Minimal percent-encoding for URI query strings.
///
/// Encodes only the characters that would break URL parsing (space, `#`, `&`,
/// `=`, `?`). This is intentionally minimal — a full percent-encoder is not
/// needed because folder/workspace URIs are already well-formed.
fn encode_uri_component(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '&' => "%26".to_string(),
            '=' => "%3D".to_string(),
            '?' => "%3F".to_string(),
            _ => c.to_string(),
        })
        .collect()
}
