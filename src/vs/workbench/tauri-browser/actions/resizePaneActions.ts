/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { Action2, IAction2Options, registerAction2 } from '../../../platform/actions/common/actions.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { IWorkbenchLayoutService } from '../../services/layout/browser/layoutService.js';
import { Direction } from '../../../base/common/direction.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';

// #region Configuration

const VSCodeEESettings = {
  RESIZE_INCREMENT: 'vscodeee.resizeIncrement',
};

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
  id: 'vscodeee',
  order: 100,
  title: localize('vscodeeeConfigurationTitle', 'VSCodeEE'),
  type: 'object',
  properties: {
    [VSCodeEESettings.RESIZE_INCREMENT]: {
      type: 'number',
      default: 60,
      minimum: 1,
      maximum: 500,
      scope: ConfigurationScope.APPLICATION,
      description: localize(
        'vscodeee.resizeIncrement',
        'The number of pixels to resize a pane by when using directional resize commands (vscodeee.resizePaneUp/Down/Left/Right).',
      ),
    },
  },
});

// #endregion

// #region Actions

/**
 * Base action class for directional pane resize commands.
 * Delegates to {@link IWorkbenchLayoutService.resizePaneBorder} to move
 * the border of the currently focused pane in a specified direction.
 *
 * Subclasses provide the concrete direction and action ID.
 */
abstract class BaseResizePaneAction extends Action2 {
  /**
   * @param desc - The action descriptor including id and localized title.
   * @param direction - The direction to move the focused pane's border.
   */
  constructor(
    desc: Readonly<IAction2Options>,
    private readonly direction: Direction,
  ) {
    super(desc);
  }

  /**
   * Executes the pane resize by delegating to the layout service.
   *
   * @param accessor - The service accessor for dependency injection.
   */
  run(accessor: ServicesAccessor): void {
    const layoutService = accessor.get(IWorkbenchLayoutService);
    layoutService.resizePaneBorder(this.direction);
  }
}

/** Resizes the focused pane by moving its top border upward. */
class ResizePaneUpAction extends BaseResizePaneAction {
  static readonly ID = 'vscodeee.resizePaneUp';
  constructor() {
    super({
      id: ResizePaneUpAction.ID,
      title: localize2('vscodeee.resizePaneUp', 'Resize Pane Up'),
      f1: true,
      category: Categories.View,
    }, Direction.Up);
  }
}

/** Resizes the focused pane by moving its bottom border downward. */
class ResizePaneDownAction extends BaseResizePaneAction {
  static readonly ID = 'vscodeee.resizePaneDown';
  constructor() {
    super({
      id: ResizePaneDownAction.ID,
      title: localize2('vscodeee.resizePaneDown', 'Resize Pane Down'),
      f1: true,
      category: Categories.View,
    }, Direction.Down);
  }
}

/** Resizes the focused pane by moving its left border leftward. */
class ResizePaneLeftAction extends BaseResizePaneAction {
  static readonly ID = 'vscodeee.resizePaneLeft';
  constructor() {
    super({
      id: ResizePaneLeftAction.ID,
      title: localize2('vscodeee.resizePaneLeft', 'Resize Pane Left'),
      f1: true,
      category: Categories.View,
    }, Direction.Left);
  }
}

/** Resizes the focused pane by moving its right border rightward. */
class ResizePaneRightAction extends BaseResizePaneAction {
  static readonly ID = 'vscodeee.resizePaneRight';
  constructor() {
    super({
      id: ResizePaneRightAction.ID,
      title: localize2('vscodeee.resizePaneRight', 'Resize Pane Right'),
      f1: true,
      category: Categories.View,
    }, Direction.Right);
  }
}

registerAction2(ResizePaneUpAction);
registerAction2(ResizePaneDownAction);
registerAction2(ResizePaneLeftAction);
registerAction2(ResizePaneRightAction);

// #endregion
