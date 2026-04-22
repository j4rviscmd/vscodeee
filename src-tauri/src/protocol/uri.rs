/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! URI parsing for the `vscode-file://` custom protocol.
//!
//! Converts raw request URIs of the form `vscode-file://vscode-app/<absolute-path>`
//! into canonicalized [`PathBuf`]s. Handles percent-decoding and path normalization
//! to prevent traversal attacks (e.g. `..` components).

use std::path::{Component, Path, PathBuf};

use super::error::ProtocolError;

/// The expected authority component of `vscode-file://` URIs.
#[allow(dead_code)]
pub const VSCODE_AUTHORITY: &str = "vscode-app";

/// The full prefix that precedes the file path in a request URI.
const URI_PREFIX: &str = "vscode-file://vscode-app";

/// Parse a `vscode-file://vscode-app/<path>` URI into a canonical filesystem path.
///
/// The path component is percent-decoded and then canonicalized via
/// [`std::fs::canonicalize`] to resolve symlinks and eliminate `..`.
///
/// # Errors
///
/// Returns [`ProtocolError::BadUri`] if the URI is malformed, and
/// [`ProtocolError::NotFound`] if canonicalization fails (i.e. the path
/// does not exist).
pub fn parse_vscode_file_uri(raw_uri: &str) -> Result<PathBuf, ProtocolError> {
    // Strip the `vscode-file://vscode-app` prefix.
    // Tauri may also strip the scheme; handle both cases.
    let encoded_path = raw_uri
        .strip_prefix(URI_PREFIX)
        .or_else(|| raw_uri.strip_prefix("/"))
        .unwrap_or(raw_uri);

    // Strip query string (e.g. `?id=...&parentId=...`) if present.
    // Webview iframes append query parameters that are not part of the file path.
    let encoded_path = encoded_path.split('?').next().unwrap_or(encoded_path);

    // Strip fragment (e.g. `#section`) if present.
    let encoded_path = encoded_path.split('#').next().unwrap_or(encoded_path);

    if encoded_path.is_empty() {
        return Err(ProtocolError::BadUri("empty path".into()));
    }

    // Percent-decode the path (e.g. `%20` → ` `).
    let decoded = percent_decode(encoded_path);

    // Ensure path is absolute after decoding.
    if !decoded.starts_with('/') {
        return Err(ProtocolError::BadUri(format!(
            "path is not absolute: {decoded}"
        )));
    }

    // Normalize `..` and `.` segments logically before calling canonicalize().
    //
    // In production builds, `frontendDist` assets (e.g. `out/`) are embedded in
    // the binary and don't exist on disk. However, module paths like
    // `<resource_dir>/out/vs/../../node_modules/vscode-oniguruma/release/onig.wasm`
    // traverse through these non-existent intermediate directories via `..`.
    // `std::fs::canonicalize()` fails because it requires every path component
    // to exist. By resolving `..` first, the path becomes
    // `<resource_dir>/node_modules/vscode-oniguruma/release/onig.wasm` which
    // does exist on disk (bundled via `bundle.resources`).
    //
    // Security: canonicalize() is still called on the normalized path to resolve
    // symlinks and verify the final path exists, and roots validation follows.
    let normalized = normalize_dot_segments(&decoded);

    // Canonicalize to resolve symlinks and verify the path exists.
    let canonical = std::fs::canonicalize(&normalized).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            ProtocolError::NotFound(format!("path does not exist: {}", normalized.display()))
        }
        _ => ProtocolError::Internal(format!(
            "canonicalize failed for {}: {e}",
            normalized.display()
        )),
    })?;

    Ok(canonical)
}

/// Parse a `vscode-file://vscode-app/<path>` URI into a decoded path **without**
/// filesystem canonicalization.
///
/// Used for embedded asset lookup when the file doesn't exist on disk (production
/// builds where assets are bundled into the binary via `frontendDist`).
/// Returns the percent-decoded absolute path string.
pub fn parse_vscode_file_uri_raw(raw_uri: &str) -> Result<String, ProtocolError> {
    let encoded_path = raw_uri
        .strip_prefix(URI_PREFIX)
        .or_else(|| raw_uri.strip_prefix("/"))
        .unwrap_or(raw_uri);

    // Strip query string and fragment
    let encoded_path = encoded_path.split('?').next().unwrap_or(encoded_path);
    let encoded_path = encoded_path.split('#').next().unwrap_or(encoded_path);

    if encoded_path.is_empty() {
        return Err(ProtocolError::BadUri("empty path".into()));
    }

    let decoded = percent_decode(encoded_path);

    if !decoded.starts_with('/') {
        return Err(ProtocolError::BadUri(format!(
            "path is not absolute: {decoded}"
        )));
    }

    Ok(decoded)
}

/// Normalize `.` and `..` path segments without touching the filesystem.
///
/// Unlike [`std::fs::canonicalize`], this does NOT require intermediate
/// directories to exist. It purely resolves `.` and `..` based on the
/// string representation, similar to POSIX `realpath -m` (logical mode).
///
/// This is critical for production builds where `frontendDist` (e.g. `out/`)
/// is embedded in the binary and doesn't exist on disk, but paths traverse
/// through it via `..` to reach bundled resources like `node_modules/`.
fn normalize_dot_segments(path: &str) -> PathBuf {
    let mut result = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::ParentDir => {
                // Pop the last component (go up one directory).
                // If we're at root, this is a no-op (can't go above root).
                result.pop();
            }
            Component::CurDir => {
                // Skip `.` — it refers to the current directory.
            }
            other => {
                // RootDir, Prefix, or Normal — push as-is.
                result.push(other);
            }
        }
    }
    result
}

/// Simple percent-decoding for URI path components.
///
/// Decodes `%XX` sequences where `XX` is a two-digit hex value.
/// Non-encoded bytes and malformed sequences are passed through as-is.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(decoded) = decode_hex_pair(bytes[i + 1], bytes[i + 2]) {
                out.push(decoded);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// Decode a pair of ASCII hex digits into a byte value.
fn decode_hex_pair(hi: u8, lo: u8) -> Option<u8> {
    let h = hex_val(hi)?;
    let l = hex_val(lo)?;
    Some(h << 4 | l)
}

/// Convert a single ASCII hex digit to its numeric value (0–15).
///
/// Returns `None` if the byte is not a valid hexadecimal digit
/// (`0`–`9`, `a`–`f`, or `A`–`F`).
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("/hello%20world"), "/hello world");
        assert_eq!(percent_decode("/a%2Fb"), "/a/b");
        assert_eq!(percent_decode("/no-encoding"), "/no-encoding");
    }

    #[test]
    fn percent_decode_passthrough_on_malformed() {
        assert_eq!(percent_decode("/bad%ZZ"), "/bad%ZZ");
        assert_eq!(percent_decode("/trailing%2"), "/trailing%2");
    }

    #[test]
    fn parse_rejects_empty_path() {
        let result = parse_vscode_file_uri("vscode-file://vscode-app");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().status_code(), 400);
    }

    #[test]
    fn parse_rejects_relative_path() {
        let result = parse_vscode_file_uri("vscode-file://vscode-apprelative/path");
        assert!(result.is_err());
    }

    #[test]
    fn parse_valid_existing_path() {
        // /tmp always exists on macOS/Linux
        let result = parse_vscode_file_uri("vscode-file://vscode-app/tmp");
        assert!(result.is_ok());
        // Canonical path should be absolute
        assert!(result.unwrap().is_absolute());
    }

    #[test]
    fn parse_nonexistent_path_returns_not_found() {
        let result =
            parse_vscode_file_uri("vscode-file://vscode-app/definitely_not_a_real_path_12345");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().status_code(), 404);
    }

    #[test]
    fn parse_handles_percent_encoded_spaces() {
        // Create a temp dir with a space
        let tmp = std::env::temp_dir().join("vscode test dir");
        let _ = std::fs::create_dir_all(&tmp);
        let uri = format!(
            "vscode-file://vscode-app{}",
            tmp.to_str().unwrap().replace(' ', "%20")
        );
        let result = parse_vscode_file_uri(&uri);
        assert!(result.is_ok());
        let _ = std::fs::remove_dir(&tmp);
    }

    #[test]
    fn parse_strips_query_string() {
        // /tmp always exists on macOS/Linux
        let result =
            parse_vscode_file_uri("vscode-file://vscode-app/tmp?id=test-id&parentId=parent-id");
        assert!(result.is_ok());
        assert!(result.unwrap().is_absolute());
    }

    #[test]
    fn parse_strips_fragment() {
        // /tmp always exists on macOS/Linux
        let result = parse_vscode_file_uri("vscode-file://vscode-app/tmp#section");
        assert!(result.is_ok());
        assert!(result.unwrap().is_absolute());
    }

    #[test]
    fn parse_strips_query_and_fragment() {
        // /tmp always exists on macOS/Linux
        let result = parse_vscode_file_uri("vscode-file://vscode-app/tmp?id=test-id#section");
        assert!(result.is_ok());
        assert!(result.unwrap().is_absolute());
    }

    // ── parse_vscode_file_uri_raw tests ──

    #[test]
    fn raw_parse_returns_decoded_path_without_canonicalize() {
        // This path doesn't exist on disk, but raw parse should succeed
        let uri = "vscode-file://vscode-app/nonexistent/path/to/out/vs/code/foo.js";
        let result = parse_vscode_file_uri_raw(uri);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/nonexistent/path/to/out/vs/code/foo.js");
    }

    #[test]
    fn raw_parse_decodes_percent_encoding() {
        let uri = "vscode-file://vscode-app/path%20with%20spaces/out/file.js";
        let result = parse_vscode_file_uri_raw(uri);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/path with spaces/out/file.js");
    }

    #[test]
    fn raw_parse_strips_query_and_fragment() {
        let uri = "vscode-file://vscode-app/some/path?id=test#section";
        let result = parse_vscode_file_uri_raw(uri);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/some/path");
    }

    #[test]
    fn raw_parse_rejects_empty_path() {
        let result = parse_vscode_file_uri_raw("vscode-file://vscode-app");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().status_code(), 400);
    }

    #[test]
    fn raw_parse_rejects_relative_path() {
        let result = parse_vscode_file_uri_raw("vscode-file://vscode-apprelative/path");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().status_code(), 400);
    }

    // ── normalize_dot_segments tests ──

    #[test]
    fn normalize_resolves_parent_dir() {
        let result = normalize_dot_segments("/a/b/c/../../d");
        assert_eq!(result, PathBuf::from("/a/d"));
    }

    #[test]
    fn normalize_resolves_current_dir() {
        let result = normalize_dot_segments("/a/./b/./c");
        assert_eq!(result, PathBuf::from("/a/b/c"));
    }

    #[test]
    fn normalize_node_modules_traversal() {
        // Simulates: <resource_dir>/out/vs/../../node_modules/vscode-oniguruma/release/onig.wasm
        let result = normalize_dot_segments(
            "/Applications/VS Codeee.app/Contents/Resources/out/vs/../../node_modules/vscode-oniguruma/release/onig.wasm"
        );
        assert_eq!(
            result,
            PathBuf::from("/Applications/VS Codeee.app/Contents/Resources/node_modules/vscode-oniguruma/release/onig.wasm")
        );
    }

    #[test]
    fn normalize_does_not_go_above_root() {
        let result = normalize_dot_segments("/a/../../b");
        assert_eq!(result, PathBuf::from("/b"));
    }

    #[test]
    fn normalize_preserves_root() {
        let result = normalize_dot_segments("/");
        assert_eq!(result, PathBuf::from("/"));
    }

    #[test]
    fn normalize_simple_path_unchanged() {
        let result = normalize_dot_segments("/a/b/c");
        assert_eq!(result, PathBuf::from("/a/b/c"));
    }
}
