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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsProperties {
    pub os_release: String,
    pub os_hostname: String,
    pub arch: String,
    pub platform: String,
    pub r#type: String,
    pub cpu_profile: CpuProfile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuProfile {
    pub model: String,
    pub speed: u64,
    pub count: usize,
}

/// Retrieve OS properties for the workbench.
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsStatistics {
    pub total_mem: u64,
    pub free_mem: u64,
    pub load_avg: [f64; 3],
}

/// Retrieve OS statistics (memory, load average).
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

/// Quit the application gracefully.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Exit the application with a specific code.
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

// ─── Network ────────────────────────────────────────────────────────────

/// Check if a given port is free for binding.
#[tauri::command]
pub fn is_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Find a free port starting from `start_port`.
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

fn get_cpu_profile() -> CpuProfile {
    CpuProfile {
        model: "unknown".to_string(),
        speed: 0,
        count: std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(1),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn load_average() -> [f64; 3] {
    let mut load = [0.0f64; 3];
    unsafe {
        libc::getloadavg(load.as_mut_ptr(), 3);
    }
    load
}

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

#[cfg(target_os = "linux")]
fn linux_total_mem() -> u64 {
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sysinfo(&mut info);
    }
    info.totalram * info.mem_unit as u64
}

#[cfg(target_os = "linux")]
fn linux_free_mem() -> u64 {
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sysinfo(&mut info);
    }
    info.freeram * info.mem_unit as u64
}
