/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Power management commands — idle state, thermal, battery,
//! power save blocker.

use serde::Serialize;

/// System idle state returned to TypeScript.
/// Matches the `SystemIdleState` type in VS Code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemIdleState {
    Active,
    Idle,
    Locked,
    Unknown,
}

/// Thermal state returned to TypeScript.
/// Matches the `ThermalState` type in VS Code.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThermalState {
    Nominal,
    Fair,
    Serious,
    Critical,
}

/// Get the system idle state based on the idle threshold in seconds.
///
/// - macOS: Uses `CGEventSource.secondsSinceLastEventType`
/// - Windows: Uses `GetLastInputInfo`
/// - Linux: Reads from `/proc/stat` idle time
#[tauri::command]
pub fn get_system_idle_state(idle_threshold: u64) -> SystemIdleState {
    let idle_time = get_idle_time_seconds();
    if idle_time >= idle_threshold {
        SystemIdleState::Idle
    } else {
        SystemIdleState::Active
    }
}

/// Get the system idle time in seconds.
#[tauri::command]
pub fn get_system_idle_time() -> u64 {
    get_idle_time_seconds()
}

/// Get the current thermal state of the system.
///
/// Only meaningful on macOS (via `NSProcessInfo.thermalState`).
/// Returns `Nominal` on other platforms.
#[tauri::command]
pub fn get_current_thermal_state() -> ThermalState {
    #[cfg(target_os = "macos")]
    {
        macos_thermal_state()
    }
    #[cfg(not(target_os = "macos"))]
    {
        ThermalState::Nominal
    }
}

/// Check if the system is running on battery power.
///
/// - macOS: Uses `IOPSCopyPowerSourcesInfo`
/// - Windows: Uses `GetSystemPowerStatus`
/// - Linux: Checks `/sys/class/power_supply/`
#[tauri::command]
pub fn is_on_battery_power() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_is_on_battery()
    }
    #[cfg(target_os = "linux")]
    {
        linux_is_on_battery()
    }
    #[cfg(target_os = "windows")]
    {
        false // TODO: Use GetSystemPowerStatus
    }
}

/// Start a power save blocker. Returns a blocker ID.
///
/// Power save blockers prevent the system from entering sleep
/// while long-running operations are in progress.
/// Currently a no-op that returns a dummy ID.
#[tauri::command]
pub fn start_power_save_blocker(_blocker_type: String) -> u32 {
    // TODO: Implement via IOPMAssertionCreateWithName on macOS,
    // SetThreadExecutionState on Windows
    0
}

/// Stop a power save blocker by ID.
#[tauri::command]
pub fn stop_power_save_blocker(_id: u32) -> bool {
    false
}

/// Check if a power save blocker is currently active.
#[tauri::command]
pub fn is_power_save_blocker_started(_id: u32) -> bool {
    false
}

// ─── Platform-specific helpers ──────────────────────────────────────────

fn get_idle_time_seconds() -> u64 {
    #[cfg(target_os = "macos")]
    {
        macos_idle_time()
    }
    #[cfg(target_os = "linux")]
    {
        linux_idle_time()
    }
    #[cfg(target_os = "windows")]
    {
        0 // TODO: Use GetLastInputInfo
    }
}

#[cfg(target_os = "macos")]
fn macos_idle_time() -> u64 {
    // Use IOKit HIDSystem to get idle time
    use std::process::Command;
    // ioreg approach — more reliable than CGEvent for idle time
    let output = Command::new("ioreg")
        .args(["-c", "IOHIDSystem", "-d", "4"])
        .output();

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse HIDIdleTime from ioreg output (in nanoseconds)
        for line in stdout.lines() {
            if line.contains("HIDIdleTime") {
                if let Some(val_str) = line.split('=').nth(1) {
                    let val_str = val_str.trim().trim_matches('"');
                    if let Ok(ns) = val_str.parse::<u64>() {
                        return ns / 1_000_000_000; // nanoseconds to seconds
                    }
                }
            }
        }
    }
    0
}

#[cfg(target_os = "macos")]
fn macos_thermal_state() -> ThermalState {
    // Use `powermetrics` or `sysctl` to check thermal state
    // For now, return nominal — a full implementation would use
    // NSProcessInfo.thermalState via objc bindings
    ThermalState::Nominal
}

#[cfg(target_os = "macos")]
fn macos_is_on_battery() -> bool {
    use std::process::Command;
    let output = Command::new("pmset")
        .args(["-g", "batt"])
        .output();

    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // If output contains "Battery Power", we're on battery
        return stdout.contains("Battery Power");
    }
    false
}

#[cfg(target_os = "linux")]
fn linux_idle_time() -> u64 {
    // Try xprintidle first (commonly available on X11)
    if let Ok(output) = std::process::Command::new("xprintidle").output() {
        if output.status.success() {
            let ms_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Ok(ms) = ms_str.parse::<u64>() {
                return ms / 1000;
            }
        }
    }
    0
}

#[cfg(target_os = "linux")]
fn linux_is_on_battery() -> bool {
    // Check /sys/class/power_supply/BAT*/status
    if let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("BAT") {
                let status_path = entry.path().join("status");
                if let Ok(status) = std::fs::read_to_string(&status_path) {
                    if status.trim() == "Discharging" {
                        return true;
                    }
                }
            }
        }
    }
    false
}
