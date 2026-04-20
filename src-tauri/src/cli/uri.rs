/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! URI conversion utilities for CLI path arguments.
//!
//! Converts filesystem paths to `file:///` URIs suitable for
//! [`WindowManager::open_window`](crate::window::manager::WindowManager::open_window).

use std::path::Path;

/// Convert a filesystem path to a `file:///` URI.
///
/// Handles absolute paths, relative paths (resolved against `cwd`),
/// and `~` expansion to the home directory. Returns `None` if the
/// path does not exist on the filesystem.
pub fn path_to_file_uri(path: &str, cwd: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }

    let resolved = if path == "~" {
        dirs::home_dir()?
    } else if let Some(stripped) = path.strip_prefix("~/") {
        let home = dirs::home_dir()?;
        home.join(stripped)
    } else if Path::new(path).is_absolute() {
        Path::new(path).to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };

    let canonical = resolved.canonicalize().ok()?;
    Some(canonical_to_uri(&canonical))
}

/// Convert a canonicalized `PathBuf` to a `file:///` URI.
///
/// Percent-encodes characters that are not valid in URI path segments
/// (space, `#`, `?`, `%`, `[`, `]`) to ensure reliable dedup matching
/// and correct workbench URL construction.
fn canonical_to_uri(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        let path_str = path
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/");
        format!("file:///{}", percent_encode_path(&path_str))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let path_str = path.to_string_lossy();
        format!("file://{}", percent_encode_path(&path_str))
    }
}

/// Minimal percent-encoding for URI path segments.
///
/// Encodes characters that would break URI parsing. This intentionally
/// does NOT encode `/` since path separators are structural in file URIs.
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            '%' => out.push_str("%25"),
            '[' => out.push_str("%5B"),
            ']' => out.push_str("%5D"),
            _ => out.push(c),
        }
    }
    out
}

/// Normalize a URI string for reliable dedup comparison.
///
/// Strips trailing slashes (except for root `/`) so that
/// `file:///Users/me/project` and `file:///Users/me/project/`
/// are treated as the same workspace.
pub fn normalize_uri(uri: &str) -> String {
    uri.trim_end_matches('/').to_string()
}

/// Determine whether a path refers to a `.code-workspace` file.
pub fn is_workspace_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|ext| ext == "code-workspace")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_path() {
        let home = dirs::home_dir().unwrap();
        let path = home.to_string_lossy().to_string();
        let uri = path_to_file_uri(&path, "/tmp");
        assert!(uri.is_some());
        assert!(uri.unwrap().starts_with("file://"));
    }

    #[test]
    fn relative_path_resolves() {
        let uri = path_to_file_uri(".", "/");
        assert!(uri.is_some());
        let uri_str = uri.unwrap();
        assert!(uri_str.starts_with("file:///"));
    }

    #[test]
    fn nonexistent_path() {
        let uri = path_to_file_uri("/nonexistent/path/that/does/not/exist", "/tmp");
        assert!(uri.is_none());
    }

    #[test]
    fn empty_path() {
        let uri = path_to_file_uri("", "/tmp");
        assert!(uri.is_none());
    }

    #[test]
    fn normalize_uri_strips_trailing_slash() {
        assert_eq!(
            normalize_uri("file:///Users/me/project/"),
            "file:///Users/me/project"
        );
    }

    #[test]
    fn normalize_uri_no_trailing_slash() {
        assert_eq!(
            normalize_uri("file:///Users/me/project"),
            "file:///Users/me/project"
        );
    }

    #[test]
    fn is_workspace_file_true() {
        assert!(is_workspace_file("project.code-workspace"));
    }

    #[test]
    fn is_workspace_file_false() {
        assert!(!is_workspace_file("project.rs"));
        assert!(!is_workspace_file("folder/"));
    }

    #[test]
    fn percent_encode_path_spaces() {
        assert_eq!(
            percent_encode_path("/Users/me/my project"),
            "/Users/me/my%20project"
        );
    }

    #[test]
    fn percent_encode_path_special_chars() {
        assert_eq!(percent_encode_path("/path/#file"), "/path/%23file");
        assert_eq!(percent_encode_path("/path/100%"), "/path/100%25");
    }

    #[test]
    fn tilde_home_expansion() {
        let uri = path_to_file_uri("~/Desktop", "/tmp");
        assert!(uri.is_some());
        let uri_str = uri.unwrap();
        assert!(uri_str.starts_with("file://"));
        assert!(uri_str.contains("Desktop"));
    }

    #[test]
    fn tilde_without_slash_not_expanded() {
        let uri = path_to_file_uri("~project", "/tmp");
        if let Some(uri_str) = uri {
            let home = dirs::home_dir().unwrap();
            assert!(!uri_str.contains(home.to_string_lossy().as_ref()));
        }
    }
}
