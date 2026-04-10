/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Built-in extension scanning for the Tauri workbench.
//!
//! In VS Code's web mode, built-in extensions are injected into the HTML
//! by the Node.js dev server. In Tauri, there is no server to do this,
//! so we scan the `extensions/` directory from Rust and return the metadata
//! to the TypeScript side.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// A single built-in extension entry, matching the `IBundledExtension`
/// interface in `builtinExtensionsScannerService.ts`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledExtension {
    /// Relative path within the extensions directory (e.g., "theme-defaults").
    pub extension_path: String,
    /// Parsed `package.json` content as a raw JSON value.
    #[serde(rename = "packageJSON")]
    pub package_json: serde_json::Value,
    /// Parsed `package.nls.json` content, if it exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "packageNLS")]
    pub package_nls: Option<serde_json::Value>,
    /// Relative path to README.md if it exists (e.g., "theme-defaults/README.md").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readme_path: Option<String>,
    /// Relative path to CHANGELOG.md if it exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changelog_path: Option<String>,
}

/// Result of scanning the built-in extensions directory.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinExtensionsResult {
    /// Absolute path to the extensions directory.
    pub extensions_dir: String,
    /// List of discovered built-in extensions.
    pub extensions: Vec<BundledExtension>,
}

/// Resolve the absolute path to the `extensions/` directory.
///
/// In dev mode, `src-tauri/` is the CWD, so `../extensions` points to the repo root.
fn resolve_extensions_dir() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let extensions_dir = cwd.join("../extensions");
    extensions_dir.canonicalize().ok()
}

/// Try to read and parse a JSON file, returning `None` on any error.
fn read_json(path: &Path) -> Option<serde_json::Value> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Check if an extension should be included.
///
/// Some extensions are web-only or require specific engines. We filter
/// to those that can run in the Tauri environment.
fn should_include_extension(package_json: &serde_json::Value) -> bool {
    // Must have a valid name and publisher
    if package_json.get("name").and_then(|v| v.as_str()).is_none() {
        return false;
    }

    // Check browser-specific: if `browser` field exists, it's a web extension
    // and can be loaded. If only `main` exists, it needs Node.js (which we
    // don't have in the scanner context, but the extension host handles that).
    // For now, include all extensions and let the extension host filter.
    true
}

/// Scan the `extensions/` directory and return metadata for all built-in extensions.
///
/// This is the Tauri equivalent of the web server's extension scanning
/// in `webClientServer.ts`. The TypeScript side uses this to populate
/// the `IBuiltinExtensionsScannerService`.
#[tauri::command]
pub fn list_builtin_extensions() -> Result<BuiltinExtensionsResult, String> {
    let extensions_dir = resolve_extensions_dir()
        .ok_or_else(|| "Could not resolve extensions directory".to_string())?;

    let entries = std::fs::read_dir(&extensions_dir)
        .map_err(|e| format!("Failed to read extensions directory: {e}"))?;

    let mut extensions = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();

        // Only process directories
        if !path.is_dir() {
            continue;
        }

        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        // Skip hidden directories and known non-extension entries
        if dir_name.starts_with('.') || dir_name.starts_with("node_modules") {
            continue;
        }

        // Must have a package.json
        let package_json_path = path.join("package.json");
        let package_json = match read_json(&package_json_path) {
            Some(json) => json,
            None => continue,
        };

        if !should_include_extension(&package_json) {
            continue;
        }

        // Optional: package.nls.json for localization
        let package_nls = read_json(&path.join("package.nls.json"));

        // Optional: README and CHANGELOG paths
        let readme_path = if path.join("README.md").exists() {
            Some(format!("{}/README.md", dir_name))
        } else {
            None
        };

        let changelog_path = if path.join("CHANGELOG.md").exists() {
            Some(format!("{}/CHANGELOG.md", dir_name))
        } else {
            None
        };

        extensions.push(BundledExtension {
            extension_path: dir_name,
            package_json,
            package_nls,
            readme_path,
            changelog_path,
        });
    }

    // Sort for deterministic order
    extensions.sort_by(|a, b| a.extension_path.cmp(&b.extension_path));

    log::info!(
        target: "vscodeee::extensions",
        "Scanned {} built-in extensions from {}",
        extensions.len(),
        extensions_dir.display()
    );

    Ok(BuiltinExtensionsResult {
        extensions_dir: extensions_dir.to_string_lossy().to_string(),
        extensions,
    })
}
