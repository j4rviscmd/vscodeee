/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Shell completion generation for the `eee` CLI.

use super::args::Cli;
use clap::CommandFactory;
use clap_complete::{generate, Shell};
use std::io;

/// Generate shell completion script for the given shell.
pub fn generate_completion(shell: Shell) {
    let mut cmd = Cli::command();
    let name = cmd.get_name().to_string();
    generate(shell, &mut cmd, name, &mut io::stdout());
}
