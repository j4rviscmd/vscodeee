/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri lifecycle service — two-phase close handshake with full async veto.
 *
 * Extends {@link AbstractLifecycleService} directly (not BrowserLifecycleService)
 * because the browser version treats async vetos as errors and its critical
 * shutdown methods (`doShutdown`, `onUnload`) are `private`.
 *
 * ## Close handshake flow
 *
 * ```
 * OS Close Click
 *   → Rust CloseRequested: api.prevent_close() + emit_to(LIFECYCLE_CLOSE_REQUESTED)
 *   → TS handleCloseRequested()
 *     → fireBeforeShutdown() — async veto support (dirty file dialog, etc.)
 *       → If vetoed: invoke('lifecycle_close_vetoed') → window stays open
 *       → If not vetoed:
 *         → fire onWillShutdown (await all joiners)
 *         → storageService.flush(SHUTDOWN)
 *         → fire onDidShutdown
 *         → invoke('lifecycle_close_confirmed')
 *           → Rust: save session → unregister → window.destroy()
 * ```
 *
 * A 30-second Rust-side timeout acts as a safety net for unresponsive TS.
 *
 * NOTE: `withExpectedShutdown()` is implemented for compatibility with
 * `BrowserHostService` which casts `ILifecycleService` to
 * `BrowserLifecycleService` and calls this method directly.
 */

import { ShutdownReason, ILifecycleService, InternalBeforeShutdownEvent, StartupKind, WillShutdownJoinerOrder, IWillShutdownEventJoiner } from '../common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AbstractLifecycleService } from '../common/lifecycleService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { IStorageService, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { invoke, listen, UnlistenFn } from '../../../../platform/tauri/common/tauriApi.js';
import { localize } from '../../../../nls.js';

/**
 * Tauri-specific lifecycle service implementing the two-phase close handshake.
 *
 * Bridges Tauri's native `CloseRequested` event with VS Code's lifecycle
 * shutdown flow, supporting async veto (e.g., dirty-file save dialogs).
 * Registered as an eager singleton to override the default browser lifecycle.
 */
export class TauriLifecycleService extends AbstractLifecycleService {

  /** Disposable listener for the DOM `beforeunload` event (page-reload safety net). */
  private beforeUnloadListener: IDisposable | undefined;
  /** Unlisten handle for the Tauri `lifecycle:close-requested` event. */
  private tauriCloseListener: UnlistenFn | undefined;
  /** When `true`, the next `beforeunload` event is silently ignored (used by `withExpectedShutdown`). */
  private ignoreBeforeUnload = false;

  constructor(
    @ILogService logService: ILogService,
    @IStorageService storageService: IStorageService,
  ) {
    super(logService, storageService);

    this.registerListeners();
  }

  /**
	 * Registers both the Tauri close-requested listener (primary close path)
	 * and the DOM `beforeunload` listener (safety net for page reloads).
	 */
  private registerListeners(): void {

    // Listen for Tauri close-requested event from the Rust backend.
    // This is the primary close path — Rust has already called
    // api.prevent_close() and is waiting for our decision.
    //
    // Filter by window label: Tauri 2's listen() delivers events to all
    // windows by default, but each window should only act on its own
    // close request (e.g., closing an SSH window must not cascade to
    // the main window).
    const currentLabel = new URL(document.location.href).searchParams.get('windowLabel') ?? 'main';
    listen<{ window_id: number; label: string; reason?: string }>('vscodeee:lifecycle:close-requested', (event) => {
      if (event.payload.label !== currentLabel) {
        return; // Not our window — ignore
      }
      const reason = event.payload.reason === 'quit' ? ShutdownReason.QUIT : ShutdownReason.CLOSE;
      this.logService.info(`[lifecycle] Tauri close-requested received (window_id: ${event.payload.window_id}, label: ${event.payload.label}, reason: ${event.payload.reason ?? 'close'})`);
      this.handleCloseRequested(reason);
    }).then(unlisten => {
      this.tauriCloseListener = unlisten;
    });

    // Keep beforeunload as a safety net for page reloads only.
    // In Tauri, window close goes through the Rust handshake above.
    this.beforeUnloadListener = addDisposableListener(mainWindow, EventType.BEFORE_UNLOAD, (e: BeforeUnloadEvent) => this.onBeforeUnload(e));
  }

  /**
	 * Handles the DOM `beforeunload` event.
	 *
	 * In Tauri, this only fires on page reloads (not window close). If a
	 * shutdown is not already in progress, prevents the unload and shows a
	 * confirmation dialog to avoid accidental data loss.
	 *
	 * @param event - The browser `BeforeUnloadEvent`.
	 */
  private onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.ignoreBeforeUnload) {
      this.logService.info('[lifecycle] onBeforeUnload triggered but ignored once');
      this.ignoreBeforeUnload = false;
      return;
    }

    // In Tauri, beforeunload only fires on page reloads (not window
    // close, which is handled by the Rust handshake). Show a
    // confirmation dialog to prevent accidental data loss.
    if (!this._willShutdown) {
      this.logService.info('[lifecycle] onBeforeUnload triggered (page reload path)');
      event.preventDefault();
      event.returnValue = localize('lifecycleVeto', "Changes that you made may not be saved. Please check press 'Cancel' and try again.");
    }
  }

  // --- Two-phase close handshake ---

  /**
	 * Handles the Rust-side `lifecycle:close-requested` event.
	 *
	 * Orchestrates the two-phase close handshake:
	 * 1. Fires `onBeforeShutdown` and collects async vetos.
	 * 2. If vetoed, invokes `lifecycle_close_vetoed` to keep the window open.
	 * 3. If not vetoed, proceeds to {@link handleShutdown} for the full
	 *    shutdown sequence.
	 *
	 * Errors during the veto phase are treated as vetoes to prevent data loss.
	 *
	 * @param reason - The shutdown reason: CLOSE for individual window close,
	 *   QUIT for application-wide quit (affects dialog messages and Hot Exit).
	 */
  private async handleCloseRequested(reason: ShutdownReason = ShutdownReason.CLOSE): Promise<void> {
    if (this._willShutdown) {
      return; // already shutting down
    }

    try {
      const veto = await this.fireBeforeShutdown(reason);

      if (veto) {
        this.logService.info('[lifecycle] Close was vetoed — notifying Rust');
        this._onShutdownVeto.fire();
        await invoke('lifecycle_close_vetoed');
        return;
      }

      // No veto — proceed with shutdown
      await this.handleShutdown(reason);

    } catch (error) {
      // Unexpected error during veto handling — treat as veto
      // to keep the window open rather than losing data.
      this.logService.error('[lifecycle] Error during close handshake, treating as veto', error);
      this._onBeforeShutdownError.fire({
        reason,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this._onShutdownVeto.fire();
      try {
        await invoke('lifecycle_close_vetoed');
      } catch {
        // If even the veto invoke fails, Rust's 30s timeout
        // will eventually force-destroy the window.
      }
    }
  }

  /**
	 * Fires the `onBeforeShutdown` event and resolves all collected vetos.
	 *
	 * Supports both synchronous (`boolean`) and asynchronous (`Promise<boolean>`)
	 * vetos. A `finalVeto` callback runs after all regular vetos resolve,
	 * providing a last-chance opportunity to prevent shutdown.
	 *
	 * @param reason - The shutdown reason to include in the event.
	 * @returns `true` if any veto was raised (shutdown should be cancelled),
	 *          `false` if all vetos passed (shutdown may proceed).
	 */
  private async fireBeforeShutdown(reason: ShutdownReason): Promise<boolean> {
    const vetos: (boolean | Promise<boolean>)[] = [];
    let finalVetoFn: (() => boolean | Promise<boolean>) | undefined;
    let finalVetoId: string | undefined;

    this._onBeforeShutdown.fire({
      reason,
      veto(value: boolean | Promise<boolean>, id: string) {
        vetos.push(value);
        if (value === true) {
          // Log sync vetos immediately for diagnostics
        }
      },
      finalVeto(vetoFn: () => boolean | Promise<boolean>, id: string) {
        finalVetoFn = vetoFn;
        finalVetoId = id;
      },
    } satisfies InternalBeforeShutdownEvent);

    // Resolve all collected vetos (supports async Promise<boolean>)
    for (const veto of vetos) {
      try {
        const result = typeof veto === 'boolean' ? veto : await veto;
        if (result) {
          this.logService.info('[lifecycle] Shutdown vetoed during BeforeShutdown phase');
          return true;
        }
      } catch (error) {
        this.logService.error('[lifecycle] Error resolving veto', error);
        // Treat errors as veto to avoid data loss
        return true;
      }
    }

    // Run the final veto after all others have resolved
    if (finalVetoFn) {
      try {
        const finalResult = finalVetoFn();
        const result = typeof finalResult === 'boolean' ? finalResult : await finalResult;
        if (result) {
          this.logService.info(`[lifecycle] Shutdown vetoed by finalVeto (id: ${finalVetoId})`);
          return true;
        }
      } catch (error) {
        this.logService.error(`[lifecycle] Error in finalVeto (id: ${finalVetoId})`, error);
        return true;
      }
    }

    return false;
  }

  /**
	 * Executes the full shutdown sequence after veto checks pass.
	 *
	 * Steps performed in order:
	 * 1. Sets `_willShutdown` flag and disposes DOM listeners.
	 * 2. Fires `onWillShutdown` and awaits all default-order joiners.
	 * 3. Awaits last-order joiners (e.g., telemetry flush).
	 * 4. Flushes storage to persist any state written by joiners.
	 * 5. Fires `onDidShutdown` for final cleanup.
	 * 6. Invokes `lifecycle_close_confirmed` to tell Rust to destroy the window.
	 *
	 * @param reason - The shutdown reason propagated to event listeners.
	 */
  private async handleShutdown(reason: ShutdownReason): Promise<void> {
    this.logService.info('[lifecycle] Proceeding with shutdown');

    this._willShutdown = true;
    this.shutdownReason = reason;

    // Dispose DOM listeners — no longer needed
    this.beforeUnloadListener?.dispose();
    this.beforeUnloadListener = undefined;
    if (this.tauriCloseListener) {
      this.tauriCloseListener();
      this.tauriCloseListener = undefined;
    }

    // Fire onWillShutdown and await all joiners
    const cts = new CancellationTokenSource();
    const defaultJoiners: Promise<void>[] = [];
    const lastJoiners: (() => Promise<void>)[] = [];
    const pendingJoiners: IWillShutdownEventJoiner[] = [];

    this._onWillShutdown.fire({
      reason,
      token: cts.token,
      join(promiseOrFn: Promise<void> | (() => Promise<void>), joiner: IWillShutdownEventJoiner): void {
        if (joiner.order === WillShutdownJoinerOrder.Last) {
          lastJoiners.push(promiseOrFn as () => Promise<void>);
        } else {
          defaultJoiners.push(typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
        }
        pendingJoiners.push(joiner);
      },
      joiners: () => pendingJoiners,
      force: () => cts.cancel(),
    });

    // Await default-order joiners first
    try {
      await Promise.all(defaultJoiners);
    } catch (error) {
      this.logService.error('[lifecycle] Error in onWillShutdown default joiners', error);
    }

    // Then await last-order joiners
    for (const joinerFn of lastJoiners) {
      try {
        await joinerFn();
      } catch (error) {
        this.logService.error('[lifecycle] Error in onWillShutdown last joiner', error);
      }
    }

    // Flush storage AFTER all joiners (joiners may write to storage)
    try {
      await this.storageService.flush(WillSaveStateReason.SHUTDOWN);
    } catch (error) {
      this.logService.error('[lifecycle] Error flushing storage', error);
    }

    // Fire final event
    this._onDidShutdown.fire();

    // Tell Rust to save session, unregister, and destroy the window
    this.logService.info('[lifecycle] Invoking lifecycle_close_confirmed');
    try {
      await invoke('lifecycle_close_confirmed');
    } catch (error) {
      this.logService.error('[lifecycle] Error invoking lifecycle_close_confirmed', error);
    }
  }

  // --- Public API ---

  /**
	 * Programmatic shutdown (e.g., from reload or workspace switch).
	 */
  async shutdown(): Promise<void> {
    this.logService.info('[lifecycle] Programmatic shutdown triggered');

    // Dispose DOM listeners
    this.beforeUnloadListener?.dispose();
    this.beforeUnloadListener = undefined;
    if (this.tauriCloseListener) {
      this.tauriCloseListener();
      this.tauriCloseListener = undefined;
    }

    // Ensure UI state is persisted
    await this.storageService.flush(WillSaveStateReason.SHUTDOWN);

    // Fire shutdown events without veto support
    await this.handleShutdown(this.shutdownReason ?? ShutdownReason.QUIT);
  }

  /**
	 * Compatibility with `BrowserHostService` which casts `ILifecycleService`
	 * to `BrowserLifecycleService` and calls this method directly.
	 */
  withExpectedShutdown(reason: ShutdownReason): Promise<void>;
  withExpectedShutdown(reason: { disableShutdownHandling: true }, callback: Function): void;
  withExpectedShutdown(reason: ShutdownReason | { disableShutdownHandling: true }, callback?: Function): Promise<void> | void {
    if (typeof reason === 'number') {
      this.shutdownReason = reason;
      return this.storageService.flush(WillSaveStateReason.SHUTDOWN);
    } else {
      this.ignoreBeforeUnload = true;
      try {
        callback?.();
      } finally {
        this.ignoreBeforeUnload = false;
      }
    }
  }

  /**
	 * Resolves the startup kind by checking the Navigation Timing API.
	 *
	 * Falls back to detecting `PerformanceNavigationTiming.type === 'reload'`
	 * when the base class cannot determine the startup kind from storage.
	 *
	 * @returns The resolved {@link StartupKind}, or `undefined` if indeterminate.
	 */
  protected override doResolveStartupKind(): StartupKind | undefined {
    let startupKind = super.doResolveStartupKind();
    if (typeof startupKind !== 'number') {
      const timing = performance.getEntriesByType('navigation').at(0) as PerformanceNavigationTiming | undefined;
      if (timing?.type === 'reload') {
        startupKind = StartupKind.ReloadedWindow;
      }
    }
    return startupKind;
  }

  /** Disposes DOM and Tauri event listeners and calls the base class cleanup. */
  override dispose(): void {
    this.beforeUnloadListener?.dispose();
    if (this.tauriCloseListener) {
      this.tauriCloseListener();
    }
    super.dispose();
  }
}

// NOTE: This import MUST come after `workbench.common.main.js` which
// transitively registers `BrowserLifecycleService`. The last registration
// wins (Map.set semantics), so our Tauri service overrides the browser one.
registerSingleton(ILifecycleService, TauriLifecycleService, InstantiationType.Eager);
