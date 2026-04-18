/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../platform/actions/common/actions.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';

// #region Quit

/**
 * Quits the application by closing the current window through the lifecycle handshake.
 *
 * IMPORTANT: Must use `closeWindow()` instead of `quit()`.
 * `quit()` calls Rust `quit_app` which bypasses the TypeScript lifecycle
 * (handleShutdown → flush(SHUTDOWN) → CommandsHistory.saveState()), causing
 * storage data that is only written during shutdown to be lost.
 * `closeWindow()` triggers `CloseRequested` → lifecycle handshake → proper flush.
 */
class QuitAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.quit',
			title: localize2('quit', "Quit"),
			category: Categories.File,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyCode.KeyQ
			},
			menu: {
				id: MenuId.MenubarFileMenu,
				group: 'z_Quit',
				order: 1
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);

		// Use closeWindow() to trigger the full lifecycle handshake:
		// CloseRequested → handleCloseRequested() → handleShutdown()
		// → flush(SHUTDOWN) → onDidShutdown → lifecycle_close_confirmed.
		// Do NOT use quit() — it calls Rust quit_app which skips the
		// TypeScript lifecycle and loses shutdown-only storage data.
		await nativeHostService.closeWindow();
	}
}

registerAction2(QuitAction);

// #endregion

// #region Close Window

/** Closes the current window via the Tauri backend. */
class CloseWindowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.closeWindow',
			title: localize2('closeWindow', "Close Window"),
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyW
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.closeWindow();
	}
}

registerAction2(CloseWindowAction);

// #endregion

// #region Window Management

/** Minimizes the current window. */
class MinimizeWindowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.minimizeWindow',
			title: localize2('minimizeWindow', "Minimize Window"),
			category: Categories.View,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.minimizeWindow();
	}
}

registerAction2(MinimizeWindowAction);

/** Maximizes the current window. */
class MaximizeWindowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.maximizeWindow',
			title: localize2('maximizeWindow', "Maximize Window"),
			category: Categories.View,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.maximizeWindow();
	}
}

registerAction2(MaximizeWindowAction);

/** Toggles the maximized state of the current window. */
class ToggleMaximizedWindowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.toggleMaximizedWindow',
			title: localize2('toggleMaximizedWindow', "Toggle Maximized Window"),
			category: Categories.View,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const maximized = await nativeHostService.isMaximized();
		if (maximized) {
			await nativeHostService.unmaximizeWindow();
		} else {
			await nativeHostService.maximizeWindow();
		}
	}
}

registerAction2(ToggleMaximizedWindowAction);

// #endregion

// #region Zoom

/** Increases the workbench zoom level by 1. */
class ZoomInAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.zoomIn',
			title: localize2('zoomIn', "Zoom In"),
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Equal
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const currentZoom = configurationService.getValue<number>('window.zoomLevel') ?? 0;
		await configurationService.updateValue('window.zoomLevel', currentZoom + 1);
	}
}

registerAction2(ZoomInAction);

/** Decreases the workbench zoom level by 1. */
class ZoomOutAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.zoomOut',
			title: localize2('zoomOut', "Zoom Out"),
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Minus
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const currentZoom = configurationService.getValue<number>('window.zoomLevel') ?? 0;
		await configurationService.updateValue('window.zoomLevel', currentZoom - 1);
	}
}

registerAction2(ZoomOutAction);

/** Resets the workbench zoom level to the default (0). */
class ZoomResetAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.zoomReset',
			title: localize2('zoomReset', "Reset Zoom"),
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Numpad0,
				secondary: [KeyMod.CtrlCmd | KeyCode.Digit0]
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		await configurationService.updateValue('window.zoomLevel', 0);
	}
}

registerAction2(ZoomResetAction);

// #endregion

// #region Relaunch

/** Relaunches the application via the Tauri backend. */
class RelaunchAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.relaunch',
			title: localize2('relaunch', "Relaunch Application"),
			category: Categories.View,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.relaunch();
	}
}

registerAction2(RelaunchAction);

// #endregion

// TODO(Phase 2): Add switchWindow action when multi-window support is stable
// TODO(Phase 2): Add macOS window tab commands (newWindowTab, mergeAllTabs, etc.)
// TODO(Phase 2): Integrate QuitAction with ShutdownReason.QUIT for correct dialog messages
