/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Quit coordination state — tracks whether a multi-window quit is in progress.
//!
//! When `quit_all_windows` is invoked, the `QuitState` is set to active. The
//! `CloseRequested` handler checks this flag to include `reason: "quit"` in the
//! event payload sent to the TypeScript lifecycle service.
//!
//! If any window vetoes, the quit is cancelled (flag cleared). When the last
//! window confirms close during an active quit, `app.exit(0)` is called.

use std::sync::atomic::{AtomicBool, Ordering};

/// Shared state tracking whether a coordinated quit is in progress.
///
/// Managed as Tauri state so it's accessible from both the event handler
/// (`handle_window_event`) and the command handlers (`lifecycle_close_confirmed`,
/// `lifecycle_close_vetoed`).
#[derive(Debug)]
pub struct QuitState {
    /// `true` when `quit_all_windows` has been triggered and we're waiting
    /// for all windows to confirm their close handshake.
    in_progress: AtomicBool,
}

impl QuitState {
    /// Creates a new `QuitState` with quit not in progress.
    pub fn new() -> Self {
        Self {
            in_progress: AtomicBool::new(false),
        }
    }

    /// Mark quit as in progress.
    pub fn start(&self) {
        self.in_progress.store(true, Ordering::SeqCst);
    }

    /// Clear the quit-in-progress flag (e.g., when a window vetoes).
    pub fn cancel(&self) {
        self.in_progress.store(false, Ordering::SeqCst);
    }

    /// Check whether a quit is currently in progress.
    pub fn is_active(&self) -> bool {
        self.in_progress.load(Ordering::SeqCst)
    }
}
