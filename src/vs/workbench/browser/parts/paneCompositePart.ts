/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/paneCompositePart.css';
import { Event } from '../../../base/common/event.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { PaneComposite, PaneCompositeDescriptor, PaneCompositeRegistry } from '../panecomposite.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../common/views.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { IView } from '../../../base/browser/ui/grid/grid.js';
import { IWorkbenchLayoutService, Parts, SINGLE_WINDOW_PARTS } from '../../services/layout/browser/layoutService.js';
import { CompositePart, ICompositePartOptions, ICompositeTitleLabel } from './compositePart.js';
import { IPaneCompositeBarOptions, PaneCompositeBar } from './paneCompositeBar.js';
import { Dimension, EventHelper, trackFocus, $, addDisposableListener, EventType, prepend, getWindow } from '../../../base/browser/dom.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IContextKey, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { IComposite } from '../../common/composite.js';
import { localize } from '../../../nls.js';
import { CompositeDragAndDropObserver, toggleDropEffect } from '../dnd.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND, EDITOR_GROUP_ACTIVE_BORDER } from '../../common/theme.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { Gesture, EventType as GestureEventType } from '../../../base/browser/touch.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IAction, SubmenuAction } from '../../../base/common/actions.js';
import { Composite } from '../composite.js';
import { ViewsSubMenu } from './views/viewPaneContainer.js';
import { getActionBarActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { DeferredPromise } from '../../../base/common/async.js';

/**
 * Describes where the composite bar (view container tabs) is rendered
 * within a pane composite part.
 */
export enum CompositeBarPosition {
	TOP,
	TITLE,
	BOTTOM
}

export interface IPaneCompositePart extends IView {

	readonly partId: SINGLE_WINDOW_PARTS;
	readonly registryId: string;

	readonly onDidPaneCompositeOpen: Event<IPaneComposite>;
	readonly onDidPaneCompositeClose: Event<IPaneComposite>;

	/**
	 * Opens a viewlet with the given identifier and pass keyboard focus to it if specified.
	 */
	openPaneComposite(id: string | undefined, focus?: boolean): Promise<IPaneComposite | undefined>;

	/**
	 * Returns the current active viewlet if any.
	 */
	getActivePaneComposite(): IPaneComposite | undefined;

	/**
	 * Returns the viewlet by id.
	 */
	getPaneComposite(id: string): PaneCompositeDescriptor | undefined;

	/**
	 * Returns all enabled viewlets
	 */
	getPaneComposites(): PaneCompositeDescriptor[];

	/**
	 * Returns the progress indicator for the side bar.
	 */
	getProgressIndicator(id: string): IProgressIndicator | undefined;

	/**
	 * Hide the active viewlet.
	 */
	hideActivePaneComposite(): void;

	/**
	 * Return the last active viewlet id.
	 */
	getLastActivePaneCompositeId(): string;

	/**
	 * Returns id of pinned view containers following the visual order.
	 */
	getPinnedPaneCompositeIds(): string[];

	/**
	 * Returns id of visible view containers following the visual order.
	 */
	getVisiblePaneCompositeIds(): string[];

	/**
	 * Returns id of all view containers following the visual order.
	 */
	getPaneCompositeIds(): string[];
}

/**
 * Abstract base class for pane composite parts (sidebar, panel, auxiliary bar).
 *
 * Manages the lifecycle of pane composites (viewlet/panel views), the composite
 * bar (view container tabs), and provides a tmux-like active border highlight
 * controlled by the `vscodeee.activePaneBorder` configuration.
 *
 * Subclasses must implement:
 * - {@link shouldShowCompositeBar}
 * - {@link getCompositeBarOptions}
 * - {@link getCompositeBarPosition}
 */
export abstract class AbstractPaneCompositePart extends CompositePart<PaneComposite> implements IPaneCompositePart {

	private static readonly MIN_COMPOSITE_BAR_WIDTH = 50;

	get snap(): boolean {
		// Always allow snapping closed
		// Only allow dragging open if the panel contains view containers
		return this.layoutService.isVisible(this.partId) || !!this.paneCompositeBar.value?.getVisiblePaneCompositeIds().length;
	}

	get onDidPaneCompositeOpen(): Event<IPaneComposite> { return Event.map(this.onDidCompositeOpen.event, compositeEvent => <IPaneComposite>compositeEvent.composite); }
	readonly onDidPaneCompositeClose = this.onDidCompositeClose.event as Event<IPaneComposite>;

	private titleContainer: HTMLElement | undefined;
	private headerFooterCompositeBarContainer: HTMLElement | undefined;
	protected readonly headerFooterCompositeBarDispoables = this._register(new DisposableStore());
	private paneCompositeBarContainer: HTMLElement | undefined;
	private readonly paneCompositeBar = this._register(new MutableDisposable<PaneCompositeBar>());
	private compositeBarPosition: CompositeBarPosition | undefined = undefined;
	private emptyPaneMessageElement: HTMLElement | undefined;

	private globalToolBar: MenuWorkbenchToolBar | undefined;
	private globalLeftToolBar: MenuWorkbenchToolBar | undefined;

	private blockOpening: DeferredPromise<PaneComposite | undefined> | undefined = undefined;
	protected contentDimension: Dimension | undefined;

	constructor(
		readonly partId: SINGLE_WINDOW_PARTS,
		partOptions: ICompositePartOptions,
		activePaneCompositeSettingsKey: string,
		private readonly activePaneContextKey: IContextKey<string>,
		private paneFocusContextKey: IContextKey<boolean>,
		nameForTelemetry: string,
		compositeCSSClass: string,
		titleForegroundColor: string | undefined,
		titleBorderColor: string | undefined,
		protected readonly location: ViewContainerLocation,
		readonly registryId: string,
		private readonly globalActionsMenuId: MenuId,
		private readonly globalLeftActionsMenuId: MenuId | undefined,
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IContextKeyService protected readonly contextKeyService: IContextKeyService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IMenuService protected readonly menuService: IMenuService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
	) {
		super(
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			Registry.as<PaneCompositeRegistry>(registryId),
			activePaneCompositeSettingsKey,
			viewDescriptorService.getDefaultViewContainer(location)?.id || '',
			nameForTelemetry,
			compositeCSSClass,
			titleForegroundColor,
			titleBorderColor,
			partId,
			partOptions
		);
		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.onDidPaneCompositeOpen(composite => this.onDidOpen(composite)));
		this._register(this.onDidPaneCompositeClose(this.onDidClose, this));

		this._register(this.registry.onDidDeregister((viewletDescriptor: PaneCompositeDescriptor) => {

			const activeContainers = this.viewDescriptorService.getViewContainersByLocation(this.location)
				.filter(container => this.viewDescriptorService.getViewContainerModel(container).activeViewDescriptors.length > 0);

			if (activeContainers.length) {
				if (this.getActiveComposite()?.getId() === viewletDescriptor.id) {
					const defaultViewletId = this.viewDescriptorService.getDefaultViewContainer(this.location)?.id;
					const containerToOpen = activeContainers.filter(c => c.id === defaultViewletId)[0] || activeContainers[0];
					this.doOpenPaneComposite(containerToOpen.id);
				}
			} else {
				this.layoutService.setPartHidden(true, this.partId);
			}

			this.removeComposite(viewletDescriptor.id);
		}));

		this._register(this.extensionService.onDidRegisterExtensions(() => {
			this.layoutCompositeBar();
		}));
	}

	private onDidOpen(composite: IComposite): void {
		this.activePaneContextKey.set(composite.getId());
	}

	private onDidClose(composite: IComposite): void {
		const id = composite.getId();
		if (this.activePaneContextKey.get() === id) {
			this.activePaneContextKey.reset();
		}
	}

	protected override showComposite(composite: Composite): void {
		super.showComposite(composite);
		this.layoutCompositeBar();
		this.layoutEmptyMessage();
	}

	protected override hideActiveComposite(): Composite | undefined {
		const composite = super.hideActiveComposite();
		this.layoutCompositeBar();
		this.layoutEmptyMessage();
		return composite;
	}

	override create(parent: HTMLElement): void {
		this.element = parent;
		this.element.classList.add('pane-composite-part');

		super.create(parent);

		if (this.contentArea) {
			this.createEmptyPaneMessage(this.contentArea);
		}

		this.updateCompositeBar();

		const focusTracker = this._register(trackFocus(parent));
		this._register(focusTracker.onDidFocus(() => {
			this.paneFocusContextKey.set(true);
			this.updateStyles();
		}));
		this._register(focusTracker.onDidBlur(() => {
			this.paneFocusContextKey.set(false);
			this.updateStyles();
		}));

		// Active pane border: react to configuration changes
		const onDidChangeActivePaneBorder = Event.filter(
			this.configurationService.onDidChangeConfiguration,
			e => e.affectsConfiguration('vscodeee.activePaneBorder')
		);
		this._register(onDidChangeActivePaneBorder(() => this.updateStyles()));
	}

	/**
	 * Updates visual styles including the tmux-like active pane border.
	 *
	 * When `vscodeee.activePaneBorder.enabled` is `true` (default) and the part
	 * currently has focus, an inset border is drawn around the container using the
	 * `active-pane-border` CSS class. The border color defaults to the theme's
	 * `editorGroup.activeBorder` token but can be overridden via
	 * `vscodeee.activePaneBorder.color`. The border width is configurable via
	 * `vscodeee.activePaneBorder.width`.
	 *
	 * CSS custom properties set on the container:
	 * - `--active-pane-border-color` - resolved border color
	 * - `--active-pane-border-width`  - resolved border width in px
	 */
	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (!container) {
			return;
		}

		// Active pane border (tmux-like): show when this part has focus
		const activePaneBorderEnabled = this.configurationService.getValue<boolean>('vscodeee.activePaneBorder.enabled') ?? true;
		if (activePaneBorderEnabled && this.paneFocusContextKey.get()) {
			const colorOverride = this.configurationService.getValue<string>('vscodeee.activePaneBorder.color');
			const activeBorderColor = colorOverride || this.getColor(EDITOR_GROUP_ACTIVE_BORDER);
			if (activeBorderColor) {
				container.classList.add('active-pane-border');
				container.style.setProperty('--active-pane-border-color', activeBorderColor);
				const widthValue = this.configurationService.getValue<number>('vscodeee.activePaneBorder.width') ?? 1;
				container.style.setProperty('--active-pane-border-width', `${widthValue}px`);
				return;
			}
		}

		container.classList.remove('active-pane-border');
		container.style.removeProperty('--active-pane-border-color');
		container.style.removeProperty('--active-pane-border-width');
	}

	private createEmptyPaneMessage(parent: HTMLElement): void {
		this.emptyPaneMessageElement = $('.empty-pane-message-area');

		const messageElement = $('.empty-pane-message');
		messageElement.textContent = localize('pane.emptyMessage', "Drag a view here to display.");

		this.emptyPaneMessageElement.appendChild(messageElement);
		parent.appendChild(this.emptyPaneMessageElement);

		const setDropBackgroundFeedback = (visible: boolean) => {
			const updateActivityBarBackground = !this.getActiveComposite() || !visible;
			const backgroundColor = visible ? this.theme.getColor(EDITOR_DRAG_AND_DROP_BACKGROUND)?.toString() || '' : '';

			if (this.titleContainer && updateActivityBarBackground) {
				this.titleContainer.style.backgroundColor = backgroundColor;
			}
			if (this.headerFooterCompositeBarContainer && updateActivityBarBackground) {
				this.headerFooterCompositeBarContainer.style.backgroundColor = backgroundColor;
			}

			this.emptyPaneMessageElement!.style.backgroundColor = backgroundColor;
		};

		if (this.viewDescriptorService.canMoveViews()) {
			this._register(CompositeDragAndDropObserver.INSTANCE.registerTarget(this.element, {
				onDragOver: (e) => {
					EventHelper.stop(e.eventData, true);
					if (this.paneCompositeBar.value) {
						const validDropTarget = this.paneCompositeBar.value.dndHandler.onDragEnter(e.dragAndDropData, undefined, e.eventData);
						toggleDropEffect(e.eventData.dataTransfer, 'move', validDropTarget);
					}
				},
				onDragEnter: (e) => {
					EventHelper.stop(e.eventData, true);
					if (this.paneCompositeBar.value) {
						const validDropTarget = this.paneCompositeBar.value.dndHandler.onDragEnter(e.dragAndDropData, undefined, e.eventData);
						setDropBackgroundFeedback(validDropTarget);
					}
				},
				onDragLeave: (e) => {
					EventHelper.stop(e.eventData, true);
					setDropBackgroundFeedback(false);
				},
				onDragEnd: (e) => {
					EventHelper.stop(e.eventData, true);
					setDropBackgroundFeedback(false);
				},
				onDrop: (e) => {
					EventHelper.stop(e.eventData, true);
					setDropBackgroundFeedback(false);
					if (this.paneCompositeBar.value) {
						this.paneCompositeBar.value.dndHandler.drop(e.dragAndDropData, undefined, e.eventData);
					} else {
						// Allow opening views/composites if the composite bar is hidden
						const dragData = e.dragAndDropData.getData();

						if (dragData.type === 'composite') {
							const currentContainer = this.viewDescriptorService.getViewContainerById(dragData.id)!;
							this.viewDescriptorService.moveViewContainerToLocation(currentContainer, this.location, undefined, 'dnd');
							this.openPaneComposite(currentContainer.id, true);
						}

						else if (dragData.type === 'view') {
							const viewToMove = this.viewDescriptorService.getViewDescriptorById(dragData.id)!;
							if (viewToMove.canMoveView) {
								this.viewDescriptorService.moveViewToLocation(viewToMove, this.location, 'dnd');

								const newContainer = this.viewDescriptorService.getViewContainerByViewId(viewToMove.id)!;

								this.openPaneComposite(newContainer.id, true).then(composite => {
									composite?.openView(viewToMove.id, true);
								});
							}
						}
					}
				},
			}));
		}
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement | undefined {
		const titleArea = super.createTitleArea(parent);
		if (!titleArea) {
			return undefined;
		}

		this._register(addDisposableListener(titleArea, EventType.CONTEXT_MENU, e => {
			this.onTitleAreaContextMenu(new StandardMouseEvent(getWindow(titleArea), e));
		}));
		this._register(Gesture.addTarget(titleArea));
		this._register(addDisposableListener(titleArea, GestureEventType.Contextmenu, e => {
			this.onTitleAreaContextMenu(new StandardMouseEvent(getWindow(titleArea), e));
		}));

		if (this.globalLeftActionsMenuId) {
			const globalLeftTitleActionsContainer = titleArea.appendChild($('.global-actions-left'));
			this.globalLeftToolBar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar,
				globalLeftTitleActionsContainer,
				this.globalLeftActionsMenuId,
				{
					actionViewItemProvider: (action, options) => this.actionViewItemProvider(action, options),
					orientation: ActionsOrientation.HORIZONTAL,
					getKeyBinding: action => this.keybindingService.lookupKeybinding(action.id),
					anchorAlignmentProvider: () => this.getTitleAreaDropDownAnchorAlignment(),
					hoverDelegate: this.toolbarHoverDelegate,
					hiddenItemStrategy: HiddenItemStrategy.NoHide,
					highlightToggledItems: false,
					telemetrySource: this.nameForTelemetry
				}
			));
		}

		const globalTitleActionsContainer = titleArea.appendChild($('.global-actions'));

		// Global Actions Toolbar
		this.globalToolBar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar,
			globalTitleActionsContainer,
			this.globalActionsMenuId,
			{
				actionViewItemProvider: (action, options) => this.actionViewItemProvider(action, options),
				orientation: ActionsOrientation.HORIZONTAL,
				getKeyBinding: action => this.keybindingService.lookupKeybinding(action.id),
				anchorAlignmentProvider: () => this.getTitleAreaDropDownAnchorAlignment(),
				toggleMenuTitle: localize('moreActions', "More Actions..."),
				hoverDelegate: this.toolbarHoverDelegate,
				hiddenItemStrategy: HiddenItemStrategy.NoHide,
				highlightToggledItems: true,
				telemetrySource: this.nameForTelemetry
			}
		));

		return titleArea;
	}

	protected override createTitleLabel(parent: HTMLElement): ICompositeTitleLabel {
		this.titleContainer = parent;

		const titleLabel = super.createTitleLabel(parent);
		this.titleLabelElement!.draggable = this.viewDescriptorService.canMoveViews();
		const draggedItemProvider = (): { type: 'view' | 'composite'; id: string } => {
			const activeViewlet = this.getActivePaneComposite()!;
			return { type: 'composite', id: activeViewlet.getId() };
		};
		this._register(CompositeDragAndDropObserver.INSTANCE.registerDraggable(this.titleLabelElement!, draggedItemProvider, {}));

		return titleLabel;
	}

	/**
	 * Recreates the composite bar when its visibility or position has changed.
	 *
	 * @param updateCompositeBarOption - When `true`, forces a relayout of the
	 *   composite bar even if the position has not changed (e.g. when label
	 *   visibility is toggled).
	 */
	protected updateCompositeBar(updateCompositeBarOption: boolean = false): void {
		const wasCompositeBarVisible = this.compositeBarPosition !== undefined;
		const isCompositeBarVisible = this.shouldShowCompositeBar();
		const previousPosition = this.compositeBarPosition;
		const newPosition = isCompositeBarVisible ? this.getCompositeBarPosition() : undefined;

		// Only update if the visibility or position has changed or if the composite bar options should be updated
		if (!updateCompositeBarOption && previousPosition === newPosition) {
			return;
		}

		// Remove old composite bar
		if (wasCompositeBarVisible) {
			const previousCompositeBarContainer = previousPosition === CompositeBarPosition.TITLE ? this.titleContainer : this.headerFooterCompositeBarContainer;
			if (!this.paneCompositeBarContainer || !this.paneCompositeBar.value || !previousCompositeBarContainer) {
				throw new Error('Composite bar containers should exist when removing the previous composite bar');
			}

			this.paneCompositeBarContainer.remove();
			this.paneCompositeBarContainer = undefined;
			this.paneCompositeBar.value = undefined;

			previousCompositeBarContainer.classList.remove('has-composite-bar');

			if (previousPosition === CompositeBarPosition.TOP) {
				this.removeFooterHeaderArea(true);
			} else if (previousPosition === CompositeBarPosition.BOTTOM) {
				this.removeFooterHeaderArea(false);
			}
		}

		// Create new composite bar
		let newCompositeBarContainer;
		switch (newPosition) {
			case CompositeBarPosition.TOP: newCompositeBarContainer = this.createHeaderArea(); break;
			case CompositeBarPosition.TITLE: newCompositeBarContainer = this.titleContainer; break;
			case CompositeBarPosition.BOTTOM: newCompositeBarContainer = this.createFooterArea(); break;
		}
		if (isCompositeBarVisible) {

			if (this.paneCompositeBarContainer || this.paneCompositeBar.value || !newCompositeBarContainer) {
				throw new Error('Invalid composite bar state when creating the new composite bar');
			}

			newCompositeBarContainer.classList.add('has-composite-bar');
			this.paneCompositeBarContainer = prepend(newCompositeBarContainer, $('.composite-bar-container'));
			this.paneCompositeBar.value = this.createCompositeBar();
			this.paneCompositeBar.value.create(this.paneCompositeBarContainer);

			if (newPosition === CompositeBarPosition.TOP) {
				this.setHeaderArea(newCompositeBarContainer);
			} else if (newPosition === CompositeBarPosition.BOTTOM) {
				this.setFooterArea(newCompositeBarContainer);
			}
		}

		this.compositeBarPosition = newPosition;

		if (updateCompositeBarOption) {
			this.layoutCompositeBar();
		}
	}

	protected override createHeaderArea(): HTMLElement {
		const headerArea = super.createHeaderArea();

		return this.createHeaderFooterCompositeBarArea(headerArea);
	}

	protected override createFooterArea(): HTMLElement {
		const footerArea = super.createFooterArea();

		return this.createHeaderFooterCompositeBarArea(footerArea);
	}

	protected createHeaderFooterCompositeBarArea(area: HTMLElement): HTMLElement {
		if (this.headerFooterCompositeBarContainer) {
			// A pane composite part has either a header or a footer, but not both
			throw new Error('Header or Footer composite bar already exists');
		}
		this.headerFooterCompositeBarContainer = area;

		this.headerFooterCompositeBarDispoables.add(addDisposableListener(area, EventType.CONTEXT_MENU, e => {
			this.onCompositeBarAreaContextMenu(new StandardMouseEvent(getWindow(area), e));
		}));
		this.headerFooterCompositeBarDispoables.add(Gesture.addTarget(area));
		this.headerFooterCompositeBarDispoables.add(addDisposableListener(area, GestureEventType.Contextmenu, e => {
			this.onCompositeBarAreaContextMenu(new StandardMouseEvent(getWindow(area), e));
		}));

		return area;
	}

	private removeFooterHeaderArea(header: boolean): void {
		this.headerFooterCompositeBarContainer = undefined;
		this.headerFooterCompositeBarDispoables.clear();
		if (header) {
			this.removeHeaderArea();
		} else {
			this.removeFooterArea();
		}
	}

	protected createCompositeBar(): PaneCompositeBar {
		return this.instantiationService.createInstance(PaneCompositeBar, this.location, this.getCompositeBarOptions(), this.partId, this);
	}

	protected override onTitleAreaUpdate(compositeId: string): void {
		super.onTitleAreaUpdate(compositeId);

		// If title actions change, relayout the composite bar
		this.layoutCompositeBar();
	}

	async openPaneComposite(id?: string, focus?: boolean): Promise<PaneComposite | undefined> {
		if (typeof id === 'string' && this.getPaneComposite(id)) {
			return this.doOpenPaneComposite(id, focus);
		}

		await this.extensionService.whenInstalledExtensionsRegistered();

		if (typeof id === 'string' && this.getPaneComposite(id)) {
			return this.doOpenPaneComposite(id, focus);
		}

		return undefined;
	}

	private async doOpenPaneComposite(id: string, focus?: boolean): Promise<PaneComposite | undefined> {
		if (this.blockOpening) {
			// Workaround against a potential race condition when calling
			// `setPartHidden` we may end up in `openPaneComposite` again.
			// But we still want to return the result of the original call,
			// so we return the promise of the original call.
			return this.blockOpening.p;
		}

		let blockOpening: DeferredPromise<PaneComposite | undefined> | undefined;
		if (!this.layoutService.isVisible(this.partId)) {
			try {
				blockOpening = this.blockOpening = new DeferredPromise<PaneComposite | undefined>();
				this.layoutService.setPartHidden(false, this.partId);
			} finally {
				this.blockOpening = undefined;
			}
		}

		try {
			const result = this.openComposite(id, focus) as PaneComposite | undefined;
			blockOpening?.complete(result);

			return result;
		} catch (error) {
			blockOpening?.error(error);
			throw error;
		}
	}

	getPaneComposite(id: string): PaneCompositeDescriptor | undefined {
		return (this.registry as PaneCompositeRegistry).getPaneComposite(id);
	}

	getPaneComposites(): PaneCompositeDescriptor[] {
		return (this.registry as PaneCompositeRegistry).getPaneComposites()
			.sort((v1, v2) => {
				if (typeof v1.order !== 'number') {
					return 1;
				}

				if (typeof v2.order !== 'number') {
					return -1;
				}

				return v1.order - v2.order;
			});
	}

	getPinnedPaneCompositeIds(): string[] {
		return this.paneCompositeBar.value?.getPinnedPaneCompositeIds() ?? [];
	}

	getVisiblePaneCompositeIds(): string[] {
		return this.paneCompositeBar.value?.getVisiblePaneCompositeIds() ?? [];
	}

	getPaneCompositeIds(): string[] {
		return this.paneCompositeBar.value?.getPaneCompositeIds() ?? [];
	}

	getActivePaneComposite(): IPaneComposite | undefined {
		return <IPaneComposite>this.getActiveComposite();
	}

	getLastActivePaneCompositeId(): string {
		return this.getLastActiveCompositeId();
	}

	hideActivePaneComposite(): void {
		if (this.layoutService.isVisible(this.partId)) {
			this.layoutService.setPartHidden(true, this.partId);
		}

		this.hideActiveComposite();
	}

	protected focusCompositeBar(): void {
		this.paneCompositeBar.value?.focus();
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(this.partId)) {
			return;
		}

		this.contentDimension = new Dimension(width, height);

		// Layout contents
		super.layout(this.contentDimension.width, this.contentDimension.height, top, left);

		// Layout composite bar
		this.layoutCompositeBar();

		// Add empty pane message
		this.layoutEmptyMessage();
	}

	private layoutCompositeBar(): void {
		if (this.contentDimension && this.dimension && this.paneCompositeBar.value) {
			const padding = this.compositeBarPosition === CompositeBarPosition.TITLE ? 16 : 8;
			const borderWidth = this.partId === Parts.PANEL_PART ? 0 : 1;
			let availableWidth = this.contentDimension.width - padding - borderWidth;
			availableWidth = Math.max(AbstractPaneCompositePart.MIN_COMPOSITE_BAR_WIDTH, availableWidth - this.getToolbarWidth());
			this.paneCompositeBar.value.layout(availableWidth, this.dimension.height);
		}
	}

	private layoutEmptyMessage(): void {
		const visible = !this.getActiveComposite();
		this.element.classList.toggle('empty', visible);
		if (visible) {
			this.titleLabel?.updateTitle('', '');
		}
	}

	protected getToolbarWidth(): number {
		if (!this.toolBar || this.compositeBarPosition !== CompositeBarPosition.TITLE) {
			return 0;
		}

		const activePane = this.getActivePaneComposite();
		if (!activePane) {
			return 0;
		}

		// Each toolbar item has 4px margin
		const toolBarWidth = this.toolBar.getItemsWidth() + this.toolBar.getItemsLength() * 4;
		const globalToolBarWidth = this.globalToolBar ? this.globalToolBar.getItemsWidth() + this.globalToolBar.getItemsLength() * 4 : 0;
		const globalLeftToolBarWidth = this.globalLeftToolBar ? this.globalLeftToolBar.getItemsWidth() + this.globalLeftToolBar.getItemsLength() * 4 : 0;
		return toolBarWidth + globalToolBarWidth + globalLeftToolBarWidth + 8; // 8px padding left
	}

	private onTitleAreaContextMenu(event: StandardMouseEvent): void {
		if (this.shouldShowCompositeBar() && this.getCompositeBarPosition() === CompositeBarPosition.TITLE) {
			return this.onCompositeBarContextMenu(event);
		} else {
			const activePaneComposite = this.getActivePaneComposite() as PaneComposite;
			const activePaneCompositeActions = activePaneComposite ? activePaneComposite.getContextMenuActions() : [];
			if (activePaneCompositeActions.length) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => event,
					getActions: () => activePaneCompositeActions,
					getActionViewItem: (action, options) => this.actionViewItemProvider(action, options),
					actionRunner: activePaneComposite.getActionRunner(),
					skipTelemetry: true
				});
			}
		}
	}

	private onCompositeBarAreaContextMenu(event: StandardMouseEvent): void {
		return this.onCompositeBarContextMenu(event);
	}

	private onCompositeBarContextMenu(event: StandardMouseEvent): void {
		if (this.paneCompositeBar.value) {
			const actions: IAction[] = [...this.paneCompositeBar.value.getContextMenuActions()];
			if (actions.length) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => event,
					getActions: () => actions,
					skipTelemetry: true
				});
			}
		}
	}

	protected getViewsSubmenuAction(): SubmenuAction | undefined {
		const viewPaneContainer = (this.getActivePaneComposite() as PaneComposite)?.getViewPaneContainer();
		if (viewPaneContainer) {
			const disposables = new DisposableStore();
			const scopedContextKeyService = disposables.add(this.contextKeyService.createScoped(this.element));
			scopedContextKeyService.createKey('viewContainer', viewPaneContainer.viewContainer.id);
			const menu = this.menuService.getMenuActions(ViewsSubMenu, scopedContextKeyService, { shouldForwardArgs: true, renderShortTitle: true });
			const viewsActions = getActionBarActions(menu, () => true).primary;
			disposables.dispose();
			return viewsActions.length > 1 && viewsActions.some(a => a.enabled) ? new SubmenuAction('views', localize('views', "Views"), viewsActions) : undefined;
		}
		return undefined;
	}

	protected abstract shouldShowCompositeBar(): boolean;
	protected abstract getCompositeBarOptions(): IPaneCompositeBarOptions;
	protected abstract getCompositeBarPosition(): CompositeBarPosition;
}
