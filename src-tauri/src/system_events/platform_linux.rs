/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Linux system event monitor — D-Bus stub.
//!
//! Future implementation will use `zbus` to listen for
//! `org.freedesktop.login1.Manager` signals (PrepareForSleep, Lock/Unlock).

use std::sync::mpsc;

use super::monitor::SystemEvent;

/// Spawn the Linux system event monitor thread (stub).
pub fn spawn_monitor(tx: mpsc::Sender<SystemEvent>) {
	// Leak the sender to keep the dispatcher channel alive (see macOS module).
	std::mem::forget(tx);

	std::thread::Builder::new()
		.name("system-event-monitor-linux".into())
		.spawn(|| {
			log::info!(
				target: "vscodeee",
				"Linux system event monitor thread started (stub)"
			);

			// TODO: Use zbus to subscribe to:
			// - org.freedesktop.login1.Manager.PrepareForSleep(true) → Suspend
			// - org.freedesktop.login1.Manager.PrepareForSleep(false) → Resume
			// - org.freedesktop.login1.Session.Lock → LockScreen
			// - org.freedesktop.login1.Session.Unlock → UnlockScreen

			std::thread::sleep(std::time::Duration::MAX);
		})
		.expect("Failed to spawn Linux system event monitor");
}
