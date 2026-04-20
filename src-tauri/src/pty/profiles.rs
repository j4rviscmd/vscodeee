/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Shell profile detection — discovers available shells on the system.
//!
//! Scans known shell paths and checks executability. Returns a list of
//! detected shells with metadata (name, path, isDefault).

use serde::Serialize;
use std::path::Path;

/// A detected shell profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    /// Display name (e.g., "zsh", "bash", "fish").
    pub profile_name: String,
    /// Absolute path to the shell executable.
    pub path: String,
    /// Whether this is the user's default shell.
    pub is_default: bool,
}

/// Detect available shells on the current system.
///
/// Scans known shell paths and checks if they exist and are executable.
/// The default shell is determined from the `SHELL` environment variable.
/// Deduplicates by shell name (basename) so `/bin/bash` and `/usr/bin/bash`
/// produce only one "Bash" entry.
pub fn detect_available_shells() -> Vec<DetectedShell> {
    let default_shell = std::env::var("SHELL").unwrap_or_default();
    let candidates = get_candidate_paths();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut detected = Vec::new();

    for path in candidates {
        if !is_executable(&path) {
            continue;
        }

        let basename = Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());

        // Deduplicate by shell basename (e.g., "bash" appears once regardless of path)
        if !seen_names.insert(basename.clone()) {
            continue;
        }

        let is_default = path == default_shell;
        detected.push(DetectedShell {
            profile_name: capitalize(&basename),
            path,
            is_default,
        });
    }

    // Ensure the default shell is always present even if not in candidate list
    if !default_shell.is_empty()
        && !detected.iter().any(|s| s.path == default_shell)
        && is_executable(&default_shell)
    {
        let basename = Path::new(&default_shell)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| default_shell.clone());
        detected.push(DetectedShell {
            profile_name: capitalize(&basename),
            path: default_shell.clone(),
            is_default: true,
        });
    }

    // Sort: default first, then alphabetically
    detected.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then(a.profile_name.cmp(&b.profile_name))
    });

    detected
}

/// Capitalize the first letter of a string (e.g., "bash" → "Bash").
fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Returns platform-specific candidate shell paths.
fn get_candidate_paths() -> Vec<String> {
    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    {
        paths.extend_from_slice(&[
            "/bin/zsh".to_string(),
            "/bin/bash".to_string(),
            "/bin/sh".to_string(),
            "/bin/fish".to_string(),
            "/bin/tcsh".to_string(),
            "/bin/csh".to_string(),
            "/bin/ksh".to_string(),
            "/usr/local/bin/fish".to_string(),
            "/opt/homebrew/bin/fish".to_string(),
            "/opt/homebrew/bin/zsh".to_string(),
            "/opt/homebrew/bin/bash".to_string(),
        ]);
    }

    #[cfg(target_os = "linux")]
    {
        paths.extend_from_slice(&[
            "/bin/bash".to_string(),
            "/bin/zsh".to_string(),
            "/bin/sh".to_string(),
            "/bin/dash".to_string(),
            "/bin/fish".to_string(),
            "/usr/bin/bash".to_string(),
            "/usr/bin/zsh".to_string(),
            "/usr/bin/fish".to_string(),
            "/usr/local/bin/fish".to_string(),
            "/usr/bin/tcsh".to_string(),
            "/usr/bin/csh".to_string(),
            "/usr/bin/ksh".to_string(),
        ]);
    }

    #[cfg(target_os = "windows")]
    {
        paths.extend_from_slice(&[
            "powershell.exe".to_string(),
            "pwsh.exe".to_string(),
            "cmd.exe".to_string(),
        ]);
    }

    // Also check /etc/shells on Unix for completeness
    #[cfg(unix)]
    {
        if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if !paths.contains(&line.to_string()) {
                    paths.push(line.to_string());
                }
            }
        }
    }

    paths
}

/// Check if a path points to an executable file.
#[cfg(unix)]
fn is_executable(path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Check if a path points to an executable file (Windows).
#[cfg(target_os = "windows")]
fn is_executable(path: &str) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}
