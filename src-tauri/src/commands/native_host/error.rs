/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Typed error enum for native host commands.

use serde::Serialize;

/// Unified error type for native host commands.
///
/// Uses `thiserror` for ergonomic error handling with automatic
/// `Display` and `From` implementations. All variants serialize
/// to a plain string for the Tauri IPC boundary.
#[derive(Debug, thiserror::Error)]
pub enum NativeHostError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Window error: {0}")]
    Window(String),

    #[error("Clipboard error: {0}")]
    Clipboard(String),

    #[error("Platform not supported: {0}")]
    Unsupported(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for NativeHostError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<String> for NativeHostError {
    fn from(s: String) -> Self {
        NativeHostError::Other(s)
    }
}

impl From<&str> for NativeHostError {
    fn from(s: &str) -> Self {
        NativeHostError::Other(s.to_string())
    }
}
