/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! CLI argument parser for single-instance arg forwarding.
//!
//! Parses raw `Vec<String>` from `tauri-plugin-single-instance` into a
//! structured [`ParsedCli`]. Pure function with no I/O dependencies.

/// Parsed result from CLI arguments.
///
/// Carries zero or more workspace targets (folder paths or workspace files)
/// and optional flags. Designed for extensibility — new flags can be added
/// without changing the routing logic.
#[derive(Debug, Clone, Default)]
pub struct ParsedCli {
    /// Paths to open (files or directories).
    pub paths: Vec<String>,

    /// When `true`, force opening in a new window even if the workspace is
    /// already open.
    pub force_new_window: bool,

    /// When `true`, reuse the most recently active window.
    pub force_reuse_window: bool,
}

/// Parse raw CLI arguments into a structured [`ParsedCli`].
///
/// Skips the first argument (the executable path) and processes known flags.
/// Unknown flags are silently ignored for forward compatibility.
pub fn parse_args(args: &[String]) -> ParsedCli {
    let mut parsed = ParsedCli::default();
    let mut stop_parsing = false;

    for arg in args.iter().skip(1) {
        if stop_parsing {
            parsed.paths.push(arg.clone());
            continue;
        }
        match arg.as_str() {
            "--" => stop_parsing = true,
            "--new-window" | "-n" => parsed.force_new_window = true,
            "--reuse-window" | "-r" => parsed.force_reuse_window = true,
            // VS Code flags we recognize but don't act on yet
            "--wait" | "-w" | "--goto" | "-g" | "--unity-launch" => {}
            other if other.starts_with('-') => {
                log::debug!(target: "vscodeee::cli::parser", "Ignoring unknown flag: {other}");
            }
            path => parsed.paths.push(path.to_string()),
        }
    }

    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_args() {
        let parsed = parse_args(&args(&["eee"]));
        assert!(parsed.paths.is_empty());
        assert!(!parsed.force_new_window);
        assert!(!parsed.force_reuse_window);
    }

    #[test]
    fn single_path() {
        let parsed = parse_args(&args(&["eee", "/path/to/project"]));
        assert_eq!(parsed.paths, vec!["/path/to/project"]);
    }

    #[test]
    fn multiple_paths() {
        let parsed = parse_args(&args(&["eee", "/a", "/b", "/c"]));
        assert_eq!(parsed.paths, vec!["/a", "/b", "/c"]);
    }

    #[test]
    fn new_window_flag() {
        let parsed = parse_args(&args(&["eee", "-n", "/path"]));
        assert!(parsed.force_new_window);
        assert_eq!(parsed.paths, vec!["/path"]);
    }

    #[test]
    fn reuse_window_flag() {
        let parsed = parse_args(&args(&["eee", "-r", "/path"]));
        assert!(parsed.force_reuse_window);
    }

    #[test]
    fn double_dash_stops_flag_parsing() {
        let parsed = parse_args(&args(&["eee", "--", "-n", "/path"]));
        assert!(!parsed.force_new_window);
        assert_eq!(parsed.paths, vec!["-n", "/path"]);
    }

    #[test]
    fn unknown_flags_ignored() {
        let parsed = parse_args(&args(&["eee", "--unknown", "/path"]));
        assert_eq!(parsed.paths, vec!["/path"]);
    }

    #[test]
    fn recognized_but_noop_flags() {
        let parsed = parse_args(&args(&["eee", "--wait", "--goto", "/path"]));
        assert_eq!(parsed.paths, vec!["/path"]);
        assert!(!parsed.force_new_window);
    }
}
