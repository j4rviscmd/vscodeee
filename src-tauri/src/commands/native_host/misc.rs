/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Miscellaneous commands — zip file creation, toast notifications,
//! elevated file write, screenshot.

use serde::{Deserialize, Serialize};

use super::error::NativeHostError;

/// File entry for zip creation.
#[derive(Deserialize)]
pub struct ZipFileEntry {
    pub path: String,
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
    pub title: Option<String>,
    pub body: String,
    #[serde(default)]
    pub id: Option<String>,
}

/// Toast notification result returned to TypeScript.
#[derive(Serialize)]
pub struct ToastResult {
    pub supported: bool,
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
