/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Windows system event monitor — Win32 stub.
//!
//! Future implementation will use Win32 `RegisterPowerSettingNotification`
//! and `WTSRegisterSessionNotification` for power/session events.

use std::sync::mpsc;

use super::monitor::SystemEvent;

/// Spawn the Windows system event monitor thread (stub).
pub fn spawn_monitor(tx: mpsc::Sender<SystemEvent>) {
	// Leak the sender to keep the dispatcher channel alive (see macOS module).
	std::mem::forget(tx);

	std::thread::Builder::new()
		.name("system-event-monitor-windows".into())
		.spawn(|| {
			log::info!(
				target: "vscodeee",
				"Windows system event monitor thread started (stub)"
			);

			// TODO: Use Win32 APIs:
			// - RegisterPowerSettingNotification for sleep/wake
			// - WTSRegisterSessionNotification for lock/unlock
			// - SYSTEM_POWER_STATUS for battery state

			std::thread::sleep(std::time::Duration::MAX);
		})
		.expect("Failed to spawn Windows system event monitor");
}
