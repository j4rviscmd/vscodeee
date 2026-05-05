/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Window management module — the Tauri equivalent of Electron's `WindowsMainService`.
//!
//! Provides a centralized window registry, event forwarding, session persistence,
//! and quit coordination. Each WebviewWindow gets a unique monotonic ID that never
//! collides, even across open/close cycles.
//!
//! # Submodules
//!
//! - [`manager`] — Centralized window registry with ID/label mapping and workspace deduplication.
//! - [`events`] — Bridges Tauri native window events to the WebView via scoped Tauri events.
//! - [`quit_state`] — Tracks whether a multi-window coordinated quit is in progress.
//! - [`chrome`] — Platform-specific window chrome configuration (decorations, title bar).
//! - [`restore`] — Computes the window restore plan from settings and session data.
//! - [`restore_geometry`] — Validates restored window geometry against current display configuration.
//! - [`session`] — Session persistence to `sessions.json`.
//! - [`settings`] — User window settings (restore mode, fullscreen behavior).
//! - [`state`] — Shared types for window state (`WindowInfo`, `OpenWindowOptions`, etc.).

pub mod chrome;
pub mod events;
pub mod manager;
pub mod quit_state;
pub mod restore;
pub mod restore_geometry;
pub mod session;
pub mod settings;
pub mod state;
