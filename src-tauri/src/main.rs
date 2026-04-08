/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Entry point for the VS Codeee desktop application.
//!
//! In release builds, `windows_subsystem = "windows"` suppresses
//! the console window on Windows.

/// Application main entry point.
///
/// Delegates to [`vscodeee_lib::run()`] to launch the Tauri application.
fn main() {
    vscodeee_lib::run()
}
