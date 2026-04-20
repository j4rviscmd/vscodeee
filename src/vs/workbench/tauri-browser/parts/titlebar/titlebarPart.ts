/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/titlebarpart.tauri.css';
import { Event } from '../../../../base/common/event.js';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { $, addDisposableListener, append, EventType, getWindow, getWindowId, hide, show } from '../../../../base/browser/dom.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { BrowserTitlebarPart, BrowserTitleService, IAuxiliaryTitlebarPart } from '../../../browser/parts/titlebar/titlebarPart.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { hasNativeTitlebar, DEFAULT_CUSTOM_TITLEBAR_HEIGHT } from '../../../../platform/window/common/window.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IEditorGroupsContainer, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { CodeWindow, mainWindow } from '../../../../base/browser/window.js';

export class TauriTitlebarPart extends BrowserTitlebarPart {

	//#region IView

	override get minimumHeight(): number {
		if (!isMacintosh) {
			return super.minimumHeight;
		}

		// macOS with Overlay: native traffic lights are always present.
		// Tahoe (macOS 26+) uses larger traffic lights requiring 32px;
		// older macOS uses 28px. We default to 32px since Tauri 2.0
		// targets recent macOS versions.
		// TODO(Phase 4): Detect OS version via Rust command for precise sizing.
		const macCompactHeight = 32;
		return (this.isCommandCenterVisible ? DEFAULT_CUSTOM_TITLEBAR_HEIGHT : macCompactHeight) / (this.preventZoom ? getZoomFactor(getWindow(this.element)) : 1);
	}
	override get maximumHeight(): number { return this.minimumHeight; }

	//#endregion

	private maxRestoreControl: HTMLElement | undefined;
	private resizer: HTMLElement | undefined;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		editorGroupsContainer: IEditorGroupsContainer,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		super(id, targetWindow, editorGroupsContainer, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, editorService, menuService, keybindingService);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const result = super.createContentArea(parent);
		const targetWindow = getWindow(parent);
		const targetWindowId = getWindowId(targetWindow);

		// Tauri window dragging + double-click maximize/restore.
		// start_dragging captures the mouse, preventing dblclick events from firing,
		// so we detect double-click via e.detail inside the mousedown handler.
		const isInteractive = (target: HTMLElement) => !!target.closest('.window-icon, .menubar, .action-item, .codicon-toolbar-more, button, input, select, textarea, a[href]');
		this._register(addDisposableListener(this.rootContainer, EventType.MOUSE_DOWN, async (e: MouseEvent) => {
			if (e.buttons !== 1) {
				return; // only primary button
			}
			if (isInteractive(e.target as HTMLElement)) {
				return; // don't drag when clicking interactive elements
			}

			if (e.detail >= 2) {
				// Double-click detected — toggle maximize/restore
				const maximized = await this.nativeHostService.isMaximized({ targetWindowId });
				if (maximized) {
					await this.nativeHostService.unmaximizeWindow({ targetWindowId });
				} else {
					await this.nativeHostService.maximizeWindow({ targetWindowId });
				}
				return;
			}

			e.preventDefault();
			(targetWindow as unknown as Record<string, { invoke: (cmd: string) => Promise<void> }>).__TAURI_INTERNALS__?.invoke('plugin:window|start_dragging').catch(() => { /* permission or runtime error */ });
		}));

		// Custom Window Controls (Windows/Linux only — macOS uses native traffic lights via TitleBarStyle::Overlay)
		if (
			!isMacintosh &&
			!hasNativeTitlebar(this.configurationService) &&
			this.windowControlsContainer
		) {

			// Minimize
			const minimizeIcon = append(this.windowControlsContainer, $('div.window-icon.window-minimize' + ThemeIcon.asCSSSelector(Codicon.chromeMinimize)));
			this._register(addDisposableListener(minimizeIcon, EventType.CLICK, async () => {
				await this.nativeHostService.minimizeWindow({ targetWindowId });
			}));

			// Restore / Maximize
			this.maxRestoreControl = append(this.windowControlsContainer, $('div.window-icon.window-max-restore'));
			this._register(addDisposableListener(this.maxRestoreControl, EventType.CLICK, async () => {
				const maximized = await this.nativeHostService.isMaximized({ targetWindowId });
				if (maximized) {
					return await this.nativeHostService.unmaximizeWindow({ targetWindowId });
				}

				return await this.nativeHostService.maximizeWindow({ targetWindowId });
			}));

			// Close
			const closeIcon = append(this.windowControlsContainer, $('div.window-icon.window-close' + ThemeIcon.asCSSSelector(Codicon.chromeClose)));
			this._register(addDisposableListener(closeIcon, EventType.CLICK, async () => {
				await this.nativeHostService.closeWindow({ targetWindowId });
			}));

			// Resizer
			this.resizer = append(this.rootContainer, $('div.resizer'));
			this._register(Event.runAndSubscribe(this.layoutService.onDidChangeWindowMaximized, ({ windowId, maximized }) => {
				if (windowId === targetWindowId) {
					this.onDidChangeWindowMaximized(maximized);
				}
			}, { windowId: targetWindowId, maximized: this.layoutService.isWindowMaximized(targetWindow) }));
		}

		return result;
	}

	private onDidChangeWindowMaximized(maximized: boolean): void {
		if (this.maxRestoreControl) {
			if (maximized) {
				this.maxRestoreControl.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chromeMaximize));
				this.maxRestoreControl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chromeRestore));
			} else {
				this.maxRestoreControl.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chromeRestore));
				this.maxRestoreControl.classList.add(...ThemeIcon.asClassNameArray(Codicon.chromeMaximize));
			}
		}

		if (this.resizer) {
			if (maximized) {
				hide(this.resizer);
			} else {
				show(this.resizer);
			}
		}
	}
}

export class MainTauriTitlebarPart extends TauriTitlebarPart {

	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@INativeHostService nativeHostService: INativeHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		super(Parts.TITLEBAR_PART, mainWindow, editorGroupService.mainPart, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, nativeHostService, editorGroupService, editorService, menuService, keybindingService);
	}
}

export class AuxiliaryTauriTitlebarPart extends TauriTitlebarPart implements IAuxiliaryTitlebarPart {

	private static COUNTER = 1;

	get height() { return this.minimumHeight; }

	constructor(
		readonly container: HTMLElement,
		editorGroupsContainer: IEditorGroupsContainer,
		private readonly mainTitlebar: BrowserTitlebarPart,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@INativeHostService nativeHostService: INativeHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService
	) {
		const id = AuxiliaryTauriTitlebarPart.COUNTER++;
		super(`workbench.parts.auxiliaryTitle.${id}`, getWindow(container), editorGroupsContainer, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, nativeHostService, editorGroupService, editorService, menuService, keybindingService);
	}

	override get preventZoom(): boolean {
		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}
}

export class TauriTitleService extends BrowserTitleService {

	protected override createMainTitlebarPart(): MainTauriTitlebarPart {
		return this.instantiationService.createInstance(MainTauriTitlebarPart);
	}

	protected override doCreateAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): AuxiliaryTauriTitlebarPart {
		return instantiationService.createInstance(AuxiliaryTauriTitlebarPart, container, editorGroupsContainer, this.mainPart);
	}
}
