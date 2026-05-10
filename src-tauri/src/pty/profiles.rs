/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Shell profile detection — discovers available shells on the system.
//!
//! Scans known shell paths and checks executability. Returns a list of
//! detected shells with metadata (name, path, isDefault, isAutoDetected).

use serde::Serialize;
use std::path::Path;

/// A detected shell profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    /// Display name (e.g., "PowerShell", "Command Prompt", "Git Bash").
    pub profile_name: String,
    /// Absolute path to the shell executable.
    pub path: String,
    /// Whether this is the user's default shell.
    pub is_default: bool,
    /// Whether this profile was auto-detected (vs. user-configured).
    pub is_auto_detected: bool,
    /// Optional arguments for the shell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

/// Detect available shells on the current system.
///
/// Scans known shell paths and checks if they exist and are executable.
/// Deduplicates by canonical path so each shell appears only once.
pub fn detect_available_shells() -> Vec<DetectedShell> {
    let default_shell = get_default_shell();
    let candidates = get_candidate_paths();
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut detected = Vec::new();

    for (path, name, args) in candidates {
        if !is_executable(&path) {
            continue;
        }

        // Deduplicate by path (case-insensitive on Windows)
        if !seen_paths.insert(path.to_lowercase()) {
            continue;
        }

        #[cfg(target_os = "windows")]
        let is_default = path.eq_ignore_ascii_case(&default_shell);
        #[cfg(not(target_os = "windows"))]
        let is_default = path == default_shell;
        detected.push(DetectedShell {
            profile_name: name,
            path,
            is_default,
            is_auto_detected: true,
            args,
        });
    }

    // Ensure the default shell is always present even if not in candidate list
    #[cfg(target_os = "windows")]
    let default_missing = !detected
        .iter()
        .any(|s| s.path.eq_ignore_ascii_case(&default_shell));
    #[cfg(not(target_os = "windows"))]
    let default_missing = !detected.iter().any(|s| s.path == default_shell);

    if !default_shell.is_empty() && default_missing && is_executable(&default_shell) {
        let basename = Path::new(&default_shell)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| default_shell.clone());
        detected.push(DetectedShell {
            profile_name: capitalize(&basename),
            path: default_shell.clone(),
            is_default: true,
            is_auto_detected: true,
            args: None,
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

/// Get the default shell for the current platform.
#[cfg(unix)]
fn get_default_shell() -> String {
    std::env::var("SHELL").unwrap_or_default()
}

/// Get the default shell for Windows (uses ComSpec).
#[cfg(target_os = "windows")]
fn get_default_shell() -> String {
    std::env::var("ComSpec").unwrap_or_default()
}

/// Capitalize the first letter of a string (e.g., "bash" -> "Bash").
fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// A candidate shell entry consisting of an absolute path, a human-readable display
/// name, and optional arguments to pass when launching the shell.
///
/// Used as the return type for [`get_candidate_paths()`].
type Candidate = (String, String, Option<Vec<String>>);

/// Returns the list of candidate shell paths to probe on **macOS**.
///
/// Includes stock shells under `/bin/` as well as Homebrew-managed
/// installations under `/opt/homebrew/bin/`. Shells found via Homebrew
/// share the same display name as their stock counterparts (e.g. both
/// are reported as `"zsh"`), so duplicates are later collapsed by
/// [`detect_available_shells()`].
#[cfg(target_os = "macos")]
fn get_candidate_paths() -> Vec<Candidate> {
    vec![
        ("/bin/zsh".into(), "zsh".into(), None),
        ("/bin/bash".into(), "bash".into(), None),
        ("/bin/sh".into(), "sh".into(), None),
        ("/bin/fish".into(), "fish".into(), None),
        ("/bin/tcsh".into(), "tcsh".into(), None),
        ("/bin/csh".into(), "csh".into(), None),
        ("/bin/ksh".into(), "ksh".into(), None),
        ("/usr/local/bin/fish".into(), "fish".into(), None),
        ("/opt/homebrew/bin/fish".into(), "fish".into(), None),
        ("/opt/homebrew/bin/zsh".into(), "zsh".into(), None),
        ("/opt/homebrew/bin/bash".into(), "bash".into(), None),
    ]
}

/// Returns the list of candidate shell paths to probe on **Linux**.
///
/// Starts with a hard-coded set of well-known locations (`/bin/`,
/// `/usr/bin/`, `/usr/local/bin/`) and then supplements the list with
/// every non-empty, non-comment entry found in `/etc/shells`. New
/// entries from `/etc/shells` that are not already present get a
/// capitalised basename as their display name.
#[cfg(target_os = "linux")]
fn get_candidate_paths() -> Vec<Candidate> {
    let mut paths: Vec<Candidate> = vec![
        ("/bin/bash".into(), "bash".into(), None),
        ("/bin/zsh".into(), "zsh".into(), None),
        ("/bin/sh".into(), "sh".into(), None),
        ("/bin/dash".into(), "dash".into(), None),
        ("/bin/fish".into(), "fish".into(), None),
        ("/usr/bin/bash".into(), "bash".into(), None),
        ("/usr/bin/zsh".into(), "zsh".into(), None),
        ("/usr/bin/fish".into(), "fish".into(), None),
        ("/usr/local/bin/fish".into(), "fish".into(), None),
        ("/usr/bin/tcsh".into(), "tcsh".into(), None),
        ("/usr/bin/csh".into(), "csh".into(), None),
        ("/usr/bin/ksh".into(), "ksh".into(), None),
    ];

    // Also check /etc/shells for completeness
    if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let basename = Path::new(line)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| line.to_string());
            if !paths.iter().any(|(p, _, _)| p == line) {
                paths.push((line.to_string(), capitalize(&basename), None));
            }
        }
    }

    paths
}

/// Returns the list of candidate shell paths to probe on **Windows**.
///
/// Covers:
/// - **Windows PowerShell** (system-installed, `System32\WindowsPowerShell\v1.0`)
/// - **Command Prompt** (`cmd.exe`)
/// - **PowerShell Core** (`pwsh.exe`) from Program Files, MSIX/Store, and Scoop
/// - **Git Bash** from multiple install directories (Program Files, x86,
///   `LocalAppData\Program`, Scoop)
/// - **WSL** (`wsl.exe`)
///
/// Paths are resolved using environment variables (`windir`, `ProgramFiles`,
/// `ProgramW6432`, `ProgramFiles(x86)`, `LocalAppData`, `UserProfile`) so that
/// non-standard Windows installations are handled correctly.
#[cfg(target_os = "windows")]
fn get_candidate_paths() -> Vec<Candidate> {
    let mut paths: Vec<Candidate> = Vec::new();

    let windir = std::env::var("windir").unwrap_or_else(|_| "C:\\Windows".to_string());

    // Windows PowerShell (built-in)
    paths.push((
        format!(
            "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            windir
        ),
        "Windows PowerShell".into(),
        None,
    ));

    // Command Prompt
    paths.push((
        format!("{}\\System32\\cmd.exe", windir),
        "Command Prompt".into(),
        None,
    ));

    // PowerShell Core (pwsh) — check common install locations
    for env_var in &["ProgramFiles", "ProgramW6432"] {
        if let Ok(pf) = std::env::var(env_var) {
            if !pf.is_empty() {
                paths.push((
                    format!("{}\\PowerShell\\7\\pwsh.exe", pf),
                    "PowerShell".into(),
                    None,
                ));
            }
        }
    }

    // PowerShell Core — Microsoft Store / MSIX install
    if let Ok(local) = std::env::var("LocalAppData") {
        paths.push((
            format!("{}\\Microsoft\\WindowsApps\\pwsh.exe", local),
            "PowerShell".into(),
            None,
        ));
    }

    // PowerShell Core — Scoop install
    if let Ok(home) = std::env::var("UserProfile") {
        paths.push((
            format!("{}\\scoop\\shims\\pwsh.exe", home),
            "PowerShell".into(),
            None,
        ));
    }

    // Git Bash — check common install locations
    let git_root_dirs: Vec<String> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var(v).ok().filter(|val| !val.is_empty()))
        .chain(
            std::env::var("LocalAppData")
                .ok()
                .map(|v| format!("{}\\Program", v)),
        )
        .collect();

    for dir in &git_root_dirs {
        paths.push((
            format!("{}\\Git\\bin\\bash.exe", dir),
            "Git Bash".into(),
            Some(vec!["--login".into(), "-i".into()]),
        ));
    }

    // Scoop install of Git
    if let Ok(home) = std::env::var("UserProfile") {
        paths.push((
            format!("{}\\scoop\\apps\\git\\current\\bin\\bash.exe", home),
            "Git Bash".into(),
            Some(vec!["--login".into(), "-i".into()]),
        ));
    }

    // WSL
    paths.push((format!("{}\\System32\\wsl.exe", windir), "WSL".into(), None));

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
    let p = Path::new(path);
    p.exists() && p.is_file()
}
