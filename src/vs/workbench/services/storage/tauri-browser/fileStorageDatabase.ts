/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageDatabase, IStorageItemsChangeEvent, IUpdateRequest } from '../../../../base/parts/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { invoke, listen } from '../../../../platform/tauri/common/tauriApi.js';

/**
 * File-based storage database using Tauri's native filesystem.
 *
 * Replaces `IndexedDBStorageDatabase` for the Tauri desktop build.
 * State is persisted as JSON files on disk via `storage_write_atomic`
 * (write-to-temp + rename), guaranteeing atomicity on POSIX systems.
 *
 * Cross-window synchronization:
 *   After each disk write, the Rust backend emits a `vscode:storage_changed`
 *   event.  Other windows listen for it, reload the file from disk, diff
 *   against their in-memory cache, and fire `onDidChangeItemsExternal` so
 *   the VS Code `Storage` layer can update listeners (e.g. the "Open Recent"
 *   workspace list).
 *
 * File layout:
 *   APPLICATION: {appDataDir}/User/globalStorage/state.json
 *   PROFILE:     {profile.globalStorageHome}/state.json
 *   WORKSPACE:   {workspaceStorageHome}/{workspaceId}/state.json
 */
export class TauriFileStorageDatabase extends Disposable implements IStorageDatabase {

  private readonly _onDidChangeItemsExternal = this._register(new Emitter<IStorageItemsChangeEvent>());
  readonly onDidChangeItemsExternal = this._onDidChangeItemsExternal.event;

  private cache: Map<string, string> | undefined;
  private pendingUpdate: Promise<void> | undefined;
  get hasPendingUpdate(): boolean { return !!this.pendingUpdate; }

  constructor(
    private readonly filePath: string,
    @ILogService private readonly logService: ILogService,
  ) {
    super();
    this.registerListeners();
  }

  private registerListeners(): void {
    // Listen for storage changes from other windows.
    // The Rust `storage_write_atomic` command emits this event after
    // successfully writing the file to disk.
    listen<string>('vscode:storage_changed', async (event) => {
      if (event.payload !== this.filePath) {
        return;
      }
      await this.handleExternalChange();
    }).then(unlisten => {
      this._register({ dispose: unlisten });
    }).catch(err => {
      this.logService.warn('[TauriFileStorage] Failed to register cross-window listener:', err);
    });
  }

  private async handleExternalChange(): Promise<void> {
    // Wait for any in-flight write to complete before reading,
    // to avoid overwriting cache with stale disk data while a
    // write based on the old cache is still in progress.
    if (this.pendingUpdate) {
      await this.pendingUpdate.catch(() => { });
    }

    const oldCache = this.cache ? new Map(this.cache) : undefined;
    if (!oldCache) {
      return; // cache not yet initialized; getItems() will read fresh
    }

    try {
      const raw = await invoke<string>('storage_read_text_file', { path: this.filePath });
      if (!raw) {
        return;
      }
      const data = JSON.parse(raw) as Record<string, string>;
      this.cache = new Map(Object.entries(data));
    } catch (error) {
      this.logService.warn('[TauriFileStorage] Failed to reload on external change:', error);
      return;
    }

    // Diff old vs new cache to find changed and deleted items
    const changed = new Map<string, string>();
    const deleted = new Set<string>();

    this.cache.forEach((value, key) => {
      if (oldCache.get(key) !== value) {
        changed.set(key, value);
      }
    });

    oldCache.forEach((_, key) => {
      if (!this.cache!.has(key)) {
        deleted.add(key);
      }
    });

    if (changed.size > 0 || deleted.size > 0) {
      this.logService.trace(`[TauriFileStorage] External change: ${changed.size} changed, ${deleted.size} deleted`);
      this._onDidChangeItemsExternal.fire({ changed, deleted });
    }
  }

  private async fileExists(): Promise<boolean> {
    try {
      await invoke<string>('storage_read_text_file', { path: this.filePath });
      return true;
    } catch {
      return false;
    }
  }

  async getItems(): Promise<Map<string, string>> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await invoke<string>('storage_read_text_file', { path: this.filePath });
      if (raw) {
        const data = JSON.parse(raw) as Record<string, string>;
        this.cache = new Map(Object.entries(data));
        this.logService.info(`[TauriFileStorage] Loaded ${this.cache.size} items from ${this.filePath}`);
      } else {
        this.cache = new Map();
        this.logService.info(`[TauriFileStorage] Empty file at ${this.filePath}`);
      }
    } catch (error) {
      // Distinguish "file not found" (expected on first launch) from
      // "corrupted JSON" (data loss risk — warn, don't silently reset).
      const fileExists = await this.fileExists();
      if (fileExists) {
        this.logService.warn(`[TauriFileStorage] Corrupted state file at ${this.filePath} (${error}), resetting.`);
      } else {
        this.logService.info(`[TauriFileStorage] No existing state file at ${this.filePath}, starting fresh.`);
      }
      this.cache = new Map();
    }

    return this.cache;
  }

  async updateItems(request: IUpdateRequest): Promise<void> {
    this.pendingUpdate = this.doUpdateItems(request);
    try {
      await this.pendingUpdate;
    } finally {
      this.pendingUpdate = undefined;
    }
  }

  private async doUpdateItems(request: IUpdateRequest): Promise<void> {
    if (!this.cache) {
      await this.getItems();
    }

    const cache = this.cache!;

    let hasChanges = false;

    if (request.insert) {
      for (const [key, value] of request.insert) {
        cache.set(key, value);
        hasChanges = true;
      }
    }

    if (request.delete) {
      for (const key of request.delete) {
        if (cache.delete(key)) {
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      await this.flushToDisk();
    }
  }

  private async flushToDisk(): Promise<void> {
    const data: Record<string, string> = {};
    this.cache!.forEach((value, key) => { data[key] = value; });

    try {
      await invoke<void>('storage_write_atomic', {
        path: this.filePath,
        content: JSON.stringify(data),
      });
      this.logService.info(`[TauriFileStorage] Wrote ${this.cache!.size} items to ${this.filePath}`);
    } catch (error) {
      this.logService.error(`[TauriFileStorage] Failed to write state to ${this.filePath}:`, error);
      throw error;
    }
  }

  async optimize(): Promise<void> {
    // No-op for file-based storage
  }

  async close(recovery?: () => Map<string, string>): Promise<void> {
    // Wait for any pending update to finish
    if (this.pendingUpdate) {
      try {
        await this.pendingUpdate;
      } catch {
        // Best effort — try recovery callback to preserve data
        if (recovery) {
          const recoveredCache = recovery();
          if (recoveredCache && recoveredCache.size > 0) {
            this.logService.warn(`[TauriFileStorage] Pending update failed, writing ${recoveredCache.size} recovered items via recovery callback`);
            this.cache = recoveredCache;
            try {
              const data: Record<string, string> = {};
              recoveredCache.forEach((value, key) => { data[key] = value; });
              await invoke<void>('storage_write_atomic', {
                path: this.filePath,
                content: JSON.stringify(data),
              });
            } catch (recoveryError) {
              this.logService.error('[TauriFileStorage] Recovery write also failed:', recoveryError);
            }
          }
        }
      }
    }
  }

  async clear(): Promise<void> {
    this.cache = new Map();
    try {
      await invoke<void>('storage_write_atomic', {
        path: this.filePath,
        content: '{}',
      });
    } catch (error) {
      this.logService.error(`[TauriFileStorage] Failed to clear state at ${this.filePath}:`, error);
    }
  }
}
