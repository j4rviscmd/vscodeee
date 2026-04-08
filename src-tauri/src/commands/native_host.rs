/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Native host commands — Tauri equivalents of `ICommonNativeHostService` methods.
//!
//! These commands are invoked from the WebView via `window.__TAURI__.invoke()`.

use serde::Serialize;

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
    window
        .set_fullscreen(!is_fs)
        .map_err(|e| e.to_string())
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
    app.clipboard()
        .read_text()
        .map_err(|e| e.to_string())
}

/// Write text to the system clipboard.
#[tauri::command]
pub fn write_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())
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
