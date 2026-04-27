/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from './window.js';
import type { IJSONSchemaSnippet } from '../common/jsonSchema.js';
import { isMacintosh, isTauri, isWindows } from '../common/platform.js';

/**
 * The best font-family to be used in CSS based on the platform:
 * - Windows: Segoe preferred, fallback to sans-serif
 * - macOS: standard system font, fallback to sans-serif
 * - Linux: standard system font preferred, fallback to Ubuntu fonts
 *
 * Note: this currently does not adjust for different locales.
 */
export const DEFAULT_FONT_FAMILY = isWindows ? '"Segoe WPC", "Segoe UI", sans-serif' : isMacintosh ? '-apple-system, BlinkMacSystemFont, sans-serif' : 'system-ui, "Ubuntu", "Droid Sans", sans-serif';

interface FontData {
	/** Font family name as reported by the browser or system API. */
	readonly family: string;
}

/** Minimal shape of the Tauri `core` API used for font enumeration. */
interface ITauriCore {
	invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

/**
 * Retrieve all available font family names from the system.
 *
 * In Tauri environments, invokes the `enumerate_fonts` Tauri command which
 * delegates to platform-specific APIs (Core Text on macOS, registry on
 * Windows, `fc-list` on Linux). In Electron environments, falls back to
 * `window.queryLocalFonts()`.
 *
 * Returns an empty array if the platform does not support font enumeration
 * or if an error occurs.
 *
 * @returns A promise that resolves to an array of font family name strings.
 */
export const getFonts = async (): Promise<string[]> => {
	if (isTauri) {
		try {
			const tauri = (globalThis as Record<string, unknown>).__TAURI__ as { core: ITauriCore } | undefined;
			if (tauri?.core) {
				return await tauri.core.invoke<string[]>('enumerate_fonts');
			}
		} catch (error) {
			console.error(`Failed to enumerate fonts via Tauri: ${error}`);
		}
		return [];
	}

	try {
		// @ts-ignore
		const fonts = await mainWindow.queryLocalFonts() as FontData[];
		return [...fonts].map(font => font.family);
	} catch (error) {
		console.error(`Failed to query fonts: ${error}`);
		return [];
	}
};


/**
 * Retrieve all available font family names as JSON schema snippet objects.
 *
 * Each snippet has a `body` property set to the font family name, suitable
 * for use in completion widgets or settings schemas.
 *
 * @returns A promise that resolves to an array of `IJSONSchemaSnippet` objects.
 */
export const getFontSnippets = async (): Promise<IJSONSchemaSnippet[]> => {
	const fonts = await getFonts();
	return fonts.map(font => ({ body: font }));
};
