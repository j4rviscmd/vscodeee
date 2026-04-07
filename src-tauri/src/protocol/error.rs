/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Error types for protocol request handling.
//!
//! Mirrors the error semantics of Electron's `ProtocolMainService`, where
//! invalid requests return specific HTTP status codes rather than panicking.

use std::fmt;

/// Errors that can occur while processing a `vscode-file://` request.
#[derive(Debug)]
pub enum ProtocolError {
    /// The URI could not be parsed or is missing required components.
    BadUri(String),
    /// The resolved path is not under any registered valid root and does
    /// not have an allowed extension.
    Forbidden(String),
    /// The requested file does not exist on disk.
    NotFound(String),
    /// An internal I/O or system error occurred.
    Internal(String),
}

impl ProtocolError {
    /// Map this error to an HTTP status code.
    pub fn status_code(&self) -> u16 {
        match self {
            Self::BadUri(_) => 400,
            Self::Forbidden(_) => 403,
            Self::NotFound(_) => 404,
            Self::Internal(_) => 500,
        }
    }

    /// A short reason phrase for the HTTP response.
    pub fn reason(&self) -> &str {
        match self {
            Self::BadUri(_) => "Bad Request",
            Self::Forbidden(_) => "Forbidden",
            Self::NotFound(_) => "Not Found",
            Self::Internal(_) => "Internal Server Error",
        }
    }
}

/// Formats the error as a human-readable message containing the variant name
/// and the associated detail string (e.g. `"Bad URI: missing authority"`).
impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadUri(msg) => write!(f, "Bad URI: {msg}"),
            Self::Forbidden(msg) => write!(f, "Forbidden: {msg}"),
            Self::NotFound(msg) => write!(f, "Not found: {msg}"),
            Self::Internal(msg) => write!(f, "Internal error: {msg}"),
        }
    }
}

/// Converts a [`std::io::Error`] into the corresponding [`ProtocolError`] variant.
///
/// The mapping follows HTTP semantics:
/// - [`NotFound`](std::io::ErrorKind::NotFound) → [`ProtocolError::NotFound`] (404)
/// - [`PermissionDenied`](std::io::ErrorKind::PermissionDenied) → [`ProtocolError::Forbidden`] (403)
/// - All other kinds → [`ProtocolError::Internal`] (500)
impl From<std::io::Error> for ProtocolError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound(e.to_string()),
            std::io::ErrorKind::PermissionDenied => Self::Forbidden(e.to_string()),
            _ => Self::Internal(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_codes_match_semantics() {
        assert_eq!(ProtocolError::BadUri("x".into()).status_code(), 400);
        assert_eq!(ProtocolError::Forbidden("x".into()).status_code(), 403);
        assert_eq!(ProtocolError::NotFound("x".into()).status_code(), 404);
        assert_eq!(ProtocolError::Internal("x".into()).status_code(), 500);
    }

    #[test]
    fn display_includes_detail() {
        let err = ProtocolError::Forbidden("path traversal".into());
        assert!(err.to_string().contains("path traversal"));
    }

    #[test]
    fn io_error_not_found_maps_correctly() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        let proto_err = ProtocolError::from(io_err);
        assert_eq!(proto_err.status_code(), 404);
    }

    #[test]
    fn io_error_permission_maps_to_forbidden() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let proto_err = ProtocolError::from(io_err);
        assert_eq!(proto_err.status_code(), 403);
    }
}
