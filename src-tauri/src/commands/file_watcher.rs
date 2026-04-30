/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! File watcher using the `notify-debouncer-full` crate.
//!
//! Provides real-time file system change notifications to the VS Code workbench
//! via Tauri events. Uses `notify-debouncer-full` for intelligent event coalescing
//! that handles atomic file replacements (e.g., git checkout), rename tracking,
//! and deduplication at the Rust level — equivalent to what `@parcel/watcher`
//! provides in the original Electron-based VS Code.

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, DebouncedEvent};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

/// File change type matching VS Code's `FileChangeType` enum.
#[allow(dead_code)]
#[derive(Serialize, Clone, Debug)]
pub enum FileChangeType {
    Updated = 0,
    Added = 1,
    Deleted = 2,
}

/// A single file change event sent to the WebView.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub resource: String,
    pub r#type: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c_id: Option<i32>,
}

/// Request to start watching a path.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatchRequest {
    pub id: u64,
    pub path: String,
    pub recursive: bool,
    pub excludes: Vec<String>,
    #[serde(default)]
    pub correlation_id: Option<i32>,
}

/// Managed state for the file watcher system.
pub struct FileWatcherState {
    watchers: Mutex<HashMap<u64, WatcherHandle>>,
}

/// Holds the debouncer instance. When dropped, the debouncer is stopped
/// and the background thread terminates.
struct WatcherHandle {
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
    #[allow(dead_code)]
    correlation_id: Option<i32>,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Stop all file watchers.
    ///
    /// Same logic as the `fs_watch_stop_all` command, but callable from
    /// non-command contexts (e.g., shutdown coordinator).
    pub fn shutdown_all(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            let count = watchers.len();
            watchers.clear();
            log::info!(
                target: "vscodeee::file_watcher",
                "Stopped all watchers (count={count})"
            );
        }
    }
}

/// Maps a debounced `notify::EventKind` to VS Code's `FileChangeType`.
///
/// The debouncer coalesces rapid DELETE+CREATE sequences (from atomic file
/// replacements like `git checkout`) into a single event. On macOS, this
/// typically arrives as `Modify(Name(Both))` or `Modify(Data(_))`.
fn debounced_event_to_change_type(kind: &notify::EventKind) -> Option<u8> {
    use notify::EventKind;
    match kind {
        EventKind::Create(_) => Some(1), // Added
        EventKind::Modify(_) => Some(0), // Updated
        EventKind::Remove(_) => Some(2), // Deleted
        _ => None,
    }
}

fn should_exclude(path: &std::path::Path, excludes: &[globset::GlobMatcher]) -> bool {
    let path_str = path.to_string_lossy();
    excludes.iter().any(|m| m.is_match(path_str.as_ref()))
}

fn build_glob_matchers(patterns: &[String]) -> Vec<globset::GlobMatcher> {
    patterns
        .iter()
        .filter_map(|p| globset::Glob::new(p).ok().map(|g| g.compile_matcher()))
        .collect()
}

/// Converts a batch of debounced events into `FileChange` items, applying
/// exclude filters and attaching the correlation ID.
fn process_debounced_events(
    events: &[DebouncedEvent],
    excludes: &[globset::GlobMatcher],
    correlation_id: Option<i32>,
) -> Vec<FileChange> {
    let mut changes: Vec<FileChange> = Vec::new();

    for debounced in events {
        if let Some(change_type) = debounced_event_to_change_type(&debounced.event.kind) {
            for path in &debounced.event.paths {
                if should_exclude(path, excludes) {
                    continue;
                }
                changes.push(FileChange {
                    resource: path.to_string_lossy().to_string(),
                    r#type: change_type,
                    c_id: correlation_id,
                });
            }
        }
    }

    changes
}

/// Start watching a file path for changes.
///
/// Creates a debounced watcher using `notify-debouncer-full` which provides
/// intelligent event coalescing: DELETE+CREATE pairs (from git operations)
/// are merged into a single MODIFY event, rapid modifications are deduplicated,
/// and rename events are properly paired.
///
/// The debounce timeout (500ms) ensures that related events from atomic file
/// replacements are always captured in the same batch, regardless of OS-level
/// event delivery timing.
#[tauri::command]
pub fn fs_watch_start(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, FileWatcherState>,
    request: WatchRequest,
) -> Result<(), String> {
    let path = PathBuf::from(&request.path);

    // If the path doesn't exist, try to watch its parent directory instead.
    // VS Code often watches config files (tasks.json, mcp.json) before they exist
    // so it can detect when they are created.
    let (watch_path, watch_mode) = if !path.exists() {
        if let Some(parent) = path.parent() {
            if parent.exists() {
                log::debug!(
                    target: "vscodeee::file_watcher",
                    "Path {} does not exist, watching parent {} instead",
                    request.path,
                    parent.display()
                );
                (parent.to_path_buf(), RecursiveMode::NonRecursive)
            } else {
                log::warn!(
                    target: "vscodeee::file_watcher",
                    "Neither path nor parent exists: {}, skipping watch",
                    request.path
                );
                return Ok(());
            }
        } else {
            return Ok(());
        }
    } else {
        let mode = if request.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        (path, mode)
    };

    let watch_id = request.id;
    let correlation_id = request.correlation_id;
    let excludes = build_glob_matchers(&request.excludes);

    let app = app_handle.clone();
    let cid = correlation_id;

    // Create a debounced watcher with 500ms timeout.
    // This timeout is chosen to be long enough to capture DELETE+CREATE pairs
    // from git operations (which may be split across FSEvents callbacks on macOS),
    // while still being responsive enough for normal editing workflows.
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        None, // tick_rate: auto (1/4 of timeout = 125ms)
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                let changes = process_debounced_events(&events, &excludes, cid);
                if !changes.is_empty() {
                    let _ = app.emit("vscode:fs_change", &changes);
                }
            }
            Err(errors) => {
                for error in &errors {
                    log::warn!(
                        target: "vscodeee::file_watcher",
                        "Watcher error: {error}"
                    );
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create debounced watcher: {e}"))?;

    debouncer
        .watch(&watch_path, watch_mode)
        .map_err(|e| format!("Failed to watch path {}: {e}", watch_path.display()))?;

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.insert(
        watch_id,
        WatcherHandle {
            _debouncer: debouncer,
            correlation_id,
        },
    );

    log::debug!(
        target: "vscodeee::file_watcher",
        "Started watching {} (id={}, recursive={}, excludes={})",
        request.path,
        watch_id,
        request.recursive,
        request.excludes.len()
    );

    Ok(())
}

/// Stop watching a specific path.
#[tauri::command]
pub fn fs_watch_stop(state: tauri::State<'_, FileWatcherState>, id: u64) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    if watchers.remove(&id).is_some() {
        log::info!(
            target: "vscodeee::file_watcher",
            "Stopped watching (id={})",
            id
        );
    }
    Ok(())
}

/// Stop all watchers.
#[tauri::command]
pub fn fs_watch_stop_all(state: tauri::State<'_, FileWatcherState>) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    let count = watchers.len();
    watchers.clear();
    log::info!(
        target: "vscodeee::file_watcher",
        "Stopped all watchers (count={})",
        count
    );
    Ok(())
}
