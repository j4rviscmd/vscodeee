/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Miscellaneous commands — zip file creation, toast notifications,
//! elevated file write, screenshot.

use serde::{Deserialize, Serialize};

use super::error::NativeHostError;

/// File entry for zip creation.
///
/// Each entry represents a file to be included in the resulting zip archive,
/// specified by its relative path within the archive and its text contents.
#[derive(Deserialize)]
pub struct ZipFileEntry {
    /// Relative path of the file within the zip archive (e.g., `"src/index.ts"`).
    pub path: String,
    /// Text contents to write for this file entry.
    pub contents: String,
}

/// Create a zip file from the given file entries.
///
/// Each entry specifies a relative path and text contents.
/// Uses the `zip` crate for cross-platform zip creation.
#[tauri::command]
pub async fn create_zip_file(
    zip_path: String,
    files: Vec<ZipFileEntry>,
) -> Result<(), NativeHostError> {
    use std::fs::File;
    use std::io::Write;

    let file = File::create(&zip_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in &files {
        zip.start_file(&entry.path, options)
            .map_err(|e| NativeHostError::Other(format!("Failed to add file to zip: {e}")))?;
        zip.write_all(entry.contents.as_bytes())?;
    }

    zip.finish()
        .map_err(|e| NativeHostError::Other(format!("Failed to finalize zip: {e}")))?;

    Ok(())
}

/// Toast notification options received from TypeScript.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastOptions {
    /// Optional title for the notification. Falls back to `"VS Codeee"` if omitted.
    pub title: Option<String>,
    /// Body text displayed in the notification.
    pub body: String,
    /// Optional identifier for the notification, used for later dismissal.
    #[serde(default)]
    // TODO(Phase 3): Remove allow(dead_code) when this is wired up
    #[allow(dead_code)]
    pub id: Option<String>,
}

/// Toast notification result returned to TypeScript.
#[derive(Serialize)]
pub struct ToastResult {
    /// `true` if the desktop notification was successfully displayed.
    pub supported: bool,
    /// `true` if the user clicked the notification. Always `false` because
    /// `notify-rust` does not support async click tracking.
    pub clicked: bool,
}

/// Show a desktop toast notification.
///
/// Uses `notify-rust` for cross-platform desktop notifications.
#[tauri::command]
pub fn show_toast(options: ToastOptions) -> ToastResult {
    let result = notify_rust::Notification::new()
        .summary(options.title.as_deref().unwrap_or("VS Codeee"))
        .body(&options.body)
        .show();

    ToastResult {
        supported: result.is_ok(),
        clicked: false, // async click tracking not supported
    }
}

/// Clear a specific toast notification by ID.
///
/// Not all platforms support clearing individual notifications.
#[tauri::command]
pub fn clear_toast(_id: String) {
    // No-op — notify-rust doesn't support clearing by ID
}

/// Clear all toast notifications.
#[tauri::command]
pub fn clear_toasts() {
    // No-op — notify-rust doesn't support clearing all
}

/// Write a file with elevated privileges.
///
/// On macOS, uses osascript with administrator privileges.
/// On Windows, would use UAC elevation.
/// On Linux, uses pkexec.
#[tauri::command]
pub async fn write_elevated(
    source: String,
    target: String,
    _unlock: bool,
) -> Result<(), NativeHostError> {
    #[cfg(target_os = "macos")]
    {
        // Escape single quotes to prevent command injection in AppleScript
        fn escape_shell(s: &str) -> String {
            s.replace('\'', "'\\''")
        }
        let script = format!(
            "do shell script \"cp '{}' '{}'\" with administrator privileges",
            escape_shell(&source),
            escape_shell(&target)
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| NativeHostError::Other(format!("Failed to run osascript: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("User canceled") || stderr.contains("-128") {
                return Err(NativeHostError::Other(
                    "User cancelled the operation".to_string(),
                ));
            }
            return Err(NativeHostError::Other(format!(
                "Elevated write failed: {stderr}"
            )));
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("pkexec")
            .args(["cp", &source, &target])
            .output()
            .map_err(|e| NativeHostError::Other(format!("Failed to run pkexec: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(NativeHostError::Other(format!(
                "Elevated write failed: {stderr}"
            )));
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let _ = (source, target);
        Err(NativeHostError::Unsupported(
            "Elevated write on Windows is not yet supported".to_string(),
        ))
    }
}

// ── Font enumeration ──────────────────────────────────────────────────

/// Enumerate all available font family names on the system.
///
/// Returns a sorted, deduplicated list of font family names suitable for
/// editor font selection.
#[tauri::command]
pub fn enumerate_fonts() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        enumerate_fonts_macos()
    }

    #[cfg(target_os = "windows")]
    {
        enumerate_fonts_windows()
    }

    #[cfg(target_os = "linux")]
    {
        enumerate_fonts_linux()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Vec::new()
    }
}

/// Enumerate font families on macOS using Core Text.
///
/// Queries `CTFontManagerCopyAvailableFontFamilyNames` and returns a
/// sorted, deduplicated list of font family names.
#[cfg(target_os = "macos")]
fn enumerate_fonts_macos() -> Vec<String> {
    use core_text::font_manager;

    let family_names = font_manager::copy_available_font_family_names();
    let mut families: Vec<String> = family_names.iter().map(|name| name.to_string()).collect();
    families.sort();
    families.dedup();
    families
}

/// Enumerate font families on Windows by reading the system font registry.
///
/// Reads from both `HKLM` and `HKCU` under
/// `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts`, extracts the
/// family name portion (stripping style suffixes like "(TrueType)"), and
/// returns a sorted, deduplicated list.
///
/// **Note:** This approach may miss some user-installed fonts. A future
/// phase will use DirectWrite for complete enumeration.
#[cfg(target_os = "windows")]
fn enumerate_fonts_windows() -> Vec<String> {
    // TODO(Phase 2): Use DirectWrite for complete font enumeration
    // Currently reads from registry which may miss some user-installed fonts.
    let mut families = Vec::new();

    let subkey = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
    let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE).open_subkey(subkey);
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey(subkey);

    for reg_key in hklm.into_iter().chain(hkcu.into_iter()) {
        collect_font_families_from_registry(&reg_key, &mut families);
    }

    families.sort();
    families.dedup();
    families
}

/// Extract font family names from a Windows registry key containing font entries.
///
/// Registry value names are typically in the form `"Segoe UI (TrueType)"`.
/// This function strips the parenthesized style suffix and trims whitespace
/// to produce a clean family name. Empty entries are silently discarded.
#[cfg(target_os = "windows")]
fn collect_font_families_from_registry(reg_key: &winreg::RegKey, families: &mut Vec<String>) {
    for result in reg_key.enum_values() {
        if let Ok((name, _)) = result {
            let family = name.split(" (").next().unwrap_or(&name).trim().to_string();
            if !family.is_empty() {
                families.push(family);
            }
        }
    }
}

/// Enumerate font families on Linux using `fc-list`.
///
/// Runs `fc-list --format=%{family}\\n` and parses the output into a
/// sorted, deduplicated list of non-empty family names. If `fc-list`
/// is unavailable or fails, logs a warning and returns an empty list.
#[cfg(target_os = "linux")]
fn enumerate_fonts_linux() -> Vec<String> {
    let output = std::process::Command::new("fc-list")
        .args(["--format=%{family}\\n"])
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut families: Vec<String> = stdout
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect();
            families.sort();
            families.dedup();
            families
        }
        _ => {
            log::warn!(target: "vscodeee::fonts", "fc-list command failed; no fonts enumerated");
            Vec::new()
        }
    }
}
