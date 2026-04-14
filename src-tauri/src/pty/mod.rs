/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! PTY (pseudo-terminal) management for the Tauri backend.
//!
//! # Architecture
//!
//! Uses `portable-pty` to spawn shell processes directly from Rust,
//! bypassing the need for a Node.js sidecar (`node-pty`). This achieves
//! lower memory usage and eliminates an extra process.
//!
//! ## Modules
//!
//! - `instance` — Individual PTY process wrapping portable-pty
//! - `manager` — Multi-instance registry and lifecycle
//! - `profiles` — Shell detection and profile management
//! - `state` — File-based terminal state persistence
//! - `autoreply` — Output pattern matching and auto-reply injection
//!
//! ## Data Flow
//!
//! ```text
//! xterm.js (WebView)
//!   ──invoke('write_terminal')──► PtyManager.write() ──► MasterPty.write()
//!   ◄──event('pty-output-{id}')── reader thread ◄────── MasterPty.read()
//! ```

pub mod autoreply;
pub mod instance;
pub mod manager;
pub mod profiles;
pub mod state;
