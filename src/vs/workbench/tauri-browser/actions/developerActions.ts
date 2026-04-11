/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';

class ToggleDevToolsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.toggleDevTools',
			title: localize2('toggleDevTools', "Toggle Developer Tools"),
			category: Categories.Developer,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI }
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		const nativeHostService = accessor.get(INativeHostService);
		nativeHostService.toggleDevTools();
	}
}

registerAction2(ToggleDevToolsAction);

// TODO(Phase 2): Add OpenDevToolsAction with mode support (right, bottom, undocked)
// TODO(Phase 2): Gate DevTools commands behind debug builds only in production
