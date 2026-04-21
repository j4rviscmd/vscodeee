/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dummy IPtyHostController for Tauri.
 *
 * In Tauri there is no separate pty host process — PTY management is handled
 * directly by the Rust backend. This controller satisfies the
 * BaseTerminalBackend constructor requirement while reporting the pty host
 * as always responsive.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { ITerminalProfile, type IPtyHostController, type IRequestResolveVariablesEvent } from '../../../../platform/terminal/common/terminal.js';

export class TauriPtyHostController implements IPtyHostController {
  // The pty host never exits in Tauri (Rust backend is always alive)
  private readonly _onPtyHostExit = new Emitter<number>();
  readonly onPtyHostExit: Event<number> = this._onPtyHostExit.event;

  // Fire once on construction to signal the pty host is ready
  private readonly _onPtyHostStart = new Emitter<void>();
  readonly onPtyHostStart: Event<void> = this._onPtyHostStart.event;

  // Never fires — the Rust backend is always responsive
  private readonly _onPtyHostUnresponsive = new Emitter<void>();
  readonly onPtyHostUnresponsive: Event<void> = this._onPtyHostUnresponsive.event;

  // Never fires — the Rust backend is always responsive
  private readonly _onPtyHostResponsive = new Emitter<void>();
  readonly onPtyHostResponsive: Event<void> = this._onPtyHostResponsive.event;

  // Variable resolution is handled differently in Tauri
  private readonly _onPtyHostRequestResolveVariables = new Emitter<IRequestResolveVariablesEvent>();
  readonly onPtyHostRequestResolveVariables: Event<IRequestResolveVariablesEvent> = this._onPtyHostRequestResolveVariables.event;

  constructor() {
    // Signal that the pty host is started (Rust backend is always ready)
    setTimeout(() => this._onPtyHostStart.fire(), 0);
  }

  async restartPtyHost(): Promise<void> {
    // No-op in Tauri — the Rust backend cannot be restarted independently.
    // Fire start event to satisfy any listeners expecting a restart cycle.
    this._onPtyHostStart.fire();
  }

  async acceptPtyHostResolvedVariables(_requestId: number, _resolved: string[]): Promise<void> {
    // No-op — variable resolution is not used via pty host in Tauri
  }

  async getProfiles(_workspaceId: string, _profiles: unknown, _defaultProfile: unknown, _includeDetectedProfiles?: boolean): Promise<ITerminalProfile[]> {
    // Profile detection is handled by the TauriTerminalBackend
    return [];
  }

  dispose(): void {
    this._onPtyHostExit.dispose();
    this._onPtyHostStart.dispose();
    this._onPtyHostUnresponsive.dispose();
    this._onPtyHostResponsive.dispose();
    this._onPtyHostRequestResolveVariables.dispose();
  }
}
