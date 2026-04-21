/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IFileChange } from '../../../../platform/files/common/files.js';
import { AbstractUniversalWatcherClient, ILogMessage, IUniversalWatcher } from '../../../../platform/files/common/watcher.js';
import { TauriWatcher } from '../../../../platform/files/tauri-browser/tauriWatcher.js';

/**
 * Universal watcher client for the Tauri workbench.
 *
 * Extends `AbstractUniversalWatcherClient` which provides:
 * - Restart logic (up to 5 restarts on unrecoverable errors)
 * - Watch request management
 * - Verbose logging control
 *
 * Architecture mirrors the Electron `UniversalWatcherClient` which uses a
 * utility process. In Tauri, the watcher runs in-process via Rust `notify` crate,
 * so `createWatcher()` simply creates a `TauriWatcher` that bridges to Tauri IPC.
 */
export class TauriUniversalWatcherClient extends AbstractUniversalWatcherClient {

  constructor(
    onFileChanges: (changes: IFileChange[]) => void,
    onLogMessage: (msg: ILogMessage) => void,
    verboseLogging: boolean,
  ) {
    super(onFileChanges, onLogMessage, verboseLogging);

    this.init();
  }

  protected override createWatcher(disposables: DisposableStore): IUniversalWatcher {
    const watcher = disposables.add(new TauriWatcher());
    return watcher;
  }
}
