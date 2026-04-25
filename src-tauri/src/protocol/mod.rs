/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
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

            // Worktrees symlink .build/ to the main repo's .build/ directory.
            // The extension service resolves through this symlink and creates
            // vscode-file:// URIs using the main repo path, which would be
            // rejected by the root validation. Resolve the symlink and register
            // the target as an additional root.
            let build_dir = project_root.join(".build");
            if let Ok(resolved) = build_dir.canonicalize() {
                roots.add_root(&resolved);
            }
        }
    }

    // Register user extensions directory as a valid root.
    // This mirrors Electron's ProtocolMainService which registers `extensionsPath`.
    // Must match product.json's `dataFolderName` (currently `.vscodeee`).
    if let Some(home) = dirs::home_dir() {
        let extensions_dir = home.join(".vscodeee").join("extensions");
        // Ensure the directory exists so canonicalize succeeds on first run.
        let _ = std::fs::create_dir_all(&extensions_dir);
        roots.add_root(&extensions_dir);
    }

    // Detect dev build: if Tauri was invoked via `cargo tauri dev`, the
    // TAURI_DEV environment variable is set.
    let is_dev = cfg!(debug_assertions);

    let state = Arc::new(ProtocolState { roots, is_dev });

    log::info!(
        target: "vscodeee::protocol",
        "Initialized with {} root(s), dev={}",
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
/// 4. If the file is not found on disk, falls back to Tauri's embedded
///    asset resolver (for production builds where `frontendDist` assets
///    are bundled into the binary).
pub fn handle_vscode_file_protocol<R: tauri::Runtime>(
    state: Arc<ProtocolState>,
) -> impl Fn(UriSchemeContext<'_, R>, Request<Vec<u8>>) -> Response<Vec<u8>> + Send + Sync + 'static
{
    move |ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>| {
        let raw_uri = request.uri().to_string();
        let request_origin = request
            .headers()
            .get("Origin")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        match serve_file(&state, &raw_uri, request_origin.as_deref()) {
            Ok(response) => response,
            Err(ProtocolError::NotFound(_)) => {
                // File not found on disk — try embedded asset fallback.
                // In production builds, frontendDist assets are embedded in the
                // binary and not available on the filesystem.
                log::debug!(
                    target: "vscodeee::protocol",
                    "File not found on disk, trying embedded asset: {raw_uri}"
                );
                match serve_embedded_asset(
                    ctx.app_handle(),
                    &raw_uri,
                    request_origin.as_deref(),
                    state.is_dev,
                ) {
                    Ok(response) => response,
                    Err(fallback_err) => {
                        log::warn!(
                            target: "vscodeee::protocol",
                            "Embedded asset fallback also failed: {fallback_err}"
                        );
                        error_response(
                            fallback_err.status_code(),
                            fallback_err.reason().as_bytes(),
                            request_origin.as_deref(),
                        )
                    }
                }
            }
            Err(e) => {
                log::error!(target: "vscodeee::protocol", "{e}");
                error_response(
                    e.status_code(),
                    e.reason().as_bytes(),
                    request_origin.as_deref(),
                )
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
fn serve_file(
    state: &ProtocolState,
    raw_uri: &str,
    request_origin: Option<&str>,
) -> Result<Response<Vec<u8>>, ProtocolError> {
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

    // 4. Compute headers (pass request origin for dynamic CORS)
    let mime_type = mime::mime_from_path(&canonical_path);
    let security_headers = headers::headers_for_path(&canonical_path, state.is_dev, request_origin);

    // 5. Build response
    let mut builder = Response::builder()
        .status(200)
        .header("Content-Type", mime_type);

    for (key, value) in &security_headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    builder
        .body(content)
        .map_err(|e| ProtocolError::Internal(format!("failed to build response: {e}")))
}

/// Extract the Tauri embedded asset key from a decoded URI path.
///
/// The `frontendDist` config is `"../out"`, so assets are keyed by their
/// relative path within the `out/` directory. For example:
///   `/Users/foo/work/vscodeee/out/vs/code/foo.js` → `"vs/code/foo.js"`
///   `/Applications/VS Codeee.app/Contents/Resources/out/vs/base/worker/...` → `"vs/base/worker/..."`
///
/// Returns `None` if the path does not contain `/out/`.
fn extract_asset_key(decoded_path: &str) -> Option<&str> {
    // Find the last occurrence of "/out/" to handle paths like
    // `/foo/checkout/out/vs/...` or `/app/Resources/out/vs/...`
    if let Some(idx) = decoded_path.rfind("/out/") {
        let key = &decoded_path[idx + 5..]; // skip "/out/"
        if !key.is_empty() {
            return Some(key);
        }
    }
    None
}

/// Serve a file from Tauri's embedded asset resolver.
///
/// This is the fallback path for production builds where `frontendDist` assets
/// are compiled into the binary and not present on the filesystem. The function:
///
/// 1. Parses the raw URI without canonicalization (the file doesn't exist on disk).
/// 2. Extracts the asset key (relative path after `/out/`).
/// 3. Resolves the asset via `AppHandle::asset_resolver().get()`.
/// 4. Returns the response with correct MIME type and security headers.
fn serve_embedded_asset<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    raw_uri: &str,
    request_origin: Option<&str>,
    is_dev: bool,
) -> Result<Response<Vec<u8>>, ProtocolError> {
    // 1. Parse URI without filesystem canonicalization
    let decoded_path = uri::parse_vscode_file_uri_raw(raw_uri)?;

    // 2. Extract asset key: relative path after "/out/"
    let asset_key = extract_asset_key(&decoded_path).ok_or_else(|| {
        ProtocolError::NotFound(format!(
            "no embedded asset path (missing /out/ segment): {decoded_path}"
        ))
    })?;

    // 3. Resolve from Tauri's embedded assets
    let asset = app_handle
        .asset_resolver()
        .get(asset_key.to_string())
        .ok_or_else(|| ProtocolError::NotFound(format!("embedded asset not found: {asset_key}")))?;

    log::info!(
        target: "vscodeee::protocol",
        "Serving embedded asset: {asset_key} (mime: {})",
        asset.mime_type()
    );

    // 4. Build response with security headers
    // Use a synthetic path for header computation so COOP/COEP etc. are applied correctly
    let path = std::path::PathBuf::from(asset_key);
    let mime_type = mime::mime_from_path(&path);
    let security_headers = headers::headers_for_path(&path, is_dev, request_origin);

    let mut builder = Response::builder()
        .status(200)
        .header("Content-Type", mime_type);

    for (key, value) in &security_headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    builder
        .body(asset.bytes().to_vec())
        .map_err(|e| ProtocolError::Internal(format!("failed to build response: {e}")))
}

/// Build a minimal error response with CORS headers.
///
/// CORS headers are required even on error responses, otherwise WKWebView's
/// fetch() will report "Load failed" instead of the actual status code.
fn error_response(status: u16, body: &[u8], request_origin: Option<&str>) -> Response<Vec<u8>> {
    // Use the same CORS origin resolution as success responses
    let dummy_path = std::path::PathBuf::from("error");
    let cors_headers = headers::headers_for_path(&dummy_path, false, request_origin);
    let cors_origin = cors_headers
        .iter()
        .find(|(k, _)| k == "Access-Control-Allow-Origin")
        .map(|(_, v)| v.as_str())
        .unwrap_or("tauri://localhost");

    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Access-Control-Allow-Origin", cors_origin)
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

        let result = serve_file(&state, &uri, None);
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
        let result = serve_file(&state, uri, None);

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

        let resp = serve_file(&state, &uri, None).unwrap();
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
    fn serve_file_with_dev_origin_cors() {
        let tmp = std::env::temp_dir().join("vscodee_proto_cors");
        let _ = fs::create_dir_all(&tmp);
        let file = tmp.join("app.js");
        fs::write(&file, b"export {};").unwrap();

        let state = test_state_with_root(&tmp);
        let uri = format!(
            "vscode-file://vscode-app{}",
            file.canonicalize().unwrap().display()
        );

        let resp = serve_file(&state, &uri, Some("http://127.0.0.1:1430")).unwrap();
        let cors = resp
            .headers()
            .get("Access-Control-Allow-Origin")
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(cors, "http://127.0.0.1:1430");

        let _ = fs::remove_file(&file);
        let _ = fs::remove_dir(&tmp);
    }

    #[test]
    fn error_response_includes_content_type() {
        let resp = error_response(404, b"Not Found", None);
        assert_eq!(resp.status(), 404);
        let ct = resp
            .headers()
            .get("Content-Type")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ct.contains("text/plain"));
    }

    #[test]
    fn error_response_uses_request_origin_for_cors() {
        let resp = error_response(403, b"Forbidden", Some("http://127.0.0.1:1430"));
        let cors = resp
            .headers()
            .get("Access-Control-Allow-Origin")
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(cors, "http://127.0.0.1:1430");
    }

    // ── extract_asset_key tests ──

    #[test]
    fn extract_asset_key_from_typical_path() {
        let path = "/Users/foo/work/vscodeee/out/vs/code/foo.js";
        assert_eq!(extract_asset_key(path), Some("vs/code/foo.js"));
    }

    #[test]
    fn extract_asset_key_from_production_path() {
        let path = "/Applications/VS Codeee.app/Contents/Resources/out/vs/base/common/lifecycle.js";
        assert_eq!(extract_asset_key(path), Some("vs/base/common/lifecycle.js"));
    }

    #[test]
    fn extract_asset_key_bootstrap_fork() {
        let path = "/some/path/out/bootstrap-fork.js";
        assert_eq!(extract_asset_key(path), Some("bootstrap-fork.js"));
    }

    #[test]
    fn extract_asset_key_uses_last_out_segment() {
        // If path contains multiple /out/ segments, use the last one
        let path = "/checkout/out/build/out/vs/code/foo.js";
        assert_eq!(extract_asset_key(path), Some("vs/code/foo.js"));
    }

    #[test]
    fn extract_asset_key_no_out_segment() {
        let path = "/Users/foo/work/vscodeee/src/vs/code/foo.js";
        assert_eq!(extract_asset_key(path), None);
    }

    #[test]
    fn extract_asset_key_out_at_end() {
        // "/out/" at end with nothing after it
        let path = "/some/path/out/";
        assert_eq!(extract_asset_key(path), None);
    }

    #[test]
    fn extract_asset_key_html_with_query() {
        // Query should already be stripped by URI parser, but test the key extraction
        let path = "/some/path/out/vs/code/tauri-browser/workbench/workbench-tauri.html";
        assert_eq!(
            extract_asset_key(path),
            Some("vs/code/tauri-browser/workbench/workbench-tauri.html")
        );
    }
}
