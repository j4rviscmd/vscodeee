/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';
import { Event } from '../../base/common/event.js';
import { DeepRequiredNonNullable, assertReturnsDefined } from '../../base/common/types.js';
import { URI } from '../../base/common/uri.js';
import { Disposable, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { ICodeEditorViewState, IDiffEditor, IDiffEditorViewState, IEditor, IEditorViewState } from '../../editor/common/editorCommon.js';
import { IEditorOptions, IResourceEditorInput, ITextResourceEditorInput, IBaseTextResourceEditorInput, IBaseUntypedEditorInput, ITextEditorOptions } from '../../platform/editor/common/editor.js';
import type { EditorInput } from './editor/editorInput.js';
import { IInstantiationService, IConstructorSignature, ServicesAccessor, BrandedService } from '../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IEncodingSupport, ILanguageSupport } from '../services/textfile/common/textfiles.js';
import { IEditorGroup } from '../services/editor/common/editorGroupsService.js';
import { ICompositeControl, IComposite } from './composite.js';
import { FileType, IFileReadLimits, IFileService } from '../../platform/files/common/files.js';
import { IPathData } from '../../platform/window/common/window.js';
import { IExtUri } from '../../base/common/resources.js';
import { Schemas } from '../../base/common/network.js';
import { IEditorService } from '../services/editor/common/editorService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IErrorWithActions, createErrorWithActions, isErrorWithActions } from '../../base/common/errorMessage.js';
import { IAction, toAction } from '../../base/common/actions.js';
import Severity from '../../base/common/severity.js';
import { IPreferencesService } from '../services/preferences/common/preferences.js';
import { IReadonlyEditorGroupModel } from './editor/editorGroupModel.js';

/**
 * Static values for editor contribution extension points.
 * Used to register editor panes and editor input factories with the platform registry.
 */
export const EditorExtensions = {
	EditorPane: 'workbench.contributions.editors',
	EditorFactory: 'workbench.contributions.editor.inputFactories'
};

/**
 * Static information regarding the built-in text editor.
 * Provides the default editor association used when no specific
 * editor is configured for a given resource type.
 */
export const DEFAULT_EDITOR_ASSOCIATION = {
	id: 'default',
	displayName: localize('promptOpenWith.defaultEditor.displayName', "Text Editor"),
	providerDisplayName: localize('builtinProviderDisplayName', "Built-in")
};

/**
 * Side by side editor id.
 */
export const SIDE_BY_SIDE_EDITOR_ID = 'workbench.editor.sidebysideEditor';

/**
 * Text diff editor id.
 */
export const TEXT_DIFF_EDITOR_ID = 'workbench.editors.textDiffEditor';

/**
 * Binary diff editor id.
 */
export const BINARY_DIFF_EDITOR_ID = 'workbench.editors.binaryResourceDiffEditor';

/**
 * Describes an editor pane that can be instantiated by the editor service.
 * Editor descriptors are registered via the `EditorExtensions.EditorPane`
 * extension point and used to create editor pane instances on demand.
 *
 * @template T - The concrete editor pane type.
 */
export interface IEditorDescriptor<T extends IEditorPane> {

	/**
	 * The unique type identifier of the editor. All instances
	 * of the same `IEditorPane` should have the same type
	 * identifier.
	 */
	readonly typeId: string;

	/**
	 * The display name of the editor.
	 */
	readonly name: string;

	/**
	 * Instantiates the editor pane using the provided services.
	 */
	instantiate(instantiationService: IInstantiationService, group: IEditorGroup): T;

	/**
	 * Whether the descriptor is for the provided editor pane.
	 */
	describes(editorPane: T): boolean;
}

/**
 * The editor pane is the container for workbench editors.
 */
export interface IEditorPane extends IComposite {

	/**
	 * An event to notify when the `IEditorControl` in this
	 * editor pane changes.
	 *
	 * This can be used for editor panes that are a compound
	 * of multiple editor controls to signal that the active
	 * editor control has changed when the user clicks around.
	 */
	readonly onDidChangeControl: Event<void>;

	/**
	 * An optional event to notify when the selection inside the editor
	 * pane changed in case the editor has a selection concept.
	 *
	 * For example, in a text editor pane, the selection changes whenever
	 * the cursor is set to a new location.
	 */
	readonly onDidChangeSelection?: Event<IEditorPaneSelectionChangeEvent>;

	/**
	 * An optional event to notify when the editor inside the pane scrolled
	 */
	readonly onDidChangeScroll?: Event<void>;

	/**
	 * The assigned input of this editor.
	 */
	readonly input: EditorInput | undefined;

	/**
	 * The assigned options of the editor.
	 */
	readonly options: IEditorOptions | undefined;

	/**
	 * The assigned group this editor is showing in.
	 */
	readonly group: IEditorGroup;

	/**
	 * The minimum width of this editor.
	 */
	readonly minimumWidth: number;

	/**
	 * The maximum width of this editor.
	 */
	readonly maximumWidth: number;

	/**
	 * The minimum height of this editor.
	 */
	readonly minimumHeight: number;

	/**
	 * The maximum height of this editor.
	 */
	readonly maximumHeight: number;

	/**
	 * An event to notify whenever minimum/maximum width/height changes.
	 */
	readonly onDidChangeSizeConstraints: Event<{ width: number; height: number } | undefined>;

	/**
	 * The context key service for this editor. Should be overridden by
	 * editors that have their own ScopedContextKeyService
	 */
	readonly scopedContextKeyService: IContextKeyService | undefined;

	/**
	 * Returns the underlying control of this editor. Callers need to cast
	 * the control to a specific instance as needed, e.g. by using the
	 * `isCodeEditor` helper method to access the text code editor.
	 *
	 * Use the `onDidChangeControl` event to track whenever the control
	 * changes.
	 */
	getControl(): IEditorControl | undefined;

	/**
	 * Returns the current view state of the editor if any.
	 *
	 * This method is optional to override for the editor pane
	 * and should only be overridden when the pane can deal with
	 * `IEditorOptions.viewState` to be applied when opening.
	 */
	getViewState(): object | undefined;

	/**
	 * An optional method to return the current selection in
	 * the editor pane in case the editor pane has a selection
	 * concept.
	 *
	 * Clients of this method will typically react to the
	 * `onDidChangeSelection` event to receive the current
	 * selection as needed.
	 */
	getSelection?(): IEditorPaneSelection | undefined;

	/**
	 * An optional method to return the current scroll position
	 * of an editor inside the pane.
	 *
	 * Clients of this method will typically react to the
	 * `onDidChangeScroll` event to receive the current
	 * scroll position as needed.
	 */
	getScrollPosition?(): IEditorPaneScrollPosition;

	/**
	 * An optional method to set the current scroll position
	 * of an editor inside the pane.
	 */
	setScrollPosition?(scrollPosition: IEditorPaneScrollPosition): void;

	/**
	 * Finds out if this editor is visible or not.
	 */
	isVisible(): boolean;
}

/**
 * Event payload for when the selection within an editor pane changes.
 * Provides additional context about what triggered the selection change.
 */
export interface IEditorPaneSelectionChangeEvent {

	/**
	 * More details for how the selection was made.
	 */
	reason: EditorPaneSelectionChangeReason;
}

export const enum EditorPaneSelectionChangeReason {

	/**
	 * The selection was changed as a result of a programmatic
	 * method invocation.
	 *
	 * For a text editor pane, this for example can be a selection
	 * being restored from previous view state automatically.
	 */
	PROGRAMMATIC = 1,

	/**
	 * The selection was changed by the user.
	 *
	 * This typically means the user changed the selection
	 * with mouse or keyboard.
	 */
	USER,

	/**
	 * The selection was changed as a result of editing in
	 * the editor pane.
	 *
	 * For a text editor pane, this for example can be typing
	 * in the text of the editor pane.
	 */
	EDIT,

	/**
	 * The selection was changed as a result of a navigation
	 * action.
	 *
	 * For a text editor pane, this for example can be a result
	 * of selecting an entry from a text outline view.
	 */
	NAVIGATION,

	/**
	 * The selection was changed as a result of a jump action
	 * from within the editor pane.
	 *
	 * For a text editor pane, this for example can be a result
	 * of invoking "Go to definition" from a symbol.
	 */
	JUMP
}

/**
 * Represents the current selection within an editor pane.
 * Enables comparing selections across editor instances and
 * restoring selections when reopening editors.
 */
export interface IEditorPaneSelection {

	/**
	 * Asks to compare this selection to another selection.
	 */
	compare(otherSelection: IEditorPaneSelection): EditorPaneSelectionCompareResult;

	/**
	 * Asks to massage the provided `options` in a way
	 * that the selection can be restored when the editor
	 * is opened again.
	 *
	 * For a text editor this means to apply the selected
	 * line and column as text editor options.
	 */
	restore(options: IEditorOptions): IEditorOptions;

	/**
	 * Only used for logging to print more info about the selection.
	 */
	log?(): string;
}

export const enum EditorPaneSelectionCompareResult {

	/**
	 * The selections are identical.
	 */
	IDENTICAL = 1,

	/**
	 * The selections are similar.
	 *
	 * For a text editor this can mean that the one
	 * selection is in close proximity to the other
	 * selection.
	 *
	 * Upstream clients may decide in this case to
	 * not treat the selection different from the
	 * previous one because it is not distinct enough.
	 */
	SIMILAR = 2,

	/**
	 * The selections are entirely different.
	 */
	DIFFERENT = 3
}

/**
 * An `IEditorPane` that supports selection tracking.
 * Provides the `onDidChangeSelection` event and `getSelection()` method
 * for consumers that need to react to or query the current selection state.
 */
export interface IEditorPaneWithSelection extends IEditorPane {

	readonly onDidChangeSelection: Event<IEditorPaneSelectionChangeEvent>;

	getSelection(): IEditorPaneSelection | undefined;
}

/**
 * Type guard that checks whether an editor pane supports selection tracking.
 *
 * @param editorPane - The editor pane to check.
 * @returns `true` if the pane implements `IEditorPaneWithSelection`.
 */
export function isEditorPaneWithSelection(editorPane: IEditorPane | undefined): editorPane is IEditorPaneWithSelection {
	const candidate = editorPane as IEditorPaneWithSelection | undefined;

	return !!candidate && typeof candidate.getSelection === 'function' && !!candidate.onDidChangeSelection;
}

/**
 * An `IEditorPane` that supports scroll position tracking.
 * Provides events and methods for reading and controlling
 * the scroll state of the editor pane.
 */
export interface IEditorPaneWithScrolling extends IEditorPane {

	readonly onDidChangeScroll: Event<void>;

	getScrollPosition(): IEditorPaneScrollPosition;

	setScrollPosition(position: IEditorPaneScrollPosition): void;
}

/**
 * Type guard that checks whether an editor pane supports scroll position tracking.
 *
 * @param editorPane - The editor pane to check.
 * @returns `true` if the pane implements `IEditorPaneWithScrolling`.
 */
export function isEditorPaneWithScrolling(editorPane: IEditorPane | undefined): editorPane is IEditorPaneWithScrolling {
	const candidate = editorPane as IEditorPaneWithScrolling | undefined;

	return !!candidate && typeof candidate.getScrollPosition === 'function' && typeof candidate.setScrollPosition === 'function' && !!candidate.onDidChangeScroll;
}

/**
 * Scroll position of a pane
 */
export interface IEditorPaneScrollPosition {
	readonly scrollTop: number;
	readonly scrollLeft?: number;
}

/**
 * Try to retrieve the view state for the editor pane that
 * has the provided editor input opened, if at all.
 *
 * This method will return `undefined` if the editor input
 * is not visible in any of the opened editor panes.
 */
export function findViewStateForEditor(input: EditorInput, group: GroupIdentifier, editorService: IEditorService): object | undefined {
	for (const editorPane of editorService.visibleEditorPanes) {
		if (editorPane.group.id === group && input.matches(editorPane.input)) {
			return editorPane.getViewState();
		}
	}

	return undefined;
}

/**
 * Overrides `IEditorPane` where `input` and `group` are known to be set.
 */
export interface IVisibleEditorPane extends IEditorPane {
	readonly input: EditorInput;
}

/**
 * The text editor pane is the container for workbench text editors.
 */
export interface ITextEditorPane extends IEditorPane {

	/**
	 * Returns the underlying text editor widget of this editor.
	 */
	getControl(): IEditor | undefined;
}

/**
 * The text editor pane is the container for workbench text diff editors.
 */
export interface ITextDiffEditorPane extends IEditorPane {

	/**
	 * Returns the underlying text diff editor widget of this editor.
	 */
	getControl(): IDiffEditor | undefined;
}

/**
 * Marker interface for the control inside an editor pane. Callers
 * have to cast the control to work with it, e.g. via methods
 * such as `isCodeEditor(control)`.
 */
export interface IEditorControl extends ICompositeControl { }

export interface IFileEditorFactory {

	/**
	 * The type identifier of the file editor.
	 */
	typeId: string;

	/**
	 * Creates new editor capable of showing files.
	 */
	createFileEditor(resource: URI, preferredResource: URI | undefined, preferredName: string | undefined, preferredDescription: string | undefined, preferredEncoding: string | undefined, preferredLanguageId: string | undefined, preferredContents: string | undefined, instantiationService: IInstantiationService): IFileEditorInput;

	/**
	 * Check if the provided object is a file editor.
	 */
	isFileEditor(obj: unknown): obj is IFileEditorInput;
}

export interface IEditorFactoryRegistry {

	/**
	 * Registers the file editor factory to use for file editors.
	 */
	registerFileEditorFactory(factory: IFileEditorFactory): void;

	/**
	 * Returns the file editor factory to use for file editors.
	 */
	getFileEditorFactory(): IFileEditorFactory;

	/**
	 * Registers a editor serializer for the given editor to the registry.
	 * An editor serializer is capable of serializing and deserializing editor
	 * from string data.
	 *
	 * @param editorTypeId the type identifier of the editor
	 * @param serializer the editor serializer for serialization/deserialization
	 */
	registerEditorSerializer<Services extends BrandedService[]>(editorTypeId: string, ctor: { new(...Services: Services): IEditorSerializer }): IDisposable;

	/**
	 * Returns the editor serializer for the given editor.
	 */
	getEditorSerializer(editor: EditorInput): IEditorSerializer | undefined;
	getEditorSerializer(editorTypeId: string): IEditorSerializer | undefined;

	/**
	 * Starts the registry by providing the required services.
	 */
	start(accessor: ServicesAccessor): void;
}

export interface IEditorSerializer {

	/**
	 * Determines whether the given editor can be serialized by the serializer.
	 */
	canSerialize(editor: EditorInput): boolean;

	/**
	 * Returns a string representation of the provided editor that contains enough information
	 * to deserialize back to the original editor from the deserialize() method.
	 */
	serialize(editor: EditorInput): string | undefined;

	/**
	 * Returns an editor from the provided serialized form of the editor. This form matches
	 * the value returned from the serialize() method.
	 */
	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined;
}

export interface IUntitledTextResourceEditorInput extends IBaseTextResourceEditorInput {

	/**
	 * Optional resource for the untitled editor. Depending on the value, the editor:
	 * - should get a unique name if `undefined` (for example `Untitled-1`)
	 * - should use the resource directly if the scheme is `untitled:`
	 * - should change the scheme to `untitled:` otherwise and assume an associated path
	 *
	 * Untitled editors with associated path behave slightly different from other untitled
	 * editors:
	 * - they are dirty right when opening
	 * - they will not ask for a file path when saving but use the associated path
	 */
	readonly resource: URI | undefined;
}

/**
 * A resource side by side editor input shows 2 editors side by side but
 * without highlighting any differences.
 *
 * Note: both sides will be resolved as editor individually. As such, it is
 * possible to show 2 different editors side by side.
 *
 * @see {@link IResourceDiffEditorInput} for a variant that compares 2 editors.
 */
export interface IResourceSideBySideEditorInput extends IBaseUntypedEditorInput {

	/**
	 * The right hand side editor to open inside a side-by-side editor.
	 */
	readonly primary: Omit<IResourceEditorInput, 'options'> | Omit<ITextResourceEditorInput, 'options'> | Omit<IUntitledTextResourceEditorInput, 'options'>;

	/**
	 * The left hand side editor to open inside a side-by-side editor.
	 */
	readonly secondary: Omit<IResourceEditorInput, 'options'> | Omit<ITextResourceEditorInput, 'options'> | Omit<IUntitledTextResourceEditorInput, 'options'>;
}

/**
 * A resource diff editor input compares 2 editors side by side
 * highlighting the differences.
 *
 * Note: both sides must be resolvable to the same editor, or
 * a text based presentation will be used as fallback.
 */
export interface IResourceDiffEditorInput extends IBaseUntypedEditorInput {

	/**
	 * The left hand side editor to open inside a diff editor.
	 */
	readonly original: Omit<IResourceEditorInput, 'options'> | Omit<ITextResourceEditorInput, 'options'> | Omit<IUntitledTextResourceEditorInput, 'options'>;

	/**
	 * The right hand side editor to open inside a diff editor.
	 */
	readonly modified: Omit<IResourceEditorInput, 'options'> | Omit<ITextResourceEditorInput, 'options'> | Omit<IUntitledTextResourceEditorInput, 'options'>;
}

export interface ITextResourceDiffEditorInput extends IBaseTextResourceEditorInput {

	/**
	 * The left hand side text editor to open inside a diff editor.
	 */
	readonly original: Omit<ITextResourceEditorInput, 'options'> | Omit<IUntitledTextResourceEditorInput, 'options'>;

	/**
	 * The right hand side text editor to open inside a diff editor.
	 */
	readonly modified: Omit<ITextResourceEditorInput, 'options'> | Omit<IUntitledTextResourceEditorInput, 'options'>;
}

/**
 * A resource list diff editor input compares multiple resources side by side
 * highlighting the differences.
 */
export interface IResourceMultiDiffEditorInput extends IBaseUntypedEditorInput {
	/**
	 * A unique identifier of this multi diff editor input.
	 * If a second multi diff editor with the same uri is opened, the existing one is revealed instead (even if the resources list is different!).
	 */
	readonly multiDiffSource?: URI;

	/**
	 * The list of resources to compare.
	 * If not set, the resources are dynamically derived from the {@link multiDiffSource}.
	 */
	readonly resources?: IMultiDiffEditorResource[];

	/**
	 * Whether the editor should be serialized and stored for subsequent sessions.
	 */
	readonly isTransient?: boolean;
}

export interface IMultiDiffEditorResource extends IResourceDiffEditorInput {
	readonly goToFileResource?: URI;
}
export type IResourceMergeEditorInputSide = (Omit<IResourceEditorInput, 'options'> | Omit<ITextResourceEditorInput, 'options'>) & { detail?: string };

/**
 * A resource merge editor input compares multiple editors
 * highlighting the differences for merging.
 *
 * Note: all sides must be resolvable to the same editor, or
 * a text based presentation will be used as fallback.
 */
export interface IResourceMergeEditorInput extends IBaseUntypedEditorInput {

	/**
	 * The one changed version of the file.
	 */
	readonly input1: IResourceMergeEditorInputSide;

	/**
	 * The second changed version of the file.
	 */
	readonly input2: IResourceMergeEditorInputSide;

	/**
	 * The base common ancestor of the file to merge.
	 */
	readonly base: Omit<IResourceEditorInput, 'options'> | Omit<ITextResourceEditorInput, 'options'>;

	/**
	 * The resulting output of the merge.
	 */
	readonly result: Omit<IResourceEditorInput, 'options'> | Omit<ITextResourceEditorInput, 'options'>;
}

/**
 * Type guard that checks whether the given object is a resource editor input.
 * Returns `false` for typed `EditorInput` instances to avoid accidental matches.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `IResourceEditorInput`.
 */
export function isResourceEditorInput(editor: unknown): editor is IResourceEditorInput {
	if (isEditorInput(editor)) {
		return false; // make sure to not accidentally match on typed editor inputs
	}

	const candidate = editor as IResourceEditorInput | undefined;

	return URI.isUri(candidate?.resource);
}

/**
 * Type guard that checks whether the given object is a resource diff editor input.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `IResourceDiffEditorInput`.
 */
export function isResourceDiffEditorInput(editor: unknown): editor is IResourceDiffEditorInput {
	if (isEditorInput(editor)) {
		return false; // make sure to not accidentally match on typed editor inputs
	}

	const candidate = editor as IResourceDiffEditorInput | undefined;

	return candidate?.original !== undefined && candidate.modified !== undefined;
}

/**
 * Type guard that checks whether the given object is a resource multi-diff editor input.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `IResourceMultiDiffEditorInput`.
 */
export function isResourceMultiDiffEditorInput(editor: unknown): editor is IResourceMultiDiffEditorInput {
	if (isEditorInput(editor)) {
		return false; // make sure to not accidentally match on typed editor inputs
	}

	const candidate = editor as IResourceMultiDiffEditorInput | undefined;
	if (!candidate) {
		return false;
	}
	if (candidate.resources && !Array.isArray(candidate.resources)) {
		return false;
	}

	return !!candidate.resources || !!candidate.multiDiffSource;
}

/**
 * Type guard that checks whether the given object is a resource side-by-side editor input.
 * Also ensures the input is not a diff editor input.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `IResourceSideBySideEditorInput`.
 */
export function isResourceSideBySideEditorInput(editor: unknown): editor is IResourceSideBySideEditorInput {
	if (isEditorInput(editor)) {
		return false; // make sure to not accidentally match on typed editor inputs
	}

	if (isResourceDiffEditorInput(editor)) {
		return false; // make sure to not accidentally match on diff editors
	}

	const candidate = editor as IResourceSideBySideEditorInput | undefined;

	return candidate?.primary !== undefined && candidate.secondary !== undefined;
}

/**
 * Type guard that checks whether the given object is an untitled text resource editor input.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `IUntitledTextResourceEditorInput`.
 */
export function isUntitledResourceEditorInput(editor: unknown): editor is IUntitledTextResourceEditorInput {
	if (isEditorInput(editor)) {
		return false; // make sure to not accidentally match on typed editor inputs
	}

	const candidate = editor as IUntitledTextResourceEditorInput | undefined;
	if (!candidate) {
		return false;
	}

	return candidate.resource === undefined || candidate.resource.scheme === Schemas.untitled || candidate.forceUntitled === true;
}

/**
 * Type guard that checks whether the given object is a resource merge editor input.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `IResourceMergeEditorInput`.
 */
export function isResourceMergeEditorInput(editor: unknown): editor is IResourceMergeEditorInput {
	if (isEditorInput(editor)) {
		return false; // make sure to not accidentally match on typed editor inputs
	}

	const candidate = editor as IResourceMergeEditorInput | undefined;

	return URI.isUri(candidate?.base?.resource) && URI.isUri(candidate?.input1?.resource) && URI.isUri(candidate?.input2?.resource) && URI.isUri(candidate?.result?.resource);
}

export const enum Verbosity {
	SHORT,
	MEDIUM,
	LONG
}

export const enum SaveReason {

	/**
	 * Explicit user gesture.
	 */
	EXPLICIT = 1,

	/**
	 * Auto save after a timeout.
	 */
	AUTO = 2,

	/**
	 * Auto save after editor focus change.
	 */
	FOCUS_CHANGE = 3,

	/**
	 * Auto save after window change.
	 */
	WINDOW_CHANGE = 4
}

/**
 * Identifier for the source of a save operation.
 * Use `SaveSourceRegistry.registerSource()` to obtain a registered source.
 */
export type SaveSource = string;

interface ISaveSourceDescriptor {
	source: SaveSource;
	label: string;
}

class SaveSourceFactory {

	private readonly mapIdToSaveSource = new Map<SaveSource, ISaveSourceDescriptor>();

	/**
	 * Registers a `SaveSource` with an identifier and label
	 * to the registry so that it can be used in save operations.
	 */
	registerSource(id: string, label: string): SaveSource {
		let sourceDescriptor = this.mapIdToSaveSource.get(id);
		if (!sourceDescriptor) {
			sourceDescriptor = { source: id, label };
			this.mapIdToSaveSource.set(id, sourceDescriptor);
		}

		return sourceDescriptor.source;
	}

	getSourceLabel(source: SaveSource): string {
		return this.mapIdToSaveSource.get(source)?.label ?? source;
	}
}

/**
 * Registry for save operation sources. Allows registering and retrieving
 * human-readable labels for save sources used in telemetry and UI.
 */
export const SaveSourceRegistry = new SaveSourceFactory();

export interface ISaveOptions {

	/**
	 * An indicator how the save operation was triggered.
	 */
	reason?: SaveReason;

	/**
	 * An indicator about the source of the save operation.
	 *
	 * Must use `SaveSourceRegistry.registerSource()` to obtain.
	 */
	readonly source?: SaveSource;

	/**
	 * Forces to save the contents of the working copy
	 * again even if the working copy is not dirty.
	 */
	readonly force?: boolean;

	/**
	 * Instructs the save operation to skip any save participants.
	 */
	readonly skipSaveParticipants?: boolean;

	/**
	 * A hint as to which file systems should be available for saving.
	 */
	readonly availableFileSystems?: string[];
}

export interface IRevertOptions {

	/**
	 * Forces to load the contents of the working copy
	 * again even if the working copy is not dirty.
	 */
	readonly force?: boolean;

	/**
	 * A soft revert will clear dirty state of a working copy
	 * but will not attempt to load it from its persisted state.
	 *
	 * This option may be used in scenarios where an editor is
	 * closed and where we do not require to load the contents.
	 */
	readonly soft?: boolean;
}

/**
 * Result of a move operation, containing the target editor input
 * and optional editor options to apply after the move.
 */
export interface IMoveResult {
	editor: EditorInput | IUntypedEditorInput;
	options?: IEditorOptions;
}

export const enum EditorInputCapabilities {

	/**
	 * Signals no specific capability for the input.
	 */
	None = 0,

	/**
	 * Signals that the input is readonly.
	 */
	Readonly = 1 << 1,

	/**
	 * Signals that the input is untitled.
	 */
	Untitled = 1 << 2,

	/**
	 * Signals that the input can only be shown in one group
	 * and not be split into multiple groups.
	 */
	Singleton = 1 << 3,

	/**
	 * Signals that the input requires workspace trust.
	 */
	RequiresTrust = 1 << 4,

	/**
	 * Signals that the editor can split into 2 in the same
	 * editor group.
	 */
	CanSplitInGroup = 1 << 5,

	/**
	 * Signals that the editor wants its description to be
	 * visible when presented to the user. By default, a UI
	 * component may decide to hide the description portion
	 * for brevity.
	 */
	ForceDescription = 1 << 6,

	/**
	 * Signals that the editor supports dropping into the
	 * editor by holding shift.
	 */
	CanDropIntoEditor = 1 << 7,

	/**
	 * Signals that the editor is composed of multiple editors
	 * within.
	 */
	MultipleEditors = 1 << 8,

	/**
	 * Signals that the editor cannot be in a dirty state
	 * and may still have unsaved changes
	 */
	Scratchpad = 1 << 9,

	/**
	 * Signals that the editor should be revealed when being
	 * opened if it is already opened in any editor group.
	 */
	ForceReveal = 1 << 10,

	/**
	 * Signals that the editor must be opened in a modal editor
	 * part, overriding the `workbench.editor.useModal` setting.
	 */
	RequiresModal = 1 << 11
}

/**
 * A union type of all untyped editor input variants.
 * Used for APIs that accept editor inputs without requiring a specific typed `EditorInput`.
 */
export type IUntypedEditorInput = IResourceEditorInput | ITextResourceEditorInput | IUntitledTextResourceEditorInput | IResourceDiffEditorInput | IResourceMultiDiffEditorInput | IResourceSideBySideEditorInput | IResourceMergeEditorInput;

export abstract class AbstractEditorInput extends Disposable {
	// Marker class for implementing `isEditorInput`
}

/**
 * Type guard that checks whether the given object is an `EditorInput` instance.
 * Relies on `AbstractEditorInput` as the marker class for all editor inputs.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `EditorInput`.
 */
export function isEditorInput(editor: unknown): editor is EditorInput {
	return editor instanceof AbstractEditorInput;
}

/**
 * An editor input that provides both a canonical resource and a preferred resource.
 * The canonical resource is used for identity comparison, while the preferred
 * resource is used for user-facing display (e.g., preserving original casing).
 */
export interface EditorInputWithPreferredResource {

	/**
	 * An editor may provide an additional preferred resource alongside
	 * the `resource` property. While the `resource` property serves as
	 * unique identifier of the editor that should be used whenever we
	 * compare to other editors, the `preferredResource` should be used
	 * in places where e.g. the resource is shown to the user.
	 *
	 * For example: on Windows and macOS, the same URI with different
	 * casing may point to the same file. The editor may chose to
	 * "normalize" the URIs so that only one editor opens for different
	 * URIs. But when displaying the editor label to the user, the
	 * preferred URI should be used.
	 *
	 * Not all editors have a `preferredResource`. The `EditorResourceAccessor`
	 * utility can be used to always get the right resource without having
	 * to do instanceof checks.
	 */
	readonly preferredResource: URI;
}

function isEditorInputWithPreferredResource(editor: unknown): editor is EditorInputWithPreferredResource {
	const candidate = editor as EditorInputWithPreferredResource | undefined;

	return URI.isUri(candidate?.preferredResource);
}

export interface ISideBySideEditorInput extends EditorInput {

	/**
	 * The primary editor input is shown on the right hand side.
	 */
	primary: EditorInput;

	/**
	 * The secondary editor input is shown on the left hand side.
	 */
	secondary: EditorInput;
}

/**
 * Type guard that checks whether the given object is a side-by-side editor input
 * with both primary and secondary editor inputs.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `ISideBySideEditorInput`.
 */
export function isSideBySideEditorInput(editor: unknown): editor is ISideBySideEditorInput {
	const candidate = editor as ISideBySideEditorInput | undefined;

	return isEditorInput(candidate?.primary) && isEditorInput(candidate?.secondary);
}

export interface IDiffEditorInput extends EditorInput {

	/**
	 * The modified (primary) editor input is shown on the right hand side.
	 */
	modified: EditorInput;

	/**
	 * The original (secondary) editor input is shown on the left hand side.
	 */
	original: EditorInput;
}

/**
 * Type guard that checks whether the given object is a diff editor input
 * with both modified and original editor inputs.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `IDiffEditorInput`.
 */
export function isDiffEditorInput(editor: unknown): editor is IDiffEditorInput {
	const candidate = editor as IDiffEditorInput | undefined;

	return isEditorInput(candidate?.modified) && isEditorInput(candidate?.original);
}

export interface IUntypedFileEditorInput extends ITextResourceEditorInput {

	/**
	 * A marker to create a `IFileEditorInput` from this untyped input.
	 */
	forceFile: true;
}

/**
 * This is a tagging interface to declare an editor input being capable of dealing with files. It is only used in the editor registry
 * to register this kind of input to the platform.
 */
export interface IFileEditorInput extends EditorInput, IEncodingSupport, ILanguageSupport, EditorInputWithPreferredResource {

	/**
	 * Gets the resource this file input is about. This will always be the
	 * canonical form of the resource, so it may differ from the original
	 * resource that was provided to create the input. Use `preferredResource`
	 * for the form as it was created.
	 */
	readonly resource: URI;

	/**
	 * Sets the preferred resource to use for this file input.
	 */
	setPreferredResource(preferredResource: URI): void;

	/**
	 * Sets the preferred name to use for this file input.
	 *
	 * Note: for certain file schemes the input may decide to ignore this
	 * name and use our standard naming. Specifically for schemes we own,
	 * we do not let others override the name.
	 */
	setPreferredName(name: string): void;

	/**
	 * Sets the preferred description to use for this file input.
	 *
	 * Note: for certain file schemes the input may decide to ignore this
	 * description and use our standard naming. Specifically for schemes we own,
	 * we do not let others override the description.
	 */
	setPreferredDescription(description: string): void;

	/**
	 * Sets the preferred encoding to use for this file input.
	 */
	setPreferredEncoding(encoding: string): void;

	/**
	 * Sets the preferred language id to use for this file input.
	 */
	setPreferredLanguageId(languageId: string): void;

	/**
	 * Sets the preferred contents to use for this file input.
	 */
	setPreferredContents(contents: string): void;

	/**
	 * Forces this file input to open as binary instead of text.
	 */
	setForceOpenAsBinary(): void;

	/**
	 * Figure out if the file input has been resolved or not.
	 */
	isResolved(): boolean;
}

/**
 * Editor options that include file read limits.
 * When limits are exceeded, an error is thrown instead of opening the file.
 */
export interface IFileLimitedEditorInputOptions extends IEditorOptions {

	/**
	 * If provided, the size of the file will be checked against the limits
	 * and an error will be thrown if any limit is exceeded.
	 */
	readonly limits?: IFileReadLimits;
}

/**
 * Combined editor options for file editor inputs, including text editor
 * options and file read limits.
 */
export interface IFileEditorInputOptions extends ITextEditorOptions, IFileLimitedEditorInputOptions { }

/**
 * Creates an error for when a file is too large to open.
 * The error includes actions to open the file anyway or configure the size limit.
 *
 * @param group - The editor group where the file was being opened.
 * @param input - The editor input that was being opened.
 * @param options - The editor options that were provided.
 * @param message - The error message to display.
 * @param preferencesService - The preferences service for opening settings.
 * @returns An error with associated actions.
 */
export function createTooLargeFileError(group: IEditorGroup, input: EditorInput, options: IEditorOptions | undefined, message: string, preferencesService: IPreferencesService): Error {
	return createEditorOpenError(message, [
		toAction({
			id: 'workbench.action.openLargeFile', label: localize('openLargeFile', "Open Anyway"), run: () => {
				const fileEditorOptions: IFileEditorInputOptions = {
					...options,
					limits: {
						size: Number.MAX_VALUE
					}
				};

				group.openEditor(input, fileEditorOptions);
			}
		}),
		toAction({
			id: 'workbench.action.configureEditorLargeFileConfirmation', label: localize('configureEditorLargeFileConfirmation', "Configure Limit"), run: () => {
				return preferencesService.openUserSettings({ query: 'workbench.editorLargeFileConfirmation' });
			}
		}),
	], {
		forceMessage: true,
		forceSeverity: Severity.Warning
	});
}

/**
 * An editor input paired with optional editor options.
 * Used when opening editors with specific configuration.
 */
export interface EditorInputWithOptions {
	editor: EditorInput;
	options?: IEditorOptions;
}

/**
 * An editor input with options and the target editor group.
 * Used when the editor is already associated with a specific group.
 */
export interface EditorInputWithOptionsAndGroup extends EditorInputWithOptions {
	group: IEditorGroup;
}

/**
 * Type guard that checks whether the given object is an `EditorInputWithOptions`.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `EditorInputWithOptions`.
 */
export function isEditorInputWithOptions(editor: unknown): editor is EditorInputWithOptions {
	const candidate = editor as EditorInputWithOptions | undefined;

	return isEditorInput(candidate?.editor);
}

/**
 * Type guard that checks whether the given object is an `EditorInputWithOptionsAndGroup`.
 *
 * @param editor - The value to check.
 * @returns `true` if the value is an `EditorInputWithOptionsAndGroup`.
 */
export function isEditorInputWithOptionsAndGroup(editor: unknown): editor is EditorInputWithOptionsAndGroup {
	const candidate = editor as EditorInputWithOptionsAndGroup | undefined;

	return isEditorInputWithOptions(editor) && candidate?.group !== undefined;
}

/**
 * Context passed into `EditorPane#setInput` to give additional
 * context information around why the editor was opened.
 */
export interface IEditorOpenContext {

	/**
	 * An indicator if the editor input is new for the group the editor is in.
	 * An editor is new for a group if it was not part of the group before and
	 * otherwise was already opened in the group and just became the active editor.
	 *
	 * This hint can e.g. be used to decide whether to restore view state or not.
	 */
	newInGroup?: boolean;
}

/**
 * Identifies a specific editor within a group by its group ID and editor input.
 */
export interface IEditorIdentifier {
	groupId: GroupIdentifier;
	editor: EditorInput;
}

/**
 * Type guard that checks whether the given object is an `IEditorIdentifier`.
 *
 * @param identifier - The value to check.
 * @returns `true` if the value is an `IEditorIdentifier`.
 */
export function isEditorIdentifier(identifier: unknown): identifier is IEditorIdentifier {
	const candidate = identifier as IEditorIdentifier | undefined;

	return typeof candidate?.groupId === 'number' && isEditorInput(candidate.editor);
}

/**
 * The editor commands context is used for editor commands (e.g. in the editor title)
 * and we must ensure that the context is serializable because it potentially travels
 * to the extension host!
 */
export interface IEditorCommandsContext {
	groupId: GroupIdentifier;
	editorIndex?: number;

	preserveFocus?: boolean;
}

/**
 * Type guard that checks whether the given object is an `IEditorCommandsContext`.
 *
 * @param context - The value to check.
 * @returns `true` if the value is an `IEditorCommandsContext`.
 */
export function isEditorCommandsContext(context: unknown): context is IEditorCommandsContext {
	const candidate = context as IEditorCommandsContext | undefined;

	return typeof candidate?.groupId === 'number';
}

/**
 * More information around why an editor was closed in the model.
 */
export enum EditorCloseContext {

	/**
	 * No specific context for closing (e.g. explicit user gesture).
	 */
	UNKNOWN,

	/**
	 * The editor closed because it was replaced with another editor.
	 * This can either happen via explicit replace call or when an
	 * editor is in preview mode and another editor opens.
	 */
	REPLACE,

	/**
	 * The editor closed as a result of moving it to another group.
	 */
	MOVE,

	/**
	 * The editor closed because another editor turned into preview
	 * and this used to be the preview editor before.
	 */
	UNPIN
}

/**
 * Event payload emitted when an editor is closed.
 * Extends `IEditorIdentifier` with additional context about the close operation.
 */
export interface IEditorCloseEvent extends IEditorIdentifier {

	/**
	 * More information around why the editor was closed.
	 */
	readonly context: EditorCloseContext;

	/**
	 * The index of the editor before closing.
	 */
	readonly index: number;

	/**
	 * Whether the editor was sticky or not.
	 */
	readonly sticky: boolean;
}

/**
 * Event payload for when the active editor changes in a group.
 */
export interface IActiveEditorChangeEvent {

	/**
	 * The new active editor or `undefined` if the group is empty.
	 */
	editor: EditorInput | undefined;
}

/**
 * Event payload emitted before an editor is moved to another group.
 */
export interface IEditorWillMoveEvent extends IEditorIdentifier {

	/**
	 * The target group of the move operation.
	 */
	readonly target: GroupIdentifier;
}

/**
 * Event payload emitted before an editor is opened.
 */
export interface IEditorWillOpenEvent extends IEditorIdentifier { }

/**
 * Event payload emitted before an editor pane is instantiated.
 */
export interface IWillInstantiateEditorPaneEvent {

	/**
	 * @see {@link IEditorDescriptor.typeId}
	 */
	readonly typeId: string;
}

export type GroupIdentifier = number;

export const enum GroupModelChangeKind {

	/* Group Changes */
	GROUP_ACTIVE,
	GROUP_INDEX,
	GROUP_LABEL,
	GROUP_LOCKED,

	/* Editors Change */
	EDITORS_SELECTION,

	/* Editor Changes */
	EDITOR_OPEN,
	EDITOR_CLOSE,
	EDITOR_MOVE,
	EDITOR_ACTIVE,
	EDITOR_LABEL,
	EDITOR_CAPABILITIES,
	EDITOR_PIN,
	EDITOR_TRANSIENT,
	EDITOR_STICKY,
	EDITOR_DIRTY,
	EDITOR_WILL_DISPOSE
}

export interface IWorkbenchEditorConfiguration {
	workbench?: {
		editor?: IEditorPartConfiguration;
		iconTheme?: string;
	};
}

interface IEditorPartLimitConfiguration {
	enabled?: boolean;
	excludeDirty?: boolean;
	value?: number;
	perEditorGroup?: boolean;
}

export interface IEditorPartLimitOptions extends Required<IEditorPartLimitConfiguration> { }

interface IEditorPartDecorationsConfiguration {
	badges?: boolean;
	colors?: boolean;
}

export interface IEditorPartDecorationOptions extends Required<IEditorPartDecorationsConfiguration> { }

interface IEditorPartConfiguration {
	showTabs?: 'multiple' | 'single' | 'none';
	wrapTabs?: boolean;
	scrollToSwitchTabs?: boolean;
	highlightModifiedTabs?: boolean;
	tabActionLocation?: 'left' | 'right';
	tabActionCloseVisibility?: boolean;
	tabActionUnpinVisibility?: boolean;
	showTabIndex?: boolean;
	/**
	 * Controls whether the editor group index is displayed in the tab bar.
	 * When enabled, a bracketed number (e.g. `[1]`, `[2]`) is shown
	 * before the tabs when multiple editor groups exist. Only visible when
	 * the `vscodeee.workbench.editor.editorGroupIndexInTab` setting is enabled and there are
	 * at least 2 editor groups in the grid.
	 */
	editorGroupIndexInTab?: boolean;
	alwaysShowEditorActions?: boolean;
	tabSizing?: 'fit' | 'shrink' | 'fixed';
	tabSizingFixedMinWidth?: number;
	tabSizingFixedMaxWidth?: number;
	pinnedTabSizing?: 'normal' | 'compact' | 'shrink';
	pinnedTabsOnSeparateRow?: boolean;
	tabHeight?: 'default' | 'compact';
	preventPinnedEditorClose?: PreventPinnedEditorClose;
	titleScrollbarSizing?: 'default' | 'large';
	titleScrollbarVisibility?: 'auto' | 'visible' | 'hidden';
	focusRecentEditorAfterClose?: boolean;
	showIcons?: boolean;
	enablePreview?: boolean;
	enablePreviewFromQuickOpen?: boolean;
	enablePreviewFromCodeNavigation?: boolean;
	closeOnFileDelete?: boolean;
	openPositioning?: 'left' | 'right' | 'first' | 'last';
	openSideBySideDirection?: 'right' | 'down';
	closeEmptyGroups?: boolean;
	autoLockGroups?: Set<string>;
	revealIfOpen?: boolean;
	swipeToNavigate?: boolean;
	mouseBackForwardToNavigate?: boolean;
	labelFormat?: 'default' | 'short' | 'medium' | 'long';
	restoreViewState?: boolean;
	splitInGroupLayout?: 'vertical' | 'horizontal';
	splitSizing?: 'auto' | 'split' | 'distribute';
	splitOnDragAndDrop?: boolean;
	allowDropIntoGroup?: boolean;
	dragToOpenWindow?: boolean;
	centeredLayoutFixedWidth?: boolean;
	doubleClickTabToToggleEditorGroupSizes?: 'maximize' | 'expand' | 'off';
	autoMaximizeOnFocus?: boolean;
	editorActionsLocation?: 'default' | 'titleBar' | 'hidden';
	limit?: IEditorPartLimitConfiguration;
	decorations?: IEditorPartDecorationsConfiguration;
}

export interface IEditorPartOptions extends DeepRequiredNonNullable<IEditorPartConfiguration> {
	hasIcons: boolean;
}

export interface IEditorPartOptionsChangeEvent {
	oldPartOptions: IEditorPartOptions;
	newPartOptions: IEditorPartOptions;
}

export enum SideBySideEditor {
	PRIMARY = 1,
	SECONDARY = 2,
	BOTH = 3,
	ANY = 4
}

export interface IFindEditorOptions {

	/**
	 * Whether to consider any or both side by side editor as matching.
	 * By default, side by side editors will not be considered
	 * as matching, even if the editor is opened in one of the sides.
	 */
	supportSideBySide?: SideBySideEditor.PRIMARY | SideBySideEditor.SECONDARY | SideBySideEditor.ANY;

	/**
	 * The order in which to consider editors for finding.
	 */
	order?: EditorsOrder;
}

export interface IMatchEditorOptions {

	/**
	 * Whether to consider a side by side editor as matching.
	 * By default, side by side editors will not be considered
	 * as matching, even if the editor is opened in one of the sides.
	 */
	supportSideBySide?: SideBySideEditor.ANY | SideBySideEditor.BOTH;

	/**
	 * Only consider an editor to match when the
	 * `candidate === editor` but not when
	 * `candidate.matches(editor)`.
	 */
	strictEquals?: boolean;
}

export interface IEditorResourceAccessorOptions {

	/**
	 * Allows to access the `resource(s)` of side by side editors. If not
	 * specified, a `resource` for a side by side editor will always be
	 * `undefined`.
	 */
	supportSideBySide?: SideBySideEditor;

	/**
	 * Allows to filter the scheme to consider. A resource scheme that does
	 * not match a filter will not be considered.
	 */
	filterByScheme?: string | string[];
}

class EditorResourceAccessorImpl {

	/**
	 * The original URI of an editor is the URI that was used originally to open
	 * the editor and should be used whenever the URI is presented to the user,
	 * e.g. as a label together with utility methods such as `ResourceLabel` or
	 * `ILabelService` that can turn this original URI into the best form for
	 * presenting.
	 *
	 * In contrast, the canonical URI (#getCanonicalUri) may be different and should
	 * be used whenever the URI is used to e.g. compare with other editors or when
	 * caching certain data based on the URI.
	 *
	 * For example: on Windows and macOS, the same file URI with different casing may
	 * point to the same file. The editor may chose to "normalize" the URI into a canonical
	 * form so that only one editor opens for same file URIs with different casing. As
	 * such, the original URI and the canonical URI can be different.
	 */
	getOriginalUri(editor: EditorInput | IUntypedEditorInput | undefined | null): URI | undefined;
	getOriginalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options: IEditorResourceAccessorOptions & { supportSideBySide?: SideBySideEditor.PRIMARY | SideBySideEditor.SECONDARY | SideBySideEditor.ANY }): URI | undefined;
	getOriginalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options: IEditorResourceAccessorOptions & { supportSideBySide: SideBySideEditor.BOTH }): URI | { primary?: URI; secondary?: URI } | undefined;
	getOriginalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options?: IEditorResourceAccessorOptions): URI | { primary?: URI; secondary?: URI } | undefined;
	getOriginalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options?: IEditorResourceAccessorOptions): URI | { primary?: URI; secondary?: URI } | undefined {
		if (!editor) {
			return undefined;
		}

		// Merge editors are handled with `merged` result editor
		if (isResourceMergeEditorInput(editor)) {
			return EditorResourceAccessor.getOriginalUri(editor.result, options);
		}

		// Optionally support side-by-side editors
		if (options?.supportSideBySide) {
			const { primary, secondary } = this.getSideEditors(editor);
			if (primary && secondary) {
				if (options?.supportSideBySide === SideBySideEditor.BOTH) {
					return {
						primary: this.getOriginalUri(primary, { filterByScheme: options.filterByScheme }),
						secondary: this.getOriginalUri(secondary, { filterByScheme: options.filterByScheme })
					};
				} else if (options?.supportSideBySide === SideBySideEditor.ANY) {
					return this.getOriginalUri(primary, { filterByScheme: options.filterByScheme }) ?? this.getOriginalUri(secondary, { filterByScheme: options.filterByScheme });
				}

				editor = options.supportSideBySide === SideBySideEditor.PRIMARY ? primary : secondary;
			}
		}

		if (isResourceDiffEditorInput(editor) || isResourceMultiDiffEditorInput(editor) || isResourceSideBySideEditorInput(editor) || isResourceMergeEditorInput(editor)) {
			return undefined;
		}

		// Original URI is the `preferredResource` of an editor if any
		const originalResource = isEditorInputWithPreferredResource(editor) ? editor.preferredResource : editor.resource;
		if (!originalResource || !options?.filterByScheme) {
			return originalResource;
		}

		return this.filterUri(originalResource, options.filterByScheme);
	}

	private getSideEditors(editor: EditorInput | IUntypedEditorInput): { primary: EditorInput | IUntypedEditorInput | undefined; secondary: EditorInput | IUntypedEditorInput | undefined } {
		if (isSideBySideEditorInput(editor) || isResourceSideBySideEditorInput(editor)) {
			return { primary: editor.primary, secondary: editor.secondary };
		}

		if (isDiffEditorInput(editor) || isResourceDiffEditorInput(editor)) {
			return { primary: editor.modified, secondary: editor.original };
		}

		return { primary: undefined, secondary: undefined };
	}

	/**
	 * The canonical URI of an editor is the true unique identifier of the editor
	 * and should be used whenever the URI is used e.g. to compare with other
	 * editors or when caching certain data based on the URI.
	 *
	 * In contrast, the original URI (#getOriginalUri) may be different and should
	 * be used whenever the URI is presented to the user, e.g. as a label.
	 *
	 * For example: on Windows and macOS, the same file URI with different casing may
	 * point to the same file. The editor may chose to "normalize" the URI into a canonical
	 * form so that only one editor opens for same file URIs with different casing. As
	 * such, the original URI and the canonical URI can be different.
	 */
	getCanonicalUri(editor: EditorInput | IUntypedEditorInput | undefined | null): URI | undefined;
	getCanonicalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options: IEditorResourceAccessorOptions & { supportSideBySide?: SideBySideEditor.PRIMARY | SideBySideEditor.SECONDARY | SideBySideEditor.ANY }): URI | undefined;
	getCanonicalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options: IEditorResourceAccessorOptions & { supportSideBySide: SideBySideEditor.BOTH }): URI | { primary?: URI; secondary?: URI } | undefined;
	getCanonicalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options?: IEditorResourceAccessorOptions): URI | { primary?: URI; secondary?: URI } | undefined;
	getCanonicalUri(editor: EditorInput | IUntypedEditorInput | undefined | null, options?: IEditorResourceAccessorOptions): URI | { primary?: URI; secondary?: URI } | undefined {
		if (!editor) {
			return undefined;
		}

		// Merge editors are handled with `merged` result editor
		if (isResourceMergeEditorInput(editor)) {
			return EditorResourceAccessor.getCanonicalUri(editor.result, options);
		}

		// Optionally support side-by-side editors
		if (options?.supportSideBySide) {
			const { primary, secondary } = this.getSideEditors(editor);
			if (primary && secondary) {
				if (options?.supportSideBySide === SideBySideEditor.BOTH) {
					return {
						primary: this.getCanonicalUri(primary, { filterByScheme: options.filterByScheme }),
						secondary: this.getCanonicalUri(secondary, { filterByScheme: options.filterByScheme })
					};
				} else if (options?.supportSideBySide === SideBySideEditor.ANY) {
					return this.getCanonicalUri(primary, { filterByScheme: options.filterByScheme }) ?? this.getCanonicalUri(secondary, { filterByScheme: options.filterByScheme });
				}

				editor = options.supportSideBySide === SideBySideEditor.PRIMARY ? primary : secondary;
			}
		}

		if (isResourceDiffEditorInput(editor) || isResourceMultiDiffEditorInput(editor) || isResourceSideBySideEditorInput(editor) || isResourceMergeEditorInput(editor)) {
			return undefined;
		}

		// Canonical URI is the `resource` of an editor
		const canonicalResource = editor.resource;
		if (!canonicalResource || !options?.filterByScheme) {
			return canonicalResource;
		}

		return this.filterUri(canonicalResource, options.filterByScheme);
	}

	private filterUri(resource: URI, filter: string | string[]): URI | undefined {

		// Multiple scheme filter
		if (Array.isArray(filter)) {
			if (filter.some(scheme => resource.scheme === scheme)) {
				return resource;
			}
		}

		// Single scheme filter
		else {
			if (filter === resource.scheme) {
				return resource;
			}
		}

		return undefined;
	}
}

export type PreventPinnedEditorClose = 'keyboardAndMouse' | 'keyboard' | 'mouse' | 'never' | undefined;

export enum EditorCloseMethod {
	UNKNOWN,
	KEYBOARD,
	MOUSE
}

/**
 * Determines whether a sticky editor should be prevented from being closed
 * based on the close method (keyboard or mouse) and the configured policy.
 *
 * @param group - The editor group or group model containing the editor.
 * @param editor - The editor input being closed.
 * @param method - The method used to close the editor (keyboard or mouse).
 * @param configuration - The editor part configuration containing the close policy.
 * @returns `true` if the editor close should be prevented.
 */
export function preventEditorClose(group: IEditorGroup | IReadonlyEditorGroupModel, editor: EditorInput, method: EditorCloseMethod, configuration: IEditorPartConfiguration): boolean {
	if (!group.isSticky(editor)) {
		return false; // only interested in sticky editors
	}

	switch (configuration.preventPinnedEditorClose) {
		case 'keyboardAndMouse': return method === EditorCloseMethod.MOUSE || method === EditorCloseMethod.KEYBOARD;
		case 'mouse': return method === EditorCloseMethod.MOUSE;
		case 'keyboard': return method === EditorCloseMethod.KEYBOARD;
	}

	return false;
}

/**
 * Utility for accessing resources from editor inputs. Provides methods to get
 * both the original (display) URI and the canonical (identity) URI, with support
 * for side-by-side, diff, and merge editor inputs.
 */
export const EditorResourceAccessor = new EditorResourceAccessorImpl();

export const enum CloseDirection {
	LEFT,
	RIGHT
}

/**
 * Provides storage for editor-related state that persists across sessions.
 * State is scoped to a specific editor resource and group.
 *
 * @template T - The type of the stored state.
 */
export interface IEditorMemento<T> {

	saveEditorState(group: IEditorGroup, resource: URI, state: T): void;
	saveEditorState(group: IEditorGroup, editor: EditorInput, state: T): void;

	loadEditorState(group: IEditorGroup, resource: URI): T | undefined;
	loadEditorState(group: IEditorGroup, editor: EditorInput): T | undefined;

	clearEditorState(resource: URI, group?: IEditorGroup): void;
	clearEditorState(editor: EditorInput, group?: IEditorGroup): void;

	clearEditorStateOnDispose(resource: URI, editor: EditorInput): void;

	moveEditorState(source: URI, target: URI, comparer: IExtUri): void;
}

class EditorFactoryRegistry implements IEditorFactoryRegistry {
	private instantiationService: IInstantiationService | undefined;

	private fileEditorFactory: IFileEditorFactory | undefined;

	private readonly editorSerializerConstructors = new Map<string /* Type ID */, IConstructorSignature<IEditorSerializer>>();
	private readonly editorSerializerInstances = new Map<string /* Type ID */, IEditorSerializer>();

	start(accessor: ServicesAccessor): void {
		const instantiationService = this.instantiationService = accessor.get(IInstantiationService);

		for (const [key, ctor] of this.editorSerializerConstructors) {
			this.createEditorSerializer(key, ctor, instantiationService);
		}

		this.editorSerializerConstructors.clear();
	}

	private createEditorSerializer(editorTypeId: string, ctor: IConstructorSignature<IEditorSerializer>, instantiationService: IInstantiationService): void {
		const instance = instantiationService.createInstance(ctor);
		this.editorSerializerInstances.set(editorTypeId, instance);
	}

	registerFileEditorFactory(factory: IFileEditorFactory): void {
		if (this.fileEditorFactory) {
			throw new Error('Can only register one file editor factory.');
		}

		this.fileEditorFactory = factory;
	}

	getFileEditorFactory(): IFileEditorFactory {
		return assertReturnsDefined(this.fileEditorFactory);
	}

	registerEditorSerializer(editorTypeId: string, ctor: IConstructorSignature<IEditorSerializer>): IDisposable {
		if (this.editorSerializerConstructors.has(editorTypeId) || this.editorSerializerInstances.has(editorTypeId)) {
			throw new Error(`A editor serializer with type ID '${editorTypeId}' was already registered.`);
		}

		if (!this.instantiationService) {
			this.editorSerializerConstructors.set(editorTypeId, ctor);
		} else {
			this.createEditorSerializer(editorTypeId, ctor, this.instantiationService);
		}

		return toDisposable(() => {
			this.editorSerializerConstructors.delete(editorTypeId);
			this.editorSerializerInstances.delete(editorTypeId);
		});
	}

	getEditorSerializer(editor: EditorInput): IEditorSerializer | undefined;
	getEditorSerializer(editorTypeId: string): IEditorSerializer | undefined;
	getEditorSerializer(arg1: string | EditorInput): IEditorSerializer | undefined {
		return this.editorSerializerInstances.get(typeof arg1 === 'string' ? arg1 : arg1.typeId);
	}
}

Registry.add(EditorExtensions.EditorFactory, new EditorFactoryRegistry());

/**
 * Converts an array of path data objects into editor inputs.
 * Validates each path, checks file existence, and creates the appropriate
 * resource or untitled editor input.
 *
 * @param paths - The array of path data objects to convert.
 * @param fileService - The file service for checking file existence and type.
 * @param logService - The log service for recording resolution issues.
 * @returns A promise that resolves to an array of editor inputs (or `undefined` for invalid paths).
 */
export async function pathsToEditors(paths: IPathData[] | undefined, fileService: IFileService, logService: ILogService): Promise<ReadonlyArray<IResourceEditorInput | IUntitledTextResourceEditorInput | undefined>> {
	if (!paths?.length) {
		return [];
	}

	return await Promise.all(paths.map(async path => {
		const resource = URI.revive(path.fileUri);
		if (!resource) {
			logService.info('Cannot resolve the path because it is not valid.', path);
			return undefined;
		}

		const canHandleResource = await fileService.canHandleResource(resource);
		if (!canHandleResource) {
			logService.info('Cannot resolve the path because it cannot be handled', path);
			return undefined;
		}

		let exists = path.exists;
		let type = path.type;
		if (typeof exists !== 'boolean' || typeof type !== 'number') {
			try {
				type = (await fileService.stat(resource)).isDirectory ? FileType.Directory : FileType.Unknown;
				exists = true;
			} catch (error) {
				logService.error(error);
				exists = false;
			}
		}

		if (!exists && path.openOnlyIfExists) {
			logService.info('Cannot resolve the path because it does not exist', path);
			return undefined;
		}

		if (type === FileType.Directory) {
			logService.info('Cannot resolve the path because it is a directory', path);
			return undefined;
		}

		const options: IEditorOptions = {
			...path.options,
			pinned: true
		};

		if (!exists) {
			return { resource, options, forceUntitled: true };
		}

		return { resource, options };
	}));
}

export const enum EditorsOrder {

	/**
	 * Editors sorted by most recent activity (most recent active first)
	 */
	MOST_RECENTLY_ACTIVE,

	/**
	 * Editors sorted by sequential order
	 */
	SEQUENTIAL
}

/**
 * Type guard that checks whether the given candidate is a valid text editor view state.
 * Handles both regular code editor view states and diff editor view states recursively.
 *
 * @param candidate - The value to check.
 * @returns `true` if the value is a valid `IEditorViewState`.
 */
export function isTextEditorViewState(candidate: unknown): candidate is IEditorViewState {
	const viewState = candidate as IEditorViewState | undefined;
	if (!viewState) {
		return false;
	}

	const diffEditorViewState = viewState as IDiffEditorViewState;
	if (diffEditorViewState.modified) {
		return isTextEditorViewState(diffEditorViewState.modified);
	}

	const codeEditorViewState = viewState as ICodeEditorViewState;

	return !!(codeEditorViewState.contributionsState && codeEditorViewState.viewState && Array.isArray(codeEditorViewState.cursorState));
}

export interface IEditorOpenErrorOptions {

	/**
	 * If set to true, the message will be taken
	 * from the error message entirely and not be
	 * composed with more text.
	 */
	forceMessage?: boolean;

	/**
	 * If set, will override the severity of the error.
	 */
	forceSeverity?: Severity;

	/**
	 * If set to true, the error may be shown in a dialog
	 * to the user if the editor opening was triggered by
	 * user action. Otherwise and by default, the error will
	 * be shown as place holder in the editor area.
	 */
	allowDialog?: boolean;
}

export interface IEditorOpenError extends IErrorWithActions, IEditorOpenErrorOptions { }

/**
 * Type guard that checks whether the given object is an `IEditorOpenError`.
 *
 * @param obj - The value to check.
 * @returns `true` if the value is an `IEditorOpenError`.
 */
export function isEditorOpenError(obj: unknown): obj is IEditorOpenError {
	return isErrorWithActions(obj);
}

/**
 * Creates an editor open error with associated actions and display options.
 * This error type can optionally be shown in a dialog to the user.
 *
 * @param messageOrError - The error message or an existing error to wrap.
 * @param actions - The actions to present to the user for remediation.
 * @param options - Additional options controlling how the error is displayed.
 * @returns An `IEditorOpenError` with the provided actions and options.
 */
export function createEditorOpenError(messageOrError: string | Error, actions: IAction[], options?: IEditorOpenErrorOptions): IEditorOpenError {
	const error: IEditorOpenError = createErrorWithActions(messageOrError, actions);

	error.forceMessage = options?.forceMessage;
	error.forceSeverity = options?.forceSeverity;
	error.allowDialog = options?.allowDialog;

	return error;
}

/**
 * Represents a set of primary and secondary toolbar actions.
 */
export interface IToolbarActions {
	readonly primary: IAction[];
	readonly secondary: IAction[];
}
