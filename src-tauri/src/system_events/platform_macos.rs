/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! macOS system event monitor — skeleton using NSWorkspace notifications.
//!
//! This is a placeholder that logs initialization. Full implementation
//! using `objc2` + CFRunLoop observers will be added in a future PR.

use std::sync::mpsc;

use super::monitor::SystemEvent;

/// Spawn the macOS system event monitor thread.
///
/// Currently a skeleton that logs startup. Future implementation will
/// use `objc2` to observe `NSWorkspace` notifications for sleep/wake,
/// screen lock/unlock, and thermal state changes.
pub fn spawn_monitor(tx: mpsc::Sender<SystemEvent>) {
    // Leak the sender intentionally to keep the dispatcher channel alive.
    // In stub mode no events are sent; the real implementation will use `tx`
    // to forward native OS events.  Process exit reclaims the memory.
    std::mem::forget(tx);

    std::thread::Builder::new()
        .name("system-event-monitor-macos".into())
        .spawn(|| {
            log::debug!(
                target: "vscodeee",
                "macOS system event monitor thread started (stub)"
            );

            // TODO: Subscribe to NSWorkspace notifications:
            // - NSWorkspaceWillSleepNotification → SystemEvent::Suspend
            // - NSWorkspaceDidWakeNotification → SystemEvent::Resume
            // - NSWorkspaceScreensDidSleepNotification → SystemEvent::LockScreen
            // - NSWorkspaceScreensDidWakeNotification → SystemEvent::UnlockScreen
            // - NSWorkspaceWillPowerOffNotification → SystemEvent::WillShutdown
            // - NSProcessInfo.thermalState KVO → SystemEvent::ThermalStateChanged
            // - IOPSNotificationCreateRunLoopSource → SystemEvent::BatteryPowerChanged

            // Block indefinitely — thread sleep is the most reliable blocking
            // mechanism for stub monitors (park() can spuriously wake, channel
            // recv() relies on sender lifetime).
            std::thread::sleep(std::time::Duration::MAX);
        })
        .expect("Failed to spawn macOS system event monitor");
}
