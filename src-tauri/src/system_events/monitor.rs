/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! System event monitor — dispatches platform events to Tauri app.emit().

use std::sync::mpsc;
use tauri::Emitter;

use super::event_names;

/// System events that platform monitors can report.
// TODO(Phase 3): Remove allow(dead_code) when all variants are wired up
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum SystemEvent {
    Suspend,
    Resume,
    LockScreen,
    UnlockScreen,
    WillShutdown,
    DisplayChanged,
    BatteryPowerChanged(bool),
    ThermalStateChanged(String),
    SpeedLimitChanged(f64),
}

/// Initialize the system event monitoring infrastructure.
///
/// Spawns a platform-specific monitor thread that sends events through
/// an `mpsc` channel. A dispatcher thread consumes these events and
/// emits them as Tauri events to the WebView.
pub fn setup(app: &tauri::App) {
    let handle = app.handle().clone();
    let (tx, rx) = mpsc::channel::<SystemEvent>();

    // Spawn the platform-specific monitor
    spawn_platform_monitor(tx);

    // Spawn the dispatcher thread that forwards events to Tauri
    std::thread::Builder::new()
        .name("system-event-dispatcher".into())
        .spawn(move || {
            log::debug!(
                target: "vscodeee",
                "System event dispatcher started, registered events: [{}]",
                [
                    event_names::SUSPEND,
                    event_names::RESUME,
                    event_names::LOCK_SCREEN,
                    event_names::UNLOCK_SCREEN,
                    event_names::WILL_SHUTDOWN,
                    event_names::DISPLAY_CHANGED,
                    event_names::BATTERY_POWER_CHANGED,
                    event_names::THERMAL_STATE_CHANGED,
                    event_names::SPEED_LIMIT_CHANGED,
                ]
                .join(", ")
            );

            while let Ok(event) = rx.recv() {
                log::debug!(target: "vscodeee", "System event received: {:?}", event);
                let result = match &event {
                    SystemEvent::Suspend => handle.emit(event_names::SUSPEND, ()),
                    SystemEvent::Resume => handle.emit(event_names::RESUME, ()),
                    SystemEvent::LockScreen => handle.emit(event_names::LOCK_SCREEN, ()),
                    SystemEvent::UnlockScreen => handle.emit(event_names::UNLOCK_SCREEN, ()),
                    SystemEvent::WillShutdown => handle.emit(event_names::WILL_SHUTDOWN, ()),
                    SystemEvent::DisplayChanged => handle.emit(event_names::DISPLAY_CHANGED, ()),
                    SystemEvent::BatteryPowerChanged(on_battery) => {
                        handle.emit(event_names::BATTERY_POWER_CHANGED, on_battery)
                    }
                    SystemEvent::ThermalStateChanged(state) => {
                        handle.emit(event_names::THERMAL_STATE_CHANGED, state)
                    }
                    SystemEvent::SpeedLimitChanged(limit) => {
                        handle.emit(event_names::SPEED_LIMIT_CHANGED, limit)
                    }
                };

                if let Err(e) = result {
                    log::warn!(target: "vscodeee", "Failed to emit system event: {e}");
                }
            }

            log::info!(target: "vscodeee", "System event dispatcher stopped");
        })
        .expect("Failed to spawn system event dispatcher thread");
}

/// Spawn the platform-specific system event monitor.
fn spawn_platform_monitor(tx: mpsc::Sender<SystemEvent>) {
    #[cfg(target_os = "macos")]
    super::platform_macos::spawn_monitor(tx);

    #[cfg(target_os = "linux")]
    super::platform_linux::spawn_monitor(tx);

    #[cfg(target_os = "windows")]
    super::platform_windows::spawn_monitor(tx);
}
