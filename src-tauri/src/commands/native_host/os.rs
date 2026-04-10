/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! OS property and statistic commands — platform info, admin check,
//! ARM64 translation, VM detection, color scheme, process ID.

use serde::Serialize;

use super::error::NativeHostError;

// ─── Types (moved from native_host.rs) ──────────────────────────────────

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

/// CPU profile information for the host machine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuProfile {
    pub model: String,
    pub speed: u64,
    pub count: usize,
}

/// OS statistics matching `IOSStatistics` in VS Code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsStatistics {
    pub total_mem: u64,
    pub free_mem: u64,
    pub load_avg: [f64; 3],
}

// ─── Existing commands (moved from native_host.rs) ──────────────────────

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

// ─── New commands ───────────────────────────────────────────────────────

/// Check if the current user has administrator/root privileges.
#[tauri::command]
pub fn is_admin() -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(windows)]
    {
        // On Windows, use the shell32 IsUserAnAdmin API
        false // Safe default — proper Windows impl requires windows-sys crate
    }
}

/// Check if the process is running under ARM64 translation (e.g., Rosetta 2).
#[tauri::command]
pub fn is_running_under_arm64_translation() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_is_translated()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Return a heuristic score (0–1) indicating whether the system is a VM.
///
/// Checks common VM indicators:
/// - macOS: `sysctl kern.hv_vmm_present`
/// - Linux: `/sys/class/dmi/id/product_name`
/// - Windows: returns 0 (not yet implemented)
#[tauri::command]
pub fn get_os_virtual_machine_hint() -> f64 {
    #[cfg(target_os = "macos")]
    {
        macos_vm_hint()
    }
    #[cfg(target_os = "linux")]
    {
        linux_vm_hint()
    }
    #[cfg(target_os = "windows")]
    {
        0.0
    }
}

/// Return the current process ID.
#[tauri::command]
pub fn get_process_id() -> u32 {
    std::process::id()
}

/// OS color scheme returned to TypeScript.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsColorScheme {
    pub dark: bool,
    pub high_contrast: bool,
}

/// Get the OS color scheme (dark mode and high contrast).
///
/// On macOS, uses `defaults read` to check dark mode.
/// On other platforms, returns defaults (non-dark, non-high-contrast).
/// The TypeScript side also checks `matchMedia` as a fallback.
#[tauri::command]
pub fn get_os_color_scheme() -> OsColorScheme {
    #[cfg(target_os = "macos")]
    {
        let dark = macos_is_dark_mode();
        OsColorScheme {
            dark,
            high_contrast: false,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        OsColorScheme {
            dark: false,
            high_contrast: false,
        }
    }
}

/// Check if WSL (Windows Subsystem for Linux) feature is installed.
/// Only relevant on Windows.
#[tauri::command]
pub fn has_wsl_feature_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new("C:\\Windows\\System32\\wsl.exe").exists()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Read a string value from the Windows Registry.
///
/// Only implemented on Windows. Returns `None` on other platforms.
#[tauri::command]
pub fn windows_get_string_reg_key(
    _hive: String,
    _path: String,
    _name: String,
) -> Result<Option<String>, NativeHostError> {
    #[cfg(target_os = "windows")]
    {
        // TODO: Use winreg crate for proper implementation
        Ok(None)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

// ─── Platform helpers (moved from native_host.rs) ───────────────────────

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

// ─── New platform helpers ───────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_is_translated() -> bool {
    // Check if running under Rosetta 2 via sysctl
    use std::mem;
    let mut ret: i32 = 0;
    let mut size = mem::size_of::<i32>();
    let name = std::ffi::CString::new("sysctl.proc_translated").unwrap();
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut ret as *mut _ as *mut _,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    result == 0 && ret == 1
}

#[cfg(target_os = "macos")]
fn macos_is_dark_mode() -> bool {
    use std::process::Command;
    Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| {
            o.status.success()
                && String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .eq_ignore_ascii_case("dark")
        })
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn macos_vm_hint() -> f64 {
    use std::mem;
    let mut val: i32 = 0;
    let mut size = mem::size_of::<i32>();
    let name = std::ffi::CString::new("kern.hv_vmm_present").unwrap();
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut val as *mut _ as *mut _,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result == 0 && val == 1 {
        0.5 // hypervisor present — likely VM
    } else {
        0.0
    }
}

#[cfg(target_os = "linux")]
fn linux_vm_hint() -> f64 {
    // Check DMI product name for common VM indicators
    if let Ok(name) = std::fs::read_to_string("/sys/class/dmi/id/product_name") {
        let name_lower = name.trim().to_lowercase();
        if name_lower.contains("virtual")
            || name_lower.contains("vmware")
            || name_lower.contains("qemu")
            || name_lower.contains("kvm")
            || name_lower.contains("hyper-v")
            || name_lower.contains("virtualbox")
        {
            return 0.5;
        }
    }
    0.0
}
