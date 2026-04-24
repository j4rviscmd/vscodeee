/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IUpdateService, IUpdate, State, StateType, UpdateType, DisablementReason } from '../../../../platform/update/common/update.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { invoke, createChannel } from '../../../../platform/tauri/common/tauriApi.js';

// -- Types matching the Rust `commands/updater/commands.rs` structs ---------

/**
 * Update metadata returned by the Rust updater backend.
 *
 * Mirrors the `UpdateInfo` struct in `commands/updater/commands.rs`.
 * Only `version` and `currentVersion` are guaranteed; `date` and `body`
 * are populated from the release notes payload when available.
 */
interface UpdateInfo {
  /** Semver string of the available update (e.g. `"1.95.0"`). */
  version: string;
  /** Semver string of the currently running version. */
  currentVersion: string;
  /** ISO-8601 release date of the update, if provided by the endpoint. */
  date?: string;
  /** Markdown release notes body, if provided by the endpoint. */
  body?: string;
}

/**
 * Byte-level download progress event emitted over a Tauri {@link Channel}
 * during `download_and_install`.
 *
 * The `phase` field indicates the lifecycle stage:
 * - `'started'` — the download has begun (`downloadedBytes` is `0`).
 * - `'progress'` — intermediate progress (`totalBytes` may be `undefined` when
 *   the server does not advertise a `Content-Length`).
 * - `'finished'` — the download is complete; `downloadedBytes` equals the
 *   final size.
 */
interface DownloadProgress {
  /** Current lifecycle phase of the download operation. */
  phase: 'started' | 'progress' | 'finished';
  /** Number of bytes received so far. */
  downloadedBytes: number;
  /** Total expected size in bytes. `undefined` when the server omits `Content-Length`. */
  totalBytes?: number;
}

// -- Service ----------------------------------------------------------------

/**
 * Tauri-native implementation of [`IUpdateService`].
 *
 * TypeScript owns the 11-state discriminated-union state machine; Rust
 * provides the capability layer (check / download / restart). This keeps
 * `update.mode` configuration, periodic scheduling, and UI orchestration
 * in the same layer that already houses VS Code's settings infrastructure.
 *
 * **Enable logic**:
 * - Production builds (`!isDev`): updater is always enabled on startup.
 * - Development builds (`isDev`): updater is gated by the `update.enabled`
 *   boolean setting (default `false`). Set to `true` to test update behavior.
 *
 * Both environments respect `update.mode` (none/manual/start/default) once
 * the updater is enabled.
 */
export class TauriUpdateService extends Disposable implements IUpdateService {

  declare readonly _serviceBrand: undefined;

  /** Emitter that fires whenever the update state machine transitions. */
  private _onStateChange = this._register(new Emitter<State>());
  /** Event listeners can subscribe here to observe state transitions. */
  readonly onStateChange: Event<State> = this._onStateChange.event;

  /** Backing field for the {@link state} property. Defaults to `Disabled(NotBuilt)`. */
  private _state: State = State.Disabled(DisablementReason.NotBuilt);
  /**
   * Current state of the update state machine.
   *
   * Setting this property fires the {@link onStateChange} event, allowing
   * UI components and other services to react to transitions.
   */
  get state(): State { return this._state; }
  set state(state: State) {
    this._state = state;
    this._onStateChange.fire(state);
  }

  /**
   * Cached update metadata from the most recent successful check.
   *
   * Populated by {@link checkForUpdates} when the Rust backend reports an
   * available update. Consumed by {@link downloadUpdate}, {@link applyUpdate},
   * and {@link quitAndInstall} to avoid redundant IPC calls.
   */
  private cachedUpdateInfo: UpdateInfo | undefined;

  /** Handle for the periodic background-check `setTimeout` timer. */
  private periodicCheckTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Disposable wrapper for the periodic check timer.
   *
   * Automatically cleaned up when this service is disposed, ensuring no
   * orphaned timers survive after the service lifecycle ends.
   */
  private readonly periodicCheckDisposable = this._register(new MutableDisposable());

  constructor(
    @IConfigurationService private readonly configurationService: IConfigurationService,
    @ILogService private readonly logService: ILogService,
  ) {
    super();

    // Listen for configuration changes.
    this._register(this.configurationService.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('update.mode')) {
        this.onModeChange();
      }
      if (e.affectsConfiguration('update.enabled')) {
        this.onEnabledChange();
      }
    }));

    // Async-initialize: determine dev/production, then decide enablement.
    this.initializeUpdater();
  }

  /**
	 * Determine whether the updater should be enabled, then start it.
	 *
	 * - Production builds: always enabled.
	 * - Development builds: enabled only when `update.enabled` is `true`.
	 */
  private async initializeUpdater(): Promise<void> {
    try {
      const isDev = await invoke<boolean>('is_dev_build');
      const enabled = isDev
        ? this.configurationService.getValue<boolean>('update.enabled')
        : true;

      if (!enabled) {
        this.logService.info('Updater disabled (dev build, update.enabled=false).');
        this.state = State.Disabled(DisablementReason.DisabledByEnvironment);
        return;
      }

      this.logService.info(`Updater enabled (isDev=${isDev}).`);
      this.initializeFromConfig();
    } catch (err) {
      this.logService.error(`Failed to initialize updater: ${String(err)}`);
      this.state = State.Disabled(DisablementReason.NotBuilt);
    }
  }

  /**
	 * Read `update.mode` and set the initial state accordingly.
	 * Called once at startup (if enabled) and again on `update.mode` changes.
	 */
  private initializeFromConfig(): void {
    const mode = this.getUpdateMode();
    if (mode === 'none') {
      this.state = State.Disabled(DisablementReason.ManuallyDisabled);
      return;
    }
    this.state = State.Idle(UpdateType.Archive);
    if (mode === 'start' || mode === 'default') {
      this.checkForUpdates(false);
    }
    if (mode === 'default') {
      this.schedulePeriodicCheck();
    }
  }

  /**
	 * Respond to `update.enabled` setting changes in dev builds.
	 * Toggling from false→true activates the updater; true→false disables it.
	 */
  private async onEnabledChange(): Promise<void> {
    let isDev: boolean;
    try {
      isDev = await invoke<boolean>('is_dev_build');
    } catch {
      return;
    }
    if (!isDev) {
      return; // Production builds ignore update.enabled.
    }

    const enabled = this.configurationService.getValue<boolean>('update.enabled');
    if (enabled && this._state.type === StateType.Disabled) {
      this.logService.info('update.enabled changed to true — activating updater.');
      this.initializeFromConfig();
    } else if (!enabled && this._state.type !== StateType.Disabled) {
      this.logService.info('update.enabled changed to false — disabling updater.');
      this.clearPeriodicCheck();
      this.state = State.Disabled(DisablementReason.DisabledByEnvironment);
    }
  }

  /**
	 * Respond to `update.mode` configuration changes.
	 *
	 * - `none`: disables the updater and clears periodic checks.
	 * - Transitioning from disabled to any other mode: re-enables and
	 *   triggers an immediate check.
	 * - `default`: enables periodic background checks (6-hour interval).
	 * - Other modes: clears periodic checks but keeps the updater active.
	 */
  private onModeChange(): void {
    const mode = this.getUpdateMode();

    if (mode === 'none') {
      this.state = State.Disabled(DisablementReason.ManuallyDisabled);
      this.clearPeriodicCheck();
      return;
    }

    // Re-enable from disabled state.
    if (this._state.type === StateType.Disabled) {
      this.state = State.Idle(UpdateType.Archive);
      this.checkForUpdates(false);
    }

    if (mode === 'default') {
      this.schedulePeriodicCheck();
    } else {
      this.clearPeriodicCheck();
    }
  }

  // -- IUpdateService methods ------------------------------------------

  /**
	 * Check the configured endpoint for an available update.
	 *
	 * Transitions to {@link StateType.CheckingForUpdates}, then either
	 * {@link StateType.AvailableForDownload} (if a newer version exists)
	 * or back to {@link StateType.Idle}. No-op when the current state is
	 * not {@link StateType.Idle}.
	 *
	 * @param explicit - `true` when the user manually triggered the check,
	 *                   `false` for automatic/scheduled checks.
	 */
  async checkForUpdates(explicit: boolean): Promise<void> {
    // Only Idle state allows a new check.
    if (this._state.type !== StateType.Idle) {
      return;
    }

    this.state = State.CheckingForUpdates(explicit);

    try {
      const update = await invoke<UpdateInfo | null>('updater_check_for_updates');

      if (update) {
        this.cachedUpdateInfo = update;
        this.logService.info(`Update available: ${update.version}`);
        this.state = State.AvailableForDownload(this.mapToUpdate(update));
        // Auto-download for background checks (start and default modes).
        if (!explicit) {
          this.downloadUpdate(false);
        }
      } else {
        this.state = State.Idle(UpdateType.Archive, undefined, explicit ? false : undefined);
      }
    } catch (err) {
      this.logService.error(`Update check failed: ${String(err)}`);
      this.state = State.Idle(UpdateType.Archive, String(err));
    }
  }

  /**
	 * Download and stage the pending update, streaming progress to the state machine.
	 *
	 * Opens a Tauri {@link Channel} to receive byte-level progress events from
	 * Rust and translates each into a {@link StateType.Downloading} state update.
	 * On success the update is staged and the state transitions to
	 * {@link StateType.Ready}; on failure it rolls back to
	 * {@link StateType.AvailableForDownload} so the user can retry.
	 *
	 * No-op unless the current state is {@link StateType.AvailableForDownload}
	 * and a cached update info is available.
	 *
	 * @param explicit - `true` when the user explicitly requested the download.
	 */
  async downloadUpdate(explicit: boolean): Promise<void> {
    if (!this.cachedUpdateInfo || this._state.type !== StateType.AvailableForDownload) {
      return;
    }

    const update = this.mapToUpdate(this.cachedUpdateInfo);
    const startTime = Date.now();

    this.state = State.Downloading(update, explicit, false, 0, undefined, startTime);

    const channel = createChannel<DownloadProgress>((progress: DownloadProgress) => {
      if (this._state.type !== StateType.Downloading) {
        return;
      }
      this.state = State.Downloading(
        this._state.update,
        this._state.explicit,
        this._state.overwrite,
        progress.phase === 'finished' ? this._state.downloadedBytes : progress.downloadedBytes,
        progress.totalBytes,
        this._state.startTime,
      );
    });

    try {
      await invoke('updater_download_and_install', { onProgress: channel });
      // Tauri updater stages the update; restart applies it.
      this.state = State.Ready(update, explicit, false);
    } catch (err) {
      this.logService.error(`Update download failed: ${String(err)}`);
      // Go back to AvailableForDownload so the user can retry.
      this.state = State.AvailableForDownload(update);
    }
  }

  /**
	 * Transition from {@link StateType.Downloaded} to {@link StateType.Ready}.
	 *
	 * In the Tauri updater flow the download and install steps are combined
	 * (`download_and_install` stages the update automatically), so this method
	 * only advances the state machine. No-op unless the current state is
	 * {@link StateType.Downloaded}.
	 */
  async applyUpdate(): Promise<void> {
    // Tauri updater combines download + install; the update is already
    // staged after downloadAndInstall. Transition directly to Ready.
    if (this._state.type === StateType.Downloaded) {
      this.state = State.Ready(this._state.update, this._state.explicit, this._state.overwrite);
    }
  }

  /**
	 * Persist the current session and restart the application to apply the staged update.
	 *
	 * Transitions to {@link StateType.Restarting}, then invokes the Rust
	 * `updater_restart_and_update` command. On failure, rolls back to
	 * {@link StateType.Ready} so the user can retry.
	 */
  async quitAndInstall(): Promise<void> {
    if (!this.cachedUpdateInfo) {
      return;
    }

    this.state = State.Restarting(this.mapToUpdate(this.cachedUpdateInfo));

    try {
      await invoke('updater_restart_and_update');
    } catch (err) {
      this.logService.error(`Restart for update failed: ${String(err)}`);
      // Go back to Ready so the user can try again.
      this.state = State.Ready(this.mapToUpdate(this.cachedUpdateInfo), true, false);
    }
  }

  /**
	 * Check whether the running version is the latest available.
	 *
	 * @returns `true` when no update is available, `false` when an update
	 *          exists, or `undefined` when the updater is disabled or the
	 *          check fails.
	 */
  async isLatestVersion(): Promise<boolean | undefined> {
    if (this._state.type === StateType.Disabled) {
      return undefined;
    }

    try {
      const update = await invoke<UpdateInfo | null>('updater_check_for_updates');
      this.cachedUpdateInfo = update ?? undefined;
      return update === null;
    } catch {
      return undefined;
    }
  }

  /**
	 * Not applicable in Tauri — updates are fetched from the configured endpoint,
	 * not from a local package path.
	 */
  async _applySpecificUpdate(_packagePath: string): Promise<void> {
    // Not applicable in Tauri — updates come from the configured endpoint.
  }

  /** Not applicable in Tauri. */
  async setInternalOrg(_internalOrg: string | undefined): Promise<void> {
    // Not applicable in Tauri.
  }

  // -- Helpers ---------------------------------------------------------

  /** Read the current `update.mode` configuration value. */
  private getUpdateMode(): 'none' | 'manual' | 'start' | 'default' {
    return this.configurationService.getValue<'none' | 'manual' | 'start' | 'default'>('update.mode');
  }

  /** Map the Rust `UpdateInfo` struct to the platform-level {@link IUpdate} interface. */
  private mapToUpdate(info: UpdateInfo): IUpdate {
    return {
      version: info.version,
      productVersion: info.version,
    };
  }

  /**
	 * Schedule automatic update checks on a 6-hour interval.
	 *
	 * Each tick verifies that `update.mode` is still `default` before
	 * checking, and re-schedules itself. The timer is tracked via
	 * {@link periodicCheckDisposable} for cleanup on dispose.
	 */
  private schedulePeriodicCheck(): void {
    this.clearPeriodicCheck();
    const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

    const check = async () => {
      // Guard: only proceed if the user hasn't switched away from 'default'
      // mode since the timer was scheduled.
      if (this.getUpdateMode() === 'default') {
        await this.checkForUpdates(false);
      }
      // Re-schedule regardless — the next tick will re-evaluate the mode.
      this.periodicCheckTimer = setTimeout(check, CHECK_INTERVAL);
    };

    this.periodicCheckTimer = setTimeout(check, CHECK_INTERVAL);
    this.periodicCheckDisposable.value = { dispose: () => this.clearPeriodicCheck() };
  }

  /** Clear the periodic check timer, if one is active. */
  private clearPeriodicCheck(): void {
    clearTimeout(this.periodicCheckTimer);
    this.periodicCheckTimer = undefined;
  }
}

// Register as an eager singleton so the updater is initialized at startup
// regardless of whether any consumer has injected IUpdateService yet.
// This ensures the initial update check fires immediately when `update.mode`
// is `start` or `default`.
registerSingleton(IUpdateService, TauriUpdateService, InstantiationType.Eager);
