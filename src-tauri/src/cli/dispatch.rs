/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! CLI dispatch — routes parsed arguments to the appropriate handler.
//!
//! Three categories of operations:
//! 1. **Early exit** — `--version`, `--help` (handled by clap, no Tauri)
//! 2. **Headless CLI** — extension management (no GUI window)
//! 3. **GUI launch** — everything else (paths, --diff, --goto, --wait)

use super::args::Cli;
use clap::Parser;

/// Result of dispatching CLI arguments.
pub enum CliResult {
    /// Print a message to stdout/stderr and exit.
    Exit { message: String, code: i32 },

    /// Generate shell completion script and exit.
    Completion(clap_complete::Shell),

    /// Extension management CLI operation (headless).
    ExtensionOp(ExtensionOp),

    /// Launch the GUI with parsed arguments.
    Gui(ParsedGuiArgs),
}

/// Parsed GUI arguments for window routing.
#[derive(Debug, Clone, Default)]
pub struct ParsedGuiArgs {
    /// File/folder paths to open.
    pub paths: Vec<String>,
    /// Force opening in a new window.
    pub force_new_window: bool,
    /// Force reusing the last active window.
    pub force_reuse_window: bool,
    /// Open a diff editor comparing two files.
    pub diff: bool,
    /// Open file at a specific line:character.
    pub goto: bool,
    /// Wait for the editor to close before returning.
    pub wait: bool,
}

/// Extension management operation.
#[derive(Debug)]
pub enum ExtensionOp {
    /// Install extensions by VSIX path (marketplace install not yet supported).
    Install {
        /// Extension identifiers or paths to `.vsix` files.
        extensions: Vec<String>,
        /// When `true`, install the pre-release version of the extension.
        pre_release: bool,
        /// Override the default extensions directory.
        extensions_dir: Option<String>,
    },
    /// Uninstall extensions by identifier.
    Uninstall {
        /// Extension identifiers to remove.
        extensions: Vec<String>,
        /// Override the default extensions directory.
        extensions_dir: Option<String>,
    },
    /// List installed extensions.
    List {
        /// When `true`, include version numbers in the output.
        show_versions: bool,
        /// Override the default extensions directory.
        extensions_dir: Option<String>,
    },
    /// Update all installed extensions.
    Update {
        /// Override the default extensions directory.
        extensions_dir: Option<String>,
    },
    /// Add MCP (Model Context Protocol) server configurations.
    AddMcp {
        /// JSON strings or server IDs for MCP server configuration.
        configs: Vec<String>,
    },
}

/// Parse and dispatch CLI arguments.
///
/// This function runs before Tauri starts, allowing early-exit operations
/// to complete without any GUI overhead.
pub fn dispatch() -> CliResult {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            let message = e.to_string();
            let code = if e.use_stderr() { 1 } else { 0 };
            return CliResult::Exit { message, code };
        }
    };

    // Shell completion generation
    if let Some(shell) = cli.generate_completion {
        return CliResult::Completion(shell);
    }

    // Extension management — headless operations
    if !cli.install_extension.is_empty() {
        return CliResult::ExtensionOp(ExtensionOp::Install {
            extensions: cli.install_extension,
            pre_release: cli.pre_release,
            extensions_dir: cli.extensions_dir,
        });
    }
    if !cli.uninstall_extension.is_empty() {
        return CliResult::ExtensionOp(ExtensionOp::Uninstall {
            extensions: cli.uninstall_extension,
            extensions_dir: cli.extensions_dir,
        });
    }
    if cli.list_extensions {
        return CliResult::ExtensionOp(ExtensionOp::List {
            show_versions: cli.show_versions,
            extensions_dir: cli.extensions_dir,
        });
    }
    if cli.update_extensions {
        return CliResult::ExtensionOp(ExtensionOp::Update {
            extensions_dir: cli.extensions_dir,
        });
    }
    if !cli.add_mcp.is_empty() {
        return CliResult::ExtensionOp(ExtensionOp::AddMcp {
            configs: cli.add_mcp,
        });
    }

    // Normal GUI launch
    CliResult::Gui(ParsedGuiArgs {
        paths: cli.paths,
        force_new_window: cli.new_window,
        force_reuse_window: cli.reuse_window,
        diff: cli.diff,
        goto: cli.goto,
        wait: cli.wait,
    })
}

/// Convert raw args (from single-instance callback) to `ParsedGuiArgs`.
///
/// Used by the single-instance callback in `lib.rs` to parse arguments
/// forwarded from a second process.
pub fn parse_gui_args(raw_args: &[String]) -> ParsedGuiArgs {
    let cli = match Cli::try_parse_from(raw_args) {
        Ok(cli) => cli,
        Err(e) => {
            log::warn!(
                target: "vscodeee::cli::dispatch",
                "Failed to parse single-instance args, falling back to legacy parser: {e}"
            );
            let legacy = super::parser::parse_args(raw_args);
            return ParsedGuiArgs {
                paths: legacy.paths,
                force_new_window: legacy.force_new_window,
                force_reuse_window: legacy.force_reuse_window,
                ..Default::default()
            };
        }
    };

    ParsedGuiArgs {
        paths: cli.paths,
        force_new_window: cli.new_window,
        force_reuse_window: cli.reuse_window,
        diff: cli.diff,
        goto: cli.goto,
        wait: cli.wait,
    }
}
