/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IFileChange, FileChangeType } from '../common/files.js';
import { coalesceEvents, ILogMessage, IUniversalWatcher, IUniversalWatchRequest, IWatcherErrorEvent } from '../common/watcher.js';
import { invoke, listen } from '../../tauri/common/tauriApi.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { normalizeNFC } from '../../../base/common/normalization.js';

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

  /**
   * Generates a unique string key for a watch request based on its path and recursiveness.
   * Used to deduplicate and diff watch requests during incremental updates.
   *
   * @param request - The watch request to generate a key for
   * @returns A composite key in the format `"path|recursive"`
   */
  private static toWatchKey(request: IUniversalWatchRequest): string {
    return `${request.path}|${request.recursive}`;
  }

  constructor() {
    super();

    this.setupEventListener();
  }

  /**
   * Subscribes to the Tauri event channel that the Rust backend emits file
   * changes on (`vscode:fs_change`). The unlisten handle is registered as
   * a disposable so it is cleaned up when this watcher is disposed.
   *
   * If the subscription fails (e.g. the Tauri event system is unavailable),
   * an error event is fired via {@link onDidError}.
   */
  private async setupEventListener(): Promise<void> {
    try {
      const unlisten = await listen<RawFileChange[]>('vscode:fs_change', (event) => {
        this.onRawFileChanges(event.payload);
      });
      this._register({ dispose: unlisten });
    } catch (err) {
      this._onDidError.fire({
        error: `Failed to setup Tauri file watcher event listener: ${err}`,
      });
    }
  }

  /**
   * Processes a batch of raw file change events received from the Rust `notify`
   * backend. Each raw change is converted to an {@link IFileChange}, coalesced
   * to eliminate redundant events, and then emitted via {@link onDidChangeFile}.
   *
   * On macOS, file paths are normalized to NFC form to handle HFS+ decomposition
   * differences between the Rust side and the VS Code side.
   *
   * When verbose logging is enabled, each individual change is traced through
   * {@link onDidLogMessage} before the batch is emitted.
   *
   * @param rawChanges - Array of raw change events from the Rust backend
   */
  private onRawFileChanges(rawChanges: RawFileChange[]): void {
    if (rawChanges.length === 0) {
      return;
    }

    const changes: IFileChange[] = rawChanges.map(raw => ({
      resource: URI.file(isMacintosh ? normalizeNFC(raw.resource) : raw.resource),
      type: this.toFileChangeType(raw.type),
      cId: raw.cId,
    }));

    const coalesced = coalesceEvents(changes);
    if (coalesced.length === 0) {
      return;
    }

    if (this.verboseLogging) {
      for (const change of coalesced) {
        this._onDidLogMessage.fire({
          type: 'trace',
          message: `[TauriWatcher] ${this.changeTypeToString(change.type)} ${change.resource.fsPath}`,
        });
      }
    }

    this._onDidChangeFile.fire(coalesced);
  }

  /**
   * Maps the numeric change kind from the Rust `notify` crate to VS Code's
   * {@link FileChangeType} enum.
   *
   * Mapping:
   * - `0` -> {@link FileChangeType.UPDATED}
   * - `1` -> {@link FileChangeType.ADDED}
   * - `2` -> {@link FileChangeType.DELETED}
   *
   * Unknown values default to {@link FileChangeType.UPDATED}.
   *
   * @param type - The numeric change kind from the Rust backend
   * @returns The corresponding VS Code file change type
   */
  private toFileChangeType(type: number): FileChangeType {
    switch (type) {
      case 0: return FileChangeType.UPDATED;
      case 1: return FileChangeType.ADDED;
      case 2: return FileChangeType.DELETED;
      default: return FileChangeType.UPDATED;
    }
  }

  /**
   * Converts a {@link FileChangeType} enum value to a human-readable string
   * for use in verbose log messages.
   *
   * @param type - The file change type to stringify
   * @returns A capitalized string representation (e.g. `"ADDED"`, `"DELETED"`, `"UPDATED"`)
   */
  private changeTypeToString(type: FileChangeType): string {
    switch (type) {
      case FileChangeType.ADDED: return 'ADDED';
      case FileChangeType.DELETED: return 'DELETED';
      case FileChangeType.UPDATED: return 'UPDATED';
    }
  }

  /**
   * Applies the given set of watch requests by computing an incremental diff
   * against the currently active watches. Watches that are no longer present
   * in `requests` are stopped, and new watches are started.
   *
   * This method is called by the watcher client whenever the set of watched
   * paths changes (e.g. when a workspace folder is opened or closed).
   *
   * @param requests - The complete set of watch requests that should be active
   *   after this call
   */
  async watch(requests: IUniversalWatchRequest[]): Promise<void> {
    // Compute the diff: what to stop, what to start
    const requestPaths = new Map<string, IUniversalWatchRequest>();

    for (const req of requests) {
      requestPaths.set(TauriWatcher.toWatchKey(req), req);
    }

    // Stop watches that are no longer needed
    const existingKeys = new Map<string, number>();
    for (const [id, watch] of this.activeWatches) {
      existingKeys.set(TauriWatcher.toWatchKey(watch), id);
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

  /**
   * Starts a single file watch by invoking the `fs_watch_start` Tauri command
   * in the Rust backend. On success, the watch is registered in
   * {@link activeWatches} for later tracking and cleanup.
   *
   * If the Rust backend fails to start the watch, an error log is emitted
   * via {@link onDidLogMessage} and an error event is fired via
   * {@link onDidError} so the watcher client can attempt recovery.
   *
   * @param request - The watch request describing the path, recursiveness,
   *   exclude patterns, and optional correlation ID
   */
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

  /**
   * Stops a single active watch by invoking the `fs_watch_stop` Tauri command
   * with the watch's numeric ID, then removes it from {@link activeWatches}.
   *
   * If the Rust backend fails to stop the watch, a warning is logged via
   * {@link onDidLogMessage} but no error event is fired, since a leaked
   * watcher on the Rust side is non-critical.
   *
   * @param id - The numeric ID of the watch to stop (as assigned by
   *   {@link startWatch})
   */
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

  /**
   * Enables or disables verbose trace-level logging for watch lifecycle events
   * (start, stop) and individual file change notifications.
   *
   * @param enabled - `true` to enable verbose logging, `false` to disable
   */
  async setVerboseLogging(enabled: boolean): Promise<void> {
    this.verboseLogging = enabled;
  }

  /**
   * Stops all active file watches by invoking the `fs_watch_stop_all` Tauri
   * command, then clears the local {@link activeWatches} map.
   *
   * Failure to stop all watches on the Rust side is silently ignored (best
   * effort), since the Rust backend will clean up watches when the Tauri
   * window is closed.
   */
  async stop(): Promise<void> {
    try {
      await invoke<void>('fs_watch_stop_all');
    } catch {
      // Best effort
    }

    this.activeWatches.clear();
  }

  /**
   * Disposes this watcher by stopping all active watches and releasing the
   * Tauri event listener. Called automatically when this instance is
   * registered with a {@link DisposableStore}.
   */
  override dispose(): void {
    this.stop();
    super.dispose();
  }
}
