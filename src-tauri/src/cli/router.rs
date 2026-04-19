/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! CLI argument router — dispatches parsed args to window actions.
//!
//! Routes a [`ParsedCli`](super::parser::ParsedCli) to the appropriate
//! window operations: focusing existing windows or opening new ones.

use tauri::Manager;

use super::parser::ParsedCli;
use super::uri;
use crate::window::manager::WindowManager;
use crate::window::state::OpenWindowOptions;

/// Route a parsed CLI request to the appropriate window action.
///
/// # Routing Rules
///
/// 1. **No paths** — focus the most recently active window
/// 2. **Paths without flags** — workspace dedup via `WindowManager`
/// 3. **`force_new_window`** — each path gets a new window regardless
pub async fn route_cli(
    app_handle: &tauri::AppHandle,
    wm: &WindowManager,
    cli: &ParsedCli,
    cwd: &str,
) {
    if cli.paths.is_empty() {
        focus_last_active(app_handle, wm).await;
        return;
    }

    for path in &cli.paths {
        let uri = match uri::path_to_file_uri(path, cwd) {
            Some(u) => uri::normalize_uri(&u),
            None => {
                log::warn!(
                    target: "vscodeee::cli::router",
                    "Skipping invalid or nonexistent path: {path}"
                );
                continue;
            }
        };

        let (folder_uri, workspace_uri) = if uri::is_workspace_file(path) {
            (None, Some(uri))
        } else {
            (Some(uri.clone()), None)
        };

        let options = OpenWindowOptions {
            folder_uri,
            workspace_uri,
            remote_authority: None,
            force_new_window: cli.force_new_window,
            force_reuse_window: cli.force_reuse_window,
        };

        match wm.open_window(app_handle, &options).await {
            Ok((id, label)) => {
                log::info!(
                    target: "vscodeee::cli::router",
                    "Opened/focused window for '{path}': {label} (id={id})"
                );
            }
            Err(e) => {
                log::error!(
                    target: "vscodeee::cli::router",
                    "Failed to open window for '{path}': {e}"
                );
            }
        }
    }
}

/// Focus the most recently active window, falling back to the "main" window.
async fn focus_last_active(app_handle: &tauri::AppHandle, wm: &WindowManager) {
    let label = if let Some(id) = wm.last_active_id().await {
        wm.label_for_id(id).await
    } else {
        None
    };

    let label = label.as_deref().unwrap_or("main");

    if let Some(window) = app_handle.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
        log::info!(
            target: "vscodeee::cli::router",
            "Focused existing window: {label}"
        );
    } else {
        log::warn!(
            target: "vscodeee::cli::router",
            "No window found to focus (label={label})"
        );
    }
}
