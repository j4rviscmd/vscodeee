/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri-specific drag-and-drop integration.
 *
 * In Tauri/WKWebView, the HTML5 Drag and Drop API does not expose native
 * file paths for OS-dropped files. This module:
 *
 * 1. Listens for Tauri's `tauri://drag-drop` event to capture native file paths
 * 2. Registers a custom `getPathForFile` resolver via the platform D&D hook
 * 3. Stores a temporary mapping of `File.name` → native path for the drop handler
 *
 * NOTE: When `dragDropEnabled: false` is set in tauri.conf.json (required for
 * HTML5 D&D to work on macOS WKWebView), Tauri's native D&D events are disabled
 * and this bridge will not receive `tauri://drag-drop` payloads. External file
 * drop path resolution will need an alternative approach in a follow-up issue.
 */

import { registerCustomGetPathForFile } from '../browser/dnd.js';
import { listen } from '../../tauri/common/tauriApi.js';

interface TauriDropPayload {
	paths: string[];
	position: { x: number; y: number };
}

const droppedFilePaths = new Map<string, string>();

let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Initialize the Tauri D&D bridge.
 *
 * Must be called once during application startup, before any D&D operations
 * can occur. Registers a custom file path resolver and listens for Tauri's
 * OS-level drag-drop events to capture native file paths.
 */
export async function initTauriDnD(): Promise<void> {
	// TODO: File.name collisions possible when dropping identically-named files
	// from different directories. Use a more unique key (e.g., file size + name + lastModified).
	registerCustomGetPathForFile((file: File): string | undefined => {
		return droppedFilePaths.get(file.name);
	});

	// TODO: The UnlistenFn returned by listen() should be registered with the
	// caller's DisposableStore for proper lifecycle management.
	await listen<TauriDropPayload>('tauri://drag-drop', (event) => {
		droppedFilePaths.clear();
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
		}

		for (const path of event.payload.paths) {
			// Extract the file name from the path (handles both / and \ separators)
			const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
			const fileName = separatorIndex >= 0 ? path.substring(separatorIndex + 1) : path;
			droppedFilePaths.set(fileName, path);
		}

		// Clear after a short delay to avoid stale entries
		cleanupTimer = setTimeout(() => {
			droppedFilePaths.clear();
			cleanupTimer = undefined;
		}, 1000);
	});
}
