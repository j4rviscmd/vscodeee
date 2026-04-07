/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! URI parsing for the `vscode-file://` custom protocol.
//!
//! Converts raw request URIs of the form `vscode-file://vscode-app/<absolute-path>`
//! into canonicalized [`PathBuf`]s. Handles percent-decoding and path normalization
//! to prevent traversal attacks (e.g. `..` components).

use std::path::PathBuf;

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

    // Canonicalize to resolve symlinks and `..` components.
    let canonical = std::fs::canonicalize(&decoded).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            ProtocolError::NotFound(format!("path does not exist: {decoded}"))
        }
        _ => ProtocolError::Internal(format!("canonicalize failed for {decoded}: {e}")),
    })?;

    Ok(canonical)
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
}
