/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Filesystem commands for the Tauri backend.
//!
//! These commands implement the low-level filesystem operations needed by
//! `TauriDiskFileSystemProvider` in TypeScript. Each command maps to a method
//! on VS Code's `IFileSystemProvider` interface.
//!
//! Error strings follow `FileSystemProviderErrorCode` values from VS Code
//! (e.g., `"EntryNotFound"`, `"EntryExists"`) so the TypeScript side can
//! parse them directly into the appropriate error type.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

/// File stat result matching VS Code's `IStat` interface.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    /// 0 = Unknown, 1 = File, 2 = Directory, 64 = SymbolicLink.
    /// Values can be OR'd (e.g., File | SymbolicLink = 65).
    pub r#type: u32,
    /// Last modification time in milliseconds since Unix epoch.
    pub mtime: u64,
    /// Creation time in milliseconds since Unix epoch.
    pub ctime: u64,
    /// File size in bytes.
    pub size: u64,
    /// File permissions: 0 = none, 1 = Readonly, 4 = Executable.
    pub permissions: u32,
}

/// Directory entry matching VS Code's `[string, FileType]` tuple.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDirEntry {
    pub name: String,
    /// Same type encoding as `FsStat.type`.
    pub r#type: u32,
}

/// Options for write operations.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWriteOptions {
    pub create: bool,
    pub overwrite: bool,
}

/// Map a `std::io::Error` to a `FileSystemProviderErrorCode` string.
fn map_io_error(err: std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => "EntryNotFound".to_string(),
        std::io::ErrorKind::AlreadyExists => "EntryExists".to_string(),
        std::io::ErrorKind::PermissionDenied => "NoPermissions".to_string(),
        std::io::ErrorKind::IsADirectory => "EntryIsADirectory".to_string(),
        _ => {
            // Check for "not a directory" (platform-specific)
            let msg = err.to_string().to_lowercase();
            if msg.contains("not a directory") {
                "EntryNotADirectory".to_string()
            } else {
                format!("Unknown: {}", err)
            }
        }
    }
}

/// Convert `std::fs::Metadata` to a file type bitmask.
fn file_type_from_metadata(metadata: &std::fs::Metadata) -> u32 {
    let mut t: u32 = 0;
    if metadata.is_file() {
        t |= 1; // FileType.File
    }
    if metadata.is_dir() {
        t |= 2; // FileType.Directory
    }
    if metadata.file_type().is_symlink() {
        t |= 64; // FileType.SymbolicLink
    }
    if t == 0 {
        // Unknown
        t = 0;
    }
    t
}

/// Convert `std::fs::Metadata` to permission flags.
fn permissions_from_metadata(metadata: &std::fs::Metadata) -> u32 {
    let mut perms: u32 = 0;
    if metadata.permissions().readonly() {
        perms |= 1; // FilePermission.Readonly
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o111 != 0 {
            perms |= 4; // FilePermission.Executable
        }
    }
    perms
}

/// Get file/directory metadata.
///
/// Returns stat info matching VS Code's `IStat` interface.
/// Uses `symlink_metadata` first to detect symlinks, then resolves
/// the target for type/size information.
#[tauri::command]
pub fn fs_stat(path: String) -> Result<FsStat, String> {
    let p = Path::new(&path);

    // Get symlink metadata first (doesn't follow symlinks)
    let symlink_meta = std::fs::symlink_metadata(p).map_err(map_io_error)?;
    let is_symlink = symlink_meta.file_type().is_symlink();

    // If symlink, also get the resolved metadata for type/size
    let meta = if is_symlink {
        std::fs::metadata(p).unwrap_or(symlink_meta.clone())
    } else {
        symlink_meta.clone()
    };

    let mut file_type = file_type_from_metadata(&meta);
    if is_symlink {
        file_type |= 64; // Add SymbolicLink flag
    }

    // Extract timestamps
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let ctime = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(FsStat {
        r#type: file_type,
        mtime,
        ctime,
        size: meta.len(),
        permissions: permissions_from_metadata(&meta),
    })
}

/// List directory entries.
///
/// Returns an array of `{ name, type }` objects for each entry
/// in the directory.
#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<FsDirEntry>, String> {
    let p = Path::new(&path);
    let entries = std::fs::read_dir(p).map_err(map_io_error)?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(map_io_error)?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Use entry.file_type() which does NOT follow symlinks (like symlink_metadata)
        let ft = entry.file_type().map_err(map_io_error)?;
        let mut type_bits: u32 = 0;
        if ft.is_file() {
            type_bits |= 1; // FileType.File
        }
        if ft.is_dir() {
            type_bits |= 2; // FileType.Directory
        }
        if ft.is_symlink() {
            type_bits |= 64; // FileType.SymbolicLink
        }
        result.push(FsDirEntry {
            name,
            r#type: type_bits,
        });
    }
    Ok(result)
}

/// Read a file's contents as base64-encoded string.
///
/// Returns the entire file content base64-encoded. This is suitable
/// for small-to-medium files (settings, source code). For large files,
/// a chunked read API should be used (Phase 2B).
#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);

    // Check if it's a directory
    if p.is_dir() {
        return Err("EntryIsADirectory".to_string());
    }

    let bytes = std::fs::read(p).map_err(map_io_error)?;
    Ok(STANDARD.encode(&bytes))
}

/// Write content to a file.
///
/// The `content` parameter is base64-encoded binary data.
/// Respects `create` and `overwrite` options to match VS Code's
/// `IFileWriteOptions` semantics.
#[tauri::command]
pub fn fs_write_file(
    path: String,
    content: String,
    create: bool,
    overwrite: bool,
) -> Result<(), String> {
    let p = Path::new(&path);
    let exists = p.exists();

    // Enforce create/overwrite semantics
    if !exists && !create {
        return Err("EntryNotFound".to_string());
    }
    if exists && !overwrite {
        return Err("EntryExists".to_string());
    }
    if exists && p.is_dir() {
        return Err("EntryIsADirectory".to_string());
    }

    // Ensure parent directory exists when creating
    if !exists {
        if let Some(parent) = p.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(map_io_error)?;
            }
        }
    }

    let bytes = STANDARD
        .decode(&content)
        .map_err(|e| format!("Unknown: base64 decode error: {}", e))?;

    std::fs::write(p, bytes).map_err(map_io_error)
}

/// Create a directory.
///
/// When `recursive` is true, creates all parent directories as needed.
/// Defaults to `false` when not provided.
#[tauri::command]
pub fn fs_mkdir(path: String, recursive: Option<bool>) -> Result<(), String> {
    let p = Path::new(&path);
    let recursive = recursive.unwrap_or(false);

    if p.exists() {
        return Err("EntryExists".to_string());
    }

    if recursive {
        std::fs::create_dir_all(p).map_err(map_io_error)
    } else {
        std::fs::create_dir(p).map_err(map_io_error)
    }
}

/// Delete a file or directory.
///
/// When `recursive` is true, removes directories and all their contents.
#[tauri::command]
pub fn fs_delete(path: String, recursive: bool) -> Result<(), String> {
    let p = Path::new(&path);

    if !p.exists() {
        return Err("EntryNotFound".to_string());
    }

    if p.is_dir() {
        if recursive {
            std::fs::remove_dir_all(p).map_err(map_io_error)
        } else {
            std::fs::remove_dir(p).map_err(map_io_error)
        }
    } else {
        std::fs::remove_file(p).map_err(map_io_error)
    }
}

/// Rename/move a file or directory.
///
/// When `overwrite` is false, returns an error if the target already exists.
#[tauri::command]
pub fn fs_rename(from: String, to: String, overwrite: bool) -> Result<(), String> {
    let from_path = Path::new(&from);
    let to_path = Path::new(&to);

    if !from_path.exists() {
        return Err("EntryNotFound".to_string());
    }

    if to_path.exists() && !overwrite {
        return Err("EntryExists".to_string());
    }

    // Ensure target parent directory exists
    if let Some(parent) = to_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(map_io_error)?;
        }
    }

    std::fs::rename(from_path, to_path).map_err(map_io_error)
}

/// Copy a file or directory.
///
/// For directories, copies recursively. When `overwrite` is false,
/// returns an error if the target already exists.
#[tauri::command]
pub fn fs_copy(from: String, to: String, overwrite: bool) -> Result<(), String> {
    let from_path = Path::new(&from);
    let to_path = Path::new(&to);

    if !from_path.exists() {
        return Err("EntryNotFound".to_string());
    }

    if to_path.exists() && !overwrite {
        return Err("EntryExists".to_string());
    }

    // Ensure target parent directory exists
    if let Some(parent) = to_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(map_io_error)?;
        }
    }

    if from_path.is_dir() {
        copy_dir_recursive(from_path, to_path)
    } else {
        std::fs::copy(from_path, to_path)
            .map(|_| ())
            .map_err(map_io_error)
    }
}

/// Recursively copy a directory and its contents.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(map_io_error)?;

    for entry in std::fs::read_dir(src).map_err(map_io_error)? {
        let entry = entry.map_err(map_io_error)?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(map_io_error)?;
        }
    }
    Ok(())
}

/// Reveal a file in its parent folder using OS-native behavior.
///
/// - macOS: `open -R <path>` (selects the file in Finder)
/// - Windows: `explorer /select,<path>`
/// - Linux: `xdg-open <parent>` (opens the containing folder)
#[tauri::command]
pub fn fs_show_item_in_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("EntryNotFound".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Unknown: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Unknown: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let parent = p.parent().unwrap_or(p);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Unknown: {}", e))?;
    }

    Ok(())
}

/// Show a message box dialog using Tauri's dialog plugin.
///
/// Accepts Electron-style `MessageBoxOptions` and returns
/// `{ response: buttonIndex, checkboxChecked: false }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBoxOptions {
    pub message: String,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub buttons: Option<Vec<String>>,
    #[serde(default)]
    pub default_id: Option<u32>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub cancel_id: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBoxResult {
    pub response: u32,
    pub checkbox_checked: bool,
}

#[tauri::command]
pub async fn show_message_box(
    app_handle: tauri::AppHandle,
    options: MessageBoxOptions,
) -> Result<MessageBoxResult, String> {
    let buttons = options.buttons.unwrap_or_else(|| vec!["OK".to_string()]);
    let title = options.title.unwrap_or_else(|| "VS Codeee".to_string());
    let message = if let Some(detail) = &options.detail {
        format!("{}\n\n{}", options.message, detail)
    } else {
        options.message.clone()
    };

    // For 1-2 buttons, use confirm dialog. For 3+, we need a different approach.
    // VS Code commonly uses 3-button dialogs (Save/Don't Save/Cancel).
    if buttons.len() <= 1 {
        // Simple OK dialog
        let dialog = app_handle.dialog().clone();
        dialog
            .message(&message)
            .title(&title)
            .buttons(MessageDialogButtons::OkCustom(buttons[0].clone()))
            .blocking_show();
        return Ok(MessageBoxResult {
            response: 0,
            checkbox_checked: false,
        });
    }

    if buttons.len() == 2 {
        // Confirm dialog (OK/Cancel or Yes/No style)
        let dialog = app_handle.dialog().clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        dialog
            .message(&message)
            .title(&title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                buttons[0].clone(),
                buttons[1].clone(),
            ))
            .show_with_result(move |result| {
                let _ = tx.send(result);
            });
        let result = rx.await.map_err(|e| format!("Unknown: {}", e))?;
        let response = match result {
            MessageDialogResult::Custom(ref s) if s == &buttons[0] => 0,
            MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
            _ => 1,
        };
        return Ok(MessageBoxResult {
            response,
            checkbox_checked: false,
        });
    }

    // 3+ buttons: Use confirm dialog with first button as OK,
    // last button as Cancel, and treat the middle buttons specially.
    // For the common Save/Don't Save/Cancel pattern:
    //   buttons[0] = "Save" (OK/Yes)
    //   buttons[1] = "Don't Save" (No)
    //   buttons[2] = "Cancel" (Cancel)
    let cancel_id = options
        .cancel_id
        .unwrap_or((buttons.len() - 1) as u32) as usize;
    let default_id = options.default_id.unwrap_or(0) as usize;

    // Pick the "no" button: the first button that isn't default or cancel.
    let no_idx = (0..buttons.len())
        .find(|&i| i != default_id && i != cancel_id)
        .unwrap_or(1);

    let dialog = app_handle.dialog().clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let buttons_clone = buttons.clone();
    dialog
        .message(&message)
        .title(&title)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            buttons[default_id].clone(),
            buttons[no_idx].clone(),
            buttons[cancel_id].clone(),
        ))
        .show_with_result(move |result| {
            let _ = tx.send(result);
        });

    let result = rx.await.map_err(|e| format!("Unknown: {}", e))?;
    let response = match result {
        MessageDialogResult::Custom(ref s) => {
            buttons_clone.iter().position(|b| b == s).unwrap_or(cancel_id) as u32
        }
        MessageDialogResult::Yes | MessageDialogResult::Ok => default_id as u32,
        MessageDialogResult::No => no_idx as u32,
        MessageDialogResult::Cancel => cancel_id as u32,
    };
    Ok(MessageBoxResult {
        response,
        checkbox_checked: false,
    })
}

// ---------------------------------------------------------------------------
// File dialogs (Save / Open)
// ---------------------------------------------------------------------------

/// A file filter matching Electron's `FileFilter` interface.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilterOption {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Options for `show_save_dialog`, matching Electron's `SaveDialogOptions`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDialogOptions {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_path: Option<String>,
    #[serde(default)]
    pub button_label: Option<String>,
    #[serde(default)]
    pub filters: Option<Vec<FileFilterOption>>,
}

/// Return value for `show_save_dialog`, matching Electron's `SaveDialogReturnValue`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDialogResult {
    pub canceled: bool,
    pub file_path: String,
}

/// Show a native save-file dialog.
#[tauri::command]
pub async fn show_save_dialog(
    app_handle: tauri::AppHandle,
    options: SaveDialogOptions,
) -> Result<SaveDialogResult, String> {
    let dialog = app_handle.dialog().clone();
    let mut builder = dialog.file();

    if let Some(title) = &options.title {
        builder = builder.set_title(title);
    }
    if let Some(default_path) = &options.default_path {
        let p = Path::new(default_path);
        if let Some(parent) = p.parent() {
            builder = builder.set_directory(parent);
        }
        if let Some(name) = p.file_name() {
            builder = builder.set_file_name(name.to_string_lossy().to_string());
        }
    }
    if let Some(filters) = &options.filters {
        for filter in filters {
            let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(&filter.name, &exts);
        }
    }
    builder = builder.set_can_create_directories(true);

    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.save_file(move |file_path| {
        let _ = tx.send(file_path);
    });

    let result = rx.await.map_err(|e| format!("Unknown: {}", e))?;

    match result {
        Some(file_path) => {
            let path_str = file_path
                .as_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            Ok(SaveDialogResult {
                canceled: false,
                file_path: path_str,
            })
        }
        None => Ok(SaveDialogResult {
            canceled: true,
            file_path: String::new(),
        }),
    }
}

/// Options for `show_open_dialog`, matching Electron's `OpenDialogOptions`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDialogOptions {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_path: Option<String>,
    #[serde(default)]
    pub button_label: Option<String>,
    #[serde(default)]
    pub filters: Option<Vec<FileFilterOption>>,
    #[serde(default)]
    pub properties: Option<Vec<String>>,
}

/// Return value for `show_open_dialog`, matching Electron's `OpenDialogReturnValue`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDialogResult {
    pub canceled: bool,
    pub file_paths: Vec<String>,
}

/// Show a native open-file/folder dialog.
///
/// Electron `properties` array may include: `openFile`, `openDirectory`,
/// `multiSelections`, `createDirectory`.
#[tauri::command]
pub async fn show_open_dialog(
    app_handle: tauri::AppHandle,
    options: OpenDialogOptions,
) -> Result<OpenDialogResult, String> {
    let dialog = app_handle.dialog().clone();
    let mut builder = dialog.file();

    if let Some(title) = &options.title {
        builder = builder.set_title(title);
    }
    if let Some(default_path) = &options.default_path {
        builder = builder.set_directory(default_path);
    }
    if let Some(filters) = &options.filters {
        for filter in filters {
            let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter(&filter.name, &exts);
        }
    }
    builder = builder.set_can_create_directories(true);

    let props = options.properties.unwrap_or_default();
    let open_directory = props.iter().any(|p| p == "openDirectory");
    let multi = props.iter().any(|p| p == "multiSelections");

    if open_directory {
        if multi {
            let (tx, rx) = tokio::sync::oneshot::channel();
            builder.pick_folders(move |paths| {
                let _ = tx.send(paths);
            });
            let result = rx.await.map_err(|e| format!("Unknown: {}", e))?;
            match result {
                Some(paths) => Ok(OpenDialogResult {
                    canceled: false,
                    file_paths: paths
                        .into_iter()
                        .filter_map(|fp| fp.as_path().map(|p| p.to_string_lossy().to_string()))
                        .collect(),
                }),
                None => Ok(OpenDialogResult {
                    canceled: true,
                    file_paths: vec![],
                }),
            }
        } else {
            let (tx, rx) = tokio::sync::oneshot::channel();
            builder.pick_folder(move |path| {
                let _ = tx.send(path);
            });
            let result = rx.await.map_err(|e| format!("Unknown: {}", e))?;
            match result {
                Some(fp) => Ok(OpenDialogResult {
                    canceled: false,
                    file_paths: fp
                        .as_path()
                        .map(|p| vec![p.to_string_lossy().to_string()])
                        .unwrap_or_default(),
                }),
                None => Ok(OpenDialogResult {
                    canceled: true,
                    file_paths: vec![],
                }),
            }
        }
    } else if multi {
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.pick_files(move |paths| {
            let _ = tx.send(paths);
        });
        let result = rx.await.map_err(|e| format!("Unknown: {}", e))?;
        match result {
            Some(paths) => Ok(OpenDialogResult {
                canceled: false,
                file_paths: paths
                    .into_iter()
                    .filter_map(|fp| fp.as_path().map(|p| p.to_string_lossy().to_string()))
                    .collect(),
            }),
            None => Ok(OpenDialogResult {
                canceled: true,
                file_paths: vec![],
            }),
        }
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel();
        builder.pick_file(move |path| {
            let _ = tx.send(path);
        });
        let result = rx.await.map_err(|e| format!("Unknown: {}", e))?;
        match result {
            Some(fp) => Ok(OpenDialogResult {
                canceled: false,
                file_paths: fp
                    .as_path()
                    .map(|p| vec![p.to_string_lossy().to_string()])
                    .unwrap_or_default(),
            }),
            None => Ok(OpenDialogResult {
                canceled: true,
                file_paths: vec![],
            }),
        }
    }
}
