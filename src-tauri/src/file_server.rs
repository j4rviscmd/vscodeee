/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Lightweight HTTP file server for Windows WebView2 compatibility.
//!
//! WebView2 blocks `fetch()` and dynamic `import()` for custom URI schemes
//! (`vscode-file://`). This module starts a localhost HTTP server that serves
//! files from the same roots as the protocol handler, allowing the TypeScript
//! side to use standard HTTP URLs for all resource loading.
//!
//! Only compiled on Windows. macOS/Linux WKWebView/WebKitGTK properly support
//! custom schemes for all request types.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::protocol::ProtocolState;

/// A localhost HTTP file server that serves files from registered roots.
pub struct FileServer {
    port: u16,
}

impl FileServer {
    /// Start the file server on a random available port.
    ///
    /// The server listens on `127.0.0.1:<random_port>` and serves GET requests
    /// by resolving the URL path to a file under one of the registered roots.
    pub async fn start(state: Arc<ProtocolState>) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("file server bind failed: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("file server local_addr failed: {e}"))?
            .port();

        log::info!(
            target: "vscodeee::file_server",
            "File server listening on http://127.0.0.1:{port}"
        );

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((mut stream, _addr)) => {
                        let state = state.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(&mut stream, &state.roots).await {
                                log::debug!(
                                    target: "vscodeee::file_server",
                                    "Connection error: {e}"
                                );
                            }
                        });
                    }
                    Err(e) => {
                        log::warn!(
                            target: "vscodeee::file_server",
                            "Accept error: {e}"
                        );
                    }
                }
            }
        });

        Ok(Self { port })
    }

    /// Returns the port number the server is listening on.
    #[allow(dead_code)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns the base URL of the file server (e.g., `http://127.0.0.1:12345`).
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// Handle a single HTTP connection.
///
/// Reads the raw request bytes, extracts the URL path, attempts to serve the
/// corresponding file from the registered roots, and writes back a complete
/// HTTP/1.1 response with appropriate status code, Content-Type, and CORS headers.
async fn handle_connection(
    stream: &mut tokio::net::TcpStream,
    roots: &crate::protocol::roots::ValidRoots,
) -> Result<(), String> {
    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("read failed: {e}"))?;

    if n == 0 {
        return Ok(());
    }

    let request = String::from_utf8_lossy(&buf[..n]);
    let path = extract_request_path(&request);

    let (status, content_type, body) = match serve_file_from_roots(roots, path) {
        Ok((mime, content)) => (200, mime, content),
        Err(FileServerError::NotFound) => (
            404,
            "text/plain; charset=utf-8".to_string(),
            b"Not Found".to_vec(),
        ),
        Err(FileServerError::Forbidden(msg)) => (
            403,
            "text/plain; charset=utf-8".to_string(),
            msg.into_bytes(),
        ),
        Err(FileServerError::Io(msg)) => {
            log::warn!(target: "vscodeee::file_server", "IO error: {msg}");
            (
                500,
                "text/plain; charset=utf-8".to_string(),
                b"Internal Server Error".to_vec(),
            )
        }
    };

    let status_text = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Internal Server Error",
    };

    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: *\r\n\
         \r\n",
        body.len()
    );

    let mut response = header.into_bytes();
    response.extend_from_slice(&body);

    stream
        .write_all(&response)
        .await
        .map_err(|e| format!("write failed: {e}"))?;

    Ok(())
}

/// Error variants for file server request handling.
enum FileServerError {
    NotFound,
    Forbidden(String),
    Io(String),
}

/// Resolve a URL path to a file on disk and read its contents.
///
/// Strips the leading `/`, percent-decodes the path, converts forward slashes
/// to backslashes (Windows), canonicalizes to resolve symlinks, and validates
/// the result against the registered roots. Returns the MIME type and file bytes
/// on success.
///
/// # Errors
///
/// - [`FileServerError::NotFound`] if the path is empty or does not exist on disk.
/// - [`FileServerError::Forbidden`] if the resolved path is not under any registered root.
/// - [`FileServerError::Io`] if the file cannot be read.
fn serve_file_from_roots(
    roots: &crate::protocol::roots::ValidRoots,
    url_path: &str,
) -> Result<(String, Vec<u8>), FileServerError> {
    // URL path is like "/E:/work/vscodeee/out/vs/foo.js"
    // Strip leading "/" to get a filesystem path on Windows.
    let fs_path_str = url_path.trim_start_matches('/');

    if fs_path_str.is_empty() {
        return Err(FileServerError::NotFound);
    }

    // Decode percent-encoded characters.
    let decoded = percent_decode(fs_path_str);

    // Convert forward slashes to backslashes for Windows.
    let native_path = decoded.replace('/', r"\");

    // Canonicalize to resolve symlinks and verify existence.
    let canonical = PathBuf::from(&native_path)
        .canonicalize()
        .map_err(|_| FileServerError::NotFound)?;

    // Security: validate against registered roots.
    if !roots.is_path_allowed(&canonical) {
        return Err(FileServerError::Forbidden(format!(
            "path not under any valid root: {}",
            canonical.display()
        )));
    }

    let content = std::fs::read(&canonical).map_err(|e| FileServerError::Io(e.to_string()))?;

    let mime = crate::protocol::mime::mime_from_path(&canonical);

    Ok((mime.to_string(), content))
}

/// Extract the path from an HTTP request line.
///
/// Parses `GET /path HTTP/1.1\r\n...` and returns the path portion.
/// Falls back to `"/"` if the request line cannot be parsed.
fn extract_request_path(request: &str) -> &str {
    let first_line = request.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    parts.next(); // Skip method (e.g. "GET")
    parts.next().unwrap_or("/")
}

/// Percent-decode a URI path component.
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
///
/// Returns `None` if either digit is not a valid hexadecimal character.
fn decode_hex_pair(hi: u8, lo: u8) -> Option<u8> {
    let h = hex_val(hi)?;
    let l = hex_val(lo)?;
    Some(h << 4 | l)
}

/// Convert a single ASCII hex digit to its numeric value (0--15).
///
/// Returns `None` if the byte is not a valid hexadecimal digit.
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
