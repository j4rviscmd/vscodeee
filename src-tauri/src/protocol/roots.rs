/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Valid root management for `vscode-file://` protocol security.
//!
//! Mirrors Electron's `ProtocolMainService` validation strategy:
//! 1. Check if the requested path falls under any registered valid root.
//! 2. If not, check if the file has an allowed extension (image/font whitelist).
//! 3. Otherwise, deny access.
//!
//! Thread-safe via [`RwLock`] so roots can be added dynamically at runtime
//! (e.g. when extensions are installed or workspaces are opened).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Thread-safe registry of allowed file system roots and extensions.
///
/// A path is considered allowed if:
/// - It is a descendant of any registered root, OR
/// - Its extension is in the allowed set (image/font fallback from Electron).
pub struct ValidRoots {
    /// Registered root directories. Paths checked via prefix matching
    /// after canonicalization.
    roots: RwLock<Vec<PathBuf>>,

    /// Allowed extensions for the fallback check (lowercase, with leading dot).
    /// Mirrors Electron's `validExtensions` set:
    /// <https://github.com/microsoft/vscode/issues/119384>
    allowed_extensions: HashSet<&'static str>,
}

impl ValidRoots {
    /// Create a new `ValidRoots` with the Electron-compatible extension whitelist.
    pub fn new() -> Self {
        Self {
            roots: RwLock::new(Vec::new()),
            allowed_extensions: [
                ".svg", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".mp4", ".otf", ".ttf",
            ]
            .into_iter()
            .collect(),
        }
    }

    /// Register a root directory. The path is canonicalized before storage.
    ///
    /// Duplicate roots are silently ignored.
    pub fn add_root(&self, path: &Path) {
        let canonical = match path.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "[protocol] Warning: could not canonicalize root {}: {e}",
                    path.display()
                );
                return;
            }
        };

        let mut roots = self.roots.write().expect("ValidRoots lock poisoned");
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }

    /// Remove a previously registered root.
    #[allow(dead_code)]
    pub fn remove_root(&self, path: &Path) {
        if let Ok(canonical) = path.canonicalize() {
            let mut roots = self.roots.write().expect("ValidRoots lock poisoned");
            roots.retain(|r| r != &canonical);
        }
    }

    /// Check whether the given canonical path is allowed.
    ///
    /// Returns `true` if:
    /// 1. The path is under a registered root, OR
    /// 2. The file extension is in the allowed set.
    pub fn is_path_allowed(&self, canonical_path: &Path) -> bool {
        // Check roots (prefix match)
        {
            let roots = self.roots.read().expect("ValidRoots lock poisoned");
            for root in roots.iter() {
                if canonical_path.starts_with(root) {
                    return true;
                }
            }
        }

        // Fallback: check extension whitelist
        if let Some(ext) = canonical_path.extension().and_then(|e| e.to_str()) {
            let dotted = format!(".{}", ext.to_lowercase());
            if self.allowed_extensions.contains(dotted.as_str()) {
                return true;
            }
        }

        false
    }

    /// Return the number of registered roots (for diagnostics).
    pub fn root_count(&self) -> usize {
        self.roots.read().expect("ValidRoots lock poisoned").len()
    }
}

/// Creates a [`ValidRoots`] with the default Electron-compatible extension whitelist.
///
/// Equivalent to calling [`ValidRoots::new()`].
impl Default for ValidRoots {
    fn default() -> Self {
        Self::new()
    }
}

// SAFETY: RwLock<Vec<PathBuf>> is Send+Sync, HashSet<&'static str> is Send+Sync.
// ValidRoots is safely shareable across threads via Arc<ValidRoots>.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn add_and_check_root() {
        let tmp = std::env::temp_dir();
        let roots = ValidRoots::new();
        roots.add_root(&tmp);

        let child = tmp.join("some_file.txt");
        // Create the file so canonicalize works
        let _ = fs::write(&child, b"test");
        let canonical = child.canonicalize().unwrap();

        assert!(roots.is_path_allowed(&canonical));
        let _ = fs::remove_file(&child);
    }

    #[test]
    fn reject_path_outside_roots() {
        let roots = ValidRoots::new();
        roots.add_root(&std::env::temp_dir());

        // /usr/bin is not under /tmp
        let outside = PathBuf::from("/usr/bin/env");
        if outside.exists() {
            let canonical = outside.canonicalize().unwrap();
            // "env" has no allowed extension, and /usr/bin is not a root
            assert!(!roots.is_path_allowed(&canonical));
        }
    }

    #[test]
    fn extension_whitelist_fallback() {
        let roots = ValidRoots::new();
        // No roots registered at all

        // .png is in the whitelist
        let png_path = PathBuf::from("/some/where/icon.png");
        assert!(roots.is_path_allowed(&png_path));

        // .svg is also allowed
        let svg_path = PathBuf::from("/some/where/logo.svg");
        assert!(roots.is_path_allowed(&svg_path));

        // .js is NOT in the whitelist
        let js_path = PathBuf::from("/some/where/script.js");
        assert!(!roots.is_path_allowed(&js_path));
    }

    #[test]
    fn extension_check_is_case_insensitive() {
        let roots = ValidRoots::new();
        let upper = PathBuf::from("/icon.PNG");
        assert!(roots.is_path_allowed(&upper));
    }

    #[test]
    fn remove_root_works() {
        let tmp = std::env::temp_dir();
        let roots = ValidRoots::new();
        roots.add_root(&tmp);
        assert_eq!(roots.root_count(), 1);

        roots.remove_root(&tmp);
        assert_eq!(roots.root_count(), 0);
    }

    #[test]
    fn duplicate_roots_ignored() {
        let tmp = std::env::temp_dir();
        let roots = ValidRoots::new();
        roots.add_root(&tmp);
        roots.add_root(&tmp);
        assert_eq!(roots.root_count(), 1);
    }
}
