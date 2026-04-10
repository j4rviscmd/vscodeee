/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IHostColorSchemeService } from '../common/hostColorSchemeService.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

/**
 * Tauri-specific implementation of {@link IHostColorSchemeService}.
 *
 * WKWebView on macOS does not reliably fire `matchMedia('prefers-color-scheme')`
 * change events. This implementation supplements the standard `matchMedia`
 * listener with Tauri's native `Window.onThemeChanged()` API, which reliably
 * fires when the OS appearance changes.
 *
 * Uses the `window.__TAURI__.window` global (injected by `withGlobalTauri: true`)
 * rather than npm `@tauri-apps/api` imports, consistent with the `tauriApi.ts` facade.
 */
export class TauriHostColorSchemeService extends Disposable implements IHostColorSchemeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidSchemeChangeEvent = this._register(new Emitter<void>());

	private _dark: boolean;
	private _highContrast: boolean;

	constructor() {
		super();

		// Initialize from matchMedia
		this._dark = mainWindow.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
		this._highContrast = mainWindow.matchMedia?.('(forced-colors: active)').matches ?? false;

		this._registerMatchMediaListeners();
		this._registerTauriThemeListener();
	}

	private _registerMatchMediaListeners(): void {
		const darkQuery = mainWindow.matchMedia?.('(prefers-color-scheme: dark)');
		const hcQuery = mainWindow.matchMedia?.('(forced-colors: active)');

		if (darkQuery) {
			const handler = () => {
				this._dark = darkQuery.matches;
				this._onDidSchemeChangeEvent.fire();
			};
			darkQuery.addEventListener('change', handler);
			this._register({ dispose: () => darkQuery.removeEventListener('change', handler) });
		}
		if (hcQuery) {
			const handler = () => {
				this._highContrast = hcQuery.matches;
				this._onDidSchemeChangeEvent.fire();
			};
			hcQuery.addEventListener('change', handler);
			this._register({ dispose: () => hcQuery.removeEventListener('change', handler) });
		}
	}

	/**
	 * Use Tauri's native `Window.onThemeChanged()` via the `__TAURI__` global
	 * as a reliable fallback for detecting OS appearance changes, since
	 * WKWebView's matchMedia change events may not fire on macOS.
	 */
	private _registerTauriThemeListener(): void {
		const tauriGlobal = (globalThis as any).__TAURI__;

		if (!tauriGlobal?.window?.getCurrentWindow) {
			return;
		}

		const currentWindow = tauriGlobal.window.getCurrentWindow();

		if (typeof currentWindow?.onThemeChanged !== 'function') {
			return;
		}

		// Tauri v2 __TAURI__ global's onThemeChanged passes the full event object
		// { event: 'tauri://theme-changed', payload: 'dark' | 'light', id: number }
		currentWindow.onThemeChanged((event: { payload: string }) => {
			this._dark = event.payload === 'dark';
			this._onDidSchemeChangeEvent.fire();
		}).then((unlisten: () => void) => {
			this._register({ dispose: unlisten });
		}).catch((_err: unknown) => {
			// Fall back to matchMedia-only detection
		});
	}

	get onDidChangeColorScheme(): Event<void> {
		return this._onDidSchemeChangeEvent.event;
	}

	get dark(): boolean {
		return this._dark;
	}

	get highContrast(): boolean {
		return this._highContrast;
	}
}

registerSingleton(IHostColorSchemeService, TauriHostColorSchemeService, InstantiationType.Delayed);
