/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri-specific workbench environment service.
 *
 * Extends `BrowserWorkbenchEnvironmentService` with Tauri-specific
 * configuration (window ID, resource paths, native host info).
 */

import { URI } from '../../../../base/common/uri.js';
import { memoize } from '../../../../base/common/decorators.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { BrowserWorkbenchEnvironmentService, IBrowserWorkbenchEnvironmentService } from '../browser/environmentService.js';
import { IWorkbenchConstructionOptions } from '../../../browser/web.api.js';

/**
 * Configuration provided by the Tauri backend at window startup.
 *
 * Populated via `invoke('get_window_configuration')` during bootstrap,
 * then passed into this service's constructor.
 */
export interface ITauriWindowConfiguration {
	readonly windowId: number;
	readonly logLevel: number;
	readonly resourceDir: string;
	readonly frontendDist: string;
	readonly homeDir?: string;
	readonly tmpDir?: string;
}

/**
 * Environment service for the Tauri workbench.
 *
 * Overrides filesystem-related URIs to point at real local paths
 * rather than the in-memory/virtual paths used by the pure browser version.
 */
export class TauriWorkbenchEnvironmentService extends BrowserWorkbenchEnvironmentService implements IBrowserWorkbenchEnvironmentService {

	constructor(
		private readonly tauriConfig: ITauriWindowConfiguration,
		workspaceId: string,
		logsHome: URI,
		options: IWorkbenchConstructionOptions,
		productService: IProductService
	) {
		super(workspaceId, logsHome, options, productService);
	}

	/**
	 * The Tauri window ID.
	 */
	get tauriWindowId(): number {
		return this.tauriConfig.windowId;
	}

	/**
	 * Path to the Tauri resource directory.
	 */
	@memoize
	get resourceDir(): string {
		return this.tauriConfig.resourceDir;
	}

	/**
	 * User's home directory (from Rust `dirs::home_dir()`).
	 */
	@memoize
	get userHome(): URI {
		if (this.tauriConfig.homeDir) {
			return URI.file(this.tauriConfig.homeDir);
		}
		return super.userRoamingDataHome;
	}
}
