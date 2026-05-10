/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Application menu setup for macOS.
//!
//! Creates a native menu bar that replaces Tauri's default with a custom
//! "About" item that triggers the VS Code About dialog instead of the
//! system's minimal version-only dialog.

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter};

/// Menu item ID for the custom About entry.
const ABOUT_MENU_ID: &str = "about-vscode-dialog";

/// Build and install the application menu (macOS only).
///
/// On macOS the first submenu becomes the "application menu" (app name in
/// the menu bar). We keep the standard items (Services, Hide, Quit) but
/// replace the default About with a custom entry that emits a Tauri event
/// so the WebView can show the VS Code About dialog.
///
/// On Windows/Linux the native menu is not created because its predefined
/// items (cut, copy, paste, etc.) register keyboard accelerators that
/// intercept keystrokes before they reach the WebView. In particular,
/// `paste()` calls `document.execCommand('paste')` which WebView2 blocks
/// for security, making Ctrl+V silently fail.
pub fn setup(_app: &tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let app_submenu = SubmenuBuilder::new(app, "VS Codeee")
            .item(&MenuItem::with_id(
                app,
                ABOUT_MENU_ID,
                "About VS Codeee",
                true,
                None::<&str>,
            )?)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        let edit_submenu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let view_submenu = SubmenuBuilder::new(app, "View")
            .text("toggle-devtools", "Toggle Developer Tools")
            .build()?;

        let window_submenu = SubmenuBuilder::new(app, "Window")
            .minimize()
            .separator()
            .close_window()
            .build()?;

        let help_submenu = SubmenuBuilder::new(app, "Help")
            .text("documentation", "Documentation")
            .build()?;

        let menu = MenuBuilder::new(app)
            .item(&app_submenu)
            .item(&edit_submenu)
            .item(&view_submenu)
            .item(&window_submenu)
            .item(&help_submenu)
            .build()?;

        app.set_menu(menu)?;
    }

    Ok(())
}

/// Handle menu item click events.
///
/// For the custom About entry, emits `show-about-dialog` to all WebView
/// windows so the TypeScript side can open the VS Code About dialog.
pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        ABOUT_MENU_ID => {
            if let Err(e) = app.emit("show-about-dialog", ()) {
                log::warn!(target: "vscodeee::menu", "Failed to emit show-about-dialog: {e}");
            }
        }
        id => {
            log::trace!(target: "vscodeee::menu", "Unhandled menu event: {id}");
        }
    }
}
