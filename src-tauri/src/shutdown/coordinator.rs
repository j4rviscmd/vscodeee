/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Shutdown coordinator — orchestrates ordered cleanup of all managed resources.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

/// Type alias for a cleanup closure. Each closure captures an `AppHandle`
/// clone and calls the cleanup method on the corresponding managed state.
type CleanupFn = Box<dyn Fn() + Send + Sync>;

/// Ordered shutdown phases.
///
/// Resources are shut down in this order to respect dependencies:
/// 1. Extensions — Extension Host sidecars (Node.js processes)
/// 2. PTY instances — pseudo-terminal shell processes
/// 3. File watchers — filesystem monitoring threads
/// 4. System events — OS event monitor threads (last, no dependencies)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ShutdownPhase {
    Extensions = 0,
    Pty = 1,
    FileWatchers = 2,
    // TODO(Phase 3): Remove allow(dead_code) when this is wired up
    #[allow(dead_code)]
    SystemEvents = 3,
}

/// Coordinates ordered shutdown of all application resources.
///
/// Registered as Tauri managed state. Each resource registers a cleanup
/// closure during app setup. The closures capture a cloned `AppHandle`
/// and call cleanup methods on their corresponding managed state.
///
/// # Termination paths covered
///
/// - **Window close**: `lifecycle_close_confirmed` → `shutdown_all()` → `window.destroy()`
/// - **Cmd+Q / quit_app**: `RunEvent::ExitRequested` → `shutdown_all()` → allow exit
/// - **RunEvent::Exit** (catch-all): final cleanup for any exit path
/// - **Hot reload**: `Drop` → `force_shutdown()` as safety net
pub struct ShutdownCoordinator {
    resources: RwLock<Vec<(ShutdownPhase, &'static str, CleanupFn)>>,
    shutdown_done: AtomicBool,
}

impl ShutdownCoordinator {
    /// Create a new shutdown coordinator wrapped in `Arc` for managed state.
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            resources: RwLock::new(Vec::new()),
            shutdown_done: AtomicBool::new(false),
        })
    }

    /// Register a cleanup closure for the given phase.
    ///
    /// The closure should capture a cloned `AppHandle` and call cleanup
    /// methods on the corresponding managed state.
    ///
    /// The shutdown-done flag is checked under the write lock to avoid a
    /// TOCTOU race with a concurrent [`shutdown_all()`](Self::shutdown_all) call.
    ///
    /// # Early return
    ///
    /// Logs a warning and returns silently if called after shutdown has already
    /// completed. No panic is raised in this case.
    ///
    /// # Panics
    ///
    /// Panics only if the internal `RwLock` is poisoned and the recovery
    /// closure (`into_inner`) itself panics, which should never happen.
    pub fn register(&self, phase: ShutdownPhase, name: &'static str, cleanup: CleanupFn) {
        let mut resources = self.resources.write().unwrap_or_else(|e| e.into_inner());
        // Check shutdown flag under the write lock to avoid TOCTOU race —
        // shutdown_all() drains the Vec under the same write lock.
        if self.shutdown_done.load(Ordering::SeqCst) {
            log::warn!(
                target: "vscodeee::shutdown",
                "Register called after shutdown — resource '{name}' will not be cleaned up"
            );
            return;
        }
        log::debug!(
            target: "vscodeee::shutdown",
            "Registered resource: {name} (phase={:?})",
            phase
        );
        resources.push((phase, name, cleanup));
    }

    /// Perform a full ordered shutdown of all registered resources.
    ///
    /// Idempotent -- safe to call multiple times. Only the first call executes cleanup;
    /// subsequent calls return immediately after logging a debug message.
    ///
    /// # Strategy
    ///
    /// 1. Atomically set the `shutdown_done` flag via `swap` (avoids TOCTOU races).
    /// 2. Drain the resource list under the write lock, then **release the lock**
    ///    before executing any cleanup closures -- this prevents deadlocks if a
    ///    closure attempts to acquire the lock (e.g., by calling `register`).
    /// 3. Sort drained resources by [`ShutdownPhase`] ordinal so that extensions
    ///    are torn down before PTY instances, PTY before file watchers, etc.
    /// 4. Execute each closure inside [`catch_unwind`](std::panic::catch_unwind) so
    ///    that a panic in one resource does not prevent cleanup of the remaining ones.
    ///
    /// # Panics
    ///
    /// Panics only if the internal `RwLock` is poisoned and the recovery closure
    /// (`into_inner`) itself panics, which should never happen.
    pub fn shutdown_all(&self) {
        if self.shutdown_done.swap(true, Ordering::SeqCst) {
            log::debug!(target: "vscodeee::shutdown", "shutdown_all() already called — skipping");
            return;
        }

        log::info!(target: "vscodeee::shutdown", "Starting ordered shutdown...");

        // Drain resources under write lock, then release before executing closures.
        let mut resources: Vec<_> = {
            let mut guard = self.resources.write().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *guard)
        };
        resources.sort_by_key(|(p, _, _)| *p);
        for (phase, name, cleanup) in resources {
            log::info!(
                target: "vscodeee::shutdown",
                "Shutting down: {name} (phase={:?})",
                phase
            );
            if let Err(err) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(cleanup)) {
                log::error!(
                    target: "vscodeee::shutdown",
                    "Cleanup panicked for '{name}': {:?}",
                    err
                );
            }
        }

        log::info!(target: "vscodeee::shutdown", "Ordered shutdown complete");
    }
}

/// Safety-net implementation -- ensures all registered resources are cleaned up even
/// if [`shutdown_all()`](ShutdownCoordinator::shutdown_all) was never explicitly called
/// (e.g., during hot reload in `tauri dev`).
///
/// Uses `swap` (not `load`) on the `shutdown_done` flag to atomically claim the
/// shutdown, avoiding a race with a concurrent [`shutdown_all()`] invocation.
/// Each cleanup closure is wrapped in [`catch_unwind`](std::panic::catch_unwind)
/// so that a panic during `Drop` does not cause an abort.
impl Drop for ShutdownCoordinator {
    fn drop(&mut self) {
        // Use swap (not load) to atomically claim the shutdown — avoids
        // racing with a concurrent shutdown_all() call.
        if self.shutdown_done.swap(true, Ordering::SeqCst) {
            return;
        }
        log::warn!(
            target: "vscodeee::shutdown",
            "ShutdownCoordinator dropped without shutdown_all() — performing force shutdown"
        );
        // Drain under write lock (like shutdown_all) and recover from
        // poisoned lock rather than panicking during Drop.
        let resources: Vec<_> = {
            let mut guard = self.resources.write().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *guard)
        };
        for (_, name, cleanup) in resources {
            log::warn!(target: "vscodeee::shutdown", "Force-shutting down: {name}");
            if let Err(err) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(cleanup)) {
                log::error!(
                    target: "vscodeee::shutdown",
                    "Force cleanup panicked for '{name}': {:?}",
                    err
                );
            }
        }
    }
}
