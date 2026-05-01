/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Security headers for `vscode-file://` protocol responses.
//!
//! Mirrors the headers applied by Electron's `ProtocolMainService`:
//! - **CORS**: Allow the requesting origin to access resources (validated against allow-list).
//! - **COOP/COEP**: Cross-Origin Isolation for workbench HTML (SharedArrayBuffer).
//! - **Cache-Control**: Disable caching in development builds.
//! - **Document-Policy**: Enable JS callstack collection for crash reports.

use std::path::Path;

/// CORS origins allowed to access `vscode-file://` resources.
///
/// - `tauri://localhost` — Default Tauri origin on macOS/Linux (production builds).
/// - `https://tauri.localhost` — Default Tauri origin on Windows.
/// - `http://127.0.0.1` — Dev server origin (port varies, checked by prefix).
/// - `http://localhost` — Alternative dev server origin.
const ALLOWED_ORIGIN_PREFIXES: &[&str] = &[
    "tauri://localhost",
    "https://tauri.localhost",
    "http://127.0.0.1",
    "http://localhost",
];

/// HTTP header key-value pair (owned strings to support dynamic CORS origins).
pub type Header = (String, String);

/// Check whether a request origin is allowed for CORS.
///
/// Returns the origin string to use in `Access-Control-Allow-Origin` if allowed,
/// or the default `tauri://localhost` if the origin is absent or not recognized.
pub(crate) fn resolve_cors_origin(request_origin: Option<&str>) -> &str {
    let origin = match request_origin {
        Some(origin) => origin,
        None => return "tauri://localhost",
    };

    for prefix in ALLOWED_ORIGIN_PREFIXES {
        if origin == *prefix || origin.starts_with(&format!("{prefix}:")) {
            return origin;
        }
    }

    // Unknown origin — fall back to default (won't match, effectively denying CORS)
    "tauri://localhost"
}

/// Compute the security headers for a given file path.
///
/// The returned headers vary based on:
/// - The request's `Origin` header (determines CORS `Access-Control-Allow-Origin`)
/// - Whether the file is a workbench HTML entry point (gets COOP/COEP + Document-Policy)
/// - Whether this is a development build (gets Cache-Control: no-cache)
///
/// All responses get CORS headers allowing validated origins.
pub fn headers_for_path(path: &Path, request_origin: Option<&str>) -> Vec<Header> {
    let mut headers = Vec::with_capacity(6);

    // Always add CORS with the resolved origin
    let cors_origin = resolve_cors_origin(request_origin);
    headers.push((
        "Access-Control-Allow-Origin".to_string(),
        cors_origin.to_string(),
    ));

    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let is_workbench_html = filename == "workbench.html"
        || filename == "workbench-dev.html"
        || filename == "workbench-tauri.html"
        || filename == "index.html";

    // Workbench HTML headers: COOP + COEP (enables SharedArrayBuffer)
    // and Document-Policy (JS callstack collection for crash reports)
    if is_workbench_html {
        headers.push((
            "Cross-Origin-Opener-Policy".to_string(),
            "same-origin".to_string(),
        ));
        headers.push((
            "Cross-Origin-Embedder-Policy".to_string(),
            "require-corp".to_string(),
        ));
        headers.push((
            "Document-Policy".to_string(),
            "include-js-call-stacks-in-crash-reports".to_string(),
        ));
    }

    // Cache-Control: static assets (JS/CSS/etc.) are immutable per build
    // and MUST be cached to avoid flooding WKWebView's main thread with
    // hundreds of response deliveries through the custom protocol handler.
    // HTML entry points use no-cache to ensure the latest workbench is loaded.
    if is_workbench_html {
        headers.push((
            "Cache-Control".to_string(),
            "no-cache, no-store".to_string(),
        ));
    } else {
        headers.push(("Cache-Control".to_string(), "max-age=604800".to_string()));
    }

    headers
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn header_map(headers: &[Header]) -> HashMap<&str, &str> {
        headers
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect()
    }

    #[test]
    fn always_includes_cors() {
        let path = PathBuf::from("/app/out/vs/base/style.css");
        let headers = headers_for_path(&path, None);
        let map = header_map(&headers);
        assert_eq!(
            map.get("Access-Control-Allow-Origin"),
            Some(&"tauri://localhost")
        );
    }

    #[test]
    fn cors_echoes_allowed_dev_origin() {
        let path = PathBuf::from("/app/out/vs/base/style.css");
        let headers = headers_for_path(&path, Some("http://127.0.0.1:1430"));
        let map = header_map(&headers);
        assert_eq!(
            map.get("Access-Control-Allow-Origin"),
            Some(&"http://127.0.0.1:1430")
        );
    }

    #[test]
    fn cors_echoes_localhost_dev_origin() {
        let path = PathBuf::from("/app/out/vs/base/style.css");
        let headers = headers_for_path(&path, Some("http://localhost:5173"));
        let map = header_map(&headers);
        assert_eq!(
            map.get("Access-Control-Allow-Origin"),
            Some(&"http://localhost:5173")
        );
    }

    #[test]
    fn cors_rejects_unknown_origin() {
        let path = PathBuf::from("/app/out/vs/base/style.css");
        let headers = headers_for_path(&path, Some("https://evil.example.com"));
        let map = header_map(&headers);
        // Falls back to tauri://localhost (won't match the attacker's origin)
        assert_eq!(
            map.get("Access-Control-Allow-Origin"),
            Some(&"tauri://localhost")
        );
    }

    #[test]
    fn cors_echoes_tauri_origin() {
        let path = PathBuf::from("/app/out/vs/base/style.css");
        let headers = headers_for_path(&path, Some("tauri://localhost"));
        let map = header_map(&headers);
        assert_eq!(
            map.get("Access-Control-Allow-Origin"),
            Some(&"tauri://localhost")
        );
    }

    #[test]
    fn workbench_html_gets_coop_coep() {
        let path = PathBuf::from("/app/out/vs/workbench/workbench.html");
        let headers = headers_for_path(&path, None);
        let map = header_map(&headers);

        assert_eq!(map.get("Cross-Origin-Opener-Policy"), Some(&"same-origin"));
        assert_eq!(
            map.get("Cross-Origin-Embedder-Policy"),
            Some(&"require-corp")
        );
        assert_eq!(
            map.get("Document-Policy"),
            Some(&"include-js-call-stacks-in-crash-reports")
        );
    }

    #[test]
    fn non_workbench_file_no_coop_coep() {
        let path = PathBuf::from("/app/out/vs/editor/editor.main.js");
        let headers = headers_for_path(&path, None);
        let map = header_map(&headers);

        assert!(!map.contains_key("Cross-Origin-Opener-Policy"));
        assert!(!map.contains_key("Cross-Origin-Embedder-Policy"));
        assert!(!map.contains_key("Document-Policy"));
    }

    #[test]
    fn js_gets_long_cache() {
        let path = PathBuf::from("/app/out/vs/base/common/network.js");
        let headers = headers_for_path(&path, None);
        let map = header_map(&headers);
        assert_eq!(map.get("Cache-Control"), Some(&"max-age=604800"));
    }

    #[test]
    fn html_gets_no_cache() {
        let path = PathBuf::from("/app/out/vs/code/browser/workbench/workbench.html");
        let headers = headers_for_path(&path, None);
        let map = header_map(&headers);
        assert_eq!(map.get("Cache-Control"), Some(&"no-cache, no-store"));
    }

    #[test]
    fn index_html_treated_as_workbench() {
        let path = PathBuf::from("/app/workbench/index.html");
        let headers = headers_for_path(&path, None);
        let map = header_map(&headers);
        assert!(map.contains_key("Cross-Origin-Opener-Policy"));
    }
}
