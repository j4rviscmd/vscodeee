/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { Event } from '../../../../base/common/event.js';

import './media/cursorAutoHide.css';

/**
 * Workbench contribution that automatically hides the mouse cursor after a
 * configurable period of inactivity. When the cursor is hidden, pointer-events
 * are suppressed on all child elements to prevent hover highlights (e.g. sash).
 * Any mouse activity restores the cursor; keyboard activity hides it immediately.
 */
export class CursorAutoHideController extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.cursorAutoHide';

	private _enabled: boolean = true;
	private _delay: number = 3000;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _isHidden: boolean = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// Listen for configuration changes
		const onDidChangeEnabled = Event.filter(
			configurationService.onDidChangeConfiguration,
			e => e.affectsConfiguration('vscodeee.cursorAutoHide.enabled')
		);
		onDidChangeEnabled(this._onDidChangeEnabled, this, this._store);

		const onDidChangeDelay = Event.filter(
			configurationService.onDidChangeConfiguration,
			e => e.affectsConfiguration('vscodeee.cursorAutoHide.delay')
		);
		onDidChangeDelay(this._onDidChangeDelay, this, this._store);

		// Initialize
		this._readConfiguration();
		this._setupListeners();
	}

	private _readConfiguration(): void {
		this._enabled = this.configurationService.getValue<boolean>('vscodeee.cursorAutoHide.enabled') ?? true;
		this._delay = this.configurationService.getValue<number>('vscodeee.cursorAutoHide.delay') ?? 3000;
	}

	private _onDidChangeEnabled(): void {
		this._enabled = this.configurationService.getValue<boolean>('vscodeee.cursorAutoHide.enabled') ?? true;
		if (!this._enabled) {
			this._showCursor();
			this._clearTimer();
		} else {
			this._resetTimer();
		}
	}

	private _onDidChangeDelay(): void {
		this._delay = this.configurationService.getValue<number>('vscodeee.cursorAutoHide.delay') ?? 3000;
		if (this._enabled) {
			this._resetTimer();
		}
	}

	private _setupListeners(): void {
		// Use document-level listeners with capture phase so they fire
		// even when pointer-events: none is applied to body
		const doc = mainWindow.document;

		this._store.add({
			dispose: () => {
				doc.removeEventListener('mousemove', this._onActivity, true);
				doc.removeEventListener('mousedown', this._onActivity, true);
				doc.removeEventListener('keydown', this._onKeyDown, true);
			}
		});

		doc.addEventListener('mousemove', this._onActivity, true);
		doc.addEventListener('mousedown', this._onActivity, true);
		doc.addEventListener('keydown', this._onKeyDown, true);

		// Start the timer if enabled
		if (this._enabled) {
			this._resetTimer();
		}
	}

	private readonly _onActivity = (e: globalThis.Event): void => {
		if (!this._enabled) {
			return;
		}
		const wasHidden = this._isHidden;
		this._showCursor();
		this._resetTimer();

		// If cursor was hidden and user clicked, re-dispatch the click
		// to the actual target element now that pointer-events is restored
		if (wasHidden && e.type === 'mousedown') {
			const mouseEvent = e as MouseEvent;
			const target = mainWindow.document.elementFromPoint(mouseEvent.clientX, mouseEvent.clientY);
			if (target) {
				const newEvent = new MouseEvent('mousedown', {
					bubbles: true,
					cancelable: true,
					clientX: mouseEvent.clientX,
					clientY: mouseEvent.clientY,
					button: mouseEvent.button,
					buttons: mouseEvent.buttons,
				});
				target.dispatchEvent(newEvent);
			}
		}
	};

	private readonly _onKeyDown = (): void => {
		if (!this._enabled) {
			return;
		}
		// On keydown, hide cursor immediately (user is typing)
		this._hideCursor();
		this._clearTimer();
	};

	private _resetTimer(): void {
		this._clearTimer();
		this._timer = setTimeout(() => {
			this._hideCursor();
		}, this._delay);
	}

	private _clearTimer(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _hideCursor(): void {
		if (!this._isHidden) {
			mainWindow.document.body.classList.add('cursor-auto-hidden');
			this._isHidden = true;
		}
	}

	private _showCursor(): void {
		if (this._isHidden) {
			mainWindow.document.body.classList.remove('cursor-auto-hidden');
			this._isHidden = false;
		}
	}

	override dispose(): void {
		this._clearTimer();
		this._showCursor();
		super.dispose();
	}
}
