/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared Tauri IPC helper for the terminal browser layer.
 *
 * All terminal-related Tauri invoke calls should use this helper
 * instead of duplicating the __TAURI_INTERNALS__ access pattern.
 */

/**
 * Call a Tauri command via IPC and return the result.
 *
 * Falls back to `window.__TAURI_INTERNALS__.invoke` which is the
 * standard Tauri v2 WebView API.
 */
export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	const w = globalThis as unknown as {
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T>;
		};
	};
	if (w.__TAURI_INTERNALS__?.invoke) {
		return w.__TAURI_INTERNALS__.invoke(cmd, args);
	}
	throw new Error('Tauri IPC not available');
}
