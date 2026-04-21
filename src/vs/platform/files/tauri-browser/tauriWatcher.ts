/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IFileChange, FileChangeType } from '../common/files.js';
import { ILogMessage, IUniversalWatcher, IUniversalWatchRequest, IWatcherErrorEvent } from '../common/watcher.js';
import { invoke, listen } from '../../tauri/common/tauriApi.js';

/**
 * Raw file change event from the Rust `notify` crate, received via Tauri events.
 */
interface RawFileChange {
  readonly resource: string;
  readonly type: number;
  readonly cId?: number;
}

/**
 * File watcher that bridges Tauri's Rust `notify` crate to VS Code's watcher interfaces.
 *
 * Architecture:
 * ```
 * Rust (notify crate) → Tauri event ("vscode:fs_change") → TauriWatcher → IFileChange[]
 *                        Tauri invoke ("fs_watch_start/stop") ← TauriWatcher ← IUniversalWatchRequest[]
 * ```
 *
 * Each watch request is assigned a unique numeric ID used to correlate start/stop
 * commands with the Rust backend.
 */
export class TauriWatcher extends Disposable implements IUniversalWatcher {

  private readonly _onDidChangeFile = this._register(new Emitter<IFileChange[]>());
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private readonly _onDidLogMessage = this._register(new Emitter<ILogMessage>());
  readonly onDidLogMessage = this._onDidLogMessage.event;

  private readonly _onDidError = this._register(new Emitter<IWatcherErrorEvent>());
  readonly onDidError = this._onDidError.event;

  private readonly activeWatches = new Map<number, IUniversalWatchRequest>();
  private nextWatchId = 1;
  private verboseLogging = false;

  constructor() {
    super();

    this.setupEventListener();
  }

  private async setupEventListener(): Promise<void> {
    try {
      const unlisten = await listen<RawFileChange[]>('vscode:fs_change', (event) => {
        this.onRawFileChanges(event.payload);
      });
      this._register({ dispose: () => unlisten() });
    } catch (err) {
      this._onDidError.fire({
        error: `Failed to setup Tauri file watcher event listener: ${err}`,
      });
    }
  }

  private onRawFileChanges(rawChanges: RawFileChange[]): void {
    if (rawChanges.length === 0) {
      return;
    }

    const changes: IFileChange[] = rawChanges.map(raw => ({
      resource: URI.file(raw.resource),
      type: this.toFileChangeType(raw.type),
      cId: raw.cId,
    }));

    if (this.verboseLogging) {
      for (const change of changes) {
        this._onDidLogMessage.fire({
          type: 'trace',
          message: `[TauriWatcher] ${this.changeTypeToString(change.type)} ${change.resource.fsPath}`,
        });
      }
    }

    this._onDidChangeFile.fire(changes);
  }

  private toFileChangeType(type: number): FileChangeType {
    switch (type) {
      case 0: return FileChangeType.UPDATED;
      case 1: return FileChangeType.ADDED;
      case 2: return FileChangeType.DELETED;
      default: return FileChangeType.UPDATED;
    }
  }

  private changeTypeToString(type: FileChangeType): string {
    switch (type) {
      case FileChangeType.ADDED: return 'ADDED';
      case FileChangeType.DELETED: return 'DELETED';
      case FileChangeType.UPDATED: return 'UPDATED';
    }
  }

  async watch(requests: IUniversalWatchRequest[]): Promise<void> {
    // Compute the diff: what to stop, what to start
    const requestPaths = new Map<string, IUniversalWatchRequest>();

    for (const req of requests) {
      const key = `${req.path}|${req.recursive}`;
      requestPaths.set(key, req);
    }

    // Stop watches that are no longer needed
    const existingKeys = new Map<string, number>();
    for (const [id, watch] of this.activeWatches) {
      const key = `${watch.path}|${watch.recursive}`;
      existingKeys.set(key, id);
    }

    for (const [key, id] of existingKeys) {
      if (!requestPaths.has(key)) {
        await this.stopWatch(id);
      }
    }

    // Start new watches
    for (const [key, req] of requestPaths) {
      if (!existingKeys.has(key)) {
        await this.startWatch(req);
      }
    }
  }

  private async startWatch(request: IUniversalWatchRequest): Promise<void> {
    const id = this.nextWatchId++;

    try {
      await invoke<void>('fs_watch_start', {
        request: {
          id,
          path: request.path,
          recursive: request.recursive,
          excludes: request.excludes,
          correlationId: request.correlationId ?? null,
        },
      });

      this.activeWatches.set(id, request);

      if (this.verboseLogging) {
        this._onDidLogMessage.fire({
          type: 'trace',
          message: `[TauriWatcher] Started watching: ${request.path} (id=${id}, recursive=${request.recursive})`,
        });
      }
    } catch (err) {
      this._onDidLogMessage.fire({
        type: 'error',
        message: `[TauriWatcher] Failed to start watching ${request.path}: ${err}`,
      });

      this._onDidError.fire({
        error: String(err),
        request,
      });
    }
  }

  private async stopWatch(id: number): Promise<void> {
    const request = this.activeWatches.get(id);
    this.activeWatches.delete(id);

    try {
      await invoke<void>('fs_watch_stop', { id });

      if (this.verboseLogging && request) {
        this._onDidLogMessage.fire({
          type: 'trace',
          message: `[TauriWatcher] Stopped watching: ${request.path} (id=${id})`,
        });
      }
    } catch (err) {
      this._onDidLogMessage.fire({
        type: 'warn',
        message: `[TauriWatcher] Failed to stop watch ${id}: ${err}`,
      });
    }
  }

  async setVerboseLogging(enabled: boolean): Promise<void> {
    this.verboseLogging = enabled;
  }

  async stop(): Promise<void> {
    try {
      await invoke<void>('fs_watch_stop_all');
    } catch {
      // Best effort
    }

    this.activeWatches.clear();
  }

  override dispose(): void {
    this.stop();
    super.dispose();
  }
}
