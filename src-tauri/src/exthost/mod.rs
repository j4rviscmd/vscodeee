/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Extension Host sidecar management — spawn Bun runtime, communicate via named pipe.

pub mod init_data;
pub mod protocol;

// Handshake and sidecar use Unix domain sockets (tokio::net::UnixListener).
// Windows named pipe support requires tokio::net::windows::named_pipe.
#[cfg(unix)]
pub mod handshake;
#[cfg(unix)]
pub mod sidecar;
#[cfg(unix)]
pub mod ws_relay;

/// Errors that can occur during Extension Host sidecar operations.
#[derive(Debug)]
pub enum ExtHostError {
    /// Failed to create the Unix domain socket / named pipe.
    PipeCreation(std::io::Error),
    /// Failed to spawn the Bun child process.
    Spawn(std::io::Error),
    /// Timeout waiting for ExtHost to connect or complete handshake.
    Timeout,
    /// The child process exited before connecting to the pipe.
    /// Contains the exit status and any captured stderr output.
    ChildExited { status: String, stderr: String },
    /// Protocol error — unexpected message type or format.
    Protocol(String),
    /// IO error during communication.
    Io(std::io::Error),
}

/// Human-readable error formatting for [`ExtHostError`].
///
/// For [`ChildExited`] variants, includes up to 2KB of captured stderr output
/// (truncated at a valid UTF-8 character boundary) to aid debugging.
impl std::fmt::Display for ExtHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PipeCreation(e) => write!(f, "Pipe creation failed: {e}"),
            Self::Spawn(e) => write!(f, "Bun spawn failed: {e}"),
            Self::Timeout => write!(f, "Handshake timeout (30s)"),
            Self::ChildExited { status, stderr } => {
                write!(f, "ExtHost process exited prematurely: {status}")?;
                if !stderr.is_empty() {
                    // Include up to 2KB of stderr for diagnostics,
                    // truncating at a valid UTF-8 char boundary.
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
            Self::Protocol(msg) => write!(f, "Protocol error: {msg}"),
            Self::Io(e) => write!(f, "IO error: {e}"),
        }
    }
}

/// Allows implicit conversion from [`std::io::Error`] to [`ExtHostError::Io`],
/// enabling `?` usage in functions that return `Result<_, ExtHostError>`.
impl From<std::io::Error> for ExtHostError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
