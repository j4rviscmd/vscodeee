/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Custom protocol handlers for VS Code's internal URI schemes.
//!
//! Replaces Electron's `ProtocolMainService` with a Rust implementation that
//! provides the same security guarantees:
//!
//! - **Multi-root validation**: paths must be under a registered root OR have
//!   an allowed extension (image/font whitelist).
//! - **Security headers**: COOP/COEP for workbench HTML, Cache-Control for
//!   dev builds, Document-Policy for crash-report callstacks.
//! - **URI normalization**: percent-decoding, canonicalization, traversal prevention.
//!
//! # Module structure
//!
//! - [`error`] — `ProtocolError` enum with HTTP status mapping
//! - [`uri`] — URI parsing and percent-decoding
//! - [`roots`] — `ValidRoots` registry (thread-safe, dynamic)
//! - [`headers`] — Security header computation
//! - [`mime`] — MIME type resolution

pub mod error;
pub mod headers;
pub mod mime;
pub mod roots;
pub mod uri;

use std::sync::Arc;
use tauri::http::{Request, Response};
use tauri::{Manager, UriSchemeContext};

use error::ProtocolError;
use roots::ValidRoots;

/// Shared protocol state, managed as Tauri app state.
///
/// Wrapped in `Arc` so it can be cheaply cloned into the protocol handler
/// closure registered with `register_uri_scheme_protocol`.
pub struct ProtocolState {
    /// The set of valid file system roots and allowed extensions.
    pub roots: ValidRoots,
    /// Whether this is a development (non-built) build — affects caching headers.
    pub is_dev: bool,
}

/// Initialize [`ProtocolState`] with the standard VS Code root directories.
///
/// Mirrors Electron's `ProtocolMainService` constructor which registers:
/// - `appRoot` (the application install directory)
/// - `extensionsPath`
/// - `globalStorageHome`
/// - `workspaceStorageHome`
///
/// For the PoC, we use `resource_dir` (Tauri's resource path) and add the
/// `src-tauri` parent as the app root.
pub fn init_protocol_state(app: &tauri::App) -> Arc<ProtocolState> {
    let roots = ValidRoots::new();

    // Register the app root (where VS Code sources live).
    // In development, this is the repo root; in production, it's the resource dir.
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.add_root(&resource_dir);
    }

    // Also add the CWD as a valid root for development convenience.
    if let Ok(cwd) = std::env::current_dir() {
        roots.add_root(&cwd);

        // In dev mode, frontendDist is "../src/vs/code/tauri-browser/workbench"
        // relative to src-tauri/. Add the project root so all source files are accessible.
        if let Ok(project_root) = cwd.join("..").canonicalize() {
            roots.add_root(&project_root);
        }
    }

    // Detect dev build: if Tauri was invoked via `cargo tauri dev`, the
    // TAURI_DEV environment variable is set.
    let is_dev = cfg!(debug_assertions);

    let state = Arc::new(ProtocolState { roots, is_dev });

    println!(
        "[protocol] Initialized with {} root(s), dev={}",
        state.roots.root_count(),
        state.is_dev
    );

    state
}

/// Handle a `vscode-file://vscode-app/<path>` request.
///
/// This is the main entry point registered with Tauri's
/// `register_uri_scheme_protocol`. It:
///
/// 1. Parses and canonicalizes the URI.
/// 2. Validates the path against registered roots + extension whitelist.
/// 3. Reads the file and returns it with appropriate security headers.
pub fn handle_vscode_file_protocol<R: tauri::Runtime>(
    state: Arc<ProtocolState>,
) -> impl Fn(UriSchemeContext<'_, R>, Request<Vec<u8>>) -> Response<Vec<u8>> + Send + Sync + 'static
{
    move |_ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>| {
        let raw_uri = request.uri().to_string();

        match serve_file(&state, &raw_uri) {
            Ok(response) => response,
            Err(e) => {
                eprintln!("[protocol] {e}");
                error_response(e.status_code(), e.reason().as_bytes())
            }
        }
    }
}

/// Internal file-serving logic, separated for testability.
///
/// NOTE: There is a known TOCTOU (Time-of-Check-Time-of-Use) race between path
/// validation (step 2) and file read (step 3). A symlink could be swapped in after
/// validation. Electron's `ProtocolMainService` has the same pattern. For production,
/// consider using `O_NOFOLLOW` or re-validating the file descriptor after open.
fn serve_file(state: &ProtocolState, raw_uri: &str) -> Result<Response<Vec<u8>>, ProtocolError> {
    // 1. Parse URI → canonical path
    let canonical_path = uri::parse_vscode_file_uri(raw_uri)?;

    // 2. Validate against roots + extension whitelist
    if !state.roots.is_path_allowed(&canonical_path) {
        return Err(ProtocolError::Forbidden(format!(
            "path not under any valid root: {}",
            canonical_path.display()
        )));
    }

    // 3. Read file
    // TODO(Phase 1): Mitigate TOCTOU — open with O_NOFOLLOW, then read from fd
    let content = std::fs::read(&canonical_path)?;

    // 4. Compute headers
    let mime_type = mime::mime_from_path(&canonical_path);
    let security_headers = headers::headers_for_path(&canonical_path, state.is_dev);

    // 5. Build response
    let mut builder = Response::builder()
        .status(200)
        .header("Content-Type", mime_type);

    for (key, value) in &security_headers {
        builder = builder.header(*key, *value);
    }

    builder
        .body(content)
        .map_err(|e| ProtocolError::Internal(format!("failed to build response: {e}")))
}

/// Build a minimal error response with CORS headers.
///
/// CORS headers are required even on error responses, otherwise WKWebView's
/// fetch() will report "Load failed" instead of the actual status code.
fn error_response(status: u16, body: &[u8]) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Access-Control-Allow-Origin", "tauri://localhost")
        .body(body.to_vec())
        .unwrap_or_else(|_| {
            Response::builder()
                .status(500)
                .body(b"Internal Server Error".to_vec())
                .unwrap()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_state_with_root(root: &std::path::Path) -> ProtocolState {
        let roots = ValidRoots::new();
        roots.add_root(root);
        ProtocolState {
            roots,
            is_dev: true,
        }
    }

    #[test]
    fn serve_existing_file_under_root() {
        let tmp = std::env::temp_dir().join("vscodee_proto_test");
        let _ = fs::create_dir_all(&tmp);
        let file = tmp.join("test.js");
        fs::write(&file, b"console.log('hello');").unwrap();

        let state = test_state_with_root(&tmp);
        let uri = format!(
            "vscode-file://vscode-app{}",
            file.canonicalize().unwrap().display()
        );

        let result = serve_file(&state, &uri);
        assert!(result.is_ok());

        let resp = result.unwrap();
        assert_eq!(resp.status(), 200);

        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&tmp);
    }

    #[test]
    fn reject_file_outside_roots() {
        let tmp = std::env::temp_dir().join("vscodee_proto_root");
        let _ = fs::create_dir_all(&tmp);

        let state = test_state_with_root(&tmp);

        // /usr/bin/env is definitely outside tmp
        let uri = "vscode-file://vscode-app/usr/bin/env";
        let result = serve_file(&state, uri);

        // Should be either Forbidden (if file exists) or NotFound
        assert!(result.is_err());

        let _ = fs::remove_dir(&tmp);
    }

    #[test]
    fn serve_file_returns_correct_mime() {
        let tmp = std::env::temp_dir().join("vscodee_proto_mime");
        let _ = fs::create_dir_all(&tmp);
        let css_file = tmp.join("style.css");
        fs::write(&css_file, "body {}").unwrap();

        let state = test_state_with_root(&tmp);
        let uri = format!(
            "vscode-file://vscode-app{}",
            css_file.canonicalize().unwrap().display()
        );

        let resp = serve_file(&state, &uri).unwrap();
        let content_type = resp
            .headers()
            .get("Content-Type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(content_type.contains("text/css"));

        let _ = fs::remove_file(&css_file);
        let _ = fs::remove_dir(&tmp);
    }

    #[test]
    fn error_response_includes_content_type() {
        let resp = error_response(404, b"Not Found");
        assert_eq!(resp.status(), 404);
        let ct = resp
            .headers()
            .get("Content-Type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ct.contains("text/plain"));
    }
}
