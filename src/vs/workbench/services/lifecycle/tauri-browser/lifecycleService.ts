/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri-specific lifecycle service.
 *
 * Extends the browser lifecycle service with Tauri window close event
 * handling. In Tauri, the Rust backend controls the window lifecycle,
 * so we listen for Tauri-specific close events instead of relying
 * solely on browser `beforeunload`.
 */

import { BrowserLifecycleService } from '../browser/lifecycleService.js';
import { ILifecycleService } from '../common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

export class TauriLifecycleService extends BrowserLifecycleService {

	constructor(
		@ILogService logService: ILogService,
		@IStorageService storageService: IStorageService,
	) {
		super(logService, storageService);
	}
}

registerSingleton(ILifecycleService, TauriLifecycleService, InstantiationType.Eager);
