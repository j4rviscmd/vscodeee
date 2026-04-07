/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Custom protocol handlers for VS Code's internal URI schemes.
//!
//! VS Code uses custom protocols to securely load resources:
//! - `vscode-file://` — loads local files with path validation
//! - `vscode-webview://` — loads webview resources (future phase)

use std::path::{Path, PathBuf};
use tauri::http::{Request, Response};
use tauri::UriSchemeContext;

/// Handle `vscode-file://vscode-app/<path>` requests.
///
/// This replaces Electron's `protocol.registerFileProtocol` and the
/// `ProtocolMainService` that validates file access. All paths are
/// validated against the app's base directory to prevent path traversal.
pub fn handle_vscode_file_protocol<R: tauri::Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();

    // Parse: vscode-file://vscode-app/<absolute-path>
    let raw_path = uri.strip_prefix("vscode-file://vscode-app").unwrap_or("");

    if raw_path.is_empty() {
        return error_response(400, b"Bad Request: empty path");
    }

    let file_path = PathBuf::from(raw_path);

    // Security: validate that the resolved path is within the allowed base directory.
    // In the full implementation this will be the app's resource directory;
    // for Phase 0 PoC we use the current working directory.
    let base_dir = match std::env::current_dir() {
        Ok(d) => d,
        Err(_) => return error_response(500, b"Internal Server Error"),
    };

    let canonical = match base_dir
        .join(file_path.strip_prefix("/").unwrap_or(&file_path))
        .canonicalize()
    {
        Ok(p) => p,
        Err(_) => return error_response(404, b"Not Found"),
    };

    if !canonical.starts_with(&base_dir) {
        return error_response(403, b"Forbidden: path traversal detected");
    }

    match std::fs::read(&canonical) {
        Ok(content) => {
            let mime = mime_from_path(&canonical);
            Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "tauri://localhost")
                .body(content)
                .unwrap_or_else(|_| error_response(500, b"Internal Server Error"))
        }
        Err(_) => error_response(404, b"Not Found"),
    }
}

/// 指定されたHTTPステータスコードとボディでエラーレスポンスを構築する。
///
/// # Arguments
///
/// * `status` - HTTPステータスコード (例: `400`, `403`, `404`, `500`)
/// * `body` - レスポンスボディのバイト列
///
/// # Returns
///
/// 構築された [`Response`]。
fn error_response(status: u16, body: &[u8]) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(body.to_vec())
        .unwrap()
}

/// ファイルパスの拡張子からMIMEタイプを推定する。
///
/// Web系リソース (HTML, JS, CSS, JSON, 画像, フォント, WASM) に対応し、
/// 一致しない場合は `"application/octet-stream"` をフォールバックとして返す。
///
/// # Arguments
///
/// * `path` - MIMEタイプを判定するファイルパス
///
/// # Returns
///
/// 拡張子に対応するMIMEタイプ文字列。
fn mime_from_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html",
        Some("js") | Some("mjs") => "application/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}
