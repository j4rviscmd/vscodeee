/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventHelper } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IDialogOptions } from '../../../../base/browser/ui/dialog/dialog.js';
import { fromNow } from '../../../../base/common/date.js';
import { localize } from '../../../../nls.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../platform/keybinding/common/keybindingResolver.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles, defaultDialogStyles } from '../../../../platform/theme/browser/defaultStyles.js';

const defaultDialogAllowableCommands = new Set([
	'workbench.action.quit',
	'workbench.action.reloadWindow',
	'copy',
	'cut',
	'editor.action.selectAll',
	'editor.action.clipboardCopyAction',
	'editor.action.clipboardCutAction',
	'editor.action.clipboardPasteAction'
]);

/**
 * Create a fully-populated {@link IDialogOptions} for workbench dialogs.
 *
 * Merges caller-provided options with workbench defaults including theme-aware
 * styles, a key event processor that blocks non-allowable keybindings while a
 * dialog is open, and a visibility handler that dims the host window.
 *
 * @param options - Partial dialog options to merge with defaults.
 * @param keybindingService - Used to resolve keyboard events against registered keybindings.
 * @param layoutService - Provides the active container for keybinding dispatch.
 * @param hostService - Used to dim/undim the window when dialog visibility changes.
 * @param allowableCommands - Set of command IDs that are allowed to execute while a dialog is open.
 *   Defaults to navigation and clipboard commands.
 * @returns A complete {@link IDialogOptions} object.
 */
export function createWorkbenchDialogOptions(options: Partial<IDialogOptions>, keybindingService: IKeybindingService, layoutService: ILayoutService, hostService: IHostService, allowableCommands = defaultDialogAllowableCommands): IDialogOptions {
	return {
		keyEventProcessor: (event: StandardKeyboardEvent) => {
			const resolved = keybindingService.softDispatch(event, layoutService.activeContainer);
			if (resolved.kind === ResultKind.KbFound && resolved.commandId) {
				if (!allowableCommands.has(resolved.commandId)) {
					EventHelper.stop(event, true);
				}
			}
		},
		buttonStyles: defaultButtonStyles,
		checkboxStyles: defaultCheckboxStyles,
		inputBoxStyles: defaultInputBoxStyles,
		dialogStyles: defaultDialogStyles,
		onVisibilityChange: (window, visible) => hostService.setWindowDimmed(window, visible),
		...options
	};
}

/**
 * Build the content for the workbench About dialog.
 *
 * Composes a title (long product name) and a details string containing the
 * version, commit hash, build date (with relative time), extension host runtime,
 * and browser user agent. Two variants of the details string are returned:
 * one with relative timestamps for display, and one without for clipboard copy.
 *
 * @param productService - Provides product metadata (name, version, commit, date, runtime).
 * @returns An object with `title`, `details` (display string), and `detailsToCopy` (plain copy string).
 */
export function createBrowserAboutDialogDetails(productService: IProductService): { title: string; details: string; detailsToCopy: string } {
	const detailString = (useAgo: boolean): string => {
		return localize('aboutDetail',
			"Version: {0}\nCommit: {1}\nDate: {2}\nRuntime: {3}\nBrowser: {4}",
			productService.version || 'Unknown',
			productService.commit || 'Unknown',
			productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Unknown',
			productService.extensionHostRuntime || 'Unknown',
			navigator.userAgent
		);
	};

	const details = detailString(true);
	const detailsToCopy = detailString(false);

	return {
		title: productService.nameLong,
		details: details,
		detailsToCopy: detailsToCopy
	};
}

