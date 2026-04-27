/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { setZoomFactor, setZoomLevel } from '../../../base/browser/browser.js';
import { mainWindow } from '../../../base/browser/window.js';
import { invoke } from '../../tauri/common/tauriApi.js';
import { zoomLevelToZoomFactor } from '../common/window.js';

/** Maximum allowed zoom level (inclusive). */
export const MAX_ZOOM_LEVEL = 8;
/** Minimum allowed zoom level (inclusive). */
export const MIN_ZOOM_LEVEL = -8;

/**
 * Apply a zoom level to the given window via Tauri's native WebView zoom.
 *
 * The requested zoom level is clamped to {@link MIN_ZOOM_LEVEL} and {@link MAX_ZOOM_LEVEL}
 * before being converted to a zoom factor and applied. This updates both the in-memory
 * WindowManager state and the native webview simultaneously.
 *
 * @param zoomLevel - The desired zoom level (integer). Will be clamped to the valid range.
 * @param targetWindow - The browser window to apply the zoom to. Defaults to the main window.
 * @returns A promise that resolves when the native zoom has been applied.
 */
export async function applyZoom(zoomLevel: number, targetWindow: Window = mainWindow): Promise<void> {
  const clampedLevel = Math.min(Math.max(zoomLevel, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL);
  const factor = zoomLevelToZoomFactor(clampedLevel);

  await invoke('set_webview_zoom', { scaleFactor: factor });
  setZoomFactor(factor, targetWindow);
  setZoomLevel(clampedLevel, targetWindow);
}
