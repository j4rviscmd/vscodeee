/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Native host commands — Tauri equivalents of `ICommonNativeHostService` methods.
//!
//! These commands are invoked from the WebView via `window.__TAURI__.invoke()`.

use serde::Serialize;
use tauri::Manager;

// ─── Window Management ──────────────────────────────────────────────────

/// Check if the current window is in fullscreen mode.
#[tauri::command]
pub fn is_fullscreen(window: tauri::Window) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}

/// Toggle fullscreen for the current window.
#[tauri::command]
pub fn toggle_fullscreen(window: tauri::Window) -> Result<(), String> {
    let is_fs = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!is_fs).map_err(|e| e.to_string())
}

/// Check if the current window is maximized.
#[tauri::command]
pub fn is_maximized(window: tauri::Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// Maximize the current window.
#[tauri::command]
pub fn maximize_window(window: tauri::Window) -> Result<(), String> {
    window.maximize().map_err(|e| e.to_string())
}

/// Unmaximize (restore) the current window.
#[tauri::command]
pub fn unmaximize_window(window: tauri::Window) -> Result<(), String> {
    window.unmaximize().map_err(|e| e.to_string())
}

/// Minimize the current window.
#[tauri::command]
pub fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Focus the current window.
#[tauri::command]
pub fn focus_window(window: tauri::Window) -> Result<(), String> {
    window.set_focus().map_err(|e| e.to_string())
}

// ─── Shell Integration ──────────────────────────────────────────────────

/// Open a URL in the system's default browser/application.
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

// ─── Trash ──────────────────────────────────────────────────────────────

/// Move a file or directory to the system trash.
#[tauri::command]
pub async fn move_item_to_trash(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("Failed to move to trash: {e}"))
}

// ─── Process Management ─────────────────────────────────────────────────

/// Kill a process by PID.
///
/// Sends a signal to the specified process. On Unix, uses `libc::kill()`
/// with the mapped signal. On Windows, falls back to `taskkill /F`.
///
/// # Arguments
///
/// * `pid` - The process ID to signal.
/// * `code` - Signal name: `"SIGTERM"` (default), `"SIGKILL"`, or `"SIGINT"`.
///
/// # Errors
///
/// Returns an error string if the signal is unsupported, or if the
/// OS-level kill/taskkill call fails.
#[tauri::command]
pub fn kill_process(pid: u32, code: String) -> Result<(), String> {
    let signal = match code.as_str() {
        "SIGTERM" | "" => libc::SIGTERM,
        "SIGKILL" => libc::SIGKILL,
        "SIGINT" => libc::SIGINT,
        other => return Err(format!("Unsupported signal: {other}")),
    };

    #[cfg(unix)]
    {
        let ret = unsafe { libc::kill(pid as i32, signal) };
        if ret != 0 {
            return Err(format!(
                "Failed to kill process {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
    }

    #[cfg(windows)]
    {
        // On Windows, use taskkill for graceful termination
        let _ = signal; // suppress unused warning
        let output = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map_err(|e| format!("Failed to run taskkill: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "taskkill failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    Ok(())
}

// ─── Lifecycle (extended) ───────────────────────────────────────────────

/// Relaunch the application.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) -> Result<(), String> {
    tauri::process::restart(&app.env());
}

// ─── Shell Command Installation ─────────────────────────────────────────

/// Install a shell command (`codeee`) by creating a symlink.
///
/// On macOS, uses osascript for privilege escalation to /usr/local/bin.
/// On Linux, creates the symlink directly (may need sudo).
#[tauri::command]
pub async fn install_shell_command(_app: tauri::AppHandle) -> Result<(), String> {
    let exe_path =
        std::env::current_exe().map_err(|e| format!("Failed to get executable path: {e}"))?;

    let link_path = if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        "/usr/local/bin/codeee"
    } else if cfg!(windows) {
        // On Windows, we'd add to PATH via registry — simplified for now
        return Err("Shell command installation on Windows is not yet supported".to_string());
    } else {
        return Err("Unsupported platform".to_string());
    };

    let exe_str = exe_path.to_string_lossy();

    #[cfg(target_os = "macos")]
    {
        // Use osascript for privilege escalation on macOS
        let script = format!(
            "do shell script \"ln -sf '{}' '{}'\" with administrator privileges",
            exe_str, link_path
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to run osascript: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("User canceled") || stderr.contains("-128") {
                return Err("User cancelled the operation".to_string());
            }
            return Err(format!("Failed to install shell command: {stderr}"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = _app; // suppress unused warning
                      // Try direct symlink first, may fail without sudo
        if let Err(_) = std::os::unix::fs::symlink(&exe_str.as_ref(), link_path) {
            return Err(format!(
                "Failed to create symlink. Try: sudo ln -sf '{}' '{}'",
                exe_str, link_path
            ));
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (_app, exe_str, link_path);
        return Err("Unsupported platform".to_string());
    }

    log::info!(
        target: "vscodeee::commands::native_host",
        "Installed shell command: {} -> {}",
        link_path,
        exe_path.display()
    );

    Ok(())
}

/// Uninstall the shell command (`codeee`).
#[tauri::command]
pub async fn uninstall_shell_command(_app: tauri::AppHandle) -> Result<(), String> {
    let link_path = if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        "/usr/local/bin/codeee"
    } else {
        return Err("Unsupported platform".to_string());
    };

    if !std::path::Path::new(link_path).exists() {
        return Ok(()); // Already uninstalled
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
            .map_err(|e| format!("Failed to run osascript: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("User canceled") || stderr.contains("-128") {
                return Err("User cancelled the operation".to_string());
            }
            return Err(format!("Failed to uninstall shell command: {stderr}"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = _app;
        std::fs::remove_file(link_path).map_err(|e| format!("Failed to remove symlink: {e}"))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = _app;
        return Err("Unsupported platform".to_string());
    }

    log::info!(
        target: "vscodeee::commands::native_host",
        "Uninstalled shell command: {}",
        link_path
    );

    Ok(())
}

// ─── OS Properties ──────────────────────────────────────────────────────

/// OS properties matching `IOSProperties` in VS Code.
///
/// Provides static system information (OS type, architecture, CPU info)
/// used by the workbench for telemetry and environment detection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsProperties {
    /// OS release version string (e.g. `"14.5"` on macOS, kernel version on Linux).
    pub os_release: String,
    /// Machine hostname, or `"unknown"` if retrieval fails.
    pub os_hostname: String,
    /// CPU architecture (e.g. `"aarch64"`, `"x86_64"`).
    pub arch: String,
    /// OS platform identifier (e.g. `"macos"`, `"linux"`, `"windows"`).
    pub platform: String,
    /// OS type string matching Node.js `os.type()` (e.g. `"Darwin"`, `"Linux"`, `"Windows_NT"`).
    pub r#type: String,
    /// CPU profile information (model, speed, core count).
    pub cpu_profile: CpuProfile,
}

/// CPU profile information for the host machine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuProfile {
    /// CPU model name (currently `"unknown"` — not yet implemented).
    pub model: String,
    /// CPU clock speed in MHz (currently `0` — not yet implemented).
    pub speed: u64,
    /// Number of available CPU cores (logical parallelism).
    pub count: usize,
}

/// Retrieve OS properties for the workbench.
///
/// Returns static system information including OS type, architecture,
/// hostname, and CPU profile. Matches the `IOSProperties` interface
/// consumed by the TypeScript workbench.
///
/// # Returns
///
/// An [`OsProperties`] struct with the current system's static properties.
#[tauri::command]
pub fn get_os_properties() -> OsProperties {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    OsProperties {
        os_release: os_release(),
        os_hostname: hostname,
        arch: std::env::consts::ARCH.to_string(),
        platform: std::env::consts::OS.to_string(),
        r#type: os_type(),
        cpu_profile: get_cpu_profile(),
    }
}

/// OS statistics matching `IOSStatistics` in VS Code.
///
/// Provides dynamic system metrics (memory usage, load average)
/// that may change over time, unlike the static [`OsProperties`].
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsStatistics {
    /// Total physical memory in bytes.
    pub total_mem: u64,
    /// Available (free) physical memory in bytes.
    pub free_mem: u64,
    /// System load averages for the last 1, 5, and 15 minutes.
    /// On Windows, all values are `0.0` (not supported).
    pub load_avg: [f64; 3],
}

/// Retrieve OS statistics (memory, load average).
///
/// Returns dynamic system metrics including total/free memory and
/// load averages. Uses platform-specific APIs (`sysctl`/`host_statistics64`
/// on macOS, `sysinfo` on Linux). Windows returns zeroed values.
///
/// # Returns
///
/// An [`OsStatistics`] struct with current memory and load data.
#[tauri::command]
pub fn get_os_statistics() -> OsStatistics {
    #[cfg(target_os = "macos")]
    {
        OsStatistics {
            total_mem: macos_total_mem(),
            free_mem: macos_free_mem(),
            load_avg: load_average(),
        }
    }
    #[cfg(target_os = "linux")]
    {
        OsStatistics {
            total_mem: linux_total_mem(),
            free_mem: linux_free_mem(),
            load_avg: load_average(),
        }
    }
    #[cfg(target_os = "windows")]
    {
        OsStatistics {
            total_mem: 0,
            free_mem: 0,
            load_avg: [0.0, 0.0, 0.0],
        }
    }
}

// ─── Clipboard ──────────────────────────────────────────────────────────

/// Read text from the system clipboard.
#[tauri::command]
pub fn read_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().map_err(|e| e.to_string())
}

/// Write text to the system clipboard.
#[tauri::command]
pub fn write_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

/// Notify the backend that the workbench has finished loading.
#[tauri::command]
pub fn notify_ready() {
    log::info!(target: "vscodeee::commands::native_host", "Workbench notified ready");
}

/// Close the current window.
#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// Quit the application gracefully, saving the session first.
///
/// Persists the current window/workspace mapping to `sessions.json`
/// via [`save_session_snapshot`](crate::window::events::save_session_snapshot),
/// then exits the process with code `0`.
#[tauri::command]
pub async fn quit_app(
    app: tauri::AppHandle,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), String> {
    crate::window::events::save_session_snapshot(&window_manager).await;
    app.exit(0);
    Ok(())
}

/// Exit the application with a specific code, saving the session first.
///
/// Same as [`quit_app`] but allows specifying a non-zero exit code
/// for error conditions.
///
/// # Arguments
///
/// * `code` - The process exit code.
#[tauri::command]
pub async fn exit_app(
    app: tauri::AppHandle,
    code: i32,
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), String> {
    crate::window::events::save_session_snapshot(&window_manager).await;
    app.exit(code);
    Ok(())
}

/// Explicitly save the current session (all windows + workspaces) to disk.
#[tauri::command]
pub async fn save_session(
    window_manager: tauri::State<'_, std::sync::Arc<crate::window::manager::WindowManager>>,
) -> Result<(), String> {
    crate::window::events::save_session_snapshot(&window_manager).await;
    Ok(())
}

// ─── Network ────────────────────────────────────────────────────────────

/// Check if a given port is free for binding.
///
/// Attempts to bind a TCP listener on `127.0.0.1:<port>`. Returns `true`
/// if binding succeeds (port is available), `false` otherwise.
///
/// # Arguments
///
/// * `port` - The TCP port number to check.
#[tauri::command]
pub fn is_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Find a free port starting from `start_port`.
///
/// Scans ports in increments of `stride` from `start_port` up to
/// `start_port + give_up_after`, returning the first available port.
///
/// # Arguments
///
/// * `start_port` - The first port to try.
/// * `give_up_after` - Maximum number of ports to scan before giving up.
/// * `_timeout` - Reserved for future use (currently ignored).
/// * `stride` - Increment between port attempts (clamped to 1 if 0).
///
/// # Errors
///
/// Returns an error string if no free port is found in the given range.
#[tauri::command]
pub fn find_free_port(
    start_port: u16,
    give_up_after: u16,
    _timeout: u64,
    stride: u16,
) -> Result<u16, String> {
    let stride = if stride == 0 { 1 } else { stride };
    let mut port = start_port;
    let end = start_port.saturating_add(give_up_after);
    while port < end {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
        port = port.saturating_add(stride);
    }
    Err(format!(
        "Could not find a free port in range {start_port}..{end}"
    ))
}

// ─── Platform Helpers ───────────────────────────────────────────────────

/// Return the OS release version string.
///
/// - macOS: Uses `sw_vers -productVersion` (e.g. `"14.5"`).
/// - Linux: Uses `uname -r` (kernel version).
/// - Windows: Returns `"windows"`.
fn os_release() -> String {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("uname")
            .arg("-r")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        "windows".to_string()
    }
}

/// Return the OS type string matching Node.js `os.type()` convention.
///
/// - macOS: `"Darwin"`
/// - Linux: `"Linux"`
/// - Windows: `"Windows_NT"`
fn os_type() -> String {
    #[cfg(target_os = "macos")]
    {
        "Darwin".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "Linux".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "Windows_NT".to_string()
    }
}

/// Build a basic CPU profile with available parallelism count.
///
/// Model and speed are currently reported as `"unknown"` / `0` since
/// Rust's standard library does not expose CPU model details.
fn get_cpu_profile() -> CpuProfile {
    CpuProfile {
        model: "unknown".to_string(),
        speed: 0,
        count: std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1),
    }
}

/// Retrieve the 1-, 5-, and 15-minute system load averages (Unix only).
///
/// # Safety
///
/// Calls `libc::getloadavg` which writes to a raw pointer.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn load_average() -> [f64; 3] {
    let mut load = [0.0f64; 3];
    unsafe {
        libc::getloadavg(load.as_mut_ptr(), 3);
    }
    load
}

/// Retrieve total physical memory on macOS via `sysctl(HW_MEMSIZE)`.
#[cfg(target_os = "macos")]
fn macos_total_mem() -> u64 {
    use std::mem;
    let mut size: u64 = 0;
    let mut len = mem::size_of::<u64>();
    let mib = [libc::CTL_HW, libc::HW_MEMSIZE];
    unsafe {
        libc::sysctl(
            mib.as_ptr() as *mut _,
            2,
            &mut size as *mut _ as *mut _,
            &mut len,
            std::ptr::null_mut(),
            0,
        );
    }
    size
}

/// Retrieve free (unused) physical memory on macOS via `host_statistics64`.
///
/// Reports `vm_statistics64.free_count * vm_page_size` in bytes.
#[cfg(target_os = "macos")]
fn macos_free_mem() -> u64 {
    use std::mem;
    let mut stats: libc::vm_statistics64 = unsafe { mem::zeroed() };
    let mut count = (mem::size_of::<libc::vm_statistics64>() / mem::size_of::<libc::integer_t>())
        as libc::mach_msg_type_number_t;
    #[allow(deprecated)]
    unsafe {
        libc::host_statistics64(
            libc::mach_host_self(),
            libc::HOST_VM_INFO64,
            &mut stats as *mut _ as *mut _,
            &mut count,
        );
    }
    (stats.free_count as u64) * (unsafe { libc::vm_page_size } as u64)
}

/// Retrieve total physical memory on Linux via `libc::sysinfo`.
#[cfg(target_os = "linux")]
fn linux_total_mem() -> u64 {
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sysinfo(&mut info);
    }
    info.totalram * info.mem_unit as u64
}

/// Retrieve free physical memory on Linux via `libc::sysinfo`.
#[cfg(target_os = "linux")]
fn linux_free_mem() -> u64 {
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sysinfo(&mut info);
    }
    info.freeram * info.mem_unit as u64
}
