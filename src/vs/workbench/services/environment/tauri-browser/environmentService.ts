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
	readonly appDataDir: string;
	readonly homeDir?: string;
	readonly tmpDir?: string;
	readonly windowLabel?: string;
}

/**
 * Environment service for the Tauri workbench.
 *
 * Overrides filesystem-related URIs to point at real local paths
 * rather than the in-memory/virtual paths used by the pure browser version.
 *
 * Path layout follows native VS Code conventions:
 *   appDataDir/User/           — user settings, keybindings, snippets
 *   appDataDir/User/globalStorage/ — global state
 *   appDataDir/User/workspaceStorage/ — workspace state
 *   appDataDir/logs/           — log files
 *   appDataDir/CachedData/     — cached data
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
	override get userHome(): URI {
		if (this.tauriConfig.homeDir) {
			return URI.file(this.tauriConfig.homeDir);
		}
		return super.userRoamingDataHome;
	}

	/**
	 * User roaming data home — where settings, keybindings, snippets live.
	 * e.g., `~/Library/Application Support/vscodeee/User` on macOS.
	 */
	@memoize
	override get userRoamingDataHome(): URI {
		return URI.file(`${this.tauriConfig.appDataDir}/User`);
	}

	/**
	 * Cache home directory.
	 */
	@memoize
	override get cacheHome(): URI {
		return URI.file(`${this.tauriConfig.appDataDir}/CachedData`);
	}

	/**
	 * Workspace storage home — per-workspace state.
	 */
	@memoize
	override get workspaceStorageHome(): URI {
		return URI.file(`${this.tauriConfig.appDataDir}/User/workspaceStorage`);
	}

	/**
	 * Local history home.
	 */
	@memoize
	override get localHistoryHome(): URI {
		return URI.file(`${this.tauriConfig.appDataDir}/User/History`);
	}

	/**
	 * State resource — global persistent state.
	 */
	@memoize
	override get stateResource(): URI {
		return URI.file(`${this.tauriConfig.appDataDir}/User/globalStorage/state.vscdb`);
	}
}
