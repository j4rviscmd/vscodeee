/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! File watcher using the `notify` crate.
//!
//! Provides real-time file system change notifications to the VS Code workbench
//! via Tauri events. Each watch request from the TypeScript side gets a unique ID,
//! and events are batched (100ms debounce) before emission.

use notify::{Config, Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Emitter;

/// File change type matching VS Code's `FileChangeType` enum.
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

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    /// The sender half of the event channel.
    /// When `WatcherHandle` is dropped, the sender is dropped, causing the
    /// batching thread's `rx.recv()` to return `Err(Disconnected)` and exit.
    _event_tx: std::sync::mpsc::Sender<NotifyEvent>,
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

fn notify_event_to_change_type(kind: &EventKind) -> Option<u8> {
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

/// Start watching a file path for changes.
///
/// Creates a watcher using the `notify` crate and emits file change events
/// to the WebView via the `vscode:fs_change` Tauri event.
/// Events are debounced internally by `notify` (100ms).
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

    // Batch events using a channel + spawn
    let (tx, rx) = std::sync::mpsc::channel::<NotifyEvent>();

    // Clone tx for the closure; the original is stored in WatcherHandle so
    // that dropping the handle closes the channel and terminates the thread.
    let tx_for_watcher = tx.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<NotifyEvent, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx_for_watcher.send(event);
            }
        },
        Config::default().with_poll_interval(std::time::Duration::from_millis(500)),
    )
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(&watch_path, watch_mode)
        .map_err(|e| format!("Failed to watch path {}: {e}", watch_path.display()))?;

    // Spawn a thread that batches events every 100ms
    let cid = correlation_id;
    std::thread::spawn(move || {
        loop {
            // Wait for the first event
            let first = match rx.recv() {
                Ok(e) => e,
                Err(_) => break, // channel closed
            };

            // Collect more events for 100ms
            let mut events = vec![first];
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
            loop {
                let timeout = deadline.saturating_duration_since(std::time::Instant::now());
                if timeout.is_zero() {
                    break;
                }
                match rx.recv_timeout(timeout) {
                    Ok(e) => events.push(e),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }

            // Convert to FileChange events
            let mut changes: Vec<FileChange> = Vec::new();
            for event in &events {
                if let Some(change_type) = notify_event_to_change_type(&event.kind) {
                    for path in &event.paths {
                        if should_exclude(path, &excludes) {
                            continue;
                        }
                        changes.push(FileChange {
                            resource: path.to_string_lossy().to_string(),
                            r#type: change_type,
                            c_id: cid,
                        });
                    }
                }
            }

            if !changes.is_empty() {
                let _ = app.emit("vscode:fs_change", &changes);
            }
        }
    });

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.insert(
        watch_id,
        WatcherHandle {
            _watcher: watcher,
            _event_tx: tx,
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
