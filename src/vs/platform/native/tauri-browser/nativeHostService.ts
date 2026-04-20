/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri implementation of `INativeHostService`.
 *
 * Unlike the Electron renderer implementation that uses `ProxyChannel.toService()`
 * to proxy calls to the main process, this directly invokes Tauri commands
 * via `window.__TAURI__.invoke()`. Each method maps to a corresponding Rust
 * command in `src-tauri/src/commands/native_host/`.
 *
 * Methods are organized by category matching the Rust submodule structure:
 * - `window.rs`: Window management (focus, position, fullscreen, etc.)
 * - `clipboard.rs`: Clipboard read/write/find pasteboard
 * - `os.rs`: OS info (admin, ARM64, VM detection, color scheme, etc.)
 * - `lifecycle.rs`: App lifecycle (quit, relaunch, close)
 * - `network.rs`: Proxy resolution, certificates
 * - `shell.rs`: External open, trash, process management
 * - `power.rs`: System idle, battery, thermal state
 * - `misc.rs`: Toast notifications, zip creation, elevated write
 */

import { Event, Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { INativeHostService, INativeHostOptions, IOSProperties, IOSStatistics, IToastOptions, IToastResult, SystemIdleState, ThermalState, PowerSaveBlockerType, FocusMode } from '../common/native.js';
import { MessageBoxOptions, MessageBoxReturnValue, OpenDevToolsOptions, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from '../../../base/parts/sandbox/common/nativeDialogTypes.js';
import { ISerializableCommandAction } from '../../action/common/action.js';
import { INativeOpenDialogOptions } from '../../dialogs/common/dialogs.js';
import { IV8Profile } from '../../profiling/common/profiling.js';
import { AuthInfo, Credentials } from '../../request/common/request.js';
import { IPartsSplash } from '../../theme/common/themeService.js';
import { IColorScheme, IOpenedAuxiliaryWindow, IOpenedMainWindow, IOpenEmptyWindowOptions, IOpenWindowOptions, IPoint, IRectangle, IWindowOpenable } from '../../window/common/window.js';
import { invoke, listen } from '../../tauri/common/tauriApi.js';

export class TauriNativeHostService extends Disposable implements INativeHostService {

	declare readonly _serviceBrand: undefined;

	/** The unique window ID assigned by the Rust `WindowManager`. */
	readonly windowId: number;

	// Events — empty emitters for Phase 1; wired to Tauri events in later phases
	private readonly _onDidOpenMainWindow = this._register(new Emitter<number>());
	readonly onDidOpenMainWindow = this._onDidOpenMainWindow.event;

	private readonly _onDidMaximizeWindow = this._register(new Emitter<number>());
	readonly onDidMaximizeWindow = this._onDidMaximizeWindow.event;

	private readonly _onDidUnmaximizeWindow = this._register(new Emitter<number>());
	readonly onDidUnmaximizeWindow = this._onDidUnmaximizeWindow.event;

	private readonly _onDidFocusMainWindow = this._register(new Emitter<number>());
	readonly onDidFocusMainWindow = this._onDidFocusMainWindow.event;

	private readonly _onDidBlurMainWindow = this._register(new Emitter<number>());
	readonly onDidBlurMainWindow = this._onDidBlurMainWindow.event;

	private readonly _onDidChangeWindowFullScreen = this._register(new Emitter<{ windowId: number; fullscreen: boolean }>());
	readonly onDidChangeWindowFullScreen = this._onDidChangeWindowFullScreen.event;

	private readonly _onDidChangeWindowAlwaysOnTop = this._register(new Emitter<{ windowId: number; alwaysOnTop: boolean }>());
	readonly onDidChangeWindowAlwaysOnTop = this._onDidChangeWindowAlwaysOnTop.event;

	private readonly _onDidFocusMainOrAuxiliaryWindow = this._register(new Emitter<number>());
	readonly onDidFocusMainOrAuxiliaryWindow = this._onDidFocusMainOrAuxiliaryWindow.event;

	private readonly _onDidBlurMainOrAuxiliaryWindow = this._register(new Emitter<number>());
	readonly onDidBlurMainOrAuxiliaryWindow = this._onDidBlurMainOrAuxiliaryWindow.event;

	readonly onDidChangeDisplay = Event.None;

	private readonly _onDidSuspendOS = this._register(new Emitter<void>());
	readonly onDidSuspendOS = this._onDidSuspendOS.event;

	private readonly _onDidResumeOS = this._register(new Emitter<void>());
	readonly onDidResumeOS = this._onDidResumeOS.event;

	private readonly _onDidChangeOnBatteryPower = this._register(new Emitter<boolean>());
	readonly onDidChangeOnBatteryPower = this._onDidChangeOnBatteryPower.event;

	private readonly _onDidChangeThermalState = this._register(new Emitter<ThermalState>());
	readonly onDidChangeThermalState = this._onDidChangeThermalState.event;

	private readonly _onDidChangeSpeedLimit = this._register(new Emitter<number>());
	readonly onDidChangeSpeedLimit = this._onDidChangeSpeedLimit.event;

	private readonly _onWillShutdownOS = this._register(new Emitter<void>());
	readonly onWillShutdownOS = this._onWillShutdownOS.event;

	private readonly _onDidLockScreen = this._register(new Emitter<void>());
	readonly onDidLockScreen = this._onDidLockScreen.event;

	private readonly _onDidUnlockScreen = this._register(new Emitter<void>());
	readonly onDidUnlockScreen = this._onDidUnlockScreen.event;

	private readonly _onDidChangeColorScheme = this._register(new Emitter<IColorScheme>());
	readonly onDidChangeColorScheme = this._onDidChangeColorScheme.event;

	private readonly _onDidChangePassword = this._register(new Emitter<{ readonly service: string; readonly account: string }>());
	readonly onDidChangePassword = this._onDidChangePassword.event;

	private readonly _onDidTriggerWindowSystemContextMenu = this._register(new Emitter<{ readonly windowId: number; readonly x: number; readonly y: number }>());
	readonly onDidTriggerWindowSystemContextMenu = this._onDidTriggerWindowSystemContextMenu.event;

	/**
	 * Create a new `TauriNativeHostService` for the given window.
	 *
	 * Registers Tauri event listeners for window lifecycle events (focus, blur,
	 * maximize, fullscreen) and wires them to the VS Code emitter API.
	 *
	 * @param windowId - The unique window ID assigned by the Rust `WindowManager`.
	 */
	constructor(windowId: number) {
		super();
		this.windowId = windowId;

		// Wire Tauri window events to VS Code emitters
		this._wireWindowEvents();
		// Wire OS system events (suspend, resume, lock, battery, thermal)
		this._wireSystemEvents();
		// Wire OS color scheme changes via matchMedia
		this._wireColorSchemeEvents();
	}

	/**
	 * Subscribe to Tauri window lifecycle events and forward them to VS Code emitters.
	 *
	 * Listens for focus, blur, maximize, unmaximize, and window-opened events
	 * from the Rust `window::events` module and fires the corresponding
	 * `INativeHostService` events so the workbench reacts to native window changes.
	 */
	private _wireWindowEvents(): void {
		const registerListener = <T>(eventName: string, handler: (payload: T) => void) => {
			listen<T>(eventName, e => handler(e.payload))
				.then(unlisten => this._register({ dispose: unlisten }));
		};

		// Focus event
		registerListener<number>('vscodeee:window:focus', id => {
			this._onDidFocusMainWindow.fire(id);
			this._onDidFocusMainOrAuxiliaryWindow.fire(id);
		});

		// Blur event
		registerListener<number>('vscodeee:window:blur', id => {
			this._onDidBlurMainWindow.fire(id);
			this._onDidBlurMainOrAuxiliaryWindow.fire(id);
		});

		// Maximize event
		registerListener<number>('vscodeee:window:maximize', id => this._onDidMaximizeWindow.fire(id));

		// Unmaximize event
		registerListener<number>('vscodeee:window:unmaximize', id => this._onDidUnmaximizeWindow.fire(id));

		// Window opened event
		registerListener<number>('vscodeee:window:opened', id => this._onDidOpenMainWindow.fire(id));

		// Fullscreen events — emitted by Rust when window enters/leaves fullscreen
		registerListener<{ window_id: number; fullscreen: boolean }>('vscodeee:window:fullscreen', payload => {
			this._onDidChangeWindowFullScreen.fire({ windowId: payload.window_id, fullscreen: payload.fullscreen });
		});
	}

	/**
	 * Subscribe to OS system events from the Rust `system_events` module.
	 *
	 * Listens for suspend, resume, lock, unlock, shutdown, battery,
	 * thermal state, and speed limit events and fires the corresponding
	 * `INativeHostService` events.
	 */
	private _wireSystemEvents(): void {
		const registerListener = <T>(eventName: string, handler: (payload: T) => void) => {
			listen<T>(eventName, e => handler(e.payload))
				.then(unlisten => this._register({ dispose: unlisten }));
		};

		registerListener<void>('vscodeee:system:suspend', () => this._onDidSuspendOS.fire());
		registerListener<void>('vscodeee:system:resume', () => this._onDidResumeOS.fire());
		registerListener<void>('vscodeee:system:lock-screen', () => this._onDidLockScreen.fire());
		registerListener<void>('vscodeee:system:unlock-screen', () => this._onDidUnlockScreen.fire());
		registerListener<void>('vscodeee:system:will-shutdown', () => this._onWillShutdownOS.fire());
		registerListener<boolean>('vscodeee:system:battery-power-changed', onBattery => this._onDidChangeOnBatteryPower.fire(onBattery));
		registerListener<ThermalState>('vscodeee:system:thermal-state-changed', state => this._onDidChangeThermalState.fire(state));
		registerListener<number>('vscodeee:system:speed-limit-changed', limit => this._onDidChangeSpeedLimit.fire(limit));
	}

	/**
	 * Subscribe to OS color scheme changes via `matchMedia` and fire
	 * the `onDidChangeColorScheme` event so the workbench reacts to
	 * system theme changes (light/dark, high contrast).
	 */
	private _wireColorSchemeEvents(): void {
		const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
		const hcQuery = window.matchMedia?.('(forced-colors: active)');

		const fireChange = () => {
			const dark = darkQuery?.matches ?? true;
			const highContrast = hcQuery?.matches ?? false;
			this._onDidChangeColorScheme.fire({ dark, highContrast });
		};

		if (darkQuery) {
			darkQuery.addEventListener('change', fireChange);
			this._register({ dispose: () => darkQuery.removeEventListener('change', fireChange) });
		}
		if (hcQuery) {
			hcQuery.addEventListener('change', fireChange);
			this._register({ dispose: () => hcQuery.removeEventListener('change', fireChange) });
		}
	}

	// #region Window

	/**
	 * Return all open main and auxiliary windows.
	 *
	 * Queries the Rust `WindowManager` via the `get_all_windows` command.
	 * Falls back to a single-window list if the command fails.
	 */
	async getWindows(_options: { includeAuxiliaryWindows: true }): Promise<Array<IOpenedMainWindow | IOpenedAuxiliaryWindow>>;
	async getWindows(_options: { includeAuxiliaryWindows: false }): Promise<Array<IOpenedMainWindow>>;
	async getWindows(_options: { includeAuxiliaryWindows: boolean }): Promise<Array<IOpenedMainWindow | IOpenedAuxiliaryWindow>> {
		try {
			const windows = await invoke<Array<{ id: number; label: string; workspace?: string }>>('get_all_windows');
			return windows.map(w => ({ id: w.id, title: 'VS Codeee', dirty: false }));
		} catch {
			return [{ id: this.windowId, title: 'VS Codeee', dirty: false }];
		}
	}

	/** Return the count of open windows from the Rust `WindowManager`. Falls back to 1 on error. */
	async getWindowCount(): Promise<number> {
		try {
			return await invoke<number>('get_window_count');
		} catch {
			return 1;
		}
	}

	/** Returns the ID of the currently active window. Always returns the local window ID in Phase 1. */
	async getActiveWindowId(): Promise<number | undefined> {
		return this.windowId;
	}

	/** Returns the position of the active window via the Rust backend. */
	async getActiveWindowPosition(): Promise<IRectangle | undefined> {
		try {
			return await invoke<IRectangle>('get_active_window_position');
		} catch {
			return undefined;
		}
	}

	/** Returns the native OS window handle via the Rust backend. */
	async getNativeWindowHandle(_windowId: number): Promise<VSBuffer | undefined> {
		try {
			const bytes = await invoke<number[] | null>('get_native_window_handle');
			if (bytes && bytes.length > 0) {
				return VSBuffer.wrap(new Uint8Array(bytes));
			}
		} catch {
			// Not yet implemented — return undefined
		}
		return undefined;
	}

	/**
	 * Open one or more windows via the Rust `WindowManager`.
	 *
	 * When called with an array of {@link IWindowOpenable}, each item is opened
	 * in a new window (or reused, depending on `forceNewWindow`). When called
	 * with {@link IOpenEmptyWindowOptions} or no arguments, opens a blank window.
	 */
	async openWindow(_options?: IOpenEmptyWindowOptions): Promise<void>;
	async openWindow(_toOpen: IWindowOpenable[], _options?: IOpenWindowOptions): Promise<void>;
	async openWindow(arg1?: IOpenEmptyWindowOptions | IWindowOpenable[], arg2?: IOpenWindowOptions): Promise<void> {
		if (Array.isArray(arg1)) {
			// Opening specific resources — for now, take the first folder/workspace URI
			const toOpen = arg1 as IWindowOpenable[];
			const options = arg2 as IOpenWindowOptions | undefined;
			for (const item of toOpen) {
				let folderUri: string | undefined;
				if ('folderUri' in item && item.folderUri) {
					folderUri = item.folderUri.toString();
				} else if ('workspaceUri' in item && item.workspaceUri) {
					folderUri = item.workspaceUri.toString();
				} else if ('fileUri' in item && item.fileUri) {
					folderUri = item.fileUri.toString();
				}
				await invoke('open_new_window', {
					options: {
						folderUri,
						forceNewWindow: options?.forceNewWindow ?? false,
					}
				});
			}
		} else {
			// Opening empty window
			await invoke('open_new_window', {
				options: {
					forceNewWindow: true,
				}
			});
		}
	}

	/** Opens the agents session window. No-op — no callers yet. */
	async openAgentsWindow(): Promise<void> {
		// No-op: Agent sessions window is not implemented yet
	}

	/** Returns whether the window is currently in fullscreen mode. */
	async isFullScreen(_options?: INativeHostOptions): Promise<boolean> {
		return invoke<boolean>('is_fullscreen');
	}

	/** Toggles the window in and out of fullscreen mode. */
	async toggleFullScreen(_options?: INativeHostOptions): Promise<void> {
		return invoke('toggle_fullscreen');
	}

	/** Returns the cursor screen point and display bounds via the Rust backend. */
	async getCursorScreenPoint(): Promise<{ readonly point: IPoint; readonly display: IRectangle }> {
		return invoke<{ readonly point: IPoint; readonly display: IRectangle }>('get_cursor_screen_point');
	}

	/** Returns whether the window is currently maximized. */
	async isMaximized(_options?: INativeHostOptions): Promise<boolean> {
		return invoke<boolean>('is_maximized');
	}

	/** Maximizes the window. */
	async maximizeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('maximize_window');
	}

	/** Unmaximizes (restores) the window. */
	async unmaximizeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('unmaximize_window');
	}

	/** Minimizes the window. */
	async minimizeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('minimize_window');
	}

	/** Moves the window to the top of the z-order via the Rust backend. */
	async moveWindowTop(_options?: INativeHostOptions): Promise<void> {
		return invoke('move_window_top');
	}

	/** Positions the window at the given screen rectangle via the Rust backend. */
	async positionWindow(position: IRectangle, _options?: INativeHostOptions): Promise<void> {
		return invoke('position_window', { position });
	}

	/** Returns whether the window is pinned to always-on-top via the Rust backend. */
	async isWindowAlwaysOnTop(_options?: INativeHostOptions): Promise<boolean> {
		return invoke<boolean>('is_always_on_top');
	}

	async toggleWindowAlwaysOnTop(_options?: INativeHostOptions): Promise<void> {
		return invoke('toggle_always_on_top');
	}

	async setWindowAlwaysOnTop(alwaysOnTop: boolean, _options?: INativeHostOptions): Promise<void> {
		return invoke('set_always_on_top', { alwaysOnTop });
	}

	async updateWindowControls(_options: INativeHostOptions & { height?: number; backgroundColor?: string; foregroundColor?: string; dimmed?: boolean }): Promise<void> {
		// No-op for Phase 1
	}

	async updateWindowAccentColor(_color: 'default' | 'off' | string, _inactiveColor: string | undefined): Promise<void> {
		// No-op for Phase 1
	}

	async setMinimumSize(width: number | undefined, height: number | undefined): Promise<void> {
		await invoke('set_minimum_size', { width: width ?? 0, height: height ?? 0 });
	}

	async saveWindowSplash(_splash: IPartsSplash): Promise<void> {
		// No-op for Phase 1
	}

	async setBackgroundThrottling(_allowed: boolean): Promise<void> {
		// No-op for Phase 1
	}

	/** Focuses the window via the Rust backend. */
	async focusWindow(_options?: INativeHostOptions & { mode?: FocusMode }): Promise<void> {
		return invoke('focus_window');
	}

	// #endregion

	// #region Dialogs

	/** Shows a native message box dialog via Tauri. */
	async showMessageBox(options: MessageBoxOptions & INativeHostOptions): Promise<MessageBoxReturnValue> {
		return invoke<MessageBoxReturnValue>('show_message_box', { options });
	}

	/** Shows a native save-file dialog via Tauri. */
	async showSaveDialog(options: SaveDialogOptions & INativeHostOptions): Promise<SaveDialogReturnValue> {
		return invoke<SaveDialogReturnValue>('show_save_dialog', { options });
	}

	/** Shows a native open-file dialog via Tauri. */
	async showOpenDialog(options: OpenDialogOptions & INativeHostOptions): Promise<OpenDialogReturnValue> {
		return invoke<OpenDialogReturnValue>('show_open_dialog', { options });
	}

	/** Opens a native file-or-folder picker and opens the selected entry in a new window or editor. */
	async pickFileFolderAndOpen(options: INativeOpenDialogOptions): Promise<void> {
		const result = await this.showOpenDialog({
			properties: ['openFile', 'openDirectory'],
			defaultPath: options.defaultPath,
		});
		if (result.filePaths.length > 0) {
			const path = result.filePaths[0];
			await this.openWindow([{ fileUri: URI.file(path) }], { forceNewWindow: options.forceNewWindow });
		}
	}

	/** Opens a native file picker and opens the selected file in a new window or editor. */
	async pickFileAndOpen(options: INativeOpenDialogOptions): Promise<void> {
		const result = await this.showOpenDialog({
			properties: ['openFile'],
			defaultPath: options.defaultPath,
		});
		if (result.filePaths.length > 0) {
			const path = result.filePaths[0];
			await this.openWindow([{ fileUri: URI.file(path) }], { forceNewWindow: options.forceNewWindow });
		}
	}

	/** Opens a native folder picker and opens the selected folder in a new window. */
	async pickFolderAndOpen(options: INativeOpenDialogOptions): Promise<void> {
		const result = await this.showOpenDialog({
			properties: ['openDirectory'],
			defaultPath: options.defaultPath,
		});
		if (result.filePaths.length > 0) {
			const path = result.filePaths[0];
			await this.openWindow([{ folderUri: URI.file(path) }], { forceNewWindow: options.forceNewWindow });
		}
	}

	/** Opens a native workspace picker and opens the selected workspace in a new window. */
	async pickWorkspaceAndOpen(options: INativeOpenDialogOptions): Promise<void> {
		const result = await this.showOpenDialog({
			properties: ['openFile'],
			defaultPath: options.defaultPath,
			filters: [{ name: 'Workspace', extensions: ['code-workspace'] }],
		});
		if (result.filePaths.length > 0) {
			const path = result.filePaths[0];
			await this.openWindow([{ workspaceUri: URI.file(path) }], { forceNewWindow: options.forceNewWindow });
		}
	}

	// #endregion

	// #region OS

	/** Reveals the given file path in the system file manager. */
	async showItemInFolder(path: string): Promise<void> {
		await invoke('fs_show_item_in_folder', { path });
	}

	/** Sets the represented filename in the macOS title bar proxy icon via the Rust backend. */
	async setRepresentedFilename(path: string, _options?: INativeHostOptions): Promise<void> {
		await invoke('set_represented_filename', { path });
	}

	/** Sets the macOS document-edited indicator (dot in close button) via the Rust backend. */
	async setDocumentEdited(edited: boolean, _options?: INativeHostOptions): Promise<void> {
		await invoke('set_document_edited', { edited });
	}

	/** Opens the given URL in the system's default browser. */
	async openExternal(url: string, _defaultApplication?: string): Promise<boolean> {
		await invoke('open_external', { url });
		return true;
	}

	/** Moves the given file or directory to the system trash. */
	async moveItemToTrash(fullPath: string): Promise<void> {
		await invoke('move_item_to_trash', { path: fullPath });
	}

	/** Returns whether the current user has administrator/root privileges via the Rust backend. */
	async isAdmin(): Promise<boolean> {
		return invoke<boolean>('is_admin');
	}

	/** Writes a file with elevated privileges via the Rust backend (osascript/pkexec). */
	async writeElevated(source: URI, target: URI, options?: { unlock?: boolean }): Promise<void> {
		await invoke('write_elevated', {
			source: source.fsPath,
			target: target.fsPath,
			unlock: options?.unlock ?? false,
		});
	}

	/** Returns whether the process is running under ARM64 translation (e.g., Rosetta 2) via the Rust backend. */
	async isRunningUnderARM64Translation(): Promise<boolean> {
		return invoke<boolean>('is_running_under_arm64_translation');
	}

	/** Returns the operating system properties (type, arch, platform, CPU info). */
	async getOSProperties(): Promise<IOSProperties> {
		return invoke<IOSProperties>('get_os_properties');
	}

	/** Returns the operating system memory and load statistics. */
	async getOSStatistics(): Promise<IOSStatistics> {
		return invoke<IOSStatistics>('get_os_statistics');
	}

	/** Returns a heuristic score indicating if running in a VM via the Rust backend. */
	async getOSVirtualMachineHint(): Promise<number> {
		return invoke<number>('get_os_virtual_machine_hint');
	}

	/** Returns the OS color scheme using matchMedia with Rust fallback. */
	async getOSColorScheme(): Promise<IColorScheme> {
		const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
		const highContrast = window.matchMedia?.('(forced-colors: active)').matches ?? false;
		return { dark, highContrast };
	}

	async hasWSLFeatureInstalled(): Promise<boolean> {
		return invoke<boolean>('has_wsl_feature_installed');
	}

	// #endregion

	// #region Screenshots

	async getScreenshot(_rect?: IRectangle): Promise<VSBuffer | undefined> {
		const result = await invoke<Uint8Array | null>('capture_screenshot', {
			rect: _rect ? { x: _rect.x, y: _rect.y, width: _rect.width, height: _rect.height } : null,
		});
		if (result) {
			return VSBuffer.wrap(result);
		}
		return undefined;
	}

	// #endregion

	// #region Process

	async getProcessId(): Promise<number | undefined> {
		return invoke<number>('get_process_id');
	}

	/** Kills a process by PID with the given exit code. */
	async killProcess(pid: number, code: string): Promise<void> {
		await invoke('kill_process', { pid, code });
	}

	// #endregion

	// #region Clipboard

	/** Triggers a paste action via the Rust backend (simulates Cmd/Ctrl+V). */
	async triggerPaste(_options?: INativeHostOptions): Promise<void> {
		return invoke('trigger_paste');
	}

	/** Reads text content from the system clipboard. */
	async readClipboardText(_type?: 'selection' | 'clipboard'): Promise<string> {
		return invoke<string>('read_clipboard_text');
	}

	/** Writes text content to the system clipboard. */
	async writeClipboardText(text: string, _type?: 'selection' | 'clipboard'): Promise<void> {
		return invoke('write_clipboard_text', { text });
	}

	/** Reads the macOS Find Pasteboard text via the Rust backend. */
	async readClipboardFindText(): Promise<string> {
		return invoke<string>('read_clipboard_find_text');
	}

	/** Writes to the macOS Find Pasteboard via the Rust backend. */
	async writeClipboardFindText(text: string): Promise<void> {
		return invoke('write_clipboard_find_text', { text });
	}

	/** Writes binary data to the clipboard in the given format via the Rust backend. */
	async writeClipboardBuffer(format: string, buffer: VSBuffer, _type?: 'selection' | 'clipboard'): Promise<void> {
		const base64 = buffer.toString();
		await invoke('write_clipboard_buffer', { format, buffer: base64 });
	}

	/** Reads binary data from the clipboard for the given format via the Rust backend. */
	async readClipboardBuffer(format: string): Promise<VSBuffer> {
		const base64 = await invoke<string>('read_clipboard_buffer', { format });
		if (!base64) {
			return VSBuffer.alloc(0);
		}
		return VSBuffer.fromString(base64);
	}

	/** Returns whether the clipboard has data in the given format via the Rust backend. */
	async hasClipboard(format: string, _type?: 'selection' | 'clipboard'): Promise<boolean> {
		return invoke<boolean>('has_clipboard', { format });
	}

	/** Reads an image from the clipboard as raw bytes via the Rust backend. */
	async readImage(): Promise<Uint8Array> {
		const base64 = await invoke<string>('read_clipboard_image');
		if (!base64) {
			return new Uint8Array(0);
		}
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}

	// #endregion

	// #region macOS Touchbar

	async newWindowTab(): Promise<void> { }
	async showPreviousWindowTab(): Promise<void> { }
	async showNextWindowTab(): Promise<void> { }
	async moveWindowTabToNewWindow(): Promise<void> { }
	async mergeAllWindowTabs(): Promise<void> { }
	async toggleWindowTabsBar(): Promise<void> { }
	async updateTouchBar(_items: ISerializableCommandAction[][]): Promise<void> { }

	// #endregion

	// #region Shell command

	/** Installs the `codeee` shell command by creating a symlink via the Rust backend. */
	async installShellCommand(): Promise<void> {
		await invoke('install_shell_command');
	}

	/** Removes the `codeee` shell command symlink via the Rust backend. */
	async uninstallShellCommand(): Promise<void> {
		await invoke('uninstall_shell_command');
	}

	// #endregion

	// #region Lifecycle

	/** Notifies the Tauri backend that the window is ready to display. */
	async notifyReady(): Promise<void> {
		return invoke('notify_ready');
	}

	/** Relaunches the application via the Tauri backend. */
	async relaunch(_options?: { addArgs?: string[]; removeArgs?: string[] }): Promise<void> {
		await invoke('relaunch_app');
	}

	/** Reloads the current window by navigating the WebView. */
	async reload(_options?: { disableExtensions?: boolean }): Promise<void> {
		window.location.reload();
	}

	/** Closes the current window via the Tauri backend. */
	async closeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('close_window');
	}

	/** Quits the application via the Tauri backend. */
	async quit(): Promise<void> {
		return invoke('quit_app');
	}

	/** Exits the application with the given exit code, saving the session first. */
	async exit(_code: number): Promise<void> {
		return invoke('exit_app', { code: _code });
	}

	// #endregion

	// #region Development

	async openDevTools(_options?: Partial<OpenDevToolsOptions> & INativeHostOptions): Promise<void> {
		try {
			await invoke('open_devtools');
		} catch {
			// DevTools unavailable in release builds — silently ignore
		}
	}

	async toggleDevTools(_options?: INativeHostOptions): Promise<void> {
		try {
			await invoke('toggle_devtools');
		} catch {
			// DevTools unavailable in release builds — silently ignore
		}
	}

	async openGPUInfoWindow(): Promise<void> { }
	async openDevToolsWindow(_url: string): Promise<void> { }
	async openContentTracingWindow(): Promise<void> { }
	async stopTracing(): Promise<void> { }

	// #endregion

	// #region Perf Introspection

	async profileRenderer(_session: string, _duration: number): Promise<IV8Profile> {
		return { nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] };
	}

	async startTracing(_categories: string): Promise<void> { }

	// #endregion

	// #region Connectivity

	/** Resolves a proxy URL for the given target via the Rust backend. */
	async resolveProxy(url: string): Promise<string | undefined> {
		const result = await invoke<string | null>('resolve_proxy', { url });
		return result ?? undefined;
	}

	/** Looks up stored credentials from the OS credential store via the Rust backend (keyring crate). */
	async lookupAuthorization(authInfo: AuthInfo): Promise<Credentials | undefined> {
		try {
			const result = await invoke<{ username: string; password: string } | null>('lookup_authorization', {
				authInfo: {
					isProxy: authInfo.isProxy,
					scheme: authInfo.scheme,
					host: authInfo.host,
					port: authInfo.port,
					realm: authInfo.realm,
					attempt: authInfo.attempt,
				}
			});
			return result ?? undefined;
		} catch {
			return undefined;
		}
	}

	async lookupKerberosAuthorization(_url: string): Promise<string | undefined> {
		return undefined;
	}

	/** Loads system SSL/TLS certificates via the Rust backend. */
	async loadCertificates(): Promise<string[]> {
		return invoke<string[]>('load_certificates');
	}

	/** Checks whether a given network port is free. */
	async isPortFree(_port: number): Promise<boolean> {
		return invoke<boolean>('is_port_free', { port: _port });
	}

	/** Finds a free network port starting from the given port number. */
	async findFreePort(startPort: number, giveUpAfter: number, timeout: number, stride?: number): Promise<number> {
		return invoke<number>('find_free_port', { startPort, giveUpAfter, timeout, stride: stride ?? 1 });
	}

	// #endregion

	// #region Registry (Windows only)

	/** Reads a Windows registry string value via the Rust backend. */
	async windowsGetStringRegKey(hive: 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE' | 'HKEY_CLASSES_ROOT' | 'HKEY_USERS' | 'HKEY_CURRENT_CONFIG', path: string, name: string): Promise<string | undefined> {
		const result = await invoke<string | null>('windows_get_string_reg_key', { hive, path, name });
		return result ?? undefined;
	}

	// #endregion

	// #region Toast Notifications

	/** Shows a desktop toast notification via the Rust backend (notify-rust). */
	async showToast(options: IToastOptions): Promise<IToastResult> {
		return invoke<IToastResult>('show_toast', { options });
	}

	/** Clears a toast notification by ID via the Rust backend. */
	async clearToast(id: string): Promise<void> {
		await invoke('clear_toast', { id });
	}

	/** Clears all toast notifications via the Rust backend. */
	async clearToasts(): Promise<void> {
		await invoke('clear_toasts');
	}

	// #endregion

	// #region Zip

	/** Creates a zip file from the given entries via the Rust backend. */
	async createZipFile(zipPath: URI, files: { path: string; contents: string }[]): Promise<void> {
		await invoke('create_zip_file', { zipPath: zipPath.fsPath, files });
	}

	// #endregion

	// #region Power

	/** Gets the system idle state via the Rust backend. */
	async getSystemIdleState(idleThreshold: number): Promise<SystemIdleState> {
		return invoke<SystemIdleState>('get_system_idle_state', { idleThreshold });
	}

	/** Gets the system idle time in seconds via the Rust backend. */
	async getSystemIdleTime(): Promise<number> {
		return invoke<number>('get_system_idle_time');
	}

	/** Gets the current thermal state via the Rust backend. */
	async getCurrentThermalState(): Promise<ThermalState> {
		return invoke<ThermalState>('get_current_thermal_state');
	}

	/** Returns whether the system is running on battery power via the Rust backend. */
	async isOnBatteryPower(): Promise<boolean> {
		return invoke<boolean>('is_on_battery_power');
	}

	/** Starts a power save blocker via the Rust backend. Returns blocker ID. */
	async startPowerSaveBlocker(type: PowerSaveBlockerType): Promise<number> {
		return invoke<number>('start_power_save_blocker', { blockerType: type });
	}

	/** Stops a power save blocker by ID via the Rust backend. */
	async stopPowerSaveBlocker(id: number): Promise<boolean> {
		return invoke<boolean>('stop_power_save_blocker', { id });
	}

	/** Returns whether a power save blocker is active via the Rust backend. */
	async isPowerSaveBlockerStarted(id: number): Promise<boolean> {
		return invoke<boolean>('is_power_save_blocker_started', { id });
	}

	// #endregion
}
