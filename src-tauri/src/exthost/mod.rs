/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Extension Host sidecar management — spawn Bun runtime.
//!
//! This module provides the infrastructure for spawning the VS Code Extension
//! Host running under the Bun JavaScript runtime. The Extension Host is a
//! separate child process that executes extension code in isolation from the
//! main application.
//!
//! # Architecture
//!
//! The Extension Host communicates directly with the WebView via WebSocket:
//!
//! 1. **Sidecar spawning** ([`sidecar`]) — Spawns the Bun runtime with the
//!    correct entry point and environment variables.
//!
//! 2. **Direct WebSocket** — The Bun process starts a WebSocket server
//!    (`Bun.serve({ port: 0 })`) and reports the port via stdout. The WebView
//!    connects directly — no Rust relay is needed.
//!
//! All VS Code wire protocol handling happens in TypeScript via
//! `PersistentProtocol`.

pub mod sidecar;

/// Errors that can occur during Extension Host sidecar operations.
#[derive(Debug)]
pub enum ExtHostError {
    /// Failed to spawn the Bun child process.
    Spawn(std::io::Error),
    /// The child process exited before reporting the WebSocket port.
    /// Contains the exit status and any captured stderr output.
    ChildExited { status: String, stderr: String },
    /// IO error during communication.
    Io(std::io::Error),
}

impl std::fmt::Display for ExtHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "Bun spawn failed: {e}"),
            Self::ChildExited { status, stderr } => {
                write!(f, "ExtHost process exited prematurely: {status}")?;
                if !stderr.is_empty() {
                    let trimmed = if stderr.len() > 2048 {
                        let mut end = 2048;
                        while end > 0 && !stderr.is_char_boundary(end) {
                            end -= 1;
                        }
                        &stderr[..end]
                    } else {
                        stderr
                    };
                    write!(f, "\n--- stderr ---\n{trimmed}")?;
                }
                Ok(())
            }
            Self::Io(e) => write!(f, "IO error: {e}"),
        }
    }
}

impl From<std::io::Error> for ExtHostError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
