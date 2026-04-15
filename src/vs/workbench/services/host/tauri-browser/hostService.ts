/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserHostService } from '../browser/browserHostService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IHostService } from '../browser/host.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from '../../lifecycle/browser/lifecycleService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';

// NOTE: This import MUST come after `workbench.common.main.js` which
// transitively registers `BrowserHostService`. The last registration
// wins (Map.set semantics), so our Tauri service overrides the browser one.
import '../browser/browserHostService.js';

/**
 * Workbench host service for the Tauri platform.
 *
 * Extends {@link BrowserHostService} and overrides methods that should
 * delegate to {@link INativeHostService} for proper native OS behavior
 * instead of using browser/DOM APIs:
 *
 * - {@link toggleFullScreen}: uses native window fullscreen instead of the DOM Fullscreen API
 * - {@link moveTop}: brings the window to front via the native API
 * - {@link restart}: relaunches the entire application (not just a WebView reload)
 *
 * Registered as a delayed singleton so that it overrides the browser
 * implementation loaded by `workbench.common.main.js`.
 */
export class TauriHostService extends BrowserHostService {

	constructor(
		@ILayoutService layoutService: ILayoutService,
		@IConfigurationService configurationService: IConfigurationService,
		@IFileService fileService: IFileService,
		@ILabelService labelService: ILabelService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService logService: ILogService,
		@IDialogService dialogService: IDialogService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super(
			layoutService, configurationService, fileService, labelService,
			environmentService, instantiationService, lifecycleService as unknown as BrowserLifecycleService,
			logService, dialogService, contextService, userDataProfilesService
		);
	}

	/**
	 * Toggles the native window fullscreen state.
	 *
	 * Overrides the browser implementation which uses the DOM Fullscreen API,
	 * delegating instead to the native Tauri window API for correct desktop
	 * fullscreen behavior (e.g. macOS Space management).
	 */
	override async toggleFullScreen(_targetWindow: Window): Promise<void> {
		return this.nativeHostService.toggleFullScreen();
	}

	/**
	 * Brings the application window to the front of the OS window stack.
	 *
	 * Overrides the browser implementation which uses `window.focus()`,
	 * delegating instead to the native Tauri API for reliable window raising
	 * across all desktop platforms.
	 */
	override async moveTop(_targetWindow: Window): Promise<void> {
		return this.nativeHostService.moveWindowTop();
	}

	/**
	 * Relaunches the entire application.
	 *
	 * Overrides the browser implementation which would only reload the WebView,
	 * delegating instead to the native Tauri relaunch API to restart the full
	 * native process (equivalent to quitting and re-opening the app).
	 */
	override async restart(): Promise<void> {
		return this.nativeHostService.relaunch();
	}
}

registerSingleton(IHostService, TauriHostService, InstantiationType.Delayed);
