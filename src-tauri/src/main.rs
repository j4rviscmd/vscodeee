/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Entry point for the VS Codeee desktop application.
//!
//! Handles three execution paths:
//! 1. **Early exit** — `--version`, `--help` (no Tauri overhead)
//! 2. **Headless CLI** — extension management (no GUI window)
//! 3. **GUI launch** — normal application startup with parsed args

use vscodeee_lib::cli::dispatch::{self, CliResult};

/// Application entry point.
///
/// Dispatches CLI arguments before the Tauri runtime starts:
///
/// - [`CliResult::Exit`] — prints a message and exits (e.g. `--help`, parse errors)
/// - [`CliResult::Completion`] — generates a shell completion script and exits
/// - [`CliResult::ExtensionOp`] — runs a headless extension operation and exits
/// - [`CliResult::Gui`] — launches the Tauri GUI with the parsed arguments
fn main() {
    match dispatch::dispatch() {
        CliResult::Exit { message, code } => {
            if code == 0 {
                print!("{message}");
            } else {
                eprint!("{message}");
            }
            std::process::exit(code);
        }
        CliResult::Completion(shell) => {
            vscodeee_lib::cli::completion::generate_completion(shell);
        }
        CliResult::ExtensionOp(op) => {
            let code = vscodeee_lib::cli::extension_cli::run(&op);
            std::process::exit(code);
        }
        CliResult::Gui(gui_args) => {
            vscodeee_lib::run(Some(gui_args));
        }
    }
}
