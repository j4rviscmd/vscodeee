/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! MIME type resolution for protocol responses.
//!
//! Maps file extensions to Content-Type values for the resources VS Code
//! typically loads: HTML, JavaScript, CSS, JSON, images, fonts, and Wasm.

use std::path::Path;

/// Resolve a MIME type from a file path's extension.
///
/// Returns `"application/octet-stream"` for unknown extensions.
pub fn mime_from_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("webp") => "image/webp",
        Some("mp4") => "video/mp4",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("map") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn text_types_include_charset() {
        assert!(mime_from_path(&PathBuf::from("index.html")).contains("charset=utf-8"));
        assert!(mime_from_path(&PathBuf::from("app.js")).contains("charset=utf-8"));
        assert!(mime_from_path(&PathBuf::from("style.css")).contains("charset=utf-8"));
        assert!(mime_from_path(&PathBuf::from("data.json")).contains("charset=utf-8"));
    }

    #[test]
    fn image_types() {
        assert_eq!(mime_from_path(&PathBuf::from("logo.png")), "image/png");
        assert_eq!(mime_from_path(&PathBuf::from("photo.jpg")), "image/jpeg");
        assert_eq!(mime_from_path(&PathBuf::from("photo.jpeg")), "image/jpeg");
        assert_eq!(mime_from_path(&PathBuf::from("icon.gif")), "image/gif");
        assert_eq!(mime_from_path(&PathBuf::from("icon.svg")), "image/svg+xml");
        assert_eq!(mime_from_path(&PathBuf::from("banner.bmp")), "image/bmp");
        assert_eq!(mime_from_path(&PathBuf::from("hero.webp")), "image/webp");
    }

    #[test]
    fn font_types() {
        assert_eq!(mime_from_path(&PathBuf::from("font.woff")), "font/woff");
        assert_eq!(mime_from_path(&PathBuf::from("font.woff2")), "font/woff2");
        assert_eq!(mime_from_path(&PathBuf::from("font.ttf")), "font/ttf");
        assert_eq!(mime_from_path(&PathBuf::from("font.otf")), "font/otf");
    }

    #[test]
    fn special_types() {
        assert_eq!(
            mime_from_path(&PathBuf::from("module.wasm")),
            "application/wasm"
        );
        assert_eq!(mime_from_path(&PathBuf::from("video.mp4")), "video/mp4");
    }

    #[test]
    fn unknown_extension_falls_back() {
        assert_eq!(
            mime_from_path(&PathBuf::from("file.xyz")),
            "application/octet-stream"
        );
        assert_eq!(
            mime_from_path(&PathBuf::from("noext")),
            "application/octet-stream"
        );
    }

    #[test]
    fn source_map_is_json() {
        assert!(mime_from_path(&PathBuf::from("app.js.map")).contains("application/json"));
    }

    #[test]
    fn mjs_is_javascript() {
        assert!(mime_from_path(&PathBuf::from("worker.mjs")).contains("application/javascript"));
    }
}
