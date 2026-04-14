/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Extension management commands for the Tauri workbench.
//!
//! Provides VSIX extraction, manifest reading, directory scanning,
//! and deletion — the file-I/O layer for `TauriExtensionManagementService`.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/// Domain errors for extension management operations.
#[derive(Debug, thiserror::Error)]
pub enum ExtensionError {
    #[error("Download failed: {0}")]
    DownloadFailed(String),
    #[error("Extraction failed: {0}")]
    ExtractionFailed(String),
    #[error("Invalid VSIX: {0}")]
    InvalidVsix(String),
    #[error("Extension not found: {0}")]
    NotFound(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Security: {0}")]
    Security(String),
}

/// Allows converting an [`ExtensionError`] into a plain `String`.
///
/// This blanket conversion is required because Tauri commands return
/// `Result<_, String>` — the error variant must be a `String`, so any
/// [`ExtensionError`] produced in the command layer is automatically
/// coerced via this impl.
impl From<ExtensionError> for String {
    fn from(err: ExtensionError) -> String {
        err.to_string()
    }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// Result of extracting a VSIX file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResult {
    /// Absolute path to the extracted extension directory.
    pub extension_path: String,
    /// Parsed `package.json` manifest as a raw JSON value.
    pub manifest: serde_json::Value,
}

/// A scanned extension on disk.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedExtension {
    /// Unique extension identifier (e.g., `publisher.name`).
    pub id: String,
    /// Extension version from `package.json`.
    pub version: String,
    /// Absolute filesystem path to the extension directory.
    pub location: String,
    /// Parsed `package.json` manifest.
    pub manifest: serde_json::Value,
    /// Unix timestamp of when the extension was installed (directory mtime).
    pub installed_timestamp: Option<u64>,
    /// Target platform string (e.g., `darwin-arm64`).
    pub target_platform: String,
}

/// Information about the current platform target.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// Target platform string (e.g., `darwin-arm64`, `linux-x64`, `win32-x64`).
    pub target_platform: String,
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Determine the current platform target string matching VS Code's `TargetPlatform` enum.
fn get_target_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "x86",
        "arm" => "armhf",
        other => other,
    };
    format!("{}-{}", os, arch)
}

/// Validate that a path is within the expected base directory (path traversal protection).
///
/// Both `base` and `target` are resolved to their canonical (absolute, symlink-free)
/// forms before comparison. This prevents directory-traversal attacks where a caller
/// could pass `../../etc` to escape the intended directory.
///
/// # Errors
///
/// * [`ExtensionError::Security`] — if either path cannot be canonicalized,
///   or if the resolved `target` is not a descendant of the resolved `base`.
fn validate_path_within(base: &Path, target: &Path) -> Result<(), ExtensionError> {
    let canonical_base = base
        .canonicalize()
        .map_err(|e| ExtensionError::Security(format!("Cannot canonicalize base path: {e}")))?;
    let canonical_target = target
        .canonicalize()
        .map_err(|e| ExtensionError::Security(format!("Cannot canonicalize target path: {e}")))?;
    if !canonical_target.starts_with(&canonical_base) {
        return Err(ExtensionError::Security(format!(
            "Path {:?} is outside of base directory {:?}",
            canonical_target, canonical_base
        )));
    }
    Ok(())
}

/// Extract the extension identifier from a manifest's `publisher` and `name` fields.
///
/// Returns `Some("publisher.name")` when both fields exist and are strings,
/// or `None` if either field is missing or not a string value.
fn extension_id_from_manifest(manifest: &serde_json::Value) -> Option<String> {
    let publisher = manifest.get("publisher")?.as_str()?;
    let name = manifest.get("name")?.as_str()?;
    Some(format!("{}.{}", publisher, name))
}

/// Read `extension/package.json` from a VSIX ZIP without full extraction.
///
/// Opens the archive just enough to locate and parse the manifest entry.
/// The VSIX is closed immediately after reading, keeping resource usage low.
///
/// # Errors
///
/// Returns a `String` describing the failure if:
/// * the VSIX file cannot be opened,
/// * the file is not a valid ZIP archive,
/// * the `extension/package.json` entry is missing,
/// * the entry cannot be read, or
/// * the manifest is not valid JSON.
fn read_manifest_from_vsix(vsix_path: &Path) -> Result<serde_json::Value, String> {
    let file = fs::File::open(vsix_path)
        .map_err(|e| format!("Failed to open VSIX for manifest read: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid VSIX archive: {e}"))?;

    let mut entry = archive
        .by_name("extension/package.json")
        .map_err(|e| format!("Manifest not found in VSIX: {e}"))?;

    let mut manifest_str = String::new();
    entry
        .read_to_string(&mut manifest_str)
        .map_err(|e| format!("Failed to read manifest: {e}"))?;

    serde_json::from_str(&manifest_str).map_err(|e| format!("Invalid manifest JSON: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Extract a VSIX (ZIP) file to a versioned subdirectory under `target_dir`.
///
/// Reads the manifest first to compute the install directory as
/// `{target_dir}/{publisher}.{name}-{version}/`, then extracts only files
/// under the `extension/` prefix into that directory.
///
/// If the versioned directory already exists, it is cleaned before extraction.
/// The base `target_dir` is never deleted.
///
/// On Unix platforms, file permissions stored in the ZIP entry (e.g. the
/// executable bit on native binaries) are restored automatically, masked to
/// `0o777` to strip setuid/setgid/sticky bits from untrusted archives.
///
/// # Arguments
///
/// * `vsix_path` - Absolute path to the `.vsix` file to extract.
/// * `target_dir` - Base directory under which extensions are installed.
///
/// # Returns
///
/// An [`ExtractResult`] containing the absolute path to the extracted
/// extension directory and the parsed `package.json` manifest.
///
/// # Errors
///
/// Returns a `String` describing the failure if:
/// * the VSIX file does not exist or cannot be opened,
/// * the archive is not a valid ZIP,
/// * the manifest is missing required fields (`publisher`, `name`),
/// * a zip-slip (path traversal) entry is detected,
/// * filesystem operations (create, write, permissions) fail.
///
/// # Examples
///
/// ```ignore
/// let result = ext_extract_vsix("/tmp/theme.vsix", "/home/user/.vscodeee/extensions")?;
/// println!("Installed to: {}", result.extension_path);
/// ```
#[tauri::command]
pub fn ext_extract_vsix(vsix_path: String, target_dir: String) -> Result<ExtractResult, String> {
    let vsix = Path::new(&vsix_path);
    let base_dir = Path::new(&target_dir);

    if !vsix.exists() {
        return Err(format!("VSIX file not found: {}", vsix_path));
    }

    // 1. Read manifest from VSIX to determine the install subdirectory
    let manifest = read_manifest_from_vsix(vsix)?;
    let publisher = manifest
        .get("publisher")
        .and_then(|v| v.as_str())
        .ok_or("Manifest missing 'publisher' field")?;
    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Manifest missing 'name' field")?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");

    // Compute the extension directory: {target_dir}/{publisher}.{name}-{version}/
    let ext_dir_name = format!("{}.{}-{}", publisher, name, version);
    let ext_dir = base_dir.join(&ext_dir_name);

    // 2. Ensure the base extensions directory exists
    fs::create_dir_all(base_dir)
        .map_err(|e| format!("Failed to create extensions directory: {e}"))?;

    // 3. Clean existing extension directory (only the versioned subdirectory!)
    if ext_dir.exists() {
        fs::remove_dir_all(&ext_dir)
            .map_err(|e| format!("Failed to clean existing extension directory: {e}"))?;
    }
    fs::create_dir_all(&ext_dir)
        .map_err(|e| format!("Failed to create extension directory: {e}"))?;

    // 4. Open VSIX and extract files under extension/ prefix
    let file = fs::File::open(vsix).map_err(|e| format!("Failed to open VSIX: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid VSIX archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry {i}: {e}"))?;

        let entry_name = entry.name().to_string();

        // Only extract files under the `extension/` prefix
        if let Some(relative) = entry_name.strip_prefix("extension/") {
            if relative.is_empty() {
                continue;
            }

            let out_path = ext_dir.join(relative);

            // Security: prevent zip-slip (path traversal)
            let canonical_ext_dir = ext_dir
                .canonicalize()
                .unwrap_or_else(|_| ext_dir.to_path_buf());

            let parent = match out_path.parent() {
                Some(p) => p,
                None => continue,
            };
            let _ = fs::create_dir_all(parent);
            if let Some(resolved_parent) = parent.canonicalize().ok() {
                if !resolved_parent.starts_with(&canonical_ext_dir) {
                    return Err(format!(
                        "Zip-slip detected: entry {:?} escapes target directory",
                        entry_name
                    ));
                }
            }

            if entry.is_dir() {
                fs::create_dir_all(&out_path)
                    .map_err(|e| format!("Failed to create directory {:?}: {e}", out_path))?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent dir: {e}"))?;
                }
                let mut out_file = fs::File::create(&out_path)
                    .map_err(|e| format!("Failed to create file: {e}"))?;
                std::io::copy(&mut entry, &mut out_file)
                    .map_err(|e| format!("Failed to write file: {e}"))?;

                // Restore Unix permissions from the ZIP entry (e.g. +x on native binaries).
                // Mask to 0o777 to strip setuid/setgid/sticky bits from untrusted archives.
                #[cfg(unix)]
                if let Some(mode) = entry.unix_mode() {
                    let safe_mode = mode & 0o777;
                    if let Err(e) =
                        fs::set_permissions(&out_path, fs::Permissions::from_mode(safe_mode))
                    {
                        log::warn!(
                            target: "vscodeee::ext_management",
                            "Failed to restore permissions ({:#o}) on {:?}: {e}",
                            safe_mode, out_path
                        );
                    }
                }
            }
        }
    }

    Ok(ExtractResult {
        extension_path: ext_dir.to_string_lossy().to_string(),
        manifest,
    })
}

/// Read the manifest (`package.json`) from a VSIX file without full extraction.
///
/// Opens the ZIP archive, reads only `extension/package.json`, and returns
/// the parsed JSON. Useful for pre-install validation (e.g. checking the
/// extension identifier or engine compatibility before extracting).
///
/// # Arguments
///
/// * `vsix_path` - Absolute path to the `.vsix` file to inspect.
///
/// # Returns
///
/// The parsed `package.json` as a [`serde_json::Value`].
///
/// # Errors
///
/// Returns a `String` if the file does not exist, is not a valid ZIP,
/// the manifest entry is missing, or the JSON cannot be parsed.
#[tauri::command]
pub fn ext_read_vsix_manifest(vsix_path: String) -> Result<serde_json::Value, String> {
    let vsix = Path::new(&vsix_path);

    if !vsix.exists() {
        return Err(format!("VSIX file not found: {}", vsix_path));
    }

    read_manifest_from_vsix(vsix)
}

/// Recursively delete an extension directory.
///
/// Validates that the path is under the user extensions directory before deletion.
/// Deletions from the system temp directory are also allowed (for cleanup of
/// staged extractions). On failure, the directory may be left partially deleted.
///
/// This command is idempotent: if the path does not exist, it returns `Ok(())`.
///
/// # Arguments
///
/// * `extension_path` - Absolute path to the extension directory to delete.
/// * `extensions_base` - The user's extensions root directory used for
///   path-traversal validation.
///
/// # Errors
///
/// Returns a `String` if the path exists but is outside both the extensions
/// base directory and the system temp directory (security error), or if the
/// filesystem deletion fails.
#[tauri::command]
pub fn ext_delete_extension(extension_path: String, extensions_base: String) -> Result<(), String> {
    let ext_path = Path::new(&extension_path);
    let base_path = Path::new(&extensions_base);

    if !ext_path.exists() {
        // Already gone — idempotent success
        return Ok(());
    }

    // Security: validate the path is within the extensions base directory,
    // or fall back to allowing deletion from the system temp directory.
    let is_within_base = validate_path_within(base_path, ext_path).is_ok();
    let is_temp = (ext_path.is_absolute() && ext_path.starts_with("/tmp/"))
        || ext_path.starts_with(&std::env::temp_dir());

    if !is_within_base && !is_temp {
        return Err(format!(
            "Security: path {:?} is not within extensions base {:?}",
            ext_path, base_path
        ));
    }

    fs::remove_dir_all(ext_path)
        .map_err(|e| format!("Failed to delete extension directory: {e}"))?;
    Ok(())
}

/// Scan the user-installed extensions directory.
///
/// Reads each subdirectory, looking for a `package.json` manifest.
/// Returns metadata for each discovered extension. Subdirectories without
/// a valid manifest (missing file, unparseable JSON, or missing `publisher`/
/// `name` fields) are silently skipped.
///
/// Results are sorted alphabetically by extension identifier for
/// deterministic ordering.
///
/// # Arguments
///
/// * `extensions_dir` - Absolute path to the user extensions directory.
///
/// # Returns
///
/// A `Vec<ScannedExtension>` sorted by [`ScannedExtension::id`].
/// Returns an empty vector if the directory does not exist.
///
/// # Errors
///
/// Returns a `String` if the extensions directory exists but cannot be read.
#[tauri::command]
pub fn ext_scan_installed(extensions_dir: String) -> Result<Vec<ScannedExtension>, String> {
    let dir = Path::new(&extensions_dir);

    if !dir.exists() {
        // No extensions directory yet — return empty
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read extensions directory: {e}"))?;

    let mut extensions = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("package.json");
        if !manifest_path.exists() {
            continue;
        }

        let manifest_str = match fs::read_to_string(&manifest_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let manifest: serde_json::Value = match serde_json::from_str(&manifest_str) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let id = match extension_id_from_manifest(&manifest) {
            Some(id) => id,
            None => continue,
        };

        let version = manifest
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0")
            .to_string();

        let installed_timestamp = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        extensions.push(ScannedExtension {
            id,
            version,
            location: path.to_string_lossy().to_string(),
            manifest,
            installed_timestamp,
            target_platform: get_target_platform(),
        });
    }

    // Sort by id for deterministic order
    extensions.sort_by(|a, b| a.id.cmp(&b.id));

    log::info!(
        target: "vscodeee::ext_management",
        "Scanned {} user extensions from {}",
        extensions.len(),
        dir.display()
    );

    Ok(extensions)
}

/// Get the current platform's target identifier.
///
/// Returns a string like `darwin-arm64`, `linux-x64`, or `win32-x64`
/// matching VS Code's `TargetPlatform` enum values.
///
/// # Returns
///
/// A [`PlatformInfo`] struct containing the `target_platform` string.
///
/// # Errors
///
/// This command currently never fails; it always returns `Ok`.
#[tauri::command]
pub fn ext_get_target_platform() -> Result<PlatformInfo, String> {
    Ok(PlatformInfo {
        target_platform: get_target_platform(),
    })
}

/// Compute the total size (bytes) of an extension directory on disk.
///
/// Recursively walks the directory tree and sums every regular file's size.
/// Returns 0 if the directory does not exist (idempotent behavior).
///
/// # Arguments
///
/// * `extension_path` - Absolute path to the extension directory to measure.
///
/// # Returns
///
/// The total size in bytes as a `u64`.
///
/// # Errors
///
/// Returns a `String` if a filesystem entry cannot be read during traversal.
#[tauri::command]
pub fn ext_compute_extension_size(extension_path: String) -> Result<u64, String> {
    let path = Path::new(&extension_path);

    if !path.exists() {
        return Ok(0);
    }

    let mut total_size: u64 = 0;

    /// Recursively accumulate file sizes under `dir` into `total`.
    ///
    /// Directories are descended into; only regular files contribute to the sum.
    fn walk(dir: &Path, total: &mut u64) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                walk(&entry.path(), total)?;
            } else {
                *total += metadata.len();
            }
        }
        Ok(())
    }

    walk(path, &mut total_size).map_err(|e| format!("Failed to compute size: {e}"))?;

    Ok(total_size)
}
