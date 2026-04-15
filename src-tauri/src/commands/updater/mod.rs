/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Updater commands — check, download, install, and restart.
//!
//! Thin wrappers over [`tauri_plugin_updater`] that expose the update lifecycle
//! to the WebView via typed IPC commands. TypeScript owns the state machine
//! (the 11-state discriminated union in `platform/update/common/update.ts`);
//! Rust provides the capability layer.

pub mod commands;
pub mod error;

pub use commands::*;
