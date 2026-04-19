/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window management module — the Tauri equivalent of Electron's `WindowsMainService`.
//!
//! Provides a centralized window registry, event forwarding, and session persistence.
//! Each WebviewWindow gets a unique monotonic ID that never collides, even across
//! open/close cycles.

pub mod chrome;
pub mod events;
pub mod manager;
pub mod restore;
pub mod restore_geometry;
pub mod session;
pub mod settings;
pub mod state;
