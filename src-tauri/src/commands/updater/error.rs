/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Typed error enum for updater commands.

use serde::Serialize;

/// Unified error type for updater commands.
///
/// All variants serialize to a plain string for the Tauri IPC boundary,
/// matching the pattern established by [`NativeHostError`].
///
/// [`NativeHostError`]: crate::commands::native_host::error::NativeHostError
#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("Updater not available: {0}")]
    NotAvailable(String),

    #[error("No pending update to download")]
    NoPendingUpdate,

    #[error("Update check failed: {0}")]
    CheckFailed(String),

    #[error("Download failed: {0}")]
    DownloadFailed(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for UpdateError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<tauri_plugin_updater::Error> for UpdateError {
    fn from(e: tauri_plugin_updater::Error) -> Self {
        UpdateError::CheckFailed(e.to_string())
    }
}
