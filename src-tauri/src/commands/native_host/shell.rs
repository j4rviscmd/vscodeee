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
    trash::delete(&path)
        .map_err(|e| NativeHostError::Other(format!("Failed to move to trash: {e}")))
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

/// Install a shell command (`codeee`) so it can be run from a terminal.
///
/// - macOS: symlink via `osascript` with administrator privileges
/// - Linux: direct symlink to `/usr/local/bin/codeee`
/// - Windows: `.cmd` wrapper in `%LOCALAPPDATA%\Programs\VS Codeee\bin\` + user PATH
#[tauri::command]
pub async fn install_shell_command(_app: tauri::AppHandle) -> Result<(), NativeHostError> {
    let exe_path = std::env::current_exe()
        .map_err(|e| NativeHostError::Other(format!("Failed to get executable path: {e}")))?;

    let exe_str = exe_path.to_string_lossy();

    // Reject paths containing characters that could break shell quoting
    if exe_str.contains('"') {
        return Err(NativeHostError::Other(
            "Executable path contains unsupported characters".to_string(),
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let link_path = "/usr/local/bin/codeee";
        let escaped_exe = exe_str.replace('\'', "'\\''");
        let script = format!("ln -sf '{}' '{}'", escaped_exe, link_path);
        run_osascript_with_admin(&script, "install shell command")?;

        log::info!(
            target: "vscodeee::commands::native_host",
            "Installed shell command: {} -> {}",
            link_path,
            exe_path.display()
        );
    }

    #[cfg(target_os = "linux")]
    {
        let _ = _app;
        let link_path = "/usr/local/bin/codeee";
        if std::os::unix::fs::symlink(&*exe_str, link_path).is_err() {
            return Err(NativeHostError::Other(format!(
                "Failed to create symlink. Try: sudo ln -sf '{}' '{}'",
                exe_str, link_path
            )));
        }

        log::info!(
            target: "vscodeee::commands::native_host",
            "Installed shell command: {} -> {}",
            link_path,
            exe_path.display()
        );
    }

    #[cfg(target_os = "windows")]
    {
        let _ = (_app, exe_str);
        install_windows_shell_command(&exe_path)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (_app, exe_str);
        return Err(NativeHostError::Unsupported(
            "Unsupported platform".to_string(),
        ));
    }

    Ok(())
}

/// Uninstall the shell command (`codeee`) by removing the symlink or wrapper.
#[tauri::command]
pub async fn uninstall_shell_command(_app: tauri::AppHandle) -> Result<(), NativeHostError> {
    #[cfg(target_os = "macos")]
    {
        let link_path = "/usr/local/bin/codeee";
        if !std::path::Path::new(link_path).exists() {
            return Ok(());
        }
        let script = format!("rm -f '{}'", link_path);
        run_osascript_with_admin(&script, "uninstall shell command")?;

        log::info!(
            target: "vscodeee::commands::native_host",
            "Uninstalled shell command: {}",
            link_path
        );
    }

    #[cfg(target_os = "linux")]
    {
        let _ = _app;
        let link_path = "/usr/local/bin/codeee";
        if std::path::Path::new(link_path).exists() {
            std::fs::remove_file(link_path)?;
        }

        log::info!(
            target: "vscodeee::commands::native_host",
            "Uninstalled shell command: {}",
            link_path
        );
    }

    #[cfg(target_os = "windows")]
    {
        let _ = _app;
        uninstall_windows_shell_command()?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = _app;
        return Err(NativeHostError::Unsupported(
            "Unsupported platform".to_string(),
        ));
    }

    Ok(())
}

// ─── macOS helper ────────────────────────────────────────────────────────

/// Execute a shell script via `osascript` with administrator privileges.
///
/// Handles the common pattern of running a command through macOS's
/// authorization dialog, including user-cancellation detection.
#[cfg(target_os = "macos")]
fn run_osascript_with_admin(script: &str, label: &str) -> Result<(), NativeHostError> {
    let full_script = format!(
        "do shell script \"{}\" with administrator privileges",
        script
    );
    let output = std::process::Command::new("osascript")
        .args(["-e", &full_script])
        .output()
        .map_err(|e| NativeHostError::Other(format!("Failed to run osascript: {e}")))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("User canceled") || stderr.contains("-128") {
        return Err(NativeHostError::Other(
            "User cancelled the operation".to_string(),
        ));
    }
    Err(NativeHostError::Other(format!(
        "Failed to {label}: {stderr}"
    )))
}

// ─── Windows-specific helpers ──────────────────────────────────────────

/// Resolve the `%LOCALAPPDATA%\Programs\VS Codeee\bin\` directory.
#[cfg(target_os = "windows")]
fn shell_command_bin_dir() -> Result<std::path::PathBuf, NativeHostError> {
    dirs::data_local_dir()
        .ok_or_else(|| {
            NativeHostError::Other("Failed to resolve local app data directory".to_string())
        })
        .map(|d| d.join("Programs").join("VS Codeee").join("bin"))
}

/// Open the current user's `Environment` registry key with read/write access.
#[cfg(target_os = "windows")]
fn open_environment_key() -> Result<winreg::RegKey, NativeHostError> {
    use winreg::enums::*;
    use winreg::RegKey;

    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| NativeHostError::Other(format!("Failed to open registry: {e}")))
}

/// Create a `codeee.cmd` wrapper in `%LOCALAPPDATA%\Programs\VS Codeee\bin\`
/// and add that directory to the current user's `Path` environment variable.
///
/// The generated `.cmd` file forwards all arguments to the running executable.
/// After updating the registry, a `WM_SETTINGCHANGE` broadcast is sent so that
/// other processes (e.g. Explorer) pick up the new PATH without a restart.
#[cfg(target_os = "windows")]
fn install_windows_shell_command(exe_path: &std::path::Path) -> Result<(), NativeHostError> {
    use std::io::Write;

    let bin_dir = shell_command_bin_dir()?;

    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| NativeHostError::Other(format!("Failed to create bin directory: {e}")))?;

    let cmd_path = bin_dir.join("codeee.cmd");
    let exe_str = exe_path.to_string_lossy();
    let cmd_content = format!("@echo off\r\n\"{exe_str}\" %*\r\n");

    let mut file = std::fs::File::create(&cmd_path)
        .map_err(|e| NativeHostError::Other(format!("Failed to create codeee.cmd: {e}")))?;
    file.write_all(cmd_content.as_bytes())
        .map_err(|e| NativeHostError::Other(format!("Failed to write codeee.cmd: {e}")))?;

    add_to_user_path(bin_dir.to_string_lossy().as_ref())?;

    broadcast_env_change();

    log::info!(
        target: "vscodeee::commands::native_host",
        "Installed shell command: {} -> {}",
        cmd_path.display(),
        exe_path.display()
    );

    Ok(())
}

/// Remove the `codeee.cmd` wrapper and clean up the corresponding entry
/// from the current user's `Path` environment variable.
///
/// If the `.cmd` file or the PATH entry does not exist, the function
/// succeeds silently. A `WM_SETTINGCHANGE` broadcast is sent after
/// the registry update.
#[cfg(target_os = "windows")]
fn uninstall_windows_shell_command() -> Result<(), NativeHostError> {
    let bin_dir = shell_command_bin_dir()?;

    let cmd_path = bin_dir.join("codeee.cmd");
    if cmd_path.exists() {
        std::fs::remove_file(&cmd_path)?;
    }

    remove_from_user_path(bin_dir.to_string_lossy().as_ref())?;

    broadcast_env_change();

    log::info!(
        target: "vscodeee::commands::native_host",
        "Uninstalled shell command: {}",
        cmd_path.display()
    );

    Ok(())
}

/// Append `dir` to the current user's `Path` environment variable in the
/// Windows registry (`HKCU\Environment`).
///
/// The directory is compared case-insensitively; if it is already present
/// the function returns early without modifying the registry.
#[cfg(target_os = "windows")]
fn add_to_user_path(dir: &str) -> Result<(), NativeHostError> {
    let env = open_environment_key()?;
    let current_path: String = env.get_value("Path").unwrap_or_default();
    let dir_normalized = dir.replace('/', "\\");

    if current_path
        .split(';')
        .any(|p| p.eq_ignore_ascii_case(&dir_normalized))
    {
        return Ok(());
    }

    let new_path = if current_path.is_empty() {
        dir_normalized
    } else {
        format!("{current_path};{dir_normalized}")
    };

    env.set_value("Path", &new_path)
        .map_err(|e| NativeHostError::Other(format!("Failed to update PATH: {e}")))?;

    Ok(())
}

/// Remove `dir` from the current user's `Path` environment variable in the
/// Windows registry (`HKCU\Environment`).
///
/// Matching is case-insensitive. Empty segments left behind by removal are
/// pruned. If the value is unchanged the function returns early without
/// modifying the registry.
#[cfg(target_os = "windows")]
fn remove_from_user_path(dir: &str) -> Result<(), NativeHostError> {
    let env = open_environment_key()?;
    let current_path: String = env.get_value("Path").unwrap_or_default();
    let dir_normalized = dir.replace('/', "\\");

    let filtered: Vec<&str> = current_path
        .split(';')
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case(&dir_normalized))
        .collect();

    let new_path = filtered.join(";");
    if new_path == current_path {
        return Ok(());
    }
    env.set_value("Path", &new_path)
        .map_err(|e| NativeHostError::Other(format!("Failed to update PATH: {e}")))?;

    Ok(())
}

/// Broadcast a `WM_SETTINGCHANGE` message with the `"Environment"` parameter
/// to all top-level windows so they reload their environment variables from
/// the registry.
///
/// Uses `SendMessageTimeoutW` with `SMTO_ABORTIFHUNG` and a 5-second timeout
/// to avoid blocking on unresponsive windows.
#[cfg(target_os = "windows")]
fn broadcast_env_change() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    const HWND_BROADCAST: isize = 0xFFFF;
    const WM_SETTINGCHANGE: u32 = 0x001A;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    unsafe {
        let env_wide: Vec<u16> = OsStr::new("Environment")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            env_wide.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            std::ptr::null_mut(),
        );
    }
}
