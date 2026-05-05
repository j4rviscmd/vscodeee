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
use tauri::{Emitter, Manager};

/// File change type matching VS Code's `FileChangeType` enum.
///
/// The discriminant values correspond to the numeric codes expected by the
/// TypeScript side so that deserialization works without explicit mapping.
#[allow(dead_code)]
#[derive(Serialize, Clone, Debug)]
pub enum FileChangeType {
    /// An existing file was modified or its metadata changed.
    Updated = 0,
    /// A new file was created.
    Added = 1,
    /// A file was removed.
    Deleted = 2,
}

/// A single file change event emitted to the WebView via `vscode:fs_change`.
///
/// Serialized as camelCase to match the TypeScript `IFileChange` interface
/// consumed by `AbstractFileService` on the workbench side.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Absolute file path of the changed resource.
    pub resource: String,
    /// Numeric change type: `0` = Updated, `1` = Added, `2` = Deleted.
    /// Matches `FileChangeType` discriminant values.
    pub r#type: u8,
    /// Optional correlation ID to link the event back to a specific watcher request.
    /// Skipped during serialization when `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c_id: Option<i32>,
}

/// Request to start watching a file or directory for changes.
///
/// Deserialized from the `invoke("fs_watch_start", request)` payload sent
/// by the TypeScript `TauriFileWatcher` service.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatchRequest {
    /// Unique watcher identifier used to stop or look up this watcher later.
    pub id: u64,
    /// Absolute path to the file or directory to watch.
    pub path: String,
    /// Whether to watch recursively (all subdirectories) or only the top level.
    pub recursive: bool,
    /// Glob patterns for paths to exclude from change notifications.
    pub excludes: Vec<String>,
    /// Optional correlation ID forwarded to emitted `FileChange` events,
    /// allowing the caller to associate changes with a specific watch request.
    #[serde(default)]
    pub correlation_id: Option<i32>,
}

/// Managed state for the file watcher system.
///
/// Registered as Tauri managed state so that both command handlers and the
/// shutdown coordinator can access the active watcher map.
///
/// The inner `Mutex<HashMap>` maps watcher IDs to their debouncer handles.
/// Dropping a `WatcherHandle` automatically stops the watcher and terminates
/// the background thread.
pub struct FileWatcherState {
    /// Map of watcher ID to debouncer handle. Protected by a mutex because
    /// command handlers and shutdown can access concurrently.
    watchers: Mutex<HashMap<u64, WatcherHandle>>,
}

/// Holds the debouncer instance for a single watcher.
///
/// When dropped, the debouncer is stopped and the background thread terminates.
/// The underscore-prefixed `_debouncer` field signals that the value is held
/// solely for its `Drop` side effect.
struct WatcherHandle {
    /// The debounced file watcher. Kept alive for the duration of the watch.
    /// Dropping this field stops the watcher and releases the background thread.
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
    /// Correlation ID associated with this watcher, forwarded to emitted events.
    #[allow(dead_code)]
    correlation_id: Option<i32>,
}

impl FileWatcherState {
    /// Create a new empty file watcher state.
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

/// Check whether a path matches any of the exclude glob patterns.
///
/// Used to filter out noise from change notifications (e.g., `.git` objects,
/// `node_modules`, build artifacts).
fn should_exclude(path: &std::path::Path, excludes: &[globset::GlobMatcher]) -> bool {
    let path_str = path.to_string_lossy();
    excludes.iter().any(|m| m.is_match(path_str.as_ref()))
}

/// Compile glob patterns into `GlobMatcher` instances for efficient matching.
///
/// Silently skips patterns that fail to parse (invalid globs are ignored rather
/// than causing the watch to fail entirely).
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
///
/// This is an async command because `Debouncer::watch()` calls
/// `FileIdMap::add_root()` which enumerates the directory tree and calls
/// `stat()` on every entry. On large directories this can take seconds,
/// so it MUST NOT run on the main thread.
#[tauri::command]
pub async fn fs_watch_start(
    app_handle: tauri::AppHandle,
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

    // Create debouncer + start watching on a background thread.
    // `Debouncer::watch()` calls `FileIdMap::add_root()` which enumerates
    // the directory tree and calls `stat()` on every entry — this can take
    // seconds on large directories and MUST NOT block the main thread.
    let debouncer_result: Result<
        notify_debouncer_full::Debouncer<
            notify::RecommendedWatcher,
            notify_debouncer_full::RecommendedCache,
        >,
        String,
    > = tauri::async_runtime::spawn_blocking(move || {
        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            None, // tick_rate: auto (1/4 of timeout = 125ms)
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    let changes = process_debounced_events(&events, &excludes, correlation_id);
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

        Ok(debouncer)
    })
    .await
    .map_err(|e| format!("Watcher setup panicked: {e}"))?;

    let debouncer = debouncer_result?;

    // Register watcher in state (lightweight HashMap insert).
    let state = app_handle.state::<FileWatcherState>();
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
