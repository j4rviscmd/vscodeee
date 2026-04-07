/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Security headers for `vscode-file://` protocol responses.
//!
//! Mirrors the headers applied by Electron's `ProtocolMainService`:
//! - **CORS**: Allow the Tauri origin to access resources.
//! - **COOP/COEP**: Cross-Origin Isolation for workbench HTML (SharedArrayBuffer).
//! - **Cache-Control**: Disable caching in development builds.
//! - **Document-Policy**: Enable JS callstack collection for crash reports.

use std::path::Path;

/// CORS origin for Tauri WebView requests.
///
/// Tauri uses `tauri://localhost` as the default origin on macOS/Linux and
/// `https://tauri.localhost` on Windows. We allow both via a wildcard in
/// development; in production this should be restricted.
const TAURI_ORIGIN: &str = "tauri://localhost";

/// HTTP header key-value pair.
pub type Header = (&'static str, &'static str);

/// Compute the security headers for a given file path.
///
/// The returned headers vary based on:
/// - Whether the file is a workbench HTML entry point (gets COOP/COEP + Document-Policy)
/// - Whether this is a development build (gets Cache-Control: no-cache)
///
/// All responses get CORS headers allowing the Tauri origin.
pub fn headers_for_path(path: &Path, is_dev_build: bool) -> Vec<Header> {
    let mut headers = Vec::with_capacity(6);

    // Always add CORS
    headers.push(("Access-Control-Allow-Origin", TAURI_ORIGIN));

    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let is_workbench_html = filename == "workbench.html"
        || filename == "workbench-dev.html"
        || filename == "index.html";

    // COOP + COEP for workbench HTML (enables SharedArrayBuffer)
    if is_workbench_html {
        headers.push(("Cross-Origin-Opener-Policy", "same-origin"));
        headers.push(("Cross-Origin-Embedder-Policy", "require-corp"));
    }

    // Document-Policy for workbench HTML (JS callstack collection)
    if is_workbench_html {
        headers.push(("Document-Policy", "include-js-call-stacks-in-crash-reports"));
    }

    // Cache-Control for dev builds
    if is_dev_build {
        headers.push(("Cache-Control", "no-cache, no-store"));
    }

    headers
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn header_map(headers: &[Header]) -> std::collections::HashMap<&str, &str> {
        headers.iter().copied().collect()
    }

    #[test]
    fn always_includes_cors() {
        let path = PathBuf::from("/app/out/vs/base/style.css");
        let headers = headers_for_path(&path, false);
        let map = header_map(&headers);
        assert_eq!(map.get("Access-Control-Allow-Origin"), Some(&TAURI_ORIGIN));
    }

    #[test]
    fn workbench_html_gets_coop_coep() {
        let path = PathBuf::from("/app/out/vs/workbench/workbench.html");
        let headers = headers_for_path(&path, false);
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
        let headers = headers_for_path(&path, false);
        let map = header_map(&headers);

        assert!(!map.contains_key("Cross-Origin-Opener-Policy"));
        assert!(!map.contains_key("Cross-Origin-Embedder-Policy"));
        assert!(!map.contains_key("Document-Policy"));
    }

    #[test]
    fn dev_build_gets_cache_control() {
        let path = PathBuf::from("/app/out/vs/base/common/network.js");
        let headers = headers_for_path(&path, true);
        let map = header_map(&headers);
        assert_eq!(map.get("Cache-Control"), Some(&"no-cache, no-store"));
    }

    #[test]
    fn production_build_no_cache_control() {
        let path = PathBuf::from("/app/out/vs/base/common/network.js");
        let headers = headers_for_path(&path, false);
        let map = header_map(&headers);
        assert!(!map.contains_key("Cache-Control"));
    }

    #[test]
    fn index_html_treated_as_workbench() {
        let path = PathBuf::from("/app/workbench/index.html");
        let headers = headers_for_path(&path, false);
        let map = header_map(&headers);
        assert!(map.contains_key("Cross-Origin-Opener-Policy"));
    }
}
