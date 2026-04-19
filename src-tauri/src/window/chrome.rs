/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Single source of truth for window decoration/chrome settings.
//!
//! All window creation sites (initial, dynamic, restored) must use
//! [`WindowChromeConfig::for_platform`] to ensure consistent behavior
//! across the application.

use tauri::{Manager, WebviewWindowBuilder};

/// Platform-specific window chrome configuration.
///
/// On macOS, the native window frame is kept with an overlay title bar
/// to preserve traffic lights and rounded corners. On other platforms,
/// decorations are disabled in favor of a custom HTML title bar.
pub struct WindowChromeConfig {
    /// Whether to show the native window frame.
    pub decorations: bool,
    /// The title bar style (macOS only).
    pub title_bar_style: Option<tauri::TitleBarStyle>,
    /// Whether to hide the native title text (macOS only).
    pub hidden_title: bool,
}

impl WindowChromeConfig {
    /// Derive the correct chrome configuration for the current platform.
    ///
    /// Matches the `tauri.conf.json` settings for the initial window:
    /// - **macOS**: `decorations: true`, `titleBarStyle: Overlay`, `hiddenTitle: true`
    /// - **Other**: `decorations: false`, no title bar overrides
    pub fn for_platform() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                decorations: true,
                title_bar_style: Some(tauri::TitleBarStyle::Overlay),
                hidden_title: true,
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            Self {
                decorations: false,
                title_bar_style: None,
                hidden_title: false,
            }
        }
    }

    /// Apply this configuration to a [`WebviewWindowBuilder`].
    pub fn apply_to_builder<'a, R: tauri::Runtime, M: Manager<R>>(
        self,
        builder: WebviewWindowBuilder<'a, R, M>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        let builder = builder.decorations(self.decorations);

        #[cfg(target_os = "macos")]
        let builder = {
            let builder = if let Some(style) = self.title_bar_style {
                builder.title_bar_style(style)
            } else {
                builder
            };
            builder.hidden_title(self.hidden_title)
        };

        #[cfg(not(target_os = "macos"))]
        let builder = builder;

        builder
    }
}
