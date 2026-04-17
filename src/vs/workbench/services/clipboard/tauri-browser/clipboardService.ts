/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { addDisposableListener, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';

/**
 * Tauri implementation of {@link IClipboardService}.
 *
 * Delegates system clipboard I/O (text, find text, image, paste trigger)
 * to {@link INativeHostService} (Rust backend via Tauri commands).
 * Manages typed text and resource URIs in-memory, consistent with
 * the browser implementation pattern.
 *
 * Typed clipboard text (keyed by MIME type) is stored in an internal map
 * and never written to the system clipboard, matching the behavior of the
 * browser-based clipboard service. Only untyped text writes reach the native
 * clipboard.
 *
 * Resource URIs are tracked in-memory and validated against a hash of the
 * current system clipboard content. If the system clipboard changes externally,
 * the in-memory resource list is automatically cleared.
 */
export class TauriClipboardService extends Disposable implements IClipboardService {

	declare readonly _serviceBrand: undefined;

	/** Maximum number of characters read from the system clipboard when computing the resource-state hash. */
	private static readonly MAX_RESOURCE_STATE_SOURCE_LENGTH = 1000;

	/** In-memory store for typed clipboard text (MIME type -> text content). */
	private readonly mapTextToType = new Map<string, string>();
	/** In-memory list of resource URIs currently held on the clipboard. */
	private resources: URI[] = [];
	/** Hash of the system clipboard content at the time resources were last written, used for staleness detection. */
	private resourcesStateHash: number | undefined = undefined;

	/**
	 * Creates a new {@link TauriClipboardService}.
	 *
	 * Registers a `copy` event listener on every window (including windows
	 * opened later) to invalidate the in-memory resource list whenever the
	 * user performs a copy operation outside of this service.
	 *
	 * @param nativeHostService - Tauri native host service for system clipboard access.
	 * @param logService - Logger for tracing clipboard operations.
	 */
	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._register(Event.runAndSubscribe(onDidRegisterWindow, ({ window, disposables }) => {
			disposables.add(addDisposableListener(window.document, 'copy', () => this.clearResourcesState()));
		}, { window: mainWindow, disposables: this._store }));
	}

	/** @inheritDoc IClipboardService.triggerPaste */
	triggerPaste(_targetWindowId: number): Promise<void> | undefined {
		// TODO(Phase 3): pass targetWindowId to nativeHostService once multi-window paste is supported
		this.logService.trace('TauriClipboardService#triggerPaste');
		return this.nativeHostService.triggerPaste();
	}

	/**
	 * Writes text to the clipboard.
	 *
	 * If a `type` is provided the text is stored in-memory only (typed
	 * clipboard slots are never flushed to the system clipboard). Otherwise
	 * the text is written to the native system clipboard via Tauri, and any
	 * previously stored resource URIs are cleared.
	 *
	 * @inheritDoc IClipboardService.writeText
	 */
	async writeText(text: string, type?: string): Promise<void> {
		this.logService.trace('TauriClipboardService#writeText, type:', type);
		this.clearResourcesState();

		if (type) {
			this.mapTextToType.set(type, text);
			return;
		}

		await this.nativeHostService.writeClipboardText(text);
	}

	/**
	 * Reads text from the clipboard.
	 *
	 * If a `type` is provided the value is read from the in-memory typed-text
	 * map. Otherwise the text is read from the native system clipboard via Tauri.
	 *
	 * @inheritDoc IClipboardService.readText
	 */
	async readText(type?: string): Promise<string> {
		this.logService.trace('TauriClipboardService#readText, type:', type);

		if (type) {
			return this.mapTextToType.get(type) || '';
		}

		return this.nativeHostService.readClipboardText();
	}

	/** @inheritDoc IClipboardService.readFindText */
	async readFindText(): Promise<string> {
		this.logService.trace('TauriClipboardService#readFindText');
		return this.nativeHostService.readClipboardFindText();
	}

	/** @inheritDoc IClipboardService.writeFindText */
	async writeFindText(text: string): Promise<void> {
		this.logService.trace('TauriClipboardService#writeFindText');
		await this.nativeHostService.writeClipboardFindText(text);
	}

	/**
	 * Stores resource URIs in-memory and snapshots the current system
	 * clipboard hash so that staleness can be detected later.
	 *
	 * Passing an empty array clears the in-memory resource state.
	 *
	 * @inheritDoc IClipboardService.writeResources
	 */
	async writeResources(resources: URI[]): Promise<void> {
		// TODO(Phase 2): write resources to system clipboard via native clipboard buffer
		if (resources.length === 0) {
			this.clearResourcesState();
		} else {
			this.resources = resources;
			this.resourcesStateHash = await this.computeResourcesStateHash();
		}
	}

	/**
	 * Returns the in-memory resource URIs after validating that the system
	 * clipboard has not changed since they were written.
	 *
	 * @inheritDoc IClipboardService.readResources
	 */
	async readResources(): Promise<URI[]> {
		await this.validateResourcesState();
		return this.resources;
	}

	/**
	 * Returns `true` if the in-memory resource list is non-empty and still
	 * consistent with the system clipboard content.
	 *
	 * @inheritDoc IClipboardService.hasResources
	 */
	async hasResources(): Promise<boolean> {
		await this.validateResourcesState();
		return this.resources.length > 0;
	}

	/**
	 * Recomputes the resource-state hash from the current system clipboard
	 * content and clears the in-memory resource list if the hash differs
	 * from the snapshot taken when resources were last written.
	 */
	private async validateResourcesState(): Promise<void> {
		const currentHash = await this.computeResourcesStateHash();
		if (this.resourcesStateHash !== currentHash) {
			this.clearResourcesState();
		}
	}

	/** @inheritDoc IClipboardService.clearInternalState */
	clearInternalState(): void {
		this.clearResourcesState();
	}

	/** @inheritDoc IClipboardService.readImage */
	async readImage(): Promise<Uint8Array> {
		this.logService.trace('TauriClipboardService#readImage');
		return this.nativeHostService.readImage();
	}

	/**
	 * Computes a hash of the current system clipboard text content,
	 * truncated to {@link MAX_RESOURCE_STATE_SOURCE_LENGTH} characters.
	 *
	 * Returns `undefined` when the in-memory resource list is empty.
	 */
	private async computeResourcesStateHash(): Promise<number | undefined> {
		if (this.resources.length === 0) {
			return undefined;
		}
		const clipboardText = await this.readText();
		return hash(clipboardText.substring(0, TauriClipboardService.MAX_RESOURCE_STATE_SOURCE_LENGTH));
	}

	/** Resets the in-memory resource list and its associated hash. */
	private clearResourcesState(): void {
		this.resources = [];
		this.resourcesStateHash = undefined;
	}
}

registerSingleton(IClipboardService, TauriClipboardService, InstantiationType.Delayed);
