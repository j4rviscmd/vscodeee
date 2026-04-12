/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { AppResourcePath, FileAccess } from '../../../../base/common/network.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { KeymapInfo, IRawMixedKeyboardMapping, IKeymapInfo } from '../common/keymapInfo.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { DispatchConfig, readKeyboardConfig } from '../../../../platform/keyboardLayout/common/keyboardConfig.js';
import { IKeyboardMapper, CachedKeyboardMapper } from '../../../../platform/keyboardLayout/common/keyboardMapper.js';
import { OS, OperatingSystem, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { WindowsKeyboardMapper } from '../common/windowsKeyboardMapper.js';
import { FallbackKeyboardMapper } from '../common/fallbackKeyboardMapper.js';
import { IKeyboardEvent } from '../../../../platform/keybinding/common/keybinding.js';
import { MacLinuxKeyboardMapper } from '../common/macLinuxKeyboardMapper.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { parse, getNodeType } from '../../../../base/common/json.js';
import * as objects from '../../../../base/common/objects.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigExtensions, IConfigurationRegistry, IConfigurationNode } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INavigatorWithKeyboard } from './navigatorKeyboard.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { getKeyboardLayoutId, IKeyboardLayoutInfo, IKeyboardLayoutService, IKeyboardMapping, IMacLinuxKeyboardMapping, IWindowsKeyboardMapping } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';

/**
 * Base class for browser-based keyboard mapper factories.
 *
 * Manages a registry of known keyboard layouts, tracks the currently active
 * layout via an MRU (most-recently-used) list, and creates the appropriate
 * `IKeyboardMapper` for the detected platform (Windows, macOS, or Linux).
 *
 * Listens for `navigator.keyboard.layoutchange` events and configuration
 * changes to automatically re-evaluate the active keyboard mapping.
 */
export class BrowserKeyboardMapperFactoryBase extends Disposable {
	// keyboard mapper
	protected _initialized: boolean;
	protected _keyboardMapper: IKeyboardMapper | null;
	private readonly _onDidChangeKeyboardMapper = this._register(new Emitter<void>());
	public readonly onDidChangeKeyboardMapper: Event<void> = this._onDidChangeKeyboardMapper.event;

	// keymap infos
	protected _keymapInfos: KeymapInfo[];
	protected _mru: KeymapInfo[];
	private _activeKeymapInfo: KeymapInfo | null;
	private keyboardLayoutMapAllowed: boolean = (navigator as INavigatorWithKeyboard).keyboard !== undefined;

	/** The currently active keymap, or `null` if no layout has been detected yet. */
	get activeKeymap(): KeymapInfo | null {
		return this._activeKeymapInfo;
	}

	/** All registered keymap info entries. */
	get keymapInfos(): KeymapInfo[] {
		return this._keymapInfos;
	}

	/** The layout metadata for the currently active keyboard layout, or `null` if not initialized. */
	get activeKeyboardLayout(): IKeyboardLayoutInfo | null {
		if (!this._initialized) {
			return null;
		}

		return this._activeKeymapInfo?.layout ?? null;
	}

	/** The raw key mapping of the currently active keyboard layout, or `null` if not initialized. */
	get activeKeyMapping(): IKeyboardMapping | null {
		if (!this._initialized) {
			return null;
		}

		return this._activeKeymapInfo?.mapping ?? null;
	}

	/** Layout metadata for all registered keymap infos. */
	get keyboardLayouts(): IKeyboardLayoutInfo[] {
		return this._keymapInfos.map(keymapInfo => keymapInfo.layout);
	}

	protected constructor(
		private readonly _configurationService: IConfigurationService,
		// private _notificationService: INotificationService,
		// private _storageService: IStorageService,
		// private _commandService: ICommandService
	) {
		super();
		this._keyboardMapper = null;
		this._initialized = false;
		this._keymapInfos = [];
		this._mru = [];
		this._activeKeymapInfo = null;

		if ((<INavigatorWithKeyboard>navigator).keyboard && (<INavigatorWithKeyboard>navigator).keyboard.addEventListener) {
			(<INavigatorWithKeyboard>navigator).keyboard.addEventListener!('layoutchange', () => {
				// Update user keyboard map settings
				this._getBrowserKeyMapping().then((mapping: IKeyboardMapping | null) => {
					if (this.isKeyMappingActive(mapping)) {
						return;
					}

					this.setLayoutFromBrowserAPI();
				});
			});
		}

		this._register(this._configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('keyboard')) {
				this._keyboardMapper = null;
				this._onDidChangeKeyboardMapper.fire();
			}
		}));
	}

	/**
	 * Register a new keyboard layout.
	 *
	 * The layout is appended to the keymap registry and the MRU list
	 * is reset to include all registered layouts.
	 *
	 * @param layout - The keymap info to register.
	 */
	registerKeyboardLayout(layout: KeymapInfo) {
		this._keymapInfos.push(layout);
		this._mru = this._keymapInfos;
	}

	/**
	 * Remove a previously registered keyboard layout from both the
	 * MRU list and the keymap registry.
	 *
	 * @param layout - The keymap info to remove.
	 */
	removeKeyboardLayout(layout: KeymapInfo): void {
		let index = this._mru.indexOf(layout);
		this._mru.splice(index, 1);
		index = this._keymapInfos.indexOf(layout);
		this._keymapInfos.splice(index, 1);
	}

	/**
	 * Find the best-matching keymap for the given key mapping.
	 *
	 * Uses the US Standard layout as a baseline. Each registered layout
	 * is scored against the provided mapping; a score of `0` indicates an
	 * exact match. If no US Standard layout exists, falls back to a
	 * fuzzy equality check against the MRU list.
	 *
	 * @param keyMapping - The raw key mapping to match, or `null`.
	 * @returns The best match with its score, or `null` if no match is found.
	 */
	getMatchedKeymapInfo(keyMapping: IKeyboardMapping | null): { result: KeymapInfo; score: number } | null {
		if (!keyMapping) {
			return null;
		}

		const usStandard = this.getUSStandardLayout();

		if (usStandard) {
			let maxScore = usStandard.getScore(keyMapping);
			if (maxScore === 0) {
				return {
					result: usStandard,
					score: 0
				};
			}

			let result = usStandard;
			for (let i = 0; i < this._mru.length; i++) {
				const score = this._mru[i].getScore(keyMapping);
				if (score > maxScore) {
					if (score === 0) {
						return {
							result: this._mru[i],
							score: 0
						};
					}

					maxScore = score;
					result = this._mru[i];
				}
			}

			return {
				result,
				score: maxScore
			};
		}

		for (let i = 0; i < this._mru.length; i++) {
			if (this._mru[i].fuzzyEqual(keyMapping)) {
				return {
					result: this._mru[i],
					score: 0
				};
			}
		}

		return null;
	}

	/**
	 * Return the US Standard keyboard layout from the MRU list, if one is registered.
	 *
	 * @returns The first US Standard layout, or `null` if none exists.
	 */
	getUSStandardLayout() {
		const usStandardLayouts = this._mru.filter(layout => layout.layout.isUSStandard);

		if (usStandardLayouts.length) {
			return usStandardLayouts[0];
		}

		return null;
	}

	/**
	 * Check whether the given key mapping is currently the active mapping.
	 *
	 * @param keymap - The key mapping to check, or `null`.
	 * @returns `true` if the active keymap fuzzily equals the given mapping.
	 */
	isKeyMappingActive(keymap: IKeyboardMapping | null) {
		return this._activeKeymapInfo && keymap && this._activeKeymapInfo.fuzzyEqual(keymap);
	}

	/** Set the active keyboard layout to the US Standard layout. */
	setUSKeyboardLayout() {
		this._activeKeymapInfo = this.getUSStandardLayout();
	}

	/**
	 * Determine and set the active keyboard layout based on a raw key mapping.
	 *
	 * Scores the provided mapping against all registered layouts and selects
	 * the best match. Falls back to the US Standard layout if no match is found.
	 * The matched layout is moved to the front of the MRU list and the keyboard
	 * mapper is rebuilt.
	 *
	 * @param keymap - The raw key mapping detected from the browser, or `null`.
	 */
	setActiveKeyMapping(keymap: IKeyboardMapping | null) {
		let keymapUpdated = false;
		const matchedKeyboardLayout = this.getMatchedKeymapInfo(keymap);
		if (matchedKeyboardLayout) {
			// let score = matchedKeyboardLayout.score;

			// Due to https://bugs.chromium.org/p/chromium/issues/detail?id=977609, any key after a dead key will generate a wrong mapping,
			// we shoud avoid yielding the false error.
			// if (keymap && score < 0) {
			// const donotAskUpdateKey = 'missing.keyboardlayout.donotask';
			// if (this._storageService.getBoolean(donotAskUpdateKey, StorageScope.APPLICATION)) {
			// 	return;
			// }

			// the keyboard layout doesn't actually match the key event or the keymap from chromium
			// this._notificationService.prompt(
			// 	Severity.Info,
			// 	nls.localize('missing.keyboardlayout', 'Fail to find matching keyboard layout'),
			// 	[{
			// 		label: nls.localize('keyboardLayoutMissing.configure', "Configure"),
			// 		run: () => this._commandService.executeCommand('workbench.action.openKeyboardLayoutPicker')
			// 	}, {
			// 		label: nls.localize('neverAgain', "Don't Show Again"),
			// 		isSecondary: true,
			// 		run: () => this._storageService.store(donotAskUpdateKey, true, StorageScope.APPLICATION)
			// 	}]
			// );

			// console.warn('Active keymap/keyevent does not match current keyboard layout', JSON.stringify(keymap), this._activeKeymapInfo ? JSON.stringify(this._activeKeymapInfo.layout) : '');

			// return;
			// }

			if (!this._activeKeymapInfo) {
				this._activeKeymapInfo = matchedKeyboardLayout.result;
				keymapUpdated = true;
			} else if (keymap) {
				if (matchedKeyboardLayout.result.getScore(keymap) > this._activeKeymapInfo.getScore(keymap)) {
					this._activeKeymapInfo = matchedKeyboardLayout.result;
					keymapUpdated = true;
				}
			}
		}

		if (!this._activeKeymapInfo) {
			this._activeKeymapInfo = this.getUSStandardLayout();
			keymapUpdated = true;
		}

		if (!this._activeKeymapInfo || !keymapUpdated) {
			return;
		}

		const index = this._mru.indexOf(this._activeKeymapInfo);

		this._mru.splice(index, 1);
		this._mru.unshift(this._activeKeymapInfo);

		this._setKeyboardData(this._activeKeymapInfo);
	}

	/**
	 * Set the active keyboard layout directly from a `KeymapInfo` instance.
	 *
	 * Moves the given keymap to the front of the MRU list and rebuilds
	 * the keyboard mapper. No-op if the keymap is already at position 0.
	 *
	 * @param keymapInfo - The keymap to activate.
	 */
	setActiveKeymapInfo(keymapInfo: KeymapInfo) {
		this._activeKeymapInfo = keymapInfo;

		const index = this._mru.indexOf(this._activeKeymapInfo);

		if (index === 0) {
			return;
		}

		this._mru.splice(index, 1);
		this._mru.unshift(this._activeKeymapInfo);

		this._setKeyboardData(this._activeKeymapInfo);
	}

	/**
	 * Trigger an asynchronous keyboard layout update using the Browser Keyboard API.
	 *
	 * Reads the current layout map from `navigator.keyboard.getLayoutMap()` and
	 * updates the active mapping if it has changed. No-op if the factory is not
	 * yet initialized.
	 */
	public setLayoutFromBrowserAPI(): void {
		this._updateKeyboardLayoutAsync(this._initialized);
	}

	/**
	 * Asynchronously query the Browser Keyboard API for the current layout
	 * and update the active mapping if it has changed.
	 *
	 * @param initialized - Whether the factory has been initialized.
	 * @param keyboardEvent - Optional keyboard event used as a fallback layout probe.
	 */
	private _updateKeyboardLayoutAsync(initialized: boolean, keyboardEvent?: IKeyboardEvent) {
		if (!initialized) {
			return;
		}

		this._getBrowserKeyMapping(keyboardEvent).then(keyMap => {
			// might be false positive
			if (this.isKeyMappingActive(keyMap)) {
				return;
			}
			this.setActiveKeyMapping(keyMap);
		});
	}

	/**
	 * Get the keyboard mapper for translating `KeyboardEvent`s to keybindings.
	 *
	 * Returns a `FallbackKeyboardMapper` (keyCode-based) if:
	 * - The dispatch config is set to `KeyCode`, or
	 * - The factory is not yet initialized, or
	 * - No active keymap is available.
	 *
	 * Otherwise returns a `CachedKeyboardMapper` wrapping the platform-specific
	 * mapper (`WindowsKeyboardMapper` or `MacLinuxKeyboardMapper`).
	 *
	 * @returns The appropriate keyboard mapper instance.
	 */
	public getKeyboardMapper(): IKeyboardMapper {
		const config = readKeyboardConfig(this._configurationService);
		if (config.dispatch === DispatchConfig.KeyCode || !this._initialized || !this._activeKeymapInfo) {
			// Forcefully set to use keyCode
			return new FallbackKeyboardMapper(config.mapAltGrToCtrlAlt, OS);
		}
		if (!this._keyboardMapper) {
			this._keyboardMapper = new CachedKeyboardMapper(BrowserKeyboardMapperFactory._createKeyboardMapper(this._activeKeymapInfo, config.mapAltGrToCtrlAlt));
		}
		return this._keyboardMapper;
	}

	/**
	 * Validate that the current keyboard mapping still matches the physical keyboard.
	 *
	 * Compares the received key event against the expected value from the active
	 * keymap. If validation fails, triggers an asynchronous layout update.
	 * Skips validation for dead keys, composing events, and when not initialized.
	 *
	 * @param keyboardEvent - The keyboard event to validate against the active mapping.
	 */
	public validateCurrentKeyboardMapping(keyboardEvent: IKeyboardEvent): void {
		if (!this._initialized) {
			return;
		}

		const isCurrentKeyboard = this._validateCurrentKeyboardMapping(keyboardEvent);

		if (isCurrentKeyboard) {
			return;
		}

		this._updateKeyboardLayoutAsync(true, keyboardEvent);
	}

	/**
	 * Set the active keyboard layout by layout name.
	 *
	 * Searches registered keymaps for one whose layout ID matches the
	 * given name and activates it if found.
	 *
	 * @param layoutName - The keyboard layout identifier to activate.
	 */
	public setKeyboardLayout(layoutName: string) {
		const matchedLayouts: KeymapInfo[] = this.keymapInfos.filter(keymapInfo => getKeyboardLayoutId(keymapInfo.layout) === layoutName);

		if (matchedLayouts.length > 0) {
			this.setActiveKeymapInfo(matchedLayouts[0]);
		}
	}

	/**
	 * Mark the factory as initialized, invalidate the cached keyboard mapper,
	 * and notify listeners that the keyboard mapper has changed.
	 *
	 * @param keymapInfo - The keymap that is now active.
	 */
	private _setKeyboardData(keymapInfo: KeymapInfo): void {
		this._initialized = true;

		this._keyboardMapper = null;
		this._onDidChangeKeyboardMapper.fire();
	}

	/**
	 * Create a platform-specific keyboard mapper for the given keymap.
	 *
	 * On Windows, returns a `WindowsKeyboardMapper`. On macOS/Linux, returns
	 * a `MacLinuxKeyboardMapper` unless the raw mapping is empty (which
	 * typically indicates a failed read for Japanese/Chinese layouts on Mac),
	 * in which case a `FallbackKeyboardMapper` is returned.
	 *
	 * @param keymapInfo - The keymap to create a mapper for.
	 * @param mapAltGrToCtrlAlt - Whether to map AltGr to Ctrl+Alt.
	 * @returns A platform-specific `IKeyboardMapper` instance.
	 */
	private static _createKeyboardMapper(keymapInfo: KeymapInfo, mapAltGrToCtrlAlt: boolean): IKeyboardMapper {
		const rawMapping = keymapInfo.mapping;
		const isUSStandard = !!keymapInfo.layout.isUSStandard;
		if (OS === OperatingSystem.Windows) {
			return new WindowsKeyboardMapper(isUSStandard, <IWindowsKeyboardMapping>rawMapping, mapAltGrToCtrlAlt);
		}
		if (Object.keys(rawMapping).length === 0) {
			// Looks like reading the mappings failed (most likely Mac + Japanese/Chinese keyboard layouts)
			return new FallbackKeyboardMapper(mapAltGrToCtrlAlt, OS);
		}

		return new MacLinuxKeyboardMapper(isUSStandard, <IMacLinuxKeyboardMapping>rawMapping, mapAltGrToCtrlAlt, OS);
	}

	//#region Browser API
	/**
	 * Validate a single keyboard event against the current active keymap.
	 *
	 * Returns `true` if the event is consistent with the active layout, or if
	 * the event should be skipped (dead keys, composing, non-printable modifiers).
	 * Returns `false` when a mismatch is detected, signaling that the keyboard
	 * layout may have changed.
	 *
	 * @param keyboardEvent - The keyboard event to validate.
	 * @returns `true` if the event is valid or should be ignored, `false` if a layout mismatch is detected.
	 */
	private _validateCurrentKeyboardMapping(keyboardEvent: IKeyboardEvent): boolean {
		if (!this._initialized) {
			return true;
		}

		const standardKeyboardEvent = keyboardEvent as StandardKeyboardEvent;
		const currentKeymap = this._activeKeymapInfo;
		if (!currentKeymap) {
			return true;
		}

		if (standardKeyboardEvent.browserEvent.key === 'Dead' || standardKeyboardEvent.browserEvent.isComposing) {
			return true;
		}

		const mapping = currentKeymap.mapping[standardKeyboardEvent.code];

		if (!mapping) {
			return false;
		}

		if (mapping.value === '') {
			// The value is empty when the key is not a printable character, we skip validation.
			if (keyboardEvent.ctrlKey || keyboardEvent.metaKey) {
				setTimeout(() => {
					this._getBrowserKeyMapping().then((keymap: IRawMixedKeyboardMapping | null) => {
						if (this.isKeyMappingActive(keymap)) {
							return;
						}

						this.setLayoutFromBrowserAPI();
					});
				}, 350);
			}
			return true;
		}

		const expectedValue = standardKeyboardEvent.altKey && standardKeyboardEvent.shiftKey ? mapping.withShiftAltGr :
			standardKeyboardEvent.altKey ? mapping.withAltGr :
				standardKeyboardEvent.shiftKey ? mapping.withShift : mapping.value;

		const isDead = (standardKeyboardEvent.altKey && standardKeyboardEvent.shiftKey && mapping.withShiftAltGrIsDeadKey) ||
			(standardKeyboardEvent.altKey && mapping.withAltGrIsDeadKey) ||
			(standardKeyboardEvent.shiftKey && mapping.withShiftIsDeadKey) ||
			mapping.valueIsDeadKey;

		if (isDead && standardKeyboardEvent.browserEvent.key !== 'Dead') {
			return false;
		}

		// TODO, this assumption is wrong as `browserEvent.key` doesn't necessarily equal expectedValue from real keymap
		if (!isDead && standardKeyboardEvent.browserEvent.key !== expectedValue) {
			return false;
		}

		return true;
	}

	/**
	 * Retrieve the current keyboard mapping from the Browser Keyboard API.
	 *
	 * Primary strategy: calls `navigator.keyboard.getLayoutMap()` to obtain
	 * the full layout map. If the API is unavailable (e.g. nested browsing context),
	 * falls back to probing a single key from the provided `keyboardEvent`.
	 *
	 * @param keyboardEvent - Optional keyboard event used as a fallback probe when
	 *   the full layout map API is not available.
	 * @returns The raw keyboard mapping, or `null` if neither strategy succeeds.
	 */
	private async _getBrowserKeyMapping(keyboardEvent?: IKeyboardEvent): Promise<IRawMixedKeyboardMapping | null> {
		if (this.keyboardLayoutMapAllowed) {
			try {
				return await (navigator as INavigatorWithKeyboard).keyboard.getLayoutMap().then((e: any) => {
					const ret: IKeyboardMapping = {};
					for (const key of e) {
						ret[key[0]] = {
							'value': key[1],
							'withShift': '',
							'withAltGr': '',
							'withShiftAltGr': ''
						};
					}

					return ret;

					// const matchedKeyboardLayout = this.getMatchedKeymapInfo(ret);

					// if (matchedKeyboardLayout) {
					// 	return matchedKeyboardLayout.result.mapping;
					// }

					// return null;
				});
			} catch {
				// getLayoutMap can throw if invoked from a nested browsing context
				this.keyboardLayoutMapAllowed = false;
			}
		}
		if (keyboardEvent && !keyboardEvent.shiftKey && !keyboardEvent.altKey && !keyboardEvent.metaKey && !keyboardEvent.ctrlKey) {
			const ret: IKeyboardMapping = {};
			const standardKeyboardEvent = keyboardEvent as StandardKeyboardEvent;
			ret[standardKeyboardEvent.browserEvent.code] = {
				'value': standardKeyboardEvent.browserEvent.key,
				'withShift': '',
				'withAltGr': '',
				'withShiftAltGr': ''
			};

			const matchedKeyboardLayout = this.getMatchedKeymapInfo(ret);

			if (matchedKeyboardLayout) {
				return ret;
			}

			return null;
		}

		return null;
	}

	//#endregion
}

/**
 * Platform-aware keyboard mapper factory that dynamically loads keyboard layout
 * contributions for the current OS (Windows, macOS, or Linux).
 *
 * On construction, asynchronously imports the platform-specific layout contribution
 * file, registers all contributed keymaps, and immediately queries the Browser
 * Keyboard API to detect the active layout.
 */
export class BrowserKeyboardMapperFactory extends BrowserKeyboardMapperFactoryBase {
	/**
	 * @param configurationService - The workspace configuration service.
	 * @param notificationService - The notification service (reserved for future use).
	 * @param storageService - The storage service (reserved for future use).
	 * @param commandService - The command service (reserved for future use).
	 */
	constructor(configurationService: IConfigurationService, notificationService: INotificationService, storageService: IStorageService, commandService: ICommandService) {
		// super(notificationService, storageService, commandService);
		super(configurationService);

		let platform: string;
		if (isWindows) {
			platform = 'win';
		} else if (isMacintosh) {
			platform = 'darwin';
		} else {
			platform = 'linux';
		}

		import(/* webpackIgnore: true */FileAccess.asBrowserUri(`vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.${platform}.js` satisfies AppResourcePath).toString(true)).then((m) => {
			const keymapInfos: IKeymapInfo[] = m.KeyboardLayoutContribution.INSTANCE.layoutInfos;
			this._keymapInfos.push(...keymapInfos.map(info => (new KeymapInfo(info.layout, info.secondaryLayouts, info.mapping, info.isUserKeyboardLayout))));
			this._mru = this._keymapInfos;
			this._initialized = true;
			this.setLayoutFromBrowserAPI();
		});
	}
}

/**
 * Watches a user-defined keyboard layout file and parses it into a `KeymapInfo`.
 *
 * The layout file is expected to contain a JSON object with `layout` and `rawMapping`
 * properties. Changes to the file are detected via `IFileService.onDidFilesChange`
 * and debounced with a 50ms scheduler.
 */
class UserKeyboardLayout extends Disposable {

	private readonly reloadConfigurationScheduler: RunOnceScheduler;
	protected readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	/** Fires when the parsed keyboard layout changes (or is cleared). */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _keyboardLayout: KeymapInfo | null;
	/** The most recently parsed keyboard layout, or `null` if parsing failed or no file exists. */
	get keyboardLayout(): KeymapInfo | null { return this._keyboardLayout; }

	constructor(
		private readonly keyboardLayoutResource: URI,
		private readonly fileService: IFileService
	) {
		super();

		this._keyboardLayout = null;

		this.reloadConfigurationScheduler = this._register(new RunOnceScheduler(() => this.reload().then(changed => {
			if (changed) {
				this._onDidChange.fire();
			}
		}), 50));

		this._register(Event.filter(this.fileService.onDidFilesChange, e => e.contains(this.keyboardLayoutResource))(() => this.reloadConfigurationScheduler.schedule()));
	}

	/** Perform the initial load of the keyboard layout file. */
	async initialize(): Promise<void> {
		await this.reload();
	}

	/**
	 * Reload and re-parse the keyboard layout file.
	 *
	 * @returns `true` if the parsed layout changed from the previous value (or
	 *   if this is the first successful parse), `false` otherwise.
	 */
	private async reload(): Promise<boolean> {
		const existing = this._keyboardLayout;
		try {
			const content = await this.fileService.readFile(this.keyboardLayoutResource);
			const value = parse(content.value.toString());
			if (getNodeType(value) === 'object') {
				const layoutInfo = value.layout;
				const mappings = value.rawMapping;
				this._keyboardLayout = KeymapInfo.createKeyboardLayoutFromDebugInfo(layoutInfo, mappings, true);
			} else {
				this._keyboardLayout = null;
			}
		} catch (e) {
			this._keyboardLayout = null;
		}

		return existing ? !objects.equals(existing, this._keyboardLayout) : true;
	}

}

/**
 * Browser implementation of `IKeyboardLayoutService`.
 *
 * Delegates keyboard mapping to a `BrowserKeyboardMapperFactory` and integrates
 * user-defined keyboard layouts from a file watched by `UserKeyboardLayout`.
 * Supports both automatic layout detection via the Browser Keyboard API and
 * manual layout selection via the `keyboard.layout` configuration setting.
 */
export class BrowserKeyboardLayoutService extends Disposable implements IKeyboardLayoutService {
	public _serviceBrand: undefined;

	private readonly _onDidChangeKeyboardLayout = this._register(new Emitter<void>());
	public readonly onDidChangeKeyboardLayout: Event<void> = this._onDidChangeKeyboardLayout.event;

	private _userKeyboardLayout: UserKeyboardLayout;

	private readonly _factory: BrowserKeyboardMapperFactory;
	private _keyboardLayoutMode: string;

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@ICommandService commandService: ICommandService,
		@IConfigurationService private configurationService: IConfigurationService,
	) {
		super();
		const keyboardConfig = configurationService.getValue<{ layout: string }>('keyboard');
		const layout = keyboardConfig.layout;
		this._keyboardLayoutMode = layout ?? 'autodetect';
		this._factory = new BrowserKeyboardMapperFactory(configurationService, notificationService, storageService, commandService);

		this._register(this._factory.onDidChangeKeyboardMapper(() => {
			this._onDidChangeKeyboardLayout.fire();
		}));

		if (layout && layout !== 'autodetect') {
			// set keyboard layout
			this._factory.setKeyboardLayout(layout);
		}

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('keyboard.layout')) {
				const keyboardConfig = configurationService.getValue<{ layout: string }>('keyboard');
				const layout = keyboardConfig.layout;
				this._keyboardLayoutMode = layout;

				if (layout === 'autodetect') {
					this._factory.setLayoutFromBrowserAPI();
				} else {
					this._factory.setKeyboardLayout(layout);
				}
			}
		}));

		this._userKeyboardLayout = new UserKeyboardLayout(environmentService.keyboardLayoutResource, fileService);
		this._userKeyboardLayout.initialize().then(() => {
			if (this._userKeyboardLayout.keyboardLayout) {
				this._factory.registerKeyboardLayout(this._userKeyboardLayout.keyboardLayout);

				this.setUserKeyboardLayoutIfMatched();
			}
		});

		this._register(this._userKeyboardLayout.onDidChange(() => {
			const userKeyboardLayouts = this._factory.keymapInfos.filter(layout => layout.isUserKeyboardLayout);

			if (userKeyboardLayouts.length) {
				if (this._userKeyboardLayout.keyboardLayout) {
					userKeyboardLayouts[0].update(this._userKeyboardLayout.keyboardLayout);
				} else {
					this._factory.removeKeyboardLayout(userKeyboardLayouts[0]);
				}
			} else {
				if (this._userKeyboardLayout.keyboardLayout) {
					this._factory.registerKeyboardLayout(this._userKeyboardLayout.keyboardLayout);
				}
			}

			this.setUserKeyboardLayoutIfMatched();
		}));
	}

	/**
	 * Activate the user-defined keyboard layout if it matches the configured layout name.
	 *
	 * Compares the user keyboard layout's ID against the `keyboard.layout` setting.
	 * If they match and the user layout differs from the currently active keymap,
	 * the user layout is promoted to active.
	 */
	setUserKeyboardLayoutIfMatched() {
		const keyboardConfig = this.configurationService.getValue<{ layout: string }>('keyboard');
		const layout = keyboardConfig.layout;

		if (layout && this._userKeyboardLayout.keyboardLayout) {
			if (getKeyboardLayoutId(this._userKeyboardLayout.keyboardLayout.layout) === layout && this._factory.activeKeymap) {

				if (!this._userKeyboardLayout.keyboardLayout.equal(this._factory.activeKeymap)) {
					this._factory.setActiveKeymapInfo(this._userKeyboardLayout.keyboardLayout);
				}
			}
		}
	}

	/** @inheritdoc */
	getKeyboardMapper(): IKeyboardMapper {
		return this._factory.getKeyboardMapper();
	}

	/** @inheritdoc */
	public getCurrentKeyboardLayout(): IKeyboardLayoutInfo | null {
		return this._factory.activeKeyboardLayout;
	}

	/** @inheritdoc */
	public getAllKeyboardLayouts(): IKeyboardLayoutInfo[] {
		return this._factory.keyboardLayouts;
	}

	/** @inheritdoc */
	public getRawKeyboardMapping(): IKeyboardMapping | null {
		return this._factory.activeKeyMapping;
	}

	/** @inheritdoc */
	public validateCurrentKeyboardMapping(keyboardEvent: IKeyboardEvent): void {
		if (this._keyboardLayoutMode !== 'autodetect') {
			return;
		}

		this._factory.validateCurrentKeyboardMapping(keyboardEvent);
	}
}

registerSingleton(IKeyboardLayoutService, BrowserKeyboardLayoutService, InstantiationType.Delayed);

// Configuration
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigExtensions.Configuration);
const keyboardConfiguration: IConfigurationNode = {
	'id': 'keyboard',
	'order': 15,
	'type': 'object',
	'title': nls.localize('keyboardConfigurationTitle', "Keyboard"),
	'properties': {
		'keyboard.layout': {
			'type': 'string',
			'default': 'autodetect',
			'description': nls.localize('keyboard.layout.config', "Control the keyboard layout used in web.")
		}
	}
};

configurationRegistry.registerConfiguration(keyboardConfiguration);
