/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';

// #region Shared shell command helper

/**
 * Represents the two shell command lifecycle operations that can be
 * dispatched through the native host service.
 */
type ShellCommandMethod = 'installShellCommand' | 'uninstallShellCommand';

/**
 * Execute a shell command action with unified success/error notification handling.
 * Silently returns when the user cancels the OS-level privilege prompt.
 *
 * The `formatError` callback must use `localize()` with a string literal key
 * so the NLS build system (which uses `eval()`) can resolve it at build time.
 */
async function executeShellCommandAction(
  accessor: ServicesAccessor,
  method: ShellCommandMethod,
  successMessage: string,
  formatError: (errorDetail: string) => string,
): Promise<void> {
  const nativeHostService = accessor.get(INativeHostService);
  const notificationService = accessor.get(INotificationService);

  try {
    await nativeHostService[method]();
    notificationService.info(successMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('cancelled') || message.includes('canceled')) {
      return;
    }
    notificationService.error(formatError(message));
  }
}

// #endregion

// #region Install Shell Command

/**
 * Action that installs the `codeee` shell command so the application
 * can be launched from any terminal session.
 *
 * Registered under `workbench.action.installShellCommand` in the
 * Developer category. Available from the Command Palette (`f1: true`).
 */
class InstallShellCommandAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.installShellCommand',
      title: localize2('installShellCommand', "Shell Command: Install 'codeee' Command in PATH"),
      category: Categories.Developer,
      f1: true,
    });
  }

  /**
	 * Invoke the native host's `installShellCommand` method and show
	 * a success notification. OS privilege prompts that are cancelled
	 * by the user are silently ignored.
	 */
  async run(accessor: ServicesAccessor): Promise<void> {
    await executeShellCommandAction(
      accessor,
      'installShellCommand',
      localize('installShellCommandSuccess', "'codeee' command successfully installed in PATH. Restart your terminal for the change to take effect."),
      (detail) => localize('installShellCommandError', "Unable to install 'codeee' command: {0}", detail),
    );
  }
}

registerAction2(InstallShellCommandAction);

// #endregion

// #region Uninstall Shell Command

/**
 * Action that removes the `codeee` shell command from the system PATH.
 *
 * Registered under `workbench.action.uninstallShellCommand` in the
 * Developer category. Available from the Command Palette (`f1: true`).
 */
class UninstallShellCommandAction extends Action2 {
  constructor() {
    super({
      id: 'workbench.action.uninstallShellCommand',
      title: localize2('uninstallShellCommand', "Shell Command: Uninstall 'codeee' Command from PATH"),
      category: Categories.Developer,
      f1: true,
    });
  }

  /**
	 * Invoke the native host's `uninstallShellCommand` method and show
	 * a success notification. OS privilege prompts that are cancelled
	 * by the user are silently ignored.
	 */
  async run(accessor: ServicesAccessor): Promise<void> {
    await executeShellCommandAction(
      accessor,
      'uninstallShellCommand',
      localize('uninstallShellCommandSuccess', "'codeee' command successfully removed from PATH."),
      (detail) => localize('uninstallShellCommandError', "Unable to uninstall 'codeee' command: {0}", detail),
    );
  }
}

registerAction2(UninstallShellCommandAction);

// #endregion
