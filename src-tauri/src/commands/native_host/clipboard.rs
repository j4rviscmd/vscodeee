/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Clipboard commands — text, buffer (binary), find-board, image, and paste.

use super::error::NativeHostError;

// ─── Existing commands (moved from native_host.rs) ──────────────────────

/// Read text from the system clipboard.
///
/// Returns an empty string if the clipboard contains no text
/// (e.g. only an image) instead of propagating the error.
#[tauri::command]
pub fn read_clipboard_text(app: tauri::AppHandle) -> Result<String, NativeHostError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    Ok(app.clipboard().read_text().unwrap_or_default())
}

/// Write text to the system clipboard.
#[tauri::command]
pub fn write_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), NativeHostError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| NativeHostError::Clipboard(e.to_string()))
}

// ─── New commands ───────────────────────────────────────────────────────

/// Write a binary buffer to the clipboard in a named format.
///
/// The buffer is received as base64-encoded data from TypeScript,
/// decoded into bytes, and stored. Currently stores as text (base64).
#[tauri::command]
pub fn write_clipboard_buffer(
    app: tauri::AppHandle,
    _format: String,
    buffer: String,
) -> Result<(), NativeHostError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    // Store the base64-encoded buffer as text — native format support
    // would require platform-specific clipboard APIs not exposed by the plugin.
    app.clipboard()
        .write_text(buffer)
        .map_err(|e| NativeHostError::Clipboard(e.to_string()))
}

/// Read a binary buffer from the clipboard in a named format.
///
/// Returns the clipboard content as a base64-encoded string.
/// The TypeScript side decodes it back into a VSBuffer.
#[tauri::command]
pub fn read_clipboard_buffer(
    app: tauri::AppHandle,
    _format: String,
) -> Result<String, NativeHostError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|e| NativeHostError::Clipboard(e.to_string()))
}

/// Check whether the clipboard contains data in the given format.
///
/// Currently only checks if the clipboard has any text content.
#[tauri::command]
pub fn has_clipboard(app: tauri::AppHandle, _format: String) -> Result<bool, NativeHostError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    Ok(app.clipboard().read_text().is_ok_and(|t| !t.is_empty()))
}

/// Read the macOS "Find" pasteboard text.
///
/// On macOS, this reads from `NSPasteboard(name: .find)`.
/// On other platforms, returns an empty string (no equivalent).
#[tauri::command]
pub fn read_clipboard_find_text() -> String {
    #[cfg(target_os = "macos")]
    {
        macos_read_find_pasteboard().unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        String::new()
    }
}

/// Write to the macOS "Find" pasteboard.
///
/// On macOS, this writes to `NSPasteboard(name: .find)`.
/// On other platforms, this is a no-op.
#[tauri::command]
pub fn write_clipboard_find_text(text: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = macos_write_find_pasteboard(&text);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
    }
}

/// Read an image from the clipboard as PNG bytes (base64-encoded).
///
/// Converts the raw RGBA pixel data from arboard into a proper PNG
/// file so that consumers receive format-encoded bytes (matching the
/// contract of BrowserClipboardService.readImage).
/// Returns an empty string if no image is available.
#[tauri::command]
pub fn read_clipboard_image(app: tauri::AppHandle) -> Result<String, NativeHostError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    match app.clipboard().read_image() {
        Ok(image_data) => {
            let img_buffer = image::RgbaImage::from_raw(
                image_data.width(),
                image_data.height(),
                image_data.rgba().to_vec(),
            )
            .ok_or_else(|| NativeHostError::Other("Invalid image dimensions".to_string()))?;

            let mut png_bytes = Vec::new();
            img_buffer
                .write_to(
                    &mut std::io::Cursor::new(&mut png_bytes),
                    image::ImageFormat::Png,
                )
                .map_err(|e| NativeHostError::Other(format!("PNG encode failed: {e}")))?;

            Ok(base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                &png_bytes,
            ))
        }
        Err(_) => Ok(String::new()),
    }
}

/// Check whether the clipboard currently contains an image.
#[tauri::command]
pub fn has_clipboard_image(app: tauri::AppHandle) -> Result<bool, NativeHostError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    Ok(app.clipboard().read_image().is_ok())
}

/// Trigger a paste operation by synthesizing Cmd+V / Ctrl+V.
///
/// This is security-sensitive — it simulates keyboard input.
/// - macOS: Uses AppleScript via System Events
/// - Windows: Uses SendInput API (no external process)
/// - Linux: Uses xdotool (if available)
#[tauri::command]
pub async fn trigger_paste() -> Result<(), NativeHostError> {
    #[cfg(target_os = "macos")]
    {
        macos_trigger_paste()
    }
    #[cfg(target_os = "windows")]
    {
        windows_trigger_paste()
    }
    #[cfg(target_os = "linux")]
    {
        linux_trigger_paste()
    }
}

// ─── Platform-specific helpers ──────────────────────────────────────────

/// Read text from the macOS "Find" pasteboard using `pbpaste -pboard find`.
///
/// Returns `Some(text)` if the pasteboard contains text, `None` on failure
/// or if the pasteboard is empty.
#[cfg(target_os = "macos")]
fn macos_read_find_pasteboard() -> Option<String> {
    use std::process::Command;
    let output = Command::new("pbpaste")
        .args(["-pboard", "find"])
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        None
    }
}

/// Write text to the macOS "Find" pasteboard using `pbcopy -pboard find`.
///
/// Pipes the given `text` to `pbcopy` via stdin so that the "Find" pasteboard
/// is updated with the new search string.
#[cfg(target_os = "macos")]
fn macos_write_find_pasteboard(text: &str) -> Result<(), NativeHostError> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("pbcopy")
        .args(["-pboard", "find"])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| NativeHostError::Other(format!("Failed to spawn pbcopy: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| NativeHostError::Other(format!("Failed to write to pbcopy: {e}")))?;
    }
    child
        .wait()
        .map_err(|e| NativeHostError::Other(format!("pbcopy failed: {e}")))?;
    Ok(())
}

/// Simulate a paste (Cmd+V) on macOS via AppleScript.
///
/// Uses `osascript` to ask System Events to keystroke "v" with the command
/// modifier held down. This triggers a native paste in whichever application
/// currently has focus.
#[cfg(target_os = "macos")]
fn macos_trigger_paste() -> Result<(), NativeHostError> {
    use std::process::Command;
    // Use osascript to trigger Cmd+V via System Events
    let script = r#"tell application "System Events" to keystroke "v" using command down"#;
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| NativeHostError::Other(format!("Failed to trigger paste: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(NativeHostError::Other(format!(
            "Failed to trigger paste: {stderr}"
        )));
    }
    Ok(())
}

/// Simulate a paste (Ctrl+V) on Windows via the Win32 `SendInput` API.
///
/// Synthesizes Ctrl key down → V key down → V key up → Ctrl key up using
/// the native `SendInput` function from `user32.dll`. This triggers the
/// browser's paste pipeline in the focused WebView2 window without spawning
/// any external processes.
#[cfg(target_os = "windows")]
fn windows_trigger_paste() -> Result<(), NativeHostError> {
    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const VK_CONTROL: u16 = 0x11;
    const VK_V: u16 = 0x56;

    /// Win32 `KEYBDINPUT` structure — describes a simulated keyboard event.
    #[repr(C)]
    struct KeybdInput {
        w_vk: u16,
        w_scan: u16,
        dw_flags: u32,
        time: u32,
        dw_extra_info: usize,
    }

    /// Win32 `INPUT` structure for keyboard events.
    ///
    /// `MOUSEINPUT` (the largest union member) is 8 bytes larger than
    /// `KEYBDINPUT` on both 32-bit and 64-bit Windows. This padding ensures
    /// the struct matches the Win32 `INPUT` layout when passed to `SendInput`.
    #[repr(C)]
    struct Input {
        type_: u32,
        ki: KeybdInput,
        _padding: [u8; 8],
    }

    extern "system" {
        /// Win32 `SendInput` — sends a sequence of simulated input events.
        fn SendInput(c_inputs: u32, p_inputs: *const Input, cb_size: i32) -> u32;
    }

    /// Create a key-down input event for the given virtual-key code.
    let key_down = |vk: u16| Input {
        type_: INPUT_KEYBOARD,
        ki: KeybdInput {
            w_vk: vk,
            w_scan: 0,
            dw_flags: 0,
            time: 0,
            dw_extra_info: 0,
        },
        _padding: [0; 8],
    };
    /// Create a key-up input event for the given virtual-key code.
    let key_up = |vk: u16| Input {
        type_: INPUT_KEYBOARD,
        ki: KeybdInput {
            w_vk: vk,
            w_scan: 0,
            dw_flags: KEYEVENTF_KEYUP,
            time: 0,
            dw_extra_info: 0,
        },
        _padding: [0; 8],
    };

    let inputs = [
        key_down(VK_CONTROL),
        key_down(VK_V),
        key_up(VK_V),
        key_up(VK_CONTROL),
    ];

    unsafe {
        let sent = SendInput(4, inputs.as_ptr(), std::mem::size_of::<Input>() as i32);
        if sent == 0 {
            return Err(NativeHostError::Other(
                "Failed to trigger paste: SendInput returned 0".to_string(),
            ));
        }
    }

    Ok(())
}

/// Simulate a paste (Ctrl+V) on Linux via `xdotool`.
///
/// Invokes `xdotool key ctrl+v` to synthesize a Ctrl+V keystroke in the
/// currently focused window. Requires `xdotool` to be installed on the system.
#[cfg(target_os = "linux")]
fn linux_trigger_paste() -> Result<(), NativeHostError> {
    let output = std::process::Command::new("xdotool")
        .args(["key", "ctrl+v"])
        .output()
        .map_err(|e| NativeHostError::Other(format!("Failed to trigger paste (xdotool): {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(NativeHostError::Other(format!("xdotool failed: {stderr}")));
    }
    Ok(())
}
