/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Headless extension management CLI operations.
//!
//! Handles `--list-extensions`, `--install-extension`, `--uninstall-extension`,
//! and `--add-mcp` without starting the Tauri GUI.

use super::dispatch::ExtensionOp;
use crate::commands::extension_management;
use std::path::PathBuf;

/// Resolve the extensions directory from an optional override or the default.
fn resolve_extensions_dir(override_dir: Option<&str>) -> PathBuf {
    if let Some(dir) = override_dir {
        return PathBuf::from(dir);
    }
    // Default: ~/.vscodeee/extensions (matching the TypeScript side)
    dirs::home_dir()
        .map(|h| h.join(".vscodeee").join("extensions"))
        .unwrap_or_else(|| PathBuf::from(".vscodeee/extensions"))
}

/// Run an extension management operation and return the exit code.
pub fn run(op: &ExtensionOp) -> i32 {
    match op {
        ExtensionOp::List {
            show_versions,
            extensions_dir,
        } => list_extensions(*show_versions, extensions_dir.as_deref()),
        ExtensionOp::Install {
            extensions,
            pre_release,
            extensions_dir,
        } => {
            if *pre_release {
                eprintln!("codeee: --pre-release is not yet supported for CLI installs");
            }
            install_extensions(extensions, extensions_dir.as_deref())
        }
        ExtensionOp::Uninstall {
            extensions,
            extensions_dir,
        } => uninstall_extensions(extensions, extensions_dir.as_deref()),
        ExtensionOp::Update { .. } => {
            eprintln!("codeee: --update-extensions is not yet supported in CLI mode");
            1
        }
        ExtensionOp::AddMcp { configs } => add_mcp(configs),
    }
}

/// List installed extensions and print them to stdout.
///
/// When `show_versions` is `true`, each line is formatted as `<id>@<version>`.
/// Otherwise only the extension identifier is printed.
///
/// Returns `0` on success, `1` on error.
fn list_extensions(show_versions: bool, extensions_dir: Option<&str>) -> i32 {
    let dir = resolve_extensions_dir(extensions_dir);
    match extension_management::ext_scan_installed(dir.to_string_lossy().to_string()) {
        Ok(extensions) => {
            for ext in &extensions {
                if show_versions {
                    println!("{}@{}", ext.id, ext.version);
                } else {
                    println!("{}", ext.id);
                }
            }
            0
        }
        Err(e) => {
            eprintln!("codeee: {e}");
            1
        }
    }
}

/// Install one or more extensions from local VSIX files.
///
/// Each entry in `extensions` is checked: if it points to an existing `.vsix` file,
/// it is extracted into the extensions directory. Marketplace identifier installation
/// is not yet supported from the CLI.
///
/// Returns `0` if all installations succeeded, `1` if any failed.
fn install_extensions(extensions: &[String], extensions_dir: Option<&str>) -> i32 {
    let dir = resolve_extensions_dir(extensions_dir);
    let mut failed = false;

    for ext_id_or_path in extensions {
        let path = std::path::Path::new(ext_id_or_path);
        if path.exists() && path.extension().is_some_and(|e| e == "vsix") {
            // Local VSIX file installation
            match extension_management::ext_extract_vsix(
                ext_id_or_path.clone(),
                dir.to_string_lossy().to_string(),
            ) {
                Ok(result) => {
                    println!("{} installed to {}", ext_id_or_path, result.extension_path);
                }
                Err(e) => {
                    eprintln!("codeee: failed to install {}: {e}", ext_id_or_path);
                    failed = true;
                }
            }
        } else {
            // Marketplace installation not yet supported from CLI
            eprintln!(
                "codeee: --install-extension from marketplace is not yet supported \
				 (install from VSIX with: eee --install-extension path/to/ext.vsix)"
            );
            failed = true;
        }
    }

    if failed {
        1
    } else {
        0
    }
}

/// Uninstall one or more extensions by identifier.
///
/// Scans the installed extensions in `extensions_dir` to locate each extension
/// by its identifier, then deletes its directory.
///
/// Returns `0` if all uninstallations succeeded, `1` if any failed.
fn uninstall_extensions(extensions: &[String], extensions_dir: Option<&str>) -> i32 {
    let dir = resolve_extensions_dir(extensions_dir);
    let base_dir = dir.to_string_lossy().to_string();

    // Scan to find extension directories by ID
    let installed =
        match extension_management::ext_scan_installed(dir.to_string_lossy().to_string()) {
            Ok(exts) => exts,
            Err(e) => {
                eprintln!("codeee: {e}");
                return 1;
            }
        };

    let mut failed = false;
    for ext_id in extensions {
        let found = installed.iter().find(|e| e.id == *ext_id);
        match found {
            Some(ext) => match extension_management::ext_delete_extension(
                ext.location.clone(),
                base_dir.clone(),
            ) {
                Ok(()) => println!("{} uninstalled", ext_id),
                Err(e) => {
                    eprintln!("codeee: failed to uninstall {}: {e}", ext_id);
                    failed = true;
                }
            },
            None => {
                eprintln!("codeee: extension not found: {ext_id}");
                failed = true;
            }
        }
    }

    if failed {
        1
    } else {
        0
    }
}

/// Validate and register MCP server configurations.
///
/// Each entry in `configs` must be a valid JSON string. Currently only
/// validation is performed; full MCP registration is not yet implemented.
///
/// Returns `0` on success, `1` if any config is invalid JSON.
fn add_mcp(configs: &[String]) -> i32 {
    for config in configs {
        // Validate that the input is valid JSON
        match serde_json::from_str::<serde_json::Value>(config) {
            Ok(_) => {}
            Err(e) => {
                eprintln!("codeee: invalid JSON for --add-mcp: {e}");
                return 1;
            }
        }
    }
    eprintln!("codeee: --add-mcp is not yet fully implemented");
    1
}
