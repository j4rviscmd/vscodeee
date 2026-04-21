/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { TauriIPCClient } from '../../../base/parts/ipc/tauri-browser/ipc.tauri.js';
import { IMainProcessService } from '../common/mainProcessService.js';

/**
 * An implementation of `IMainProcessService` that leverages Tauri's IPC.
 *
 * Mirrors `ElectronIPCMainProcessService` but uses `TauriIPCClient` as the
 * transport instead of Electron's `ipcRenderer`.
 */
export class TauriIPCMainProcessService extends Disposable implements IMainProcessService {

  declare readonly _serviceBrand: undefined;

  private mainProcessConnection: TauriIPCClient;

  constructor(
    windowId: number,
  ) {
    super();

    this.mainProcessConnection = this._register(new TauriIPCClient(windowId));
  }

  getChannel(channelName: string): IChannel {
    return this.mainProcessConnection.getChannel(channelName);
  }

  registerChannel(channelName: string, channel: IServerChannel<string>): void {
    this.mainProcessConnection.registerChannel(channelName, channel);
  }
}
