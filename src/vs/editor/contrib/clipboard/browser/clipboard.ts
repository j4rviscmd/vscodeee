/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as browser from '../../../../base/browser/browser.js';
import { getActiveDocument, getActiveWindow } from '../../../../base/browser/dom.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import * as platform from '../../../../base/common/platform.js';
import * as nls from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CopyOptions, generateDataToCopyAndStoreInMemory, InMemoryClipboardMetadataManager } from '../../../browser/controller/editContext/clipboardUtils.js';
import { NativeEditContextRegistry } from '../../../browser/controller/editContext/native/nativeEditContextRegistry.js';
import { IActiveCodeEditor, ICodeEditor } from '../../../browser/editorBrowser.js';
import { Command, EditorAction, MultiCommand, registerEditorAction } from '../../../browser/editorExtensions.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Handler } from '../../../common/editorCommon.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { CopyPasteController } from '../../dropOrPasteInto/browser/copyPasteController.js';

const CLIPBOARD_CONTEXT_MENU_GROUP = '9_cutcopypaste';

const supportsCut = (platform.isNative || document.queryCommandSupported('cut'));
const supportsCopy = (platform.isNative || document.queryCommandSupported('copy'));
// Firefox only supports navigator.clipboard.readText() in browser extensions.
// See https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/readText#Browser_compatibility
// When loading over http, navigator.clipboard can be undefined. See https://github.com/microsoft/monaco-editor/issues/2313
const supportsPaste = (typeof navigator.clipboard === 'undefined' || browser.isFirefox) ? document.queryCommandSupported('paste') : true;

/**
 * Register an editor command and return it for further chaining.
 *
 * @param command - The command instance to register.
 * @returns The same command instance, after registration.
 */
function registerCommand<T extends Command>(command: T): T {
	command.register();
	return command;
}

/** Multi-command for the Cut operation. Registered only when the platform supports `cut`. */
export const CutAction = supportsCut ? registerCommand(new MultiCommand({
	id: 'editor.action.clipboardCutAction',
	precondition: undefined,
	kbOpts: (
		// Do not bind cut keybindings in the browser,
		// since browsers do that for us and it avoids security prompts
		(platform.isNative || platform.isTauri) ? {
			primary: KeyMod.CtrlCmd | KeyCode.KeyX,
			win: { primary: KeyMod.CtrlCmd | KeyCode.KeyX, secondary: [KeyMod.Shift | KeyCode.Delete] },
			weight: KeybindingWeight.EditorContrib
		} : undefined
	),
	menuOpts: [{
		menuId: MenuId.MenubarEditMenu,
		group: '2_ccp',
		title: nls.localize({ key: 'miCut', comment: ['&& denotes a mnemonic'] }, "Cu&&t"),
		order: 1
	}, {
		menuId: MenuId.EditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title: nls.localize('actions.clipboard.cutLabel', "Cut"),
		when: EditorContextKeys.writable,
		order: 1,
	}, {
		menuId: MenuId.CommandPalette,
		group: '',
		title: nls.localize('actions.clipboard.cutLabel', "Cut"),
		order: 1
	}, {
		menuId: MenuId.SimpleEditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title: nls.localize('actions.clipboard.cutLabel', "Cut"),
		when: EditorContextKeys.writable,
		order: 1,
	}]
})) : undefined;

/** Multi-command for the Copy operation. Registered only when the platform supports `copy`. */
export const CopyAction = supportsCopy ? registerCommand(new MultiCommand({
	id: 'editor.action.clipboardCopyAction',
	precondition: undefined,
	kbOpts: (
		// Do not bind copy keybindings in the browser,
		// since browsers do that for us and it avoids security prompts
		(platform.isNative || platform.isTauri) ? {
			primary: KeyMod.CtrlCmd | KeyCode.KeyC,
			win: { primary: KeyMod.CtrlCmd | KeyCode.KeyC, secondary: [KeyMod.CtrlCmd | KeyCode.Insert] },
			weight: KeybindingWeight.EditorContrib
		} : undefined
	),
	menuOpts: [{
		menuId: MenuId.MenubarEditMenu,
		group: '2_ccp',
		title: nls.localize({ key: 'miCopy', comment: ['&& denotes a mnemonic'] }, "&&Copy"),
		order: 2
	}, {
		menuId: MenuId.EditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title: nls.localize('actions.clipboard.copyLabel', "Copy"),
		order: 2,
	}, {
		menuId: MenuId.CommandPalette,
		group: '',
		title: nls.localize('actions.clipboard.copyLabel', "Copy"),
		order: 1
	}, {
		menuId: MenuId.SimpleEditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title: nls.localize('actions.clipboard.copyLabel', "Copy"),
		order: 2,
	}]
})) : undefined;

MenuRegistry.appendMenuItem(MenuId.MenubarEditMenu, { submenu: MenuId.MenubarCopy, title: nls.localize2('copy as', "Copy As"), group: '2_ccp', order: 3 });
MenuRegistry.appendMenuItem(MenuId.EditorContext, { submenu: MenuId.EditorContextCopy, title: nls.localize2('copy as', "Copy As"), group: CLIPBOARD_CONTEXT_MENU_GROUP, order: 3 });
MenuRegistry.appendMenuItem(MenuId.EditorContext, { submenu: MenuId.EditorContextShare, title: nls.localize2('share', "Share"), group: '11_share', order: -1, when: ContextKeyExpr.and(ContextKeyExpr.notEquals('resourceScheme', 'output'), EditorContextKeys.editorTextFocus) });
MenuRegistry.appendMenuItem(MenuId.ExplorerContext, { submenu: MenuId.ExplorerContextShare, title: nls.localize2('share', "Share"), group: '11_share', order: -1 });

/** Multi-command for the Paste operation. Registered only when the platform supports `paste`. */
export const PasteAction = supportsPaste ? registerCommand(new MultiCommand({
	id: 'editor.action.clipboardPasteAction',
	precondition: undefined,
	kbOpts: (
		// Do not bind paste keybindings in the browser,
		// since browsers do that for us and it avoids security prompts
		(platform.isNative || platform.isTauri) ? {
			primary: KeyMod.CtrlCmd | KeyCode.KeyV,
			win: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.Shift | KeyCode.Insert] },
			linux: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.Shift | KeyCode.Insert] },
			weight: KeybindingWeight.EditorContrib
		} : undefined
	),
	menuOpts: [{
		menuId: MenuId.MenubarEditMenu,
		group: '2_ccp',
		title: nls.localize({ key: 'miPaste', comment: ['&& denotes a mnemonic'] }, "&&Paste"),
		order: 4
	}, {
		menuId: MenuId.EditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title: nls.localize('actions.clipboard.pasteLabel', "Paste"),
		when: EditorContextKeys.writable,
		order: 4,
	}, {
		menuId: MenuId.CommandPalette,
		group: '',
		title: nls.localize('actions.clipboard.pasteLabel', "Paste"),
		order: 1
	}, {
		menuId: MenuId.SimpleEditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title: nls.localize('actions.clipboard.pasteLabel', "Paste"),
		when: EditorContextKeys.writable,
		order: 4,
	}]
})) : undefined;

/**
 * Editor action that copies the current selection to the clipboard with
 * syntax highlighting preserved (rich text / HTML).
 *
 * Sets {@link CopyOptions.forceCopyWithSyntaxHighlighting} to `true` before
 * invoking the clipboard copy so that the EditContext layer formats the
 * copied text as HTML instead of plain text. On native platforms a fallback
 * path writes plain-text data if the `execCommand('copy')` event never fires
 * (known Electron/Tauri race condition).
 */
class ExecCommandCopyWithSyntaxHighlightingAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.clipboardCopyWithSyntaxHighlightingAction',
			label: nls.localize2('actions.clipboard.copyWithSyntaxHighlightingLabel', "Copy with Syntax Highlighting"),
			precondition: undefined,
			kbOpts: {
				kbExpr: EditorContextKeys.textInputFocus,
				primary: 0,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const logService = accessor.get(ILogService);
		const clipboardService = accessor.get(IClipboardService);
		logService.trace('ExecCommandCopyWithSyntaxHighlightingAction#run');
		if (!editor.hasModel()) {
			return;
		}

		const emptySelectionClipboard = editor.getOption(EditorOption.emptySelectionClipboard);

		if (!emptySelectionClipboard && editor.getSelection().isEmpty()) {
			return;
		}

		CopyOptions.forceCopyWithSyntaxHighlighting = true;
		editor.focus();
		logService.trace('ExecCommandCopyWithSyntaxHighlightingAction (before execCommand copy)');
		executeClipboardCopyWithWorkaround(editor, clipboardService);
		logService.trace('ExecCommandCopyWithSyntaxHighlightingAction (after execCommand copy)');
		CopyOptions.forceCopyWithSyntaxHighlighting = false;
	}
}

/**
 * Execute a clipboard copy with a workaround for a known race condition
 * where `document.execCommand('copy')` does not fire the `copy` event.
 *
 * If the copy event never fires (detected via
 * {@link CopyOptions.electronBugWorkaroundCopyEventHasFired}), the method
 * falls back to writing plain-text content directly through the clipboard
 * service, bypassing the browser's clipboard pipeline.
 *
 * @param editor - The active code editor whose selection should be copied.
 * @param clipboardService - The clipboard service used as a fallback write path.
 */
function executeClipboardCopyWithWorkaround(editor: IActiveCodeEditor, clipboardService: IClipboardService) {
	// !!!!!
	// This is a workaround for what we think is an Electron bug where
	// execCommand('copy') does not always work (it does not fire a clipboard event)
	// We will use this as a signal that we have executed a copy command
	// !!!!!
	CopyOptions.electronBugWorkaroundCopyEventHasFired = false;
	editor.getContainerDomNode().ownerDocument.execCommand('copy');
	if (platform.isNative && CopyOptions.electronBugWorkaroundCopyEventHasFired === false) {
		// We have encountered the Electron bug!
		// As a workaround, we will write (only the plaintext data) to the clipboard in a different way
		// We will use the clipboard service (which in the native case will go to electron's clipboard API)
		const { dataToCopy } = generateDataToCopyAndStoreInMemory(editor._getViewModel(), undefined, browser.isFirefox);
		clipboardService.writeText(dataToCopy.text);
	}
}

/**
 * Register two implementations on a cut/copy multi-command:
 *
 * 1. **code-editor** (priority 10000) — handles the case where a code editor
 *    has text focus. Executes `execCommand('cut'|'copy')` on the editor's DOM
 *    node, with a special case for Edit Context mode where `cut` is performed
 *    by first copying via `execCommand('copy')` then triggering the editor's
 *    `Handler.Cut` to remove the selection.
 * 2. **generic-dom** (priority 0) — fallback that calls `execCommand` on the
 *    active document for any other focused element.
 *
 * @param target - The multi-command to register implementations on, or `undefined`
 *                 if the platform does not support the command (no-op).
 * @param browserCommand - The `document.execCommand` identifier: `'cut'` or `'copy'`.
 */
function registerExecCommandImpl(target: MultiCommand | undefined, browserCommand: 'cut' | 'copy'): void {
	if (!target) {
		return;
	}

	// 1. handle case when focus is in editor.
	target.addImplementation(10000, 'code-editor', (accessor: ServicesAccessor, args: unknown) => {
		const logService = accessor.get(ILogService);
		const clipboardService = accessor.get(IClipboardService);
		logService.trace('registerExecCommandImpl (addImplementation code-editor for : ', browserCommand, ')');
		// Only if editor text focus (i.e. not if editor has widget focus).
		const focusedEditor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
		if (focusedEditor && focusedEditor.hasTextFocus() && focusedEditor.hasModel()) {
			// Do not execute if there is no selection and empty selection clipboard is off
			const emptySelectionClipboard = focusedEditor.getOption(EditorOption.emptySelectionClipboard);
			const selection = focusedEditor.getSelection();
			if (selection && selection.isEmpty() && !emptySelectionClipboard) {
				return true;
			}
			// TODO this is very ugly. The entire copy/paste/cut system needs a complete refactoring.
			if (focusedEditor.getOption(EditorOption.effectiveEditContext) && browserCommand === 'cut') {
				logCopyCommand(focusedEditor);
				// execCommand(copy) works for edit context, but not execCommand(cut).
				logService.trace('registerExecCommandImpl (before execCommand copy)');
				executeClipboardCopyWithWorkaround(focusedEditor, clipboardService);
				focusedEditor.trigger(undefined, Handler.Cut, undefined);
				logService.trace('registerExecCommandImpl (after execCommand copy)');
			} else {
				logCopyCommand(focusedEditor);
				logService.trace('registerExecCommandImpl (before execCommand ' + browserCommand + ')');
				if (browserCommand === 'copy') {
					executeClipboardCopyWithWorkaround(focusedEditor, clipboardService);
				} else {
					focusedEditor.getContainerDomNode().ownerDocument.execCommand(browserCommand);
				}
				logService.trace('registerExecCommandImpl (after execCommand ' + browserCommand + ')');
			}
			return true;
		}
		return false;
	});

	// 2. (default) handle case when focus is somewhere else.
	target.addImplementation(0, 'generic-dom', (accessor: ServicesAccessor, args: unknown) => {
		const logService = accessor.get(ILogService);
		logService.trace('registerExecCommandImpl (addImplementation generic-dom for : ', browserCommand, ')');
		logService.trace('registerExecCommandImpl (before execCommand ' + browserCommand + ')');
		getActiveDocument().execCommand(browserCommand);
		logService.trace('registerExecCommandImpl (after execCommand ' + browserCommand + ')');
		return true;
	});
}

/**
 * Notify the native Edit Context layer that a copy operation is about to occur,
 * so it can prepare the clipboard data (e.g. HTML with syntax highlighting).
 *
 * No-op when Edit Context is disabled for the given editor.
 *
 * @param editor - The code editor that is about to execute a copy.
 */
function logCopyCommand(editor: ICodeEditor) {
	const editContextEnabled = editor.getOption(EditorOption.effectiveEditContext);
	if (editContextEnabled) {
		const nativeEditContext = NativeEditContextRegistry.get(editor.getId());
		if (nativeEditContext) {
			nativeEditContext.handleWillCopy();
		}
	}
}

registerExecCommandImpl(CutAction, 'cut');
registerExecCommandImpl(CopyAction, 'copy');

if (PasteAction) {
	// 1. Paste: handle case when focus is in editor.
	PasteAction.addImplementation(10000, 'code-editor', (accessor: ServicesAccessor, args: unknown) => {
		const logService = accessor.get(ILogService);
		logService.trace('registerExecCommandImpl (addImplementation code-editor for : paste)');
		const codeEditorService = accessor.get(ICodeEditorService);
		const clipboardService = accessor.get(IClipboardService);

		// Only if editor text focus (i.e. not if editor has widget focus).
		const focusedEditor = codeEditorService.getFocusedCodeEditor();
		if (focusedEditor && focusedEditor.hasModel() && focusedEditor.hasTextFocus()) {
			// execCommand(paste) does not work with edit context
			const editContextEnabled = focusedEditor.getOption(EditorOption.effectiveEditContext);
			if (editContextEnabled) {
				const nativeEditContext = NativeEditContextRegistry.get(focusedEditor.getId());
				if (nativeEditContext) {
					nativeEditContext.handleWillPaste();
				}
			}

			logService.trace('registerExecCommandImpl (before triggerPaste)');
			const triggerPaste = clipboardService.triggerPaste(getActiveWindow().vscodeWindowId);
			if (triggerPaste) {
				logService.trace('registerExecCommandImpl (triggerPaste defined)');
				return triggerPaste.then(async () => {
					logService.trace('registerExecCommandImpl (after triggerPaste)');
					return CopyPasteController.get(focusedEditor)?.finishedPaste() ?? Promise.resolve();
				});
			} else {
				logService.trace('registerExecCommandImpl (triggerPaste undefined)');
			}
			if (platform.isWeb || platform.isTauri) {
				logService.trace('registerExecCommandImpl (Paste handling on web/tauri)');
				// Use the clipboard service if document.execCommand('paste') was not successful
				return (async () => {
					const clipboardText = await clipboardService.readText();
					if (clipboardText !== '') {
						const metadata = InMemoryClipboardMetadataManager.INSTANCE.get(clipboardText);
						let pasteOnNewLine = false;
						let multicursorText: string[] | null = null;
						let mode: string | null = null;
						if (metadata) {
							pasteOnNewLine = (focusedEditor.getOption(EditorOption.emptySelectionClipboard) && !!metadata.isFromEmptySelection);
							multicursorText = (typeof metadata.multicursorText !== 'undefined' ? metadata.multicursorText : null);
							mode = metadata.mode;
						}
						logService.trace('registerExecCommandImpl (clipboardText.length : ', clipboardText.length, ' id : ', metadata?.id, ')');
						focusedEditor.trigger('keyboard', Handler.Paste, {
							text: clipboardText,
							pasteOnNewLine,
							multicursorText,
							mode
						});
					}
				})();
			}
			return true;
		}
		return false;
	});

	// 2. Paste: (default) handle case when focus is somewhere else.
	PasteAction.addImplementation(0, 'generic-dom', (accessor: ServicesAccessor, args: unknown) => {
		const logService = accessor.get(ILogService);
		logService.trace('registerExecCommandImpl (addImplementation generic-dom for : paste)');
		if (platform.isTauri) {
			// The PasteAction keybinding intercepts Ctrl+V before it reaches the
			// browser, so the native paste event never fires on non-editor elements
			// (e.g. xterm.js terminal). Read the clipboard directly and dispatch a
			// synthetic paste event so that listeners like xterm.js can process it.
			const clipboardService = accessor.get(IClipboardService);
			return (async () => {
				const text = await clipboardService.readText();
				if (text) {
					const target = getActiveDocument().activeElement;
					if (target) {
						const dt = new DataTransfer();
						dt.setData('text/plain', text);
						target.dispatchEvent(new ClipboardEvent('paste', {
							clipboardData: dt,
							bubbles: true,
							cancelable: true,
						}));
					}
				}
			})();
		}
		const triggerPaste = accessor.get(IClipboardService).triggerPaste(getActiveWindow().vscodeWindowId);
		return triggerPaste ?? false;
	});
}

if (supportsCopy) {
	registerEditorAction(ExecCommandCopyWithSyntaxHighlightingAction);
}
