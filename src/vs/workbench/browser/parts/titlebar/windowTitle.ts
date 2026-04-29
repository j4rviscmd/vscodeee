/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { dirname, basename } from '../../../../base/common/resources.js';
import { ITitleProperties, ITitleVariable } from './titlebarPart.js';
import { IConfigurationService, IConfigurationChangeEvent, isConfigured } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { EditorResourceAccessor, Verbosity, SideBySideEditor } from '../../../common/editor.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { IWorkspaceContextService, WorkbenchState, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { isWindows, isWeb, isMacintosh, isNative, isTauri } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { trim } from '../../../../base/common/strings.js';
import { template } from '../../../../base/common/labels.js';
import { ILabelService, Verbosity as LabelVerbosity } from '../../../../platform/label/common/label.js';
import { Emitter } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Schemas } from '../../../../base/common/network.js';
import { getVirtualWorkspaceLocation } from '../../../../platform/workspace/common/virtualWorkspace.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { getWindowById } from '../../../../base/browser/dom.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';

/** Configuration setting names used by the window title. */
const enum WindowSettingNames {
	titleSeparator = 'window.titleSeparator',
	title = 'window.title',
}

/**
 * Default window title template string, computed at module load time.
 *
 * The template varies by platform to match native conventions:
 * - **macOS**: Omits `${dirty}` (the native title bar shows the dot indicator)
 *   and `${appName}` (the app name is shown by the menu bar).
 * - **Windows/Linux**: Includes `${dirty}` and `${appName}` in the title.
 * - **Web**: Appends `${remoteName}` to always indicate remote connections.
 *
 * In Tauri, the same per-OS defaults as Electron are used since Tauri
 * behaves as a native application.
 */
export const defaultWindowTitle = (() => {
	// Tauri behaves as native app — match upstream Electron defaults per OS
	if (isTauri) {
		if (isMacintosh) {
			return '${activeEditorShort}${separator}${rootName}${separator}${profileName}'; // macOS has native dirty indicator
		}
		return '${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}';
	}

	if (isMacintosh && isNative) {
		return '${activeEditorShort}${separator}${rootName}${separator}${profileName}'; // macOS has native dirty indicator
	}

	const base = '${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}';
	if (isWeb) {
		return base + '${separator}${remoteName}'; // Web: always show remote name
	}

	return base;
})();
/**
 * Default title separator character(s).
 *
 * Uses an em dash on macOS and a hyphen on all other platforms,
 * matching each OS's native window title conventions.
 */
export const defaultWindowTitleSeparator = isMacintosh ? ' \u2014 ' : ' - ';

/**
 * Manages the window title for a VS Code window.
 *
 * Computes and applies the window title by resolving a configurable
 * template string against the current editor, workspace, and environment
 * state. Supports template variables such as `${activeEditorShort}`,
 * `${rootName}`, `${appName}`, `${dirty}`, `${focusedView}`, and
 * custom context-key-based variables registered by extensions.
 *
 * The resolved title is set on `document.title` and, on Tauri, also
 * forwarded to the native window via `plugin:window|set_title` so that
 * Cmd+Tab / Mission Control / Alt+Tab displays the correct title.
 *
 * @see `window.title` and `window.titleSeparator` settings for customization.
 */
export class WindowTitle extends Disposable {

	private static readonly NLS_USER_IS_ADMIN = isWindows ? localize('userIsAdmin', "[Administrator]") : localize('userIsSudo', "[Superuser]");
	private static readonly NLS_EXTENSION_HOST = localize('devExtensionWindowTitlePrefix', "[Extension Development Host]");
	private static readonly DEV_BUILD_PREFIX = 'DEV@'; // Intentionally not localized: compact technical prefix for dev/prod differentiation
	private static readonly TITLE_DIRTY = '\u25cf ';

	private readonly properties: ITitleProperties = { isPure: true, isAdmin: false, prefix: undefined };
	private readonly variables = new Map<string /* context key */, string /* name */>();

	private readonly activeEditorListeners = this._register(new DisposableStore());
	private readonly titleUpdater = this._register(new RunOnceScheduler(() => this.doUpdateTitle(), 0));

	private readonly onDidChangeEmitter = this._register(new Emitter<void>());
	/** Event that fires when the resolved window title changes. */
	readonly onDidChange = this.onDidChangeEmitter.event;

	/** The current resolved window title string, or empty string if not yet computed. */
	get value() { return this.title ?? ''; }
	/** The human-readable workspace name from the label service. */
	get workspaceName() { return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace()); }
	/**
	 * The file name of the currently active editor with a dirty indicator
	 * prefix (a bullet character) if the editor has unsaved changes.
	 * Returns `undefined` when no editor is active.
	 */
	get fileName() {
		const activeEditor = this.editorService.activeEditor;
		if (!activeEditor) {
			return undefined;
		}
		const fileName = activeEditor.getTitle(Verbosity.SHORT);
		const dirty = activeEditor?.isDirty() && !activeEditor.isSaving() ? WindowTitle.TITLE_DIRTY : '';
		return `${dirty}${fileName}`;
	}

	private title: string | undefined;

	private titleIncludesFocusedView: boolean = false;
	private titleIncludesEditorState: boolean = false;

	private readonly windowId: number;

	constructor(
		targetWindow: CodeWindow,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserWorkbenchEnvironmentService protected readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILabelService private readonly labelService: ILabelService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IProductService private readonly productService: IProductService,
		@IViewsService private readonly viewsService: IViewsService,
		@IDecorationsService private readonly decorationsService: IDecorationsService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService
	) {
		super();

		this.windowId = targetWindow.vscodeWindowId;

		this.checkTitleVariables();

		this.registerListeners();
	}

	/**
	 * Register event listeners for configuration, editor, workspace, and
	 * context-key changes that may affect the window title.
	 */
	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationChanged(e)));
		this._register(this.editorService.onDidActiveEditorChange(() => this.onActiveEditorChange()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.titleUpdater.schedule()));
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.titleUpdater.schedule()));
		this._register(this.contextService.onDidChangeWorkspaceName(() => this.titleUpdater.schedule()));
		this._register(this.labelService.onDidChangeFormatters(() => this.titleUpdater.schedule()));
		this._register(this.userDataProfileService.onDidChangeCurrentProfile(() => this.titleUpdater.schedule()));
		this._register(this.viewsService.onDidChangeFocusedView(() => {
			if (this.titleIncludesFocusedView) {
				this.titleUpdater.schedule();
			}
		}));
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(this.variables)) {
				this.titleUpdater.schedule();
			}
		}));
		this._register(this.accessibilityService.onDidChangeScreenReaderOptimized(() => this.titleUpdater.schedule()));
	}

	/**
	 * Handle configuration change events.
	 *
	 * Re-checks the title template for `${focusedView}` / `${activeEditorState}`
	 * variables and schedules a title update if the title or separator settings
	 * have changed.
	 */
	private onConfigurationChanged(event: IConfigurationChangeEvent): void {
		const affectsTitleConfiguration = event.affectsConfiguration(WindowSettingNames.title);
		if (affectsTitleConfiguration) {
			this.checkTitleVariables();
		}

		if (affectsTitleConfiguration || event.affectsConfiguration(WindowSettingNames.titleSeparator)) {
			this.titleUpdater.schedule();
		}
	}

	/**
	 * Scan the current title template for `${focusedView}` and
	 * `${activeEditorState}` variables to determine which additional
	 * listeners are needed for change detection.
	 */
	private checkTitleVariables(): void {
		const titleTemplate = this.configurationService.getValue<unknown>(WindowSettingNames.title);
		if (typeof titleTemplate === 'string') {
			this.titleIncludesFocusedView = titleTemplate.includes('${focusedView}');
			this.titleIncludesEditorState = titleTemplate.includes('${activeEditorState}');
		}
	}

	/**
	 * Handle active editor changes.
	 *
	 * Clears previous editor-specific listeners, schedules a title update,
	 * and attaches new listeners for dirty state, label changes, focus/blur
	 * (when `${focusedView}` is in the template), and decoration changes
	 * (when `${activeEditorState}` is in the template).
	 */
	private onActiveEditorChange(): void {

		// Dispose old listeners
		this.activeEditorListeners.clear();

		// Calculate New Window Title
		this.titleUpdater.schedule();

		// Apply listener for dirty and label changes
		const activeEditor = this.editorService.activeEditor;
		if (activeEditor) {
			this.activeEditorListeners.add(activeEditor.onDidChangeDirty(() => this.titleUpdater.schedule()));
			this.activeEditorListeners.add(activeEditor.onDidChangeLabel(() => this.titleUpdater.schedule()));
		}

		// Apply listeners for tracking focused code editor
		if (this.titleIncludesFocusedView) {
			const activeTextEditorControl = this.editorService.activeTextEditorControl;
			const textEditorControls: ICodeEditor[] = [];
			if (isCodeEditor(activeTextEditorControl)) {
				textEditorControls.push(activeTextEditorControl);
			} else if (isDiffEditor(activeTextEditorControl)) {
				textEditorControls.push(activeTextEditorControl.getOriginalEditor(), activeTextEditorControl.getModifiedEditor());
			}

			for (const textEditorControl of textEditorControls) {
				this.activeEditorListeners.add(textEditorControl.onDidBlurEditorText(() => this.titleUpdater.schedule()));
				this.activeEditorListeners.add(textEditorControl.onDidFocusEditorText(() => this.titleUpdater.schedule()));
			}
		}

		// Apply listener for decorations to track editor state
		if (this.titleIncludesEditorState) {
			this.activeEditorListeners.add(this.decorationsService.onDidChangeDecorations(() => this.titleUpdater.schedule()));
		}
	}

	/**
	 * Resolve and apply the new window title.
	 *
	 * Sets `document.title` on the target window. On Tauri, also invokes
	 * `plugin:window|set_title` to update the native window title for
	 * OS-level window switching (Cmd+Tab, Mission Control, Alt+Tab).
	 * Fires the `onDidChange` event when the title actually changes.
	 */
	private doUpdateTitle(): void {
		const title = this.getFullWindowTitle();
		if (title !== this.title) {

			// Always set the native window title to identify us properly to the OS
			let nativeTitle = title;
			if (!trim(nativeTitle)) {
				nativeTitle = this.productService.nameLong;
			}

			const window = getWindowById(this.windowId, true).window;
			if (!window.document.title && isMacintosh && nativeTitle === this.productService.nameLong) {
				// TODO@electron macOS: if we set a window title for
				// the first time and it matches the one we set in
				// `windowImpl.ts` somehow the window does not appear
				// in the "Windows" menu. As such, we set the title
				// briefly to something different to ensure macOS
				// recognizes we have a window.
				// See: https://github.com/microsoft/vscode/issues/191288
				window.document.title = `${this.productService.nameLong} ${WindowTitle.TITLE_DIRTY}`;
			}

			window.document.title = nativeTitle;

			// Tauri: set the native window title separately for Cmd+Tab, Mission Control, etc.
			// hiddenTitle:true prevents document.title from propagating to the native title.
			// Use the same template-resolved title so Alt+Tab shows the active editor/workspace.
			if (isTauri) {
				// TODO(Phase 2): extract __TAURI_INTERNALS__ usage into shared tauriInvoke helper
				(window as unknown as Record<string, { invoke: (cmd: string, args: Record<string, unknown>) => Promise<void> }>).__TAURI_INTERNALS__?.invoke('plugin:window|set_title', { value: nativeTitle }).catch(() => { /* runtime error */ });
			}

			this.title = title;

			this.onDidChangeEmitter.fire();
		}
	}

	/**
	 * Build the full window title including prefix/suffix decorations.
	 *
	 * Falls back to the product name when the computed title is empty,
	 * and normalizes any non-space whitespace characters to spaces.
	 *
	 * @returns The fully decorated window title string.
	 */
	private getFullWindowTitle(): string {
		const { prefix, suffix } = this.getTitleDecorations();

		let title = this.getWindowTitle() || this.productService.nameLong;
		if (prefix) {
			title = `${prefix} ${title}`;
		}

		if (suffix) {
			title = `${title} ${suffix}`;
		}

		// Replace non-space whitespace
		return title.replace(/[^\S ]/g, ' ');
	}

	/**
	 * Compute the prefix and suffix decorations for the window title.
	 *
	 * Prefix is composed from (in order of innermost to outermost):
	 * extension development host label, dev build prefix, and custom prefix.
	 * Suffix is added when running with elevated privileges (admin/sudo).
	 *
	 * @returns An object with optional `prefix` and `suffix` strings.
	 */
	getTitleDecorations() {
		let prefix: string | undefined;
		let suffix: string | undefined;

		if (this.properties.prefix) {
			prefix = this.properties.prefix;
		}

		if (this.environmentService.isExtensionDevelopment) {
			prefix = !prefix
				? WindowTitle.NLS_EXTENSION_HOST
				: `${WindowTitle.NLS_EXTENSION_HOST} - ${prefix}`;
		}

		if (this.environmentService.isDevBuild) {
			prefix = !prefix
				? WindowTitle.DEV_BUILD_PREFIX
				: `${WindowTitle.DEV_BUILD_PREFIX} ${prefix}`;
		}

		if (this.properties.isAdmin) {
			suffix = WindowTitle.NLS_USER_IS_ADMIN;
		}

		return { prefix, suffix };
	}

	/**
	 * Update the title properties (admin state, purity, custom prefix).
	 *
	 * Only triggers a title update if at least one property has actually changed.
	 *
	 * @param properties - The new title properties to apply. Missing fields
	 *   retain their current values.
	 */
	updateProperties(properties: ITitleProperties): void {
		const isAdmin = typeof properties.isAdmin === 'boolean' ? properties.isAdmin : this.properties.isAdmin;
		const isPure = typeof properties.isPure === 'boolean' ? properties.isPure : this.properties.isPure;
		const prefix = typeof properties.prefix === 'string' ? properties.prefix : this.properties.prefix;

		if (isAdmin !== this.properties.isAdmin || isPure !== this.properties.isPure || prefix !== this.properties.prefix) {
			this.properties.isAdmin = isAdmin;
			this.properties.isPure = isPure;
			this.properties.prefix = prefix;

			this.titleUpdater.schedule();
		}
	}

	/**
	 * Register custom title template variables provided by extensions.
	 *
	 * Each variable maps a context key (for change detection) to a template
	 * placeholder name (e.g., `{name: "gitBranch", contextKey: "git.branch"}`).
	 * Triggers a title update if any new variable is registered.
	 *
	 * @param variables - Array of title variable definitions to register.
	 */
	registerVariables(variables: ITitleVariable[]): void {
		let changed = false;

		for (const { name, contextKey } of variables) {
			if (!this.variables.has(contextKey)) {
				this.variables.set(contextKey, name);

				changed = true;
			}
		}

		if (changed) {
			this.titleUpdater.schedule();
		}
	}

	/**
	 * Compute the full window title by resolving the configured template
	 * against the current editor, workspace, and environment state.
	 *
	 * Possible template values:
	 *
	 * {activeEditorLong}: e.g. /Users/Development/myFolder/myFileFolder/myFile.txt
	 * {activeEditorMedium}: e.g. myFolder/myFileFolder/myFile.txt
	 * {activeEditorShort}: e.g. myFile.txt
	 * {activeEditorLanguageId}: e.g. typescript
	 * {activeFolderLong}: e.g. /Users/Development/myFolder/myFileFolder
	 * {activeFolderMedium}: e.g. myFolder/myFileFolder
	 * {activeFolderShort}: e.g. myFileFolder
	 * {rootName}: e.g. myFolder1, myFolder2, myFolder3
	 * {rootPath}: e.g. /Users/Development
	 * {folderName}: e.g. myFolder
	 * {folderPath}: e.g. /Users/Development/myFolder
	 * {appName}: e.g. VS Code
	 * {remoteName}: e.g. SSH
	 * {dirty}: indicator
	 * {focusedView}: e.g. Terminal
	 * {separator}: conditional separator
	 * {activeEditorState}: e.g. Modified
	 *
	 * @returns The resolved window title string.
	 */
	getWindowTitle(): string {
		const editor = this.editorService.activeEditor;
		const workspace = this.contextService.getWorkspace();

		// Compute root
		let root: URI | undefined;
		if (workspace.configuration) {
			root = workspace.configuration;
		} else if (workspace.folders.length) {
			root = workspace.folders[0].uri;
		}

		// Compute active editor folder
		const editorResource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
		let editorFolderResource = editorResource ? dirname(editorResource) : undefined;
		if (editorFolderResource?.path === '.') {
			editorFolderResource = undefined;
		}

		// Compute folder resource
		// Single Root Workspace: always the root single workspace in this case
		// Otherwise: root folder of the currently active file if any
		let folder: IWorkspaceFolder | undefined = undefined;
		if (this.contextService.getWorkbenchState() === WorkbenchState.FOLDER) {
			folder = workspace.folders[0];
		} else if (editorResource) {
			folder = this.contextService.getWorkspaceFolder(editorResource) ?? undefined;
		}

		// Compute remote
		// vscode-remtoe: use as is
		// otherwise figure out if we have a virtual folder opened
		let remoteName: string | undefined = undefined;
		if (this.environmentService.remoteAuthority && !isWeb) {
			remoteName = this.labelService.getHostLabel(Schemas.vscodeRemote, this.environmentService.remoteAuthority);
			// Tauri: append hostname parsed from authority (e.g. "ssh-remote+raspi" → "raspi")
			// so the title shows "SSH raspi" instead of just "SSH".
			if (isTauri && remoteName && this.environmentService.remoteAuthority) {
				const plusIdx = this.environmentService.remoteAuthority.indexOf('+');
				if (plusIdx !== -1) {
					const host = this.environmentService.remoteAuthority.substring(plusIdx + 1);
					if (host) {
						remoteName = `${remoteName} ${host}`;
					}
				}
			}
		} else {
			const virtualWorkspaceLocation = getVirtualWorkspaceLocation(workspace);
			if (virtualWorkspaceLocation) {
				remoteName = this.labelService.getHostLabel(virtualWorkspaceLocation.scheme, virtualWorkspaceLocation.authority);
			}
		}

		// Variables
		const activeEditorShort = editor ? editor.getTitle(Verbosity.SHORT) : '';
		const activeEditorMedium = editor ? editor.getTitle(Verbosity.MEDIUM) : activeEditorShort;
		const activeEditorLong = editor ? editor.getTitle(Verbosity.LONG) : activeEditorMedium;
		const activeFolderShort = editorFolderResource ? basename(editorFolderResource) : '';
		const activeFolderMedium = editorFolderResource ? this.labelService.getUriLabel(editorFolderResource, { relative: true }) : '';
		const activeFolderLong = editorFolderResource ? this.labelService.getUriLabel(editorFolderResource) : '';
		const rootName = this.labelService.getWorkspaceLabel(workspace);
		const rootNameShort = this.labelService.getWorkspaceLabel(workspace, { verbose: LabelVerbosity.SHORT });
		const rootPath = root ? this.labelService.getUriLabel(root) : '';
		const folderName = folder ? folder.name : '';
		const folderPath = folder ? this.labelService.getUriLabel(folder.uri) : '';
		const dirty = editor?.isDirty() && !editor.isSaving() ? WindowTitle.TITLE_DIRTY : '';
		const appName = this.productService.nameLong;
		const profileName = this.userDataProfileService.currentProfile.isDefault ? '' : this.userDataProfileService.currentProfile.name;
		const focusedView: string = this.viewsService.getFocusedViewName();
		const activeEditorState = editorResource ? this.decorationsService.getDecoration(editorResource, false)?.tooltip : undefined;
		const activeEditorLanguageId = this.editorService.activeTextEditorLanguageId;

		const variables: Record<string, string> = {};
		for (const [contextKey, name] of this.variables) {
			variables[name] = this.contextKeyService.getContextKeyValue(contextKey) ?? '';
		}

		let titleTemplate = this.configurationService.getValue<string>(WindowSettingNames.title);
		if (typeof titleTemplate !== 'string') {
			titleTemplate = defaultWindowTitle;
		}

		if (!this.titleIncludesEditorState && this.accessibilityService.isScreenReaderOptimized() && this.configurationService.getValue('accessibility.windowTitleOptimized')) {
			titleTemplate += '${separator}${activeEditorState}';
		}

		let separator = this.configurationService.getValue<string>(WindowSettingNames.titleSeparator);
		if (typeof separator !== 'string') {
			separator = defaultWindowTitleSeparator;
		}

		return template(titleTemplate, {
			...variables,
			activeEditorShort,
			activeEditorLong,
			activeEditorMedium,
			activeEditorLanguageId,
			activeFolderShort,
			activeFolderMedium,
			activeFolderLong,
			rootName,
			rootPath,
			rootNameShort,
			folderName,
			folderPath,
			dirty,
			appName,
			remoteName,
			profileName,
			focusedView,
			activeEditorState,
			separator: { label: separator }
		});
	}

	/**
	 * Determine whether the current window title uses a custom format.
	 *
	 * Returns `true` if:
	 * - A screen reader is active (which appends `${activeEditorState}`), or
	 * - The `window.title` or `window.titleSeparator` settings are explicitly configured, or
	 * - The default title value has been overridden in the configuration registry.
	 *
	 * @returns `true` if the title format deviates from the upstream default.
	 */
	isCustomTitleFormat(): boolean {
		if (this.accessibilityService.isScreenReaderOptimized() || this.titleIncludesEditorState) {
			return true;
		}
		const title = this.configurationService.inspect<string>(WindowSettingNames.title);
		const titleSeparator = this.configurationService.inspect<string>(WindowSettingNames.titleSeparator);

		if (isConfigured(title) || isConfigured(titleSeparator)) {
			return true;
		}

		// Check if the default value is overridden from the configuration registry
		const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const configurationProperties = configurationRegistry.getConfigurationProperties();
		return title.defaultValue !== configurationProperties[WindowSettingNames.title]?.defaultDefaultValue;
	}
}
