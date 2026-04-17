/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Shutdown coordination — ordered cleanup of all child processes and background threads.
//!
//! # Shutdown phases (in order)
//!
//! 1. **Extensions** — Kill Extension Host sidecars (Node.js processes)
//! 2. **PTY** — Close pseudo-terminal instances (shell processes)
//! 3. **FileWatchers** — Stop file system watcher threads
//! 4. **SystemEvents** — Stop OS event monitor threads
//!
//! # Termination paths covered
//!
//! - **Window close** (Cmd+W / click ×): `lifecycle_close_confirmed` → `shutdown_all()` → `window.destroy()`
//! - **Cmd+Q / quit_app**: `RunEvent::ExitRequested` → `shutdown_all()` → allow exit
//! - **Hot reload** (`tauri:dev`): `RunEvent::Exit` → `shutdown_all()` → process exits
//! - **Safety net**: `ShutdownCoordinator::Drop` → force cleanup on all resources

mod coordinator;

pub use coordinator::{ShutdownCoordinator, ShutdownPhase};
