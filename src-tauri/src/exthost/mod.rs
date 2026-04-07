/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Extension Host sidecar management — spawn Node.js, communicate via named pipe.
//!
//! # Phase 0-2 PoC Architecture (Minimal)
//!
//! Rust directly implements the VS Code wire protocol and runs the handshake
//! state machine over a Unix domain socket / named pipe. The Extension Host
//! process (`extensionHostProcess.ts`) is spawned as a plain Node.js child
//! process — no Electron dependency.
//!
//! # TODO: Production Architecture (Clean Architecture — Phase 1-2)
//!
//! In production, replace the Rust-side protocol handling with a WebSocket↔Pipe
//! byte relay. The TypeScript side (`TauriLocalProcessExtensionHost` implementing
//! `IExtensionHost`) will handle the protocol via the existing `PersistentProtocol`
//! class, connecting through a WebSocket to the Rust relay.
//!
//! Key components for production:
//! - `SidecarManager` — multi-instance lifecycle orchestrator (replaces single spawn)
//! - `WsRelay` — bidirectional byte relay (WebSocket ↔ named pipe)
//! - `TauriLocalProcessExtensionHost` — TypeScript IExtensionHost implementation
//! - `TauriExtensionService` — TypeScript extension service with factory
//!
//! See: `src/vs/workbench/services/extensions/tauri-browser/` (to be created)

pub mod init_data;
pub mod protocol;

// Handshake and sidecar use Unix domain sockets (tokio::net::UnixListener).
// Windows named pipe support requires tokio::net::windows::named_pipe (Phase 1+).
#[cfg(unix)]
pub mod handshake;
#[cfg(unix)]
pub mod sidecar;

/// Errors that can occur during Extension Host sidecar operations.
#[derive(Debug)]
pub enum ExtHostError {
    /// Failed to create the Unix domain socket / named pipe.
    PipeCreation(std::io::Error),
    /// Failed to spawn the Node.js child process.
    Spawn(std::io::Error),
    /// Timeout waiting for ExtHost to connect or complete handshake.
    Timeout,
    /// Protocol error — unexpected message type or format.
    Protocol(String),
    /// IO error during communication.
    Io(std::io::Error),
}

impl std::fmt::Display for ExtHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PipeCreation(e) => write!(f, "Pipe creation failed: {e}"),
            Self::Spawn(e) => write!(f, "Node.js spawn failed: {e}"),
            Self::Timeout => write!(f, "Handshake timeout (30s)"),
            Self::Protocol(msg) => write!(f, "Protocol error: {msg}"),
            Self::Io(e) => write!(f, "IO error: {e}"),
        }
    }
}

impl From<std::io::Error> for ExtHostError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
