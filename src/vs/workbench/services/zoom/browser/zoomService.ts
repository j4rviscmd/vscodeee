/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService } from '../../layout/browser/layoutService.js';
import { getZoomLevel, setZoomFactor, setZoomLevel } from '../../../../base/browser/browser.js';
import { invoke } from '../../../../platform/tauri/common/tauriApi.js';
import { zoomLevelToZoomFactor } from '../../../../platform/window/common/window.js';
import { IWindowZoomService, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL } from '../common/zoom.js';

const ZOOM_PER_WINDOW_STORAGE_KEY = 'window.perWindowZoomLevel';

/**
 * Implementation of {@link IWindowZoomService} for the Tauri platform.
 *
 * Manages zoom state by reacting to configuration changes for `window.zoomLevel`
 * and `window.zoomPerWindow`. When per-window zoom is active, per-window zoom
 * levels are persisted to {@link ZOOM_PER_WINDOW_STORAGE_KEY} in application storage
 * so they survive restarts without polluting user settings.
 */
export class WindowZoomService extends Disposable implements IWindowZoomService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChangeZoom = this._register(new Emitter<void>());
  readonly onDidChangeZoom: Event<void> = this._onDidChangeZoom.event;

  private _configuredZoomLevel: number;

  constructor(
    @IConfigurationService private readonly configurationService: IConfigurationService,
    @IStorageService private readonly storageService: IStorageService,
    @IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
  ) {
    super();

    this._configuredZoomLevel = this.resolveConfiguredZoomLevel();

    this._register(configurationService.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('window.zoomLevel') || e.affectsConfiguration('window.zoomPerWindow')) {
        this._configuredZoomLevel = this.resolveConfiguredZoomLevel();
        let handled = false;

        if (e.affectsConfiguration('window.zoomLevel') && !this.zoomPerWindow) {
          this.applyConfiguredZoom();
          handled = true;
        }

        if (e.affectsConfiguration('window.zoomPerWindow') && !this.zoomPerWindow) {
          this.applyConfiguredZoom();
          this.storageService.remove(ZOOM_PER_WINDOW_STORAGE_KEY, StorageScope.APPLICATION);
          handled = true;
        }

        if (!handled) {
          this._onDidChangeZoom.fire();
        }
      }
    }));
  }

  get configuredZoomLevel(): number {
    return this._configuredZoomLevel;
  }

  get zoomPerWindow(): boolean {
    return this.configurationService.getValue<boolean>('window.zoomPerWindow') !== false;
  }

  getZoomLevel(): number {
    return getZoomLevel(mainWindow);
  }

  async applyZoomDelta(delta: number): Promise<void> {
    const currentLevel = this.zoomPerWindow ? getZoomLevel(mainWindow) : this._configuredZoomLevel;
    const newLevel = Math.round(currentLevel + delta);
    if (newLevel > MAX_ZOOM_LEVEL || newLevel < MIN_ZOOM_LEVEL) {
      return;
    }

    if (this.zoomPerWindow) {
      await this.applyZoom(newLevel);
      this.layoutService.layout();
      this.persistPerWindowZoom(newLevel);
      this._onDidChangeZoom.fire();
    } else {
      await this.configurationService.updateValue('window.zoomLevel', newLevel);
    }
  }

  async resetZoom(): Promise<void> {
    if (this.zoomPerWindow) {
      await this.applyZoom(this._configuredZoomLevel);
      this.layoutService.layout();
      this.storageService.remove(ZOOM_PER_WINDOW_STORAGE_KEY, StorageScope.APPLICATION);
      this._onDidChangeZoom.fire();
    } else {
      await this.configurationService.updateValue('window.zoomLevel', this._configuredZoomLevel);
    }
  }

  async restoreZoom(): Promise<void> {
    let targetLevel = this._configuredZoomLevel;
    let notify = false;

    if (this.zoomPerWindow) {
      const storedLevel = this.storageService.getNumber(ZOOM_PER_WINDOW_STORAGE_KEY, StorageScope.APPLICATION);
      if (typeof storedLevel === 'number' && storedLevel !== this._configuredZoomLevel) {
        targetLevel = storedLevel;
        notify = true;
      }
    }

    await this.applyZoom(targetLevel);
    this.layoutService.layout();
    if (notify) {
      this._onDidChangeZoom.fire();
    }
  }

  /** Resolve the current `window.zoomLevel` setting, defaulting to 0 if unset. */
  private resolveConfiguredZoomLevel(): number {
    const windowZoomLevel = this.configurationService.getValue<number>('window.zoomLevel');
    return typeof windowZoomLevel === 'number' ? windowZoomLevel : 0;
  }

  /** Apply the configured (global) zoom level and trigger a layout recalculation. */
  private async applyConfiguredZoom(): Promise<void> {
    await this.applyZoom(this._configuredZoomLevel);
    this.layoutService.layout();
    this._onDidChangeZoom.fire();
  }

  /**
   * Persist a per-window zoom level to application storage.
   *
   * If the given level matches the configured (global) zoom level, the storage
   * entry is removed to avoid redundancy.
   *
   * @param level - The per-window zoom level to persist.
   */
  private persistPerWindowZoom(level: number): void {
    if (level === this._configuredZoomLevel) {
      this.storageService.remove(ZOOM_PER_WINDOW_STORAGE_KEY, StorageScope.APPLICATION);
    } else {
      this.storageService.store(ZOOM_PER_WINDOW_STORAGE_KEY, level, StorageScope.APPLICATION, StorageTarget.MACHINE);
    }
  }

  /** Apply a zoom level to the main window via Tauri's native WebView zoom. */
  private async applyZoom(level: number): Promise<void> {
    const clampedLevel = Math.min(Math.max(level, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL);
    const factor = zoomLevelToZoomFactor(clampedLevel);

    await invoke('set_webview_zoom', { scaleFactor: factor });
    setZoomFactor(factor, mainWindow);
    setZoomLevel(clampedLevel, mainWindow);
  }
}
