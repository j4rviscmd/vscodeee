/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri-specific native window actions.
 *
 * Registers commands that require native OS integration and are not
 * available in the browser environment. Follows the same pattern as
 * developerActions.ts.
 */

import { localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';

/**
 * Action that quits the application entirely.
 *
 * Delegates to {@link INativeHostService.quit} to perform a clean shutdown
 * of the native process. Registered under `workbench.action.quit` with the
 * File category and bound to the Command Palette (`f1: true`).
 */
class QuitAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.quit',
			title: localize2('quit', 'Quit'),
			category: Categories.File,
			f1: true
		});
	}

	/**
	 * Triggers application quit via the native host service.
	 *
	 * @param accessor - The service accessor used to resolve {@link INativeHostService}.
	 * @returns A promise that resolves when the quit request has been sent.
	 */
	run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		return nativeHostService.quit();
	}
}

registerAction2(QuitAction);
