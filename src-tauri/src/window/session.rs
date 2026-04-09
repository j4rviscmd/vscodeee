/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Session persistence for window state and workspace mapping.
//!
//! Stores which workspaces were open in which windows so they can be
//! restored on next launch. The actual window position/size persistence
//! is handled by `tauri-plugin-window-state` (Phase 3C).
//!
//! **Phase 3A**: Stub module — session save/restore will be implemented in Phase 3C.

use serde::{Deserialize, Serialize};
use super::state::WindowSessionEntry;

/// Persistent session store for workspace → window mapping.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStore {
    pub entries: Vec<WindowSessionEntry>,
}

impl SessionStore {
    /// Create an empty session store with no entries.
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}
