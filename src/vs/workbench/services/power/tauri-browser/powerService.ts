/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IPowerService, PowerSaveBlockerType, SystemIdleState, ThermalState } from '../common/powerService.js';

/**
 * Tauri implementation of IPowerService.
 *
 * Delegates all power-related operations to {@link INativeHostService},
 * which already wires the Rust backend commands (`get_system_idle_state`,
 * `start_power_save_blocker`, etc.) and Tauri system events
 * (`vscodeee:system:suspend`, `vscodeee:system:battery-power-changed`, etc.).
 */
export class TauriPowerService extends Disposable implements IPowerService {

  declare readonly _serviceBrand: undefined;

  readonly onDidSuspend: Event<void>;
  readonly onDidResume: Event<void>;
  readonly onDidChangeOnBatteryPower: Event<boolean>;
  readonly onDidChangeThermalState: Event<ThermalState>;
  readonly onDidChangeSpeedLimit: Event<number>;
  readonly onWillShutdown: Event<void>;
  readonly onDidLockScreen: Event<void>;
  readonly onDidUnlockScreen: Event<void>;

  private readonly nativeHostService: INativeHostService;

  constructor(
    @INativeHostService nativeHostService: INativeHostService,
  ) {
    super();
    this.nativeHostService = nativeHostService;

    // Forward all events from INativeHostService
    this.onDidSuspend = nativeHostService.onDidSuspendOS;
    this.onDidResume = nativeHostService.onDidResumeOS as Event<void>;
    this.onDidChangeOnBatteryPower = nativeHostService.onDidChangeOnBatteryPower;
    this.onDidChangeThermalState = nativeHostService.onDidChangeThermalState;
    this.onDidChangeSpeedLimit = nativeHostService.onDidChangeSpeedLimit;
    this.onWillShutdown = nativeHostService.onWillShutdownOS;
    this.onDidLockScreen = nativeHostService.onDidLockScreen;
    this.onDidUnlockScreen = nativeHostService.onDidUnlockScreen;
  }

  getSystemIdleState(idleThreshold: number): Promise<SystemIdleState> {
    return this.nativeHostService.getSystemIdleState(idleThreshold);
  }

  getSystemIdleTime(): Promise<number> {
    return this.nativeHostService.getSystemIdleTime();
  }

  getCurrentThermalState(): Promise<ThermalState> {
    return this.nativeHostService.getCurrentThermalState();
  }

  isOnBatteryPower(): Promise<boolean> {
    return this.nativeHostService.isOnBatteryPower();
  }

  startPowerSaveBlocker(type: PowerSaveBlockerType): Promise<number> {
    return this.nativeHostService.startPowerSaveBlocker(type);
  }

  stopPowerSaveBlocker(id: number): Promise<boolean> {
    return this.nativeHostService.stopPowerSaveBlocker(id);
  }

  isPowerSaveBlockerStarted(id: number): Promise<boolean> {
    return this.nativeHostService.isPowerSaveBlockerStarted(id);
  }
}

registerSingleton(IPowerService, TauriPowerService, InstantiationType.Delayed);
