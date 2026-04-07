/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! PTY (pseudo-terminal) management for the Tauri backend.
//!
//! # Phase 0-4 PoC Architecture
//!
//! Uses `portable-pty` to spawn shell processes directly from Rust,
//! bypassing the need for a Node.js sidecar (`node-pty`). This achieves
//! lower memory usage and eliminates an extra process.
//!
//! ## Data Flow
//!
//! ```text
//! xterm.js (WebView)
//!   ──invoke('write_terminal')──► PtyManager.write() ──► MasterPty.write()
//!   ◄──event('pty-output-{id}')── reader thread ◄────── MasterPty.read()
//! ```
//!
//! # TODO: Production (Phase 1+)
//!
//! - Shell integration injection (matching VS Code's `terminalEnvironment.ts`)
//! - Proper environment variable handling
//! - Process title tracking
//! - Reconnection / persistence support

pub mod instance;
pub mod manager;
