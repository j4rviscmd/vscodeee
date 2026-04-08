/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Centralized facade for the Tauri API.
 *
 * Uses `window.__TAURI__` globals (injected by Tauri runtime when
 * `withGlobalTauri: true` in tauri.conf.json) instead of npm imports.
 * This avoids bare module specifier issues in browser ESM environments.
 *
 * All Tauri-specific calls go through this module so that:
 * - The API surface is mockable for unit tests.
 * - Future Tauri version upgrades only affect this single file.
 */

/* eslint-disable no-restricted-globals */

export type UnlistenFn = () => void;

interface ITauriGlobal {
	core: {
		invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
	};
	event: {
		emit(event: string, payload?: unknown): Promise<void>;
		listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn>;
	};
}

function getTauriGlobal(): ITauriGlobal {
	const tauri = (globalThis as any).__TAURI__;
	if (!tauri) {
		throw new Error('Tauri API not available. Ensure withGlobalTauri is true in tauri.conf.json.');
	}
	return tauri as ITauriGlobal;
}

/**
 * Invoke a Tauri command (Rust backend).
 *
 * @param command - The name of the Rust `#[tauri::command]` to call.
 * @param args - Optional arguments passed as a JSON object.
 * @returns A promise resolving to the command's return value.
 */
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	return getTauriGlobal().core.invoke<T>(command, args);
}

/**
 * Emit a Tauri event from the WebView to Rust.
 *
 * @param event - Event name.
 * @param payload - Optional payload (must be serializable).
 */
export function emit(event: string, payload?: unknown): Promise<void> {
	return getTauriGlobal().event.emit(event, payload);
}

/**
 * Listen for Tauri events emitted from Rust.
 *
 * @param event - Event name to listen for.
 * @param handler - Callback invoked with the event payload.
 * @returns A function that unsubscribes the listener.
 */
export function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
	return getTauriGlobal().event.listen<T>(event, handler);
}
