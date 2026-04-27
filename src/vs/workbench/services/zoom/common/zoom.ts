/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Service identifier for {@link IWindowZoomService}. */
export const IWindowZoomService = createDecorator<IWindowZoomService>('windowZoomService');

/** Maximum allowed zoom level (inclusive). */
export const MAX_ZOOM_LEVEL = 8;
/** Minimum allowed zoom level (inclusive). */
export const MIN_ZOOM_LEVEL = -8;

/**
 * Service for managing window zoom levels in the workbench.
 *
 * Supports two modes controlled by the `window.zoomPerWindow` setting:
 * - **Global mode** (`zoomPerWindow = false`): Zoom changes are written to
 *   `window.zoomLevel` in user settings and apply to all windows.
 * - **Per-window mode** (`zoomPerWindow = true`): Zoom changes apply only to
 *   the current window and are persisted in application storage.
 */
export interface IWindowZoomService {
	readonly _serviceBrand: undefined;

	/** The configured (global) zoom level from window.zoomLevel setting. */
	readonly configuredZoomLevel: number;

	/** Whether per-window zoom is enabled. */
	readonly zoomPerWindow: boolean;

	/** Fires when the effective zoom changes (per-window or global). */
	readonly onDidChangeZoom: Event<void>;

	/** Get the current effective zoom level for the main window. */
	getZoomLevel(): number;

	/**
	 * Apply a zoom delta to the active window.
	 * When zoomPerWindow is true: applies in-memory only, persists to storage.
	 * When zoomPerWindow is false: writes to window.zoomLevel config.
	 */
	applyZoomDelta(delta: number): Promise<void>;

	/** Reset zoom to the configured level. */
	resetZoom(): Promise<void>;

	/** Restore persisted per-window zoom on startup. */
	restoreZoom(): Promise<void>;
}
