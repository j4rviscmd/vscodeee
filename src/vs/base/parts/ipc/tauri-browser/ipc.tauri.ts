/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri IPC transport layer.
 *
 * Implements VS Code's `IMessagePassingProtocol` over Tauri's `invoke` / `emit` / `listen`
 * using base64-encoded `VSBuffer` for full binary protocol compatibility.
 *
 * Architecture:
 *   WebView --invoke('ipc_message', {data})--> Rust backend
 *   WebView <--emit('vscode:ipc_message:{windowId}')-- Rust backend
 */

import { VSBuffer } from '../../../common/buffer.js';
import { Emitter, Event } from '../../../common/event.js';
import { Disposable } from '../../../common/lifecycle.js';
import { IMessagePassingProtocol, IPCClient } from '../common/ipc.js';
// TODO(Phase 2): Move tauriApi.ts from platform/ to base/ to fix layering violation
// eslint-disable-next-line local/code-import-patterns
import { invoke, listen, type UnlistenFn } from '../../../../platform/tauri/common/tauriApi.js';

/**
 * Implements `IMessagePassingProtocol` over Tauri IPC.
 *
 * Messages are base64-encoded VSBuffer payloads sent via:
 * - **send**: `invoke('ipc_message', { windowId, data: base64 })`
 * - **receive**: `listen('vscode:ipc_message:{windowId}', callback)`
 */
export class TauriMessagePassingProtocol extends Disposable implements IMessagePassingProtocol {

  private readonly _onMessage = this._register(new Emitter<VSBuffer>());
  readonly onMessage: Event<VSBuffer> = this._onMessage.event;

  private _unlisten: UnlistenFn | undefined;

  constructor(private readonly windowId: number) {
    super();

    this._startListening();
  }

  private _startListening(): void {
    listen<string>(`vscode:ipc_message:${this.windowId}`, (event) => {
      const buffer = VSBuffer.wrap(
        new Uint8Array(
          atob(event.payload)
            .split('')
            .map(c => c.charCodeAt(0)),
        ),
      );
      this._onMessage.fire(buffer);
    }).then(unlisten => {
      this._unlisten = unlisten;
    }).catch(err => {
      console.error('[TauriIPC] Failed to start listening:', err);
    });
  }

  send(buffer: VSBuffer): void {
    const bytes = buffer.buffer;
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    invoke('ipc_message', {
      windowId: this.windowId,
      data: base64,
    }).catch(err => {
      console.error('[TauriIPC] Failed to send message:', err);
    });
  }

  override dispose(): void {
    this._unlisten?.();
    super.dispose();
  }
}

/**
 * Tauri IPC client for the renderer process.
 *
 * Extends `IPCClient` (which internally creates a `ChannelClient` + `ChannelServer`)
 * using `TauriMessagePassingProtocol` as the transport.
 *
 * Usage:
 * ```ts
 * const client = new TauriIPCClient(windowId);
 * const channel = client.getChannel('nativeHost');
 * ```
 */
export class TauriIPCClient extends IPCClient {

  private readonly protocol: TauriMessagePassingProtocol;

  constructor(windowId: number) {
    const protocol = new TauriMessagePassingProtocol(windowId);
    super(protocol, `window:${windowId}`);
    this.protocol = protocol;
  }

  override dispose(): void {
    this.protocol.dispose();
    super.dispose();
  }
}
