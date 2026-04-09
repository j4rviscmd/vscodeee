/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { IMarkdownString } from '../../../base/common/htmlContent.js';
import { basename } from '../../../base/common/resources.js';
import Severity from '../../../base/common/severity.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ITelemetryData } from '../../telemetry/common/telemetry.js';
import { MessageBoxOptions } from '../../../base/parts/sandbox/common/nativeDialogTypes.js';
import { mnemonicButtonLabel } from '../../../base/common/labels.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { IProductService } from '../../product/common/productService.js';
import { deepClone } from '../../../base/common/objects.js';

/**
 * Arguments for a dialog request. Exactly one of the sub-args should be provided.
 */
export interface IDialogArgs {
	readonly confirmArgs?: IConfirmDialogArgs;
	readonly inputArgs?: IInputDialogArgs;
	readonly promptArgs?: IPromptDialogArgs;
}

/**
 * Base options shared by all dialog types.
 */
export interface IBaseDialogOptions {
	readonly type?: Severity | DialogType;

	readonly title?: string;
	readonly message: string;
	readonly detail?: string;

	readonly checkbox?: ICheckbox;

	/**
	 * Allows to enforce use of custom dialog even in native environments.
	 */
	readonly custom?: boolean | ICustomDialogOptions;

	/**
	 * An optional cancellation token that can be used to dismiss the dialog
	 * programmatically for custom dialog implementations.
	 *
	 * When cancelled, the custom dialog resolves as if the cancel button was
	 * pressed. Native dialog handlers cannot currently be dismissed
	 * programmatically and ignore this option unless a custom dialog is
	 * explicitly enforced via the {@link custom} option.
	 */
	readonly token?: CancellationToken;
}

/**
 * Arguments for a confirmation dialog.
 */
export interface IConfirmDialogArgs {
	readonly confirmation: IConfirmation;
}

/**
 * Options for a confirmation dialog with primary and cancel buttons.
 */
export interface IConfirmation extends IBaseDialogOptions {

	/**
	 * If not provided, defaults to `Yes`.
	 */
	readonly primaryButton?: string;

	/**
	 * If not provided, defaults to `Cancel`.
	 */
	readonly cancelButton?: string;
}

/**
 * Result of a confirmation dialog interaction.
 */
export interface IConfirmationResult extends ICheckboxResult {

	/**
	 * Will be true if the dialog was confirmed with the primary button pressed.
	 */
	readonly confirmed: boolean;
}

/**
 * Arguments for an input dialog.
 */
export interface IInputDialogArgs {
	readonly input: IInput;
}

/**
 * Options for an input dialog that prompts the user for text input.
 */
export interface IInput extends IConfirmation {
	readonly inputs: IInputElement[];

	/**
	 * If not provided, defaults to `Ok`.
	 */
	readonly primaryButton?: string;
}

/**
 * An input element within a dialog (text or password field).
 */
export interface IInputElement {
	readonly type?: 'text' | 'password';
	readonly value?: string;
	readonly placeholder?: string;
}

/**
 * Result of an input dialog interaction.
 */
export interface IInputResult extends IConfirmationResult {

	/**
	 * Values for the input fields as provided by the user or `undefined` if none.
	 */
	readonly values?: string[];
}

/**
 * Arguments for a prompt dialog.
 */
export interface IPromptDialogArgs {
	readonly prompt: IPrompt<unknown>;
}

/**
 * Base interface for a button in a prompt dialog that produces a result.
 *
 * @typeParam T - The type of result returned when the button is pressed.
 */
export interface IPromptBaseButton<T> {

	/**
	 * @returns the result of the prompt button will be returned
	 * as result from the `prompt()` call.
	 */
	run(checkbox: ICheckboxResult): T | Promise<T>;
}

/**
 * A labeled button in a prompt dialog that produces a typed result.
 *
 * @typeParam T - The type of result returned when the button is pressed.
 */
export interface IPromptButton<T> extends IPromptBaseButton<T> {
	readonly label: string;
}

/**
 * A cancel button in a prompt dialog that produces a typed result.
 *
 * @typeParam T - The type of result returned when the button is pressed.
 */
export interface IPromptCancelButton<T> extends IPromptBaseButton<T> {

	/**
	 * The cancel button to show in the prompt. Defaults to
	 * `Cancel` if not provided.
	 */
	readonly label?: string;
}

/**
 * Options for a prompt dialog with configurable buttons and cancel behavior.
 *
 * @typeParam T - The type of result returned from the pressed button.
 */
export interface IPrompt<T> extends IBaseDialogOptions {

	/**
	 * The buttons to show in the prompt. Defaults to `OK`
	 * if no buttons or cancel button is provided.
	 */
	readonly buttons?: IPromptButton<T>[];

	/**
	 * The cancel button to show in the prompt. Defaults to
	 * `Cancel` if set to `true`.
	 */
	readonly cancelButton?: IPromptCancelButton<T> | true | string;
}

/**
 * A prompt with a custom cancel button that returns a result.
 *
 * @typeParam T - The type of result returned from the pressed button.
 */
export interface IPromptWithCustomCancel<T> extends IPrompt<T> {
	readonly cancelButton: IPromptCancelButton<T>;
}

/**
 * A prompt with a default cancel button (true or a string label).
 *
 * @typeParam T - The type of result returned from the pressed button.
 */
export interface IPromptWithDefaultCancel<T> extends IPrompt<T> {
	readonly cancelButton: true | string;
}

/**
 * Result of a prompt dialog interaction.
 *
 * @typeParam T - The type of result from the pressed button.
 */
export interface IPromptResult<T> extends ICheckboxResult {

	/**
	 * The result of the `IPromptButton` that was pressed or `undefined` if none.
	 */
	readonly result?: T;
}

/**
 * Result of a prompt with a custom cancel button. The result is always defined.
 *
 * @typeParam T - The type of result from the pressed button.
 */
export interface IPromptResultWithCancel<T> extends IPromptResult<T> {
	readonly result: T;
}

/**
 * Result of a prompt dialog interaction where the result is wrapped in a Promise.
 *
 * @typeParam T - The type of result from the pressed button.
 */
export interface IAsyncPromptResult<T> extends ICheckboxResult {

	/**
	 * The result of the `IPromptButton` that was pressed or `undefined` if none.
	 */
	readonly result?: Promise<T>;
}

/**
 * Result of a prompt with a custom cancel button where the result is a Promise.
 *
 * @typeParam T - The type of result from the pressed button.
 */
export interface IAsyncPromptResultWithCancel<T> extends IAsyncPromptResult<T> {
	readonly result: Promise<T>;
}

/** Union type of all possible dialog result types. */
export type IDialogResult = IConfirmationResult | IInputResult | IAsyncPromptResult<unknown>;

/** The type of a dialog, controlling the icon displayed. */
export type DialogType = 'none' | 'info' | 'error' | 'question' | 'warning';

/**
 * A checkbox option that can be shown in a dialog.
 */
export interface ICheckbox {
	readonly label: string;
	readonly checked?: boolean;
}

/**
 * Result that includes the checkbox state from a dialog.
 */
export interface ICheckboxResult {

	/**
	 * This will only be defined if the confirmation was created
	 * with the checkbox option defined.
	 */
	readonly checkboxChecked?: boolean;
}

/**
 * Options for the pick-and-open file/folder dialog flow.
 */
export interface IPickAndOpenOptions {
	readonly forceNewWindow?: boolean;
	defaultUri?: URI;
	readonly telemetryExtraData?: ITelemetryData;
	availableFileSystems?: string[];
	remoteAuthority?: string | null;
}

/**
 * A file filter used in save/open dialogs. Each entry provides a human-readable
 * label and a list of file extensions to match.
 */
export interface FileFilter {
	readonly extensions: string[];
	readonly name: string;
}

export interface ISaveDialogOptions {

	/**
	 * A human-readable string for the dialog title
	 */
	title?: string;

	/**
	 * The resource the dialog shows when opened.
	 */
	defaultUri?: URI;

	/**
	 * A set of file filters that are used by the dialog. Each entry is a human readable label,
	 * like "TypeScript", and an array of extensions.
	 */
	filters?: FileFilter[];

	/**
	 * A human-readable string for the ok button
	 */
	readonly saveLabel?: { readonly withMnemonic: string; readonly withoutMnemonic: string } | string;

	/**
	 * Specifies a list of schemas for the file systems the user can save to. If not specified, uses the schema of the defaultURI or, if also not specified,
	 * the schema of the current window.
	 */
	availableFileSystems?: readonly string[];
}

export interface IOpenDialogOptions {

	/**
	 * A human-readable string for the dialog title
	 */
	readonly title?: string;

	/**
	 * The resource the dialog shows when opened.
	 */
	defaultUri?: URI;

	/**
	 * A human-readable string for the open button.
	 */
	readonly openLabel?: { readonly withMnemonic: string; readonly withoutMnemonic: string } | string;

	/**
	 * Allow to select files, defaults to `true`.
	 */
	canSelectFiles?: boolean;

	/**
	 * Allow to select folders, defaults to `false`.
	 */
	canSelectFolders?: boolean;

	/**
	 * Allow to select many files or folders.
	 */
	readonly canSelectMany?: boolean;

	/**
	 * A set of file filters that are used by the dialog. Each entry is a human readable label,
	 * like "TypeScript", and an array of extensions.
	 */
	filters?: FileFilter[];

	/**
	 * Specifies a list of schemas for the file systems the user can load from. If not specified, uses the schema of the defaultURI or, if also not available,
	 * the schema of the current window.
	 */
	availableFileSystems?: readonly string[];
}

export const IDialogService = createDecorator<IDialogService>('dialogService');

/**
 * Additional options for custom-styled dialogs.
 */
export interface ICustomDialogOptions {
	readonly buttonDetails?: string[];
	readonly markdownDetails?: ICustomDialogMarkdown[];
	readonly classes?: string[];
	readonly icon?: ThemeIcon;
	readonly disableCloseAction?: boolean;
}

/**
 * Markdown content to display in a custom dialog.
 */
export interface ICustomDialogMarkdown {
	readonly markdown: IMarkdownString;
	readonly classes?: string[];
	/** Custom link handler for markdown content, see {@link IContentActionHandler}. Defaults to {@link openLinkFromMarkdown}. */
	actionHandler?(link: string): Promise<boolean>;
}

/**
 * A handler to bring up modal dialogs.
 */
export interface IDialogHandler {

	/**
	 * Ask the user for confirmation with a modal dialog.
	 */
	confirm(confirmation: IConfirmation): Promise<IConfirmationResult>;

	/**
	 * Prompt the user with a modal dialog.
	 */
	prompt<T>(prompt: IPrompt<T>): Promise<IAsyncPromptResult<T>>;

	/**
	 * Present a modal dialog to the user asking for input.
	 */
	input(input: IInput): Promise<IInputResult>;

	/**
	 * Present the about dialog to the user.
	 */
	about(title: string, details: string, detailsToCopy: string): Promise<void>;
}

enum DialogKind {
	Confirmation = 1,
	Prompt,
	Input
}

/**
 * Abstract base class for dialog handlers. Provides shared logic for building
 * button labels, determining dialog types, and computing prompt results.
 *
 * Implementations must override the `confirm`, `input`, `prompt`, and `about`
 * methods to provide platform-specific dialog behavior.
 */
export abstract class AbstractDialogHandler implements IDialogHandler {

	/**
	 * Get the button labels for a confirmation dialog.
	 * @param dialog - The confirmation dialog options.
	 * @returns An array of localized button label strings.
	 */
	protected getConfirmationButtons(dialog: IConfirmation): string[] {
		return this.getButtons(dialog, DialogKind.Confirmation);
	}

	/**
	 * Get the button labels for a prompt dialog.
	 * @param dialog - The prompt dialog options.
	 * @returns An array of localized button label strings.
	 */
	protected getPromptButtons(dialog: IPrompt<unknown>): string[] {
		return this.getButtons(dialog, DialogKind.Prompt);
	}

	/**
	 * Get the button labels for an input dialog.
	 * @param dialog - The input dialog options.
	 * @returns An array of localized button label strings.
	 */
	protected getInputButtons(dialog: IInput): string[] {
		return this.getButtons(dialog, DialogKind.Input);
	}

	private getButtons(dialog: IConfirmation, kind: DialogKind.Confirmation): string[];
	private getButtons(dialog: IPrompt<unknown>, kind: DialogKind.Prompt): string[];
	private getButtons(dialog: IInput, kind: DialogKind.Input): string[];
	/**
	 * Build the list of button labels for a dialog based on its kind.
	 *
	 * For confirmation dialogs, defaults to "Yes" and "Cancel".
	 * For prompt dialogs, uses the provided button labels or defaults to "OK".
	 * For input dialogs, defaults to "OK" and "Cancel".
	 *
	 * @param dialog - The dialog options containing button configuration.
	 * @param kind - The kind of dialog to build buttons for.
	 * @returns An array of localized button label strings.
	 */
	private getButtons(dialog: IConfirmation | IInput | IPrompt<unknown>, kind: DialogKind): string[] {

		// We put buttons in the order of "default" button first and "cancel"
		// button last. There maybe later processing when presenting the buttons
		// based on OS standards.

		const buttons: string[] = [];

		switch (kind) {
			case DialogKind.Confirmation: {
				const confirmationDialog = dialog as IConfirmation;

				if (confirmationDialog.primaryButton) {
					buttons.push(confirmationDialog.primaryButton);
				} else {
					buttons.push(localize({ key: 'yesButton', comment: ['&& denotes a mnemonic'] }, "&&Yes"));
				}

				if (confirmationDialog.cancelButton) {
					buttons.push(confirmationDialog.cancelButton);
				} else {
					buttons.push(localize('cancelButton', "Cancel"));
				}

				break;
			}
			case DialogKind.Prompt: {
				const promptDialog = dialog as IPrompt<unknown>;

				if (Array.isArray(promptDialog.buttons) && promptDialog.buttons.length > 0) {
					buttons.push(...promptDialog.buttons.map(button => button.label));
				}

				if (promptDialog.cancelButton) {
					if (promptDialog.cancelButton === true) {
						buttons.push(localize('cancelButton', "Cancel"));
					} else if (typeof promptDialog.cancelButton === 'string') {
						buttons.push(promptDialog.cancelButton);
					} else {
						if (promptDialog.cancelButton.label) {
							buttons.push(promptDialog.cancelButton.label);
						} else {
							buttons.push(localize('cancelButton', "Cancel"));
						}
					}
				}

				if (buttons.length === 0) {
					buttons.push(localize({ key: 'okButton', comment: ['&& denotes a mnemonic'] }, "&&OK"));
				}

				break;
			}
			case DialogKind.Input: {
				const inputDialog = dialog as IInput;

				if (inputDialog.primaryButton) {
					buttons.push(inputDialog.primaryButton);
				} else {
					buttons.push(localize({ key: 'okButton', comment: ['&& denotes a mnemonic'] }, "&&OK"));
				}

				if (inputDialog.cancelButton) {
					buttons.push(inputDialog.cancelButton);
				} else {
					buttons.push(localize('cancelButton', "Cancel"));
				}

				break;
			}
		}

		return buttons;
	}

	/**
	 * Convert a `Severity` or `DialogType` value to a `DialogType`.
	 *
	 * @param type - The severity level or dialog type string.
	 * @returns The corresponding `DialogType`, or `undefined` if not provided.
	 */
	protected getDialogType(type: Severity | DialogType | undefined): DialogType | undefined {
		if (typeof type === 'string') {
			return type;
		}

		if (typeof type === 'number') {
			if (type === Severity.Info) { return 'info'; }
			if (type === Severity.Error) { return 'error'; }
			if (type === Severity.Warning) { return 'warning'; }
			return 'none';
		}

		return undefined;
	}

	/**
	 * Compute the result of a prompt dialog based on the pressed button index.
	 *
	 * @typeParam T - The type of result returned by the prompt buttons.
	 * @param prompt - The prompt options containing button definitions.
	 * @param buttonIndex - The index of the button that was pressed.
	 * @param checkboxChecked - Whether the checkbox was checked, if present.
	 * @returns The async prompt result wrapping the button's return value.
	 */
	protected getPromptResult<T>(prompt: IPrompt<T>, buttonIndex: number, checkboxChecked: boolean | undefined): IAsyncPromptResult<T> {
		const promptButtons: IPromptBaseButton<T>[] = [...(prompt.buttons ?? [])];
		if (prompt.cancelButton && typeof prompt.cancelButton !== 'string' && typeof prompt.cancelButton !== 'boolean') {
			promptButtons.push(prompt.cancelButton);
		}

		let result = promptButtons[buttonIndex]?.run({ checkboxChecked });
		if (!(result instanceof Promise)) {
			result = Promise.resolve(result);
		}

		return { result, checkboxChecked };
	}

	abstract confirm(confirmation: IConfirmation): Promise<IConfirmationResult>;
	abstract input(input: IInput): Promise<IInputResult>;
	abstract prompt<T>(prompt: IPrompt<T>): Promise<IAsyncPromptResult<T>>;
	abstract about(title: string, details: string, detailsToCopy: string): Promise<void>;
}

/**
 * A service to bring up modal dialogs.
 *
 * Note: use the `INotificationService.prompt()` method for a non-modal way to ask
 * the user for input.
 */
export interface IDialogService {

	readonly _serviceBrand: undefined;

	/**
	 * An event that fires when a dialog is about to show.
	 */
	readonly onWillShowDialog: Event<void>;

	/**
	 * An event that fires when a dialog did show (closed).
	 */
	readonly onDidShowDialog: Event<void>;

	/**
	 * Ask the user for confirmation with a modal dialog.
	 */
	confirm(confirmation: IConfirmation): Promise<IConfirmationResult>;

	/**
	 * Prompt the user with a modal dialog. Provides a bit
	 * more control over the dialog compared to the simpler
	 * `confirm` method. Specifically, allows to show more
	 * than 2 buttons and makes it easier to just show a
	 * message to the user.
	 *
	 * @returns a promise that resolves to the `T` result
	 * from the provided `IPromptButton<T>` or `undefined`.
	 */
	prompt<T>(prompt: IPromptWithCustomCancel<T>): Promise<IPromptResultWithCancel<T>>;
	prompt<T>(prompt: IPromptWithDefaultCancel<T>): Promise<IPromptResult<T>>;
	prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>>;

	/**
	 * Present a modal dialog to the user asking for input.
	 */
	input(input: IInput): Promise<IInputResult>;

	/**
	 * Show a modal info dialog.
	 */
	info(message: string, detail?: string): Promise<void>;

	/**
	 * Show a modal warning dialog.
	 */
	warn(message: string, detail?: string): Promise<void>;

	/**
	 * Show a modal error dialog.
	 */
	error(message: string, detail?: string): Promise<void>;

	/**
	 * Present the about dialog to the user.
	 */
	about(): Promise<void>;
}

export const IFileDialogService = createDecorator<IFileDialogService>('fileDialogService');

/**
 * A service to bring up file dialogs.
 */
export interface IFileDialogService {

	readonly _serviceBrand: undefined;

	/**
	 * The default path for a new file based on previously used files.
	 * @param schemeFilter The scheme of the file path. If no filter given, the scheme of the current window is used.
	 * Falls back to user home in the absence of enough information to find a better URI.
	 */
	defaultFilePath(schemeFilter?: string): Promise<URI>;

	/**
	 * The default path for a new folder based on previously used folders.
	 * @param schemeFilter The scheme of the folder path. If no filter given, the scheme of the current window is used.
	 * Falls back to user home in the absence of enough information to find a better URI.
	 */
	defaultFolderPath(schemeFilter?: string): Promise<URI>;

	/**
	 * The default path for a new workspace based on previously used workspaces.
	 * @param schemeFilter The scheme of the workspace path. If no filter given, the scheme of the current window is used.
	 * Falls back to user home in the absence of enough information to find a better URI.
	 */
	defaultWorkspacePath(schemeFilter?: string): Promise<URI>;

	/**
	 * Shows a file-folder selection dialog and opens the selected entry.
	 */
	pickFileFolderAndOpen(options: IPickAndOpenOptions): Promise<void>;

	/**
	 * Shows a file selection dialog and opens the selected entry.
	 */
	pickFileAndOpen(options: IPickAndOpenOptions): Promise<void>;

	/**
	 * Shows a folder selection dialog and opens the selected entry.
	 */
	pickFolderAndOpen(options: IPickAndOpenOptions): Promise<void>;

	/**
	 * Shows a workspace selection dialog and opens the selected entry.
	 */
	pickWorkspaceAndOpen(options: IPickAndOpenOptions): Promise<void>;

	/**
	 * Shows a save file dialog and save the file at the chosen file URI.
	 */
	pickFileToSave(defaultUri: URI, availableFileSystems?: string[]): Promise<URI | undefined>;

	/**
	 * The preferred folder path to open the dialog at.
	 * @param schemeFilter The scheme of the file path. If no filter given, the scheme of the current window is used.
	 * Falls back to user home in the absence of a setting.
	 */
	preferredHome(schemeFilter?: string): Promise<URI>;

	/**
	 * Shows a save file dialog and returns the chosen file URI.
	 */
	showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined>;

	/**
	 * Shows a confirm dialog for saving 1-N files.
	 */
	showSaveConfirm(fileNamesOrResources: (string | URI)[]): Promise<ConfirmResult>;

	/**
	 * Shows a open file dialog and returns the chosen file URI.
	 */
	showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined>;
}

export const enum ConfirmResult {
	SAVE,
	DONT_SAVE,
	CANCEL
}

const MAX_CONFIRM_FILES = 10;

/**
 * Build a human-readable message listing file names for a save-confirmation dialog.
 *
 * Shows up to {@link MAX_CONFIRM_FILES} file names, then appends a summary
 * line for any additional files not shown.
 *
 * @param fileNamesOrResources - An array of file names or URIs to list.
 * @returns A newline-separated string of file names with a trailing blank line.
 */
export function getFileNamesMessage(fileNamesOrResources: readonly (string | URI)[]): string {
	const message: string[] = [];
	message.push(...fileNamesOrResources.slice(0, MAX_CONFIRM_FILES).map(fileNameOrResource => typeof fileNameOrResource === 'string' ? fileNameOrResource : basename(fileNameOrResource)));

	if (fileNamesOrResources.length > MAX_CONFIRM_FILES) {
		if (fileNamesOrResources.length - MAX_CONFIRM_FILES === 1) {
			message.push(localize('moreFile', "...1 additional file not shown"));
		} else {
			message.push(localize('moreFiles', "...{0} additional files not shown", fileNamesOrResources.length - MAX_CONFIRM_FILES));
		}
	}

	message.push('');
	return message.join('\n');
}

/**
 * Options for native open dialogs used by the native host service.
 */
export interface INativeOpenDialogOptions {
	readonly forceNewWindow?: boolean;

	readonly defaultPath?: string;

	readonly telemetryEventName?: string;
	readonly telemetryExtraData?: ITelemetryData;
}

/**
 * The result of {@link massageMessageBoxOptions}. Contains the platform-adjusted
 * dialog options and a mapping from the new button order back to the original
 * indices.
 */
export interface IMassagedMessageBoxOptions {

	/**
	 * OS massaged message box options.
	 */
	readonly options: MessageBoxOptions;

	/**
	 * Since the massaged result of the message box options potentially
	 * changes the order of buttons, we have to keep a map of these
	 * changes so that we can still return the correct index to the caller.
	 */
	readonly buttonIndeces: number[];
}

/**
 * A utility method to ensure the options for the message box dialog
 * are using properties that are consistent across all platforms and
 * specific to the platform where necessary.
 */
export function massageMessageBoxOptions(options: MessageBoxOptions, productService: IProductService): IMassagedMessageBoxOptions {
	const massagedOptions = deepClone(options);

	let buttons = (massagedOptions.buttons ?? []).map(button => mnemonicButtonLabel(button).withMnemonic);
	let buttonIndeces = (options.buttons || []).map((button, index) => index);

	let defaultId = 0; // by default the first button is default button
	let cancelId = massagedOptions.cancelId ?? buttons.length - 1; // by default the last button is cancel button

	// Apply HIG per OS when more than one button is used
	if (buttons.length > 1) {
		const cancelButton = typeof cancelId === 'number' ? buttons[cancelId] : undefined;

		if (isLinux || isMacintosh) {

			// Linux: the GNOME HIG (https://developer.gnome.org/hig/patterns/feedback/dialogs.html?highlight=dialog)
			// recommend the following:
			// "Always ensure that the cancel button appears first, before the affirmative button. In left-to-right
			//  locales, this is on the left. This button order ensures that users become aware of, and are reminded
			//  of, the ability to cancel prior to encountering the affirmative button."
			//
			// Electron APIs do not reorder buttons for us, so we ensure a reverse order of buttons and a position
			// of the cancel button (if provided) that matches the HIG

			// macOS: the HIG (https://developer.apple.com/design/human-interface-guidelines/components/presentation/alerts)
			// recommend the following:
			// "Place buttons where people expect. In general, place the button people are most likely to choose on the trailing side in a
			//  row of buttons or at the top in a stack of buttons. Always place the default button on the trailing side of a row or at the
			//  top of a stack. Cancel buttons are typically on the leading side of a row or at the bottom of a stack."
			//
			// However: it seems that older macOS versions where 3 buttons were presented in a row differ from this
			// recommendation. In fact, cancel buttons were placed to the left of the default button and secondary
			// buttons on the far left. To support these older macOS versions we have to manually shuffle the cancel
			// button in the same way as we do on Linux. This will not have any impact on newer macOS versions where
			// shuffling is done for us.

			if (typeof cancelButton === 'string' && buttons.length > 1 && cancelId !== 1) {
				buttons.splice(cancelId, 1);
				buttons.splice(1, 0, cancelButton);

				const cancelButtonIndex = buttonIndeces[cancelId];
				buttonIndeces.splice(cancelId, 1);
				buttonIndeces.splice(1, 0, cancelButtonIndex);

				cancelId = 1;
			}

			if (isLinux && buttons.length > 1) {
				buttons = buttons.reverse();
				buttonIndeces = buttonIndeces.reverse();

				defaultId = buttons.length - 1;
				if (typeof cancelButton === 'string') {
					cancelId = defaultId - 1;
				}
			}
		} else if (isWindows) {

			// Windows: the HIG (https://learn.microsoft.com/en-us/windows/win32/uxguide/win-dialog-box)
			// recommend the following:
			// "One of the following sets of concise commands: Yes/No, Yes/No/Cancel, [Do it]/Cancel,
			//  [Do it]/[Don't do it], [Do it]/[Don't do it]/Cancel."
			//
			// Electron APIs do not reorder buttons for us, so we ensure the position of the cancel button
			// (if provided) that matches the HIG

			if (typeof cancelButton === 'string' && buttons.length > 1 && cancelId !== buttons.length - 1 /* last action */) {
				buttons.splice(cancelId, 1);
				buttons.push(cancelButton);

				const buttonIndex = buttonIndeces[cancelId];
				buttonIndeces.splice(cancelId, 1);
				buttonIndeces.push(buttonIndex);

				cancelId = buttons.length - 1;
			}
		}
	}

	massagedOptions.buttons = buttons;
	massagedOptions.defaultId = defaultId;
	massagedOptions.cancelId = cancelId;
	massagedOptions.noLink = true;
	massagedOptions.title = massagedOptions.title || productService.nameLong;

	return {
		options: massagedOptions,
		buttonIndeces
	};
}
