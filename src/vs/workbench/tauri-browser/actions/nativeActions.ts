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

// #region Quit

/**
 * Quits the application by closing ALL windows through the lifecycle handshake.
 *
 * Calls `quit()` which invokes Rust `quit_all_windows`:
 * 1. Sets QuitState.in_progress in Rust
 * 2. Triggers `window.close()` on each window
 * 3. Each window receives CloseRequested with reason="quit"
 * 4. TypeScript lifecycle runs with ShutdownReason.QUIT (correct dialog text, Hot Exit)
 * 5. After all windows confirm → app.exit(0)
 * 6. If any window vetoes → quit cancelled, that window stays
 */
class QuitAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.quit',
      title: localize2('quit', 'Quit'),
      category: Categories.File,
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib + 1,
        primary: KeyMod.CtrlCmd | KeyCode.KeyQ,
      },
      menu: {
        id: MenuId.MenubarFileMenu,
        group: 'z_Quit',
        order: 1,
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const nativeHostService = accessor.get(INativeHostService);

    // quit() now calls quit_all_windows which goes through the full
    // lifecycle handshake for each window with ShutdownReason.QUIT.
    await nativeHostService.quit();
  }
}

registerAction2(QuitAction);

// #endregion

// #region Close Window

/**
 * Action that closes the current window via the Tauri backend.
 *
 * Registered with keybinding `CmdOrCtrl+W` and accessible from the command palette.
 * Delegates to `INativeHostService.closeWindow()` which invokes the Rust `close_window` command.
 */
class CloseWindowAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.closeWindow',
      title: localize2('closeWindow', 'Close Window'),
      category: Categories.View,
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyCode.KeyW,
      },
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

/**
 * Action that minimizes the current window.
 *
 * Accessible from the command palette under the View category.
 * Delegates to `INativeHostService.minimizeWindow()`.
 */
class MinimizeWindowAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.minimizeWindow',
      title: localize2('minimizeWindow', 'Minimize Window'),
      category: Categories.View,
      f1: true,
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const nativeHostService = accessor.get(INativeHostService);
    await nativeHostService.minimizeWindow();
  }
}

registerAction2(MinimizeWindowAction);

/**
 * Action that maximizes the current window.
 *
 * Accessible from the command palette under the View category.
 * Delegates to `INativeHostService.maximizeWindow()`.
 */
class MaximizeWindowAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.maximizeWindow',
      title: localize2('maximizeWindow', 'Maximize Window'),
      category: Categories.View,
      f1: true,
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const nativeHostService = accessor.get(INativeHostService);
    await nativeHostService.maximizeWindow();
  }
}

registerAction2(MaximizeWindowAction);

/**
 * Action that toggles the maximized state of the current window.
 *
 * Queries `INativeHostService.isMaximized()` and calls either
 * `unmaximizeWindow()` or `maximizeWindow()` depending on the current state.
 * Accessible from the command palette under the View category.
 */
class ToggleMaximizedWindowAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.toggleMaximizedWindow',
      title: localize2('toggleMaximizedWindow', 'Toggle Maximized Window'),
      category: Categories.View,
      f1: true,
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

import { IWindowZoomService } from '../../services/zoom/common/zoom.js';

/**
 * Action that increases the workbench zoom level by 1.
 *
 * Registered with keybinding `CmdOrCtrl+=`.
 * Delegates to `IWindowZoomService.applyZoomDelta(1)`.
 */
class ZoomInAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.zoomIn',
      title: localize2('zoomIn', 'Zoom In'),
      category: Categories.View,
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyCode.Equal,
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const windowZoomService = accessor.get(IWindowZoomService);
    await windowZoomService.applyZoomDelta(1);
  }
}

registerAction2(ZoomInAction);

/**
 * Action that decreases the workbench zoom level by 1.
 *
 * Registered with keybinding `CmdOrCtrl+-`.
 * Delegates to `IWindowZoomService.applyZoomDelta(-1)`.
 */
class ZoomOutAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.zoomOut',
      title: localize2('zoomOut', 'Zoom Out'),
      category: Categories.View,
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyCode.Minus,
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const windowZoomService = accessor.get(IWindowZoomService);
    await windowZoomService.applyZoomDelta(-1);
  }
}

registerAction2(ZoomOutAction);

/**
 * Action that resets the workbench zoom level to the default.
 *
 * Registered with keybindings `CmdOrCtrl+Numpad0` (primary) and `CmdOrCtrl+Digit0` (secondary).
 * Delegates to `IWindowZoomService.resetZoom()`.
 */
class ZoomResetAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.zoomReset',
      title: localize2('zoomReset', 'Reset Zoom'),
      category: Categories.View,
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib,
        primary: KeyMod.CtrlCmd | KeyCode.Numpad0,
        secondary: [KeyMod.CtrlCmd | KeyCode.Digit0],
      },
    });
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const windowZoomService = accessor.get(IWindowZoomService);
    await windowZoomService.resetZoom();
  }
}

registerAction2(ZoomResetAction);

// #endregion

// #region Relaunch

/**
 * Action that relaunches the application via the Tauri backend.
 *
 * Accessible from the command palette under the View category.
 * Delegates to `INativeHostService.relaunch()` which invokes the Rust `relaunch_app` command.
 */
class RelaunchAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.relaunch',
      title: localize2('relaunch', 'Relaunch Application'),
      category: Categories.View,
      f1: true,
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
