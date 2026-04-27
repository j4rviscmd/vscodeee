/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable @stylistic/ts/indent */

import { localize } from '../../../nls.js';
import { Action } from '../../../base/common/actions.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { $ } from '../../../base/browser/dom.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { nativeHoverDelegate } from '../../../platform/hover/browser/hover.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IStatusbarService, ShowTooltipCommand, StatusbarAlignment } from '../../services/statusbar/browser/statusbar.js';
import { IWindowZoomService } from '../../services/zoom/common/zoom.js';
import { getZoomFactor, getZoomLevel } from '../../../base/browser/browser.js';
import { mainWindow } from '../../../base/browser/window.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../common/contributions.js';

/**
 * Manages a zoom indicator entry in the status bar.
 *
 * When visible, the entry displays an inline tooltip with zoom-in, zoom-out,
 * reset, and settings actions. The current zoom level label and its percentage
 * equivalent are shown in the tooltip bar.
 *
 * The entry is shown only when the effective zoom level differs from the
 * configured zoom level, and is automatically hidden when they match.
 */
class ZoomStatusEntry extends Disposable {

	private readonly disposable = this._register(new MutableDisposable<DisposableStore>());
	private zoomLevelLabel: Action | undefined = undefined;
	private currentText: string | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();
	}

	/**
	 * Show, hide, or update the zoom status bar entry.
	 *
	 * @param visibleOrText - The status bar text (e.g. `'$(zoom-in)'` or `'$(zoom-out)'`)
	 *   to display, or `false` to hide the entry entirely.
	 */
	updateZoomEntry(visibleOrText: false | string): void {
		if (typeof visibleOrText === 'string') {
			if (!this.disposable.value || this.currentText !== visibleOrText) {
				this.createZoomEntry(visibleOrText);
				this.currentText = visibleOrText;
			}

			this.updateZoomLevelLabel();
		} else {
			this.disposable.clear();
			this.currentText = undefined;
		}
	}

	/**
	 * Create (or recreate) the status bar entry with the given display text.
	 *
	 * Builds two action bars:
	 * - **Left**: Zoom Out button, zoom level label, Zoom In button.
	 * - **Right**: Reset label, Settings gear button.
	 *
	 * Each action is wired to its corresponding command via {@link ICommandService}.
	 * Keybindings are resolved via {@link IKeybindingService} and shown in tooltips.
	 *
	 * @param visibleOrText - The status bar text to display for the entry.
	 */
	private createZoomEntry(visibleOrText: string): void {
		const disposables = new DisposableStore();
		this.disposable.value = disposables;

		const container = $('.zoom-status');

		const left = $('.zoom-status-left');
		container.appendChild(left);

		const zoomOutAction: Action = disposables.add(new Action('workbench.action.zoomOut', localize('zoomOut', 'Zoom Out'), ThemeIcon.asClassName(Codicon.remove), true, () => this.commandService.executeCommand(zoomOutAction.id)));
		const zoomInAction: Action = disposables.add(new Action('workbench.action.zoomIn', localize('zoomIn', 'Zoom In'), ThemeIcon.asClassName(Codicon.plus), true, () => this.commandService.executeCommand(zoomInAction.id)));
		const zoomResetAction: Action = disposables.add(new Action('workbench.action.zoomReset', localize('zoomReset', 'Reset'), undefined, true, () => this.commandService.executeCommand(zoomResetAction.id)));
		zoomResetAction.tooltip = this.keybindingService.appendKeybinding(zoomResetAction.label, zoomResetAction.id) ?? zoomResetAction.label;
		const zoomSettingsAction: Action = disposables.add(new Action('workbench.action.openSettings', localize('zoomSettings', 'Settings'), ThemeIcon.asClassName(Codicon.settingsGear), true, () => this.commandService.executeCommand(zoomSettingsAction.id, 'window.zoom')));
		const zoomLevelLabel = disposables.add(new Action('zoomLabel', undefined, undefined, false));

		this.zoomLevelLabel = zoomLevelLabel;
		disposables.add(toDisposable(() => this.zoomLevelLabel = undefined));

		const actionBarLeft = disposables.add(new ActionBar(left, { hoverDelegate: nativeHoverDelegate }));
		actionBarLeft.push(zoomOutAction, { icon: true, label: false, keybinding: this.keybindingService.lookupKeybinding(zoomOutAction.id)?.getLabel() });
		actionBarLeft.push(this.zoomLevelLabel, { icon: false, label: true });
		actionBarLeft.push(zoomInAction, { icon: true, label: false, keybinding: this.keybindingService.lookupKeybinding(zoomInAction.id)?.getLabel() });

		const right = $('.zoom-status-right');
		container.appendChild(right);

		const actionBarRight = disposables.add(new ActionBar(right, { hoverDelegate: nativeHoverDelegate }));
		actionBarRight.push(zoomResetAction, { icon: false, label: true });
		actionBarRight.push(zoomSettingsAction, { icon: true, label: false, keybinding: this.keybindingService.lookupKeybinding(zoomSettingsAction.id)?.getLabel() });

		const name = localize('status.windowZoom', 'Window Zoom');
		disposables.add(this.statusbarService.addEntry({
			name,
			text: visibleOrText,
			tooltip: container,
			ariaLabel: name,
			command: ShowTooltipCommand,
			kind: 'prominent',
		}, 'status.windowZoom', StatusbarAlignment.RIGHT, 102));
	}

	/** Update the zoom level label text and tooltip to reflect the current effective zoom. */
	private updateZoomLevelLabel(): void {
		if (this.zoomLevelLabel) {
			const zoomFactor = Math.round(getZoomFactor(mainWindow) * 100);
			const zoomLevel = getZoomLevel(mainWindow);

			this.zoomLevelLabel.label = `${zoomLevel}`;
			this.zoomLevelLabel.tooltip = localize('zoomNumber', 'Zoom Level: {0} ({1}%)', zoomLevel, zoomFactor);
		}
	}
}

/**
 * Workbench contribution that drives the zoom status bar entry.
 *
 * Listens to {@link IWindowZoomService.onDidChangeZoom} and shows a zoom indicator
 * in the status bar whenever the effective zoom level diverges from the configured
 * zoom level. The indicator uses `$(zoom-in)` when zoomed in and `$(zoom-out)` when
 * zoomed out.
 */
export class ZoomStatusEntryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'tauri.zoomStatusEntry';

	private readonly zoomStatusEntry: ZoomStatusEntry;

	constructor(
		@IWindowZoomService private readonly windowZoomService: IWindowZoomService,
		@IStatusbarService statusbarService: IStatusbarService,
		@ICommandService commandService: ICommandService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super();

		this.zoomStatusEntry = this._register(new ZoomStatusEntry(statusbarService, commandService, keybindingService));

		this._register(this.windowZoomService.onDidChangeZoom(() => this.updateStatusEntry()));
		this.updateStatusEntry();
	}

	/**
	 * Compare the current effective zoom level against the configured zoom level
	 * and show or hide the status bar entry accordingly.
	 */
	private updateStatusEntry(): void {
		const currentZoomLevel = this.windowZoomService.getZoomLevel();
		const configuredZoomLevel = this.windowZoomService.configuredZoomLevel;

		let text: string | undefined = undefined;
		if (currentZoomLevel < configuredZoomLevel) {
			text = '$(zoom-out)';
		} else if (currentZoomLevel > configuredZoomLevel) {
			text = '$(zoom-in)';
		}

		this.zoomStatusEntry.updateZoomEntry(text ?? false);
	}
}

registerWorkbenchContribution2(ZoomStatusEntryContribution.ID, ZoomStatusEntryContribution, WorkbenchPhase.AfterRestored);
