/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Read VS Code user settings from `settings.json` at startup.
//!
//! VS Code's `settings.json` uses JSONC (JSON with Comments), so we strip
//! single-line (`//`) and multi-line (`/* */`) comments before parsing.
//! This module is called from `setup()` before any WebView loads, avoiding
//! an IPC round-trip to determine the `restoreWindows` mode.

use std::path::PathBuf;

use super::state::RestoreWindowsMode;

/// Settings relevant to window restore, read from `settings.json`.
#[derive(Debug, Default)]
pub struct WindowSettings {
    /// The `window.restoreWindows` setting value.
    pub restore_windows: RestoreWindowsMode,
    /// The `window.restoreFullscreen` setting value.
    pub restore_fullscreen: bool,
}

/// Locate the user `settings.json` file.
///
/// Uses the same directory convention as VS Code:
/// - macOS: `~/Library/Application Support/vscodeee/User/settings.json`
/// - Linux: `~/.config/vscodeee/User/settings.json`
/// - Windows: `%APPDATA%\vscodeee\User\settings.json`
fn settings_json_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = dirs::data_dir(); // ~/Library/Application Support

    #[cfg(target_os = "linux")]
    let base = dirs::config_dir(); // ~/.config

    #[cfg(target_os = "windows")]
    let base = dirs::config_dir(); // %APPDATA%

    base.map(|dir| dir.join("vscodeee").join("User").join("settings.json"))
}

/// Strip JSONC comments (single-line `//` and multi-line `/* */`) from input.
///
/// Respects string boundaries — comments inside JSON strings are preserved.
/// This is a simple state-machine parser that handles escape sequences (`\"`)
/// within strings correctly.
///
/// # Arguments
///
/// * `input` - A JSONC string that may contain `//` and `/* */` comments.
///
/// # Returns
///
/// A new `String` with all comments removed, suitable for `serde_json::from_str`.
fn strip_jsonc_comments(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut in_string = false;

    while i < len {
        if in_string {
            result.push(chars[i]);
            // Handle escape sequences inside strings
            if chars[i] == '\\' && i + 1 < len {
                i += 1;
                result.push(chars[i]);
            } else if chars[i] == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if chars[i] == '"' {
            in_string = true;
            result.push(chars[i]);
            i += 1;
            continue;
        }

        // Single-line comment
        if chars[i] == '/' && i + 1 < len && chars[i + 1] == '/' {
            // Skip until end of line
            i += 2;
            while i < len && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // Multi-line comment
        if chars[i] == '/' && i + 1 < len && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            if i + 1 < len {
                i += 2; // skip */
            }
            continue;
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

/// Read window-related settings from the user's `settings.json`.
///
/// Returns defaults if the file doesn't exist, is unreadable, or has
/// invalid JSON. Logs warnings for parse errors but never panics.
pub fn read_window_settings() -> WindowSettings {
    let path = match settings_json_path() {
        Some(p) => p,
        None => {
            log::debug!(
                target: "vscodeee::window::settings",
                "Could not determine settings.json path, using defaults"
            );
            return WindowSettings::default();
        }
    };

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    target: "vscodeee::window::settings",
                    "Failed to read {}: {e}", path.display()
                );
            }
            return WindowSettings::default();
        }
    };

    let stripped = strip_jsonc_comments(&content);

    let json: serde_json::Value = match serde_json::from_str(&stripped) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                target: "vscodeee::window::settings",
                "Failed to parse {}: {e}", path.display()
            );
            return WindowSettings::default();
        }
    };

    let restore_windows = json
        .get("window.restoreWindows")
        .and_then(|v| v.as_str())
        .map(RestoreWindowsMode::from_setting)
        .unwrap_or_default();

    let restore_fullscreen = json
        .get("window.restoreFullscreen")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    log::info!(
        target: "vscodeee::window::settings",
        "Loaded settings: restoreWindows={restore_windows:?}, restoreFullscreen={restore_fullscreen}"
    );

    WindowSettings {
        restore_windows,
        restore_fullscreen,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_single_line_comments() {
        let input = r#"{
    // This is a comment
    "key": "value"
}"#;
        let result = strip_jsonc_comments(input);
        assert!(!result.contains("// This"));
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["key"], "value");
    }

    #[test]
    fn strip_multi_line_comments() {
        let input = r#"{
    /* multi
       line */
    "key": "value"
}"#;
        let result = strip_jsonc_comments(input);
        assert!(!result.contains("multi"));
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["key"], "value");
    }

    #[test]
    fn preserve_strings_with_slashes() {
        let input = r#"{"url": "https://example.com"}"#;
        let result = strip_jsonc_comments(input);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["url"], "https://example.com");
    }

    #[test]
    fn parse_restore_windows_modes() {
        assert_eq!(
            RestoreWindowsMode::from_setting("preserve"),
            RestoreWindowsMode::Preserve
        );
        assert_eq!(
            RestoreWindowsMode::from_setting("all"),
            RestoreWindowsMode::All
        );
        assert_eq!(
            RestoreWindowsMode::from_setting("folders"),
            RestoreWindowsMode::Folders
        );
        assert_eq!(
            RestoreWindowsMode::from_setting("one"),
            RestoreWindowsMode::One
        );
        assert_eq!(
            RestoreWindowsMode::from_setting("none"),
            RestoreWindowsMode::None
        );
        assert_eq!(
            RestoreWindowsMode::from_setting("invalid"),
            RestoreWindowsMode::All
        );
    }
}
