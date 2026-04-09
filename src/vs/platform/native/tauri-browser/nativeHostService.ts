/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri implementation of `INativeHostService`.
 *
 * Unlike the Electron renderer implementation that uses `ProxyChannel.toService()`
 * to proxy calls to the main process, this directly invokes Tauri commands.
 * Methods are incrementally implemented as each Phase progresses.
 *
 * Phase 1: Window lifecycle, basic OS info, clipboard (most methods stubbed).
 */

import { Event, Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { INativeHostService, INativeHostOptions, IOSProperties, IOSStatistics, IToastOptions, IToastResult, SystemIdleState, ThermalState, PowerSaveBlockerType, FocusMode } from '../common/native.js';
import { MessageBoxOptions, MessageBoxReturnValue, OpenDevToolsOptions, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from '../../../base/parts/sandbox/common/electronTypes.js';
import { ISerializableCommandAction } from '../../action/common/action.js';
import { INativeOpenDialogOptions } from '../../dialogs/common/dialogs.js';
import { IV8Profile } from '../../profiling/common/profiling.js';
import { AuthInfo, Credentials } from '../../request/common/request.js';
import { IPartsSplash } from '../../theme/common/themeService.js';
import { IColorScheme, IOpenedAuxiliaryWindow, IOpenedMainWindow, IOpenEmptyWindowOptions, IOpenWindowOptions, IPoint, IRectangle, IWindowOpenable } from '../../window/common/window.js';
import { invoke, listen } from '../../tauri/common/tauriApi.js';

function notImplemented(method: string): never {
	throw new Error(`[TauriNativeHostService] ${method} is not yet implemented.`);
}

export class TauriNativeHostService extends Disposable implements INativeHostService {

	declare readonly _serviceBrand: undefined;

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
	readonly onDidSuspendOS = Event.None;
	readonly onDidResumeOS = Event.None;
	readonly onDidChangeOnBatteryPower = Event.None;
	readonly onDidChangeThermalState = Event.None;
	readonly onDidChangeSpeedLimit = Event.None;
	readonly onWillShutdownOS = Event.None;
	readonly onDidLockScreen = Event.None;
	readonly onDidUnlockScreen = Event.None;

	private readonly _onDidChangeColorScheme = this._register(new Emitter<IColorScheme>());
	readonly onDidChangeColorScheme = this._onDidChangeColorScheme.event;

	private readonly _onDidChangePassword = this._register(new Emitter<{ readonly service: string; readonly account: string }>());
	readonly onDidChangePassword = this._onDidChangePassword.event;

	private readonly _onDidTriggerWindowSystemContextMenu = this._register(new Emitter<{ readonly windowId: number; readonly x: number; readonly y: number }>());
	readonly onDidTriggerWindowSystemContextMenu = this._onDidTriggerWindowSystemContextMenu.event;

	constructor(windowId: number) {
		super();
		this.windowId = windowId;

		// Wire Tauri window events to VS Code emitters
		this._wireWindowEvents();
	}

	/**
	 * Subscribe to Tauri window lifecycle events and forward them to VS Code emitters.
	 *
	 * Listens for focus, blur, maximize, unmaximize, and window-opened events
	 * from the Rust `window::events` module and fires the corresponding
	 * `INativeHostService` events so the workbench reacts to native window changes.
	 */
	private _wireWindowEvents(): void {
		// Focus event
		listen<number>('vscodeee:window:focus', (event) => {
			const id = event.payload;
			this._onDidFocusMainWindow.fire(id);
			this._onDidFocusMainOrAuxiliaryWindow.fire(id);
		}).then(unlisten => this._register({ dispose: unlisten }));

		// Blur event
		listen<number>('vscodeee:window:blur', (event) => {
			const id = event.payload;
			this._onDidBlurMainWindow.fire(id);
			this._onDidBlurMainOrAuxiliaryWindow.fire(id);
		}).then(unlisten => this._register({ dispose: unlisten }));

		// Maximize event
		listen<number>('vscodeee:window:maximize', (event) => {
			this._onDidMaximizeWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));

		// Unmaximize event
		listen<number>('vscodeee:window:unmaximize', (event) => {
			this._onDidUnmaximizeWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));

		// Window opened event
		listen<number>('vscodeee:window:opened', (event) => {
			this._onDidOpenMainWindow.fire(event.payload);
		}).then(unlisten => this._register({ dispose: unlisten }));
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

	async getActiveWindowId(): Promise<number | undefined> {
		return this.windowId;
	}

	async getActiveWindowPosition(): Promise<IRectangle | undefined> {
		return undefined;
	}

	async getNativeWindowHandle(_windowId: number): Promise<VSBuffer | undefined> {
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

	async openAgentsWindow(): Promise<void> {
		notImplemented('openAgentsWindow');
	}

	async isFullScreen(_options?: INativeHostOptions): Promise<boolean> {
		return invoke<boolean>('is_fullscreen');
	}

	async toggleFullScreen(_options?: INativeHostOptions): Promise<void> {
		return invoke('toggle_fullscreen');
	}

	async getCursorScreenPoint(): Promise<{ readonly point: IPoint; readonly display: IRectangle }> {
		notImplemented('getCursorScreenPoint');
	}

	async isMaximized(_options?: INativeHostOptions): Promise<boolean> {
		return invoke<boolean>('is_maximized');
	}

	async maximizeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('maximize_window');
	}

	async unmaximizeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('unmaximize_window');
	}

	async minimizeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('minimize_window');
	}

	async moveWindowTop(_options?: INativeHostOptions): Promise<void> {
		notImplemented('moveWindowTop');
	}

	async positionWindow(_position: IRectangle, _options?: INativeHostOptions): Promise<void> {
		notImplemented('positionWindow');
	}

	async isWindowAlwaysOnTop(_options?: INativeHostOptions): Promise<boolean> {
		return false;
	}

	async toggleWindowAlwaysOnTop(_options?: INativeHostOptions): Promise<void> {
		notImplemented('toggleWindowAlwaysOnTop');
	}

	async setWindowAlwaysOnTop(_alwaysOnTop: boolean, _options?: INativeHostOptions): Promise<void> {
		notImplemented('setWindowAlwaysOnTop');
	}

	async updateWindowControls(_options: INativeHostOptions & { height?: number; backgroundColor?: string; foregroundColor?: string; dimmed?: boolean }): Promise<void> {
		// No-op for Phase 1
	}

	async updateWindowAccentColor(_color: 'default' | 'off' | string, _inactiveColor: string | undefined): Promise<void> {
		// No-op for Phase 1
	}

	async setMinimumSize(_width: number | undefined, _height: number | undefined): Promise<void> {
		// No-op for Phase 1
	}

	async saveWindowSplash(_splash: IPartsSplash): Promise<void> {
		// No-op for Phase 1
	}

	async setBackgroundThrottling(_allowed: boolean): Promise<void> {
		// No-op for Phase 1
	}

	async focusWindow(_options?: INativeHostOptions & { mode?: FocusMode }): Promise<void> {
		return invoke('focus_window');
	}

	// #endregion

	// #region Dialogs

	async showMessageBox(options: MessageBoxOptions & INativeHostOptions): Promise<MessageBoxReturnValue> {
		return invoke<MessageBoxReturnValue>('show_message_box', { options });
	}

	async showSaveDialog(options: SaveDialogOptions & INativeHostOptions): Promise<SaveDialogReturnValue> {
		return invoke<SaveDialogReturnValue>('show_save_dialog', { options });
	}

	async showOpenDialog(options: OpenDialogOptions & INativeHostOptions): Promise<OpenDialogReturnValue> {
		return invoke<OpenDialogReturnValue>('show_open_dialog', { options });
	}

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

	async pickWorkspaceAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		notImplemented('pickWorkspaceAndOpen');
	}

	// #endregion

	// #region OS

	async showItemInFolder(path: string): Promise<void> {
		await invoke('fs_show_item_in_folder', { path });
	}

	async setRepresentedFilename(_path: string, _options?: INativeHostOptions): Promise<void> {
		// No-op: macOS-specific feature
	}

	async setDocumentEdited(_edited: boolean, _options?: INativeHostOptions): Promise<void> {
		// No-op: macOS-specific feature
	}

	async openExternal(url: string, _defaultApplication?: string): Promise<boolean> {
		await invoke('open_external', { url });
		return true;
	}

	async moveItemToTrash(fullPath: string): Promise<void> {
		await invoke('move_item_to_trash', { path: fullPath });
	}

	async isAdmin(): Promise<boolean> {
		return false;
	}

	async writeElevated(_source: URI, _target: URI, _options?: { unlock?: boolean }): Promise<void> {
		notImplemented('writeElevated');
	}

	async isRunningUnderARM64Translation(): Promise<boolean> {
		return false;
	}

	async getOSProperties(): Promise<IOSProperties> {
		return invoke<IOSProperties>('get_os_properties');
	}

	async getOSStatistics(): Promise<IOSStatistics> {
		return invoke<IOSStatistics>('get_os_statistics');
	}

	async getOSVirtualMachineHint(): Promise<number> {
		return 0;
	}

	async getOSColorScheme(): Promise<IColorScheme> {
		return { dark: true, highContrast: false };
	}

	async hasWSLFeatureInstalled(): Promise<boolean> {
		return false;
	}

	// #endregion

	// #region Screenshots

	async getScreenshot(_rect?: IRectangle): Promise<VSBuffer | undefined> {
		return undefined;
	}

	// #endregion

	// #region Process

	async getProcessId(): Promise<number | undefined> {
		return undefined;
	}

	async killProcess(pid: number, code: string): Promise<void> {
		await invoke('kill_process', { pid, code });
	}

	// #endregion

	// #region Clipboard

	async triggerPaste(_options?: INativeHostOptions): Promise<void> {
		notImplemented('triggerPaste');
	}

	async readClipboardText(_type?: 'selection' | 'clipboard'): Promise<string> {
		return invoke<string>('read_clipboard_text');
	}

	async writeClipboardText(text: string, _type?: 'selection' | 'clipboard'): Promise<void> {
		return invoke('write_clipboard_text', { text });
	}

	async readClipboardFindText(): Promise<string> {
		return '';
	}

	async writeClipboardFindText(_text: string): Promise<void> {
		// No-op
	}

	async writeClipboardBuffer(_format: string, _buffer: VSBuffer, _type?: 'selection' | 'clipboard'): Promise<void> {
		notImplemented('writeClipboardBuffer');
	}

	async readClipboardBuffer(_format: string): Promise<VSBuffer> {
		return VSBuffer.alloc(0);
	}

	async hasClipboard(_format: string, _type?: 'selection' | 'clipboard'): Promise<boolean> {
		return false;
	}

	async readImage(): Promise<Uint8Array> {
		return new Uint8Array(0);
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

	// #region macOS Shell command

	async installShellCommand(): Promise<void> {
		await invoke('install_shell_command');
	}

	async uninstallShellCommand(): Promise<void> {
		await invoke('uninstall_shell_command');
	}

	// #endregion

	// #region Lifecycle

	async notifyReady(): Promise<void> {
		return invoke('notify_ready');
	}

	async relaunch(_options?: { addArgs?: string[]; removeArgs?: string[] }): Promise<void> {
		await invoke('relaunch_app');
	}

	async reload(_options?: { disableExtensions?: boolean }): Promise<void> {
		window.location.reload();
	}

	async closeWindow(_options?: INativeHostOptions): Promise<void> {
		return invoke('close_window');
	}

	async quit(): Promise<void> {
		return invoke('quit_app');
	}

	async exit(_code: number): Promise<void> {
		return invoke('exit_app', { code: _code });
	}

	// #endregion

	// #region Development

	async openDevTools(_options?: Partial<OpenDevToolsOptions> & INativeHostOptions): Promise<void> {
		// Cannot open DevTools in system WebView — no-op
	}

	async toggleDevTools(_options?: INativeHostOptions): Promise<void> {
		// Cannot toggle DevTools in system WebView — no-op
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

	async resolveProxy(_url: string): Promise<string | undefined> {
		return undefined;
	}

	async lookupAuthorization(_authInfo: AuthInfo): Promise<Credentials | undefined> {
		return undefined;
	}

	async lookupKerberosAuthorization(_url: string): Promise<string | undefined> {
		return undefined;
	}

	async loadCertificates(): Promise<string[]> {
		return [];
	}

	async isPortFree(_port: number): Promise<boolean> {
		return invoke<boolean>('is_port_free', { port: _port });
	}

	async findFreePort(startPort: number, giveUpAfter: number, timeout: number, stride?: number): Promise<number> {
		return invoke<number>('find_free_port', { startPort, giveUpAfter, timeout, stride: stride ?? 1 });
	}

	// #endregion

	// #region Registry (Windows only)

	async windowsGetStringRegKey(_hive: 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE' | 'HKEY_CLASSES_ROOT' | 'HKEY_USERS' | 'HKEY_CURRENT_CONFIG', _path: string, _name: string): Promise<string | undefined> {
		return undefined;
	}

	// #endregion

	// #region Toast Notifications

	async showToast(_options: IToastOptions): Promise<IToastResult> {
		return { supported: false, clicked: false };
	}

	async clearToast(_id: string): Promise<void> { }
	async clearToasts(): Promise<void> { }

	// #endregion

	// #region Zip

	async createZipFile(_zipPath: URI, _files: { path: string; contents: string }[]): Promise<void> {
		notImplemented('createZipFile');
	}

	// #endregion

	// #region Power

	async getSystemIdleState(_idleThreshold: number): Promise<SystemIdleState> {
		return 'active';
	}

	async getSystemIdleTime(): Promise<number> {
		return 0;
	}

	async getCurrentThermalState(): Promise<ThermalState> {
		return 'nominal';
	}

	async isOnBatteryPower(): Promise<boolean> {
		return false;
	}

	async startPowerSaveBlocker(_type: PowerSaveBlockerType): Promise<number> {
		return 0;
	}

	async stopPowerSaveBlocker(_id: number): Promise<boolean> {
		return false;
	}

	async isPowerSaveBlockerStarted(_id: number): Promise<boolean> {
		return false;
	}

	// #endregion
}
