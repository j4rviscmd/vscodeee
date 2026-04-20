/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! CLI argument definitions using clap derive macros.

use clap::Parser;
use clap_complete::Shell;

/// VS Codeee — a VS Code fork powered by Tauri 2.0.
#[derive(Parser, Debug)]
#[command(
    name = "codeee",
    version,
    about = "VS Codeee — a VS Code fork powered by Tauri 2.0",
    long_about = "codeee is the command-line interface for VS Codeee.\n\
	              It can open files and folders, manage extensions, and more.\n\n\
	              Usage:\n  \
	              codeee <file-or-folder>   Open a file or folder\n  \
	              codeee --diff <a> <b>     Compare two files\n  \
	              codeee -n                 Open a new empty window"
)]
pub struct Cli {
    /// Files or folders to open. Use '-' to read from stdin.
    #[arg(value_hint = clap::ValueHint::AnyPath)]
    pub paths: Vec<String>,

    // ── Window flags ──
    /// Open a new window even if a folder is already open.
    #[arg(short = 'n', long)]
    pub new_window: bool,

    /// Force opening in the last active window.
    #[arg(short = 'r', long)]
    pub reuse_window: bool,

    // ── Editor modes ──
    /// Open a diff editor comparing two files.
    #[arg(short = 'd', long)]
    pub diff: bool,

    /// Open a file at a specific line and character (file:line[:character]).
    #[arg(short = 'g', long)]
    pub goto: bool,

    /// Wait for the file to be closed before returning to the shell.
    #[arg(short = 'w', long)]
    pub wait: bool,

    // ── Extension management ──
    /// Install an extension by identifier or VSIX path.
    #[arg(long = "install-extension", value_name = "EXT_ID_OR_VSIX")]
    pub install_extension: Vec<String>,

    /// Uninstall an extension by identifier.
    #[arg(long = "uninstall-extension", value_name = "EXT_ID")]
    pub uninstall_extension: Vec<String>,

    /// List installed extensions.
    #[arg(long = "list-extensions")]
    pub list_extensions: bool,

    /// Update installed extensions.
    #[arg(long = "update-extensions")]
    pub update_extensions: bool,

    /// Add an MCP server configuration (JSON string or server ID).
    #[arg(long = "add-mcp", value_name = "JSON_OR_ID")]
    pub add_mcp: Vec<String>,

    /// Set the root path for extensions.
    #[arg(
		long = "extensions-dir",
		value_name = "DIR",
		value_hint = clap::ValueHint::DirPath
	)]
    pub extensions_dir: Option<String>,

    /// Show versions when listing extensions (use with --list-extensions).
    #[arg(long = "show-versions")]
    pub show_versions: bool,

    /// Install a pre-release version of the extension.
    #[arg(long = "pre-release")]
    pub pre_release: bool,

    /// Generate shell completion script.
    #[arg(long = "generate-completion", value_name = "SHELL", hide = true)]
    pub generate_completion: Option<Shell>,
}
