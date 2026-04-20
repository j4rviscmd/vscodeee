/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

// -- Setting IDs --

export const TRANSPARENCY_SETTING_PREFIX = 'vscodeee.transparency';
export const TRANSPARENCY_OPACITY_SETTING = 'vscodeee.transparency.opacity';
export const TRANSPARENCY_BLUR_SETTING = 'vscodeee.transparency.blur';
export const TRANSPARENCY_BACKGROUND_IMAGE_SETTING = 'vscodeee.transparency.backgroundImage';
export const TRANSPARENCY_BACKGROUND_IMAGE_OPACITY_SETTING = 'vscodeee.transparency.backgroundImageOpacity';
export const TRANSPARENCY_BACKGROUND_IMAGE_BLUR_SETTING = 'vscodeee.transparency.backgroundImageBlur';
export const TRANSPARENCY_NATIVE_SETTING = 'vscodeee.transparency.nativeTransparency';
export const TRANSPARENCY_NATIVE_EFFECT_SETTING = 'vscodeee.transparency.nativeEffect';

// -- Enums --

export const enum NativeEffect {
	Auto = 'auto',
	Mica = 'mica',
	Acrylic = 'acrylic',
	Vibrancy = 'vibrancy',
	None = 'none'
}

// -- Configuration model (Domain) --

export interface ITransparencyConfiguration {
	/** Part background opacity (0-100, 100 = fully opaque) */
	readonly opacity: number;
	/** Backdrop-filter blur radius in px (0-50) */
	readonly blur: number;
	/** Background image path (empty = none) */
	readonly backgroundImage: string;
	/** Background image opacity (0-100) */
	readonly backgroundImageOpacity: number;
	/** Background image blur in px (0-50) */
	readonly backgroundImageBlur: number;
	/** Enable OS-native window transparency (requires restart) */
	readonly nativeTransparency: boolean;
	/** Native effect type */
	readonly nativeEffect: NativeEffect;
}

// -- Default configuration --

export const DEFAULT_TRANSPARENCY_CONFIG: ITransparencyConfiguration = {
	opacity: 100,
	blur: 0,
	backgroundImage: '',
	backgroundImageOpacity: 30,
	backgroundImageBlur: 0,
	nativeTransparency: false,
	nativeEffect: NativeEffect.Auto,
};

// -- CSS Selectors for transparent parts --

/** All workbench part selectors that should be made transparent */
export const TRANSPARENT_PART_SELECTORS = [
	'.monaco-workbench',
	'.monaco-workbench .part.editor',
	'.monaco-workbench .part.sidebar',
	'.monaco-workbench .part.panel',
	'.monaco-workbench .part.titlebar',
	'.monaco-workbench .part.statusbar',
	'.monaco-workbench .part.activitybar',
	'.monaco-workbench .part.auxiliarybar',
] as const;

// -- Service interface --

export const ITransparencyService = createDecorator<ITransparencyService>('transparencyService');

export interface ITransparencyService {
	readonly _serviceBrand: undefined;

	/** Current configuration */
	readonly configuration: ITransparencyConfiguration;

	/** Fires when any transparency setting changes */
	readonly onDidChangeConfiguration: Event<ITransparencyConfiguration>;

	/**
	 * Apply the current transparency configuration to the DOM.
	 * Called automatically on setting changes and theme switches.
	 */
	apply(): void;

	/**
	 * Remove all transparency effects and restore defaults.
	 */
	reset(): void;

	/**
	 * Enable OS-native window transparency via Tauri.
	 * This requires a window restart and macOS Private API.
	 * No-op on non-Tauri environments.
	 */
	enableNativeTransparency(): Promise<void>;

	/**
	 * Disable OS-native window transparency.
	 * Requires a window restart.
	 */
	disableNativeTransparency(): Promise<void>;
}
