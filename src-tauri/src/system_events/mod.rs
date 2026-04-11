/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! System event monitoring — OS-level events (suspend, resume, lock, battery, thermal)
//! forwarded to the WebView via Tauri's `app.emit()` mechanism.
//!
//! Each platform module spawns a background thread that listens for native events
//! and sends them through a channel to the main dispatcher, which emits them as
//! Tauri events for the TypeScript layer to consume.

mod monitor;

#[cfg(target_os = "macos")]
mod platform_macos;

#[cfg(target_os = "linux")]
mod platform_linux;

#[cfg(target_os = "windows")]
mod platform_windows;

pub use monitor::setup;

/// Event name constants for Tauri `app.emit()` calls.
/// These must match the `listen()` calls in `nativeHostService.ts`.
pub mod event_names {
    pub const SUSPEND: &str = "vscodeee:system:suspend";
    pub const RESUME: &str = "vscodeee:system:resume";
    pub const LOCK_SCREEN: &str = "vscodeee:system:lock-screen";
    pub const UNLOCK_SCREEN: &str = "vscodeee:system:unlock-screen";
    pub const WILL_SHUTDOWN: &str = "vscodeee:system:will-shutdown";
    pub const DISPLAY_CHANGED: &str = "vscodeee:system:display-changed";
    pub const BATTERY_POWER_CHANGED: &str = "vscodeee:system:battery-power-changed";
    pub const THERMAL_STATE_CHANGED: &str = "vscodeee:system:thermal-state-changed";
    pub const SPEED_LIMIT_CHANGED: &str = "vscodeee:system:speed-limit-changed";
}
