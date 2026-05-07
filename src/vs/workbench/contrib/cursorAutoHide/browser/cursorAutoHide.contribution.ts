/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cursor auto-hide and VSCodeee-specific configuration contribution.
 *
 * Registers the {@link CursorAutoHideController} as a workbench contribution and
 * declares all `vscodeee.*` configuration properties, including:
 *
 * - `vscodeee.cursorAutoHide.enabled` / `vscodeee.cursorAutoHide.delay` -
 *   automatic mouse cursor hiding after a period of inactivity
 * - `vscodeee.activePaneBorder.enabled` / `.color` / `.width` -
 *   tmux-like active editor pane border highlighting
 * - `vscodeee.terminal.horizontalPadding` -
 *   configurable horizontal padding for the integrated terminal
 */

import { localize } from '../../../../nls.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CursorAutoHideController } from './cursorAutoHide.js';

// Cursor auto-hide contribution
registerWorkbenchContribution2(CursorAutoHideController.ID, CursorAutoHideController, WorkbenchPhase.AfterRestored);

// VS Codeee configuration
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration({
		'id': 'vscodeee',
		'title': localize('vscodeeeConfigurationTitle', "VS Codeee"),
		'type': 'object',
		'properties': {
			'vscodeee.cursorAutoHide.enabled': {
				'type': 'boolean',
				'default': true,
				'description': localize('cursorAutoHideEnabled', "Controls whether the mouse cursor is automatically hidden after a period of inactivity.")
			},
			'vscodeee.cursorAutoHide.delay': {
				'type': 'number',
				'default': 3000,
				'minimum': 500,
				'maximum': 60000,
				'description': localize('cursorAutoHideDelay', "Controls the delay in milliseconds before the mouse cursor is hidden after inactivity.")
			},
			'vscodeee.activePaneBorder.enabled': {
				'type': 'boolean',
				'default': true,
				'description': localize('activePaneBorderEnabled', "Controls whether the active pane displays a border highlight (tmux-like). Applies to editor panes when multiple are open, and to sidebar/panel when focused.")
			},
			'vscodeee.activePaneBorder.color': {
				'type': 'string',
				'default': '',
				'description': localize('activePaneBorderColor', "Override color for the active pane border (e.g. '#00FF00'). When empty, the theme's focus border color is used.")
			},
			'vscodeee.activePaneBorder.width': {
				'type': 'number',
				'default': 1,
				'minimum': 1,
				'maximum': 5,
				'description': localize('activePaneBorderWidth', "Controls the width in pixels of the active pane border.")
			},
			'vscodeee.terminal.horizontalPadding': {
				'type': 'number',
				'default': 20,
				'minimum': 0,
				'maximum': 100,
				'description': localize('terminalHorizontalPadding', "Controls the horizontal padding (in pixels) applied to both left and right sides of the integrated terminal.")
			}
		}
	});
