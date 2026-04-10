/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Shell integration and process management commands — open external,
//! trash, shell command install/uninstall, kill process.

use super::error::NativeHostError;

// ─── Existing commands (moved from native_host.rs) ──────────────────────

/// Open a URL in the system's default browser/application.
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), NativeHostError> {
    open::that(&url).map_err(|e| NativeHostError::Other(e.to_string()))
}

/// Move a file or directory to the system trash.
#[tauri::command]
pub async fn move_item_to_trash(path: String) -> Result<(), NativeHostError> {
    trash::delete(&path).map_err(|e| NativeHostError::Other(format!("Failed to move to trash: {e}")))
}

/// Kill a process by PID.
#[tauri::command]
pub fn kill_process(pid: u32, code: String) -> Result<(), NativeHostError> {
    #[cfg(unix)]
    {
        let signal = match code.as_str() {
            "SIGTERM" | "" => libc::SIGTERM,
            "SIGKILL" => libc::SIGKILL,
            "SIGINT" => libc::SIGINT,
            other => {
                return Err(NativeHostError::Unsupported(format!(
                    "Unsupported signal: {other}"
                )))
            }
        };
        let ret = unsafe { libc::kill(pid as i32, signal) };
        if ret != 0 {
            return Err(NativeHostError::Io(std::io::Error::last_os_error()));
        }
    }

    #[cfg(windows)]
    {
        let _ = code;
        let output = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map_err(NativeHostError::Io)?;
        if !output.status.success() {
            return Err(NativeHostError::Other(format!(
                "taskkill failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
    }

    Ok(())
}

/// Install a shell command (`codeee`) by creating a symlink.
#[tauri::command]
pub async fn install_shell_command(_app: tauri::AppHandle) -> Result<(), NativeHostError> {
    let exe_path = std::env::current_exe()
        .map_err(|e| NativeHostError::Other(format!("Failed to get executable path: {e}")))?;

    let link_path = if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        "/usr/local/bin/codeee"
    } else if cfg!(windows) {
        return Err(NativeHostError::Unsupported(
            "Shell command installation on Windows is not yet supported".to_string(),
        ));
    } else {
        return Err(NativeHostError::Unsupported(
            "Unsupported platform".to_string(),
        ));
    };

    let exe_str = exe_path.to_string_lossy();

    #[cfg(target_os = "macos")]
    {
        // Escape single quotes to prevent command injection in AppleScript
        let escaped_exe = exe_str.replace('\'', "'\\''");
        let script = format!(
            "do shell script \"ln -sf '{}' '{}'\" with administrator privileges",
            escaped_exe, link_path
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| NativeHostError::Other(format!("Failed to run osascript: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("User canceled") || stderr.contains("-128") {
                return Err(NativeHostError::Other(
                    "User cancelled the operation".to_string(),
                ));
            }
            return Err(NativeHostError::Other(format!(
                "Failed to install shell command: {stderr}"
            )));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = _app;
        if let Err(_) = std::os::unix::fs::symlink(&exe_str.as_ref(), link_path) {
            return Err(NativeHostError::Other(format!(
                "Failed to create symlink. Try: sudo ln -sf '{}' '{}'",
                exe_str, link_path
            )));
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (_app, exe_str, link_path);
        return Err(NativeHostError::Unsupported(
            "Unsupported platform".to_string(),
        ));
    }

    log::info!(
        target: "vscodeee::commands::native_host",
        "Installed shell command: {} -> {}",
        link_path,
        exe_path.display()
    );

    Ok(())
}

/// Uninstall the shell command (`codeee`) by removing the symlink.
#[tauri::command]
pub async fn uninstall_shell_command(_app: tauri::AppHandle) -> Result<(), NativeHostError> {
    let link_path = if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        "/usr/local/bin/codeee"
    } else {
        return Err(NativeHostError::Unsupported(
            "Unsupported platform".to_string(),
        ));
    };

    if !std::path::Path::new(link_path).exists() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "do shell script \"rm -f '{}'\" with administrator privileges",
            link_path
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| NativeHostError::Other(format!("Failed to run osascript: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("User canceled") || stderr.contains("-128") {
                return Err(NativeHostError::Other(
                    "User cancelled the operation".to_string(),
                ));
            }
            return Err(NativeHostError::Other(format!(
                "Failed to uninstall shell command: {stderr}"
            )));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = _app;
        std::fs::remove_file(link_path)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = _app;
        return Err(NativeHostError::Unsupported(
            "Unsupported platform".to_string(),
        ));
    }

    log::info!(
        target: "vscodeee::commands::native_host",
        "Uninstalled shell command: {}",
        link_path
    );

    Ok(())
}
