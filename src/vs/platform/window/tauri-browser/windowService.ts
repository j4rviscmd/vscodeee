/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { invoke, listen } from '../../tauri/common/tauriApi.js';

/**
 * Information about a Tauri window, as returned by the Rust WindowManager.
 */
export interface ITauriWindowInfo {
	readonly id: number;
	readonly label: string;
	readonly workspace?: string;
	readonly isFocused: boolean;
}

/**
 * Service providing Tauri-specific window management capabilities.
 *
 * This service bridges the Rust `WindowManager` with the TypeScript workbench,
 * exposing window lifecycle events and query methods via dependency injection.
 */
export const ITauriWindowService = createDecorator<ITauriWindowService>('tauriWindowService');

export interface ITauriWindowService {
	readonly _serviceBrand: undefined;

	/** Fires when a window gains focus. Payload is the window ID. */
	readonly onDidFocusWindow: Event<number>;

	/** Fires when a window loses focus. Payload is the window ID. */
	readonly onDidBlurWindow: Event<number>;

	/** Fires when a window is maximized. Payload is the window ID. */
	readonly onDidMaximizeWindow: Event<number>;

	/** Fires when a window is unmaximized. Payload is the window ID. */
	readonly onDidUnmaximizeWindow: Event<number>;

	/** Fires when a new window is opened. Payload is the window ID. */
	readonly onDidOpenWindow: Event<number>;

	/** Fires when a window is closed. Payload is the window ID. */
	readonly onDidCloseWindow: Event<number>;

	/** Get all open windows from the Rust WindowManager. */
	getWindows(): Promise<ITauriWindowInfo[]>;

	/** Get the number of open windows. */
	getWindowCount(): Promise<number>;

	/** Get the ID of the currently focused window, or undefined. */
	getFocusedWindowId(): number | undefined;
}

/**
 * Default implementation of {@link ITauriWindowService}.
 *
 * Subscribes to Tauri window lifecycle events emitted by the Rust
 * `window::events` module and re-exposes them as VS Code `Event<T>` instances.
 * Query methods delegate to the Rust `WindowManager` via `invoke()`.
 *
 * Lifecycle: Created as a singleton via dependency injection and disposed
 * when the workbench shuts down. All Tauri event listeners are cleaned up
 * automatically via the `Disposable` base class.
 */
export class TauriWindowService extends Disposable implements ITauriWindowService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidFocusWindow = this._register(new Emitter<number>());
	readonly onDidFocusWindow = this._onDidFocusWindow.event;

	private readonly _onDidBlurWindow = this._register(new Emitter<number>());
	readonly onDidBlurWindow = this._onDidBlurWindow.event;

	private readonly _onDidMaximizeWindow = this._register(new Emitter<number>());
	readonly onDidMaximizeWindow = this._onDidMaximizeWindow.event;

	private readonly _onDidUnmaximizeWindow = this._register(new Emitter<number>());
	readonly onDidUnmaximizeWindow = this._onDidUnmaximizeWindow.event;

	private readonly _onDidOpenWindow = this._register(new Emitter<number>());
	readonly onDidOpenWindow = this._onDidOpenWindow.event;

	private readonly _onDidCloseWindow = this._register(new Emitter<number>());
	readonly onDidCloseWindow = this._onDidCloseWindow.event;

	/** Tracks the currently focused window ID, updated by focus/blur events. */
	private _focusedWindowId: number | undefined;

	constructor() {
		super();
		this._wireEvents();
	}

	/**
	 * Subscribe to Tauri window events and forward them to the corresponding emitters.
	 *
	 * Each `listen()` call returns an `unlisten` function that is registered as a
	 * disposable so it is cleaned up when this service is disposed.
	 */
	private _wireEvents(): void {
		listen<number>('vscodeee:window:focus', (event) => {
			this._focusedWindowId = event.payload;
			this._onDidFocusWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));

		listen<number>('vscodeee:window:blur', (event) => {
			if (this._focusedWindowId === event.payload) {
				this._focusedWindowId = undefined;
			}
			this._onDidBlurWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));

		listen<number>('vscodeee:window:maximize', (event) => {
			this._onDidMaximizeWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));

		listen<number>('vscodeee:window:unmaximize', (event) => {
			this._onDidUnmaximizeWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));

		listen<number>('vscodeee:window:opened', (event) => {
			this._onDidOpenWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));

		listen<number>('vscodeee:window:close', (event) => {
			this._onDidCloseWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));
	}

	/** Retrieve all open windows from the Rust `WindowManager` via `get_all_windows`. */
	async getWindows(): Promise<ITauriWindowInfo[]> {
		try {
			return await invoke<ITauriWindowInfo[]>('get_all_windows');
		} catch {
			return [];
		}
	}

	/** Return the number of currently open windows via `get_window_count`. Falls back to 1 on error. */
	async getWindowCount(): Promise<number> {
		try {
			return await invoke<number>('get_window_count');
		} catch {
			return 1;
		}
	}

	/** Return the ID of the currently focused window, or `undefined` if no window has focus. */
	getFocusedWindowId(): number | undefined {
		return this._focusedWindowId;
	}
}
