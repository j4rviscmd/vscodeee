/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri working copy backup service and tracker registration.
 *
 * Reuses `BrowserWorkingCopyBackupService` for the actual backup storage
 * (same file-based backup mechanism), but registers the Tauri-specific
 * `TauriWorkingCopyBackupTracker` which supports async save dialogs
 * during shutdown (instead of the browser's sync-only hot exit check).
 *
 * This module replaces `browser/workingCopyBackupService.js` in
 * `workbench.tauri.main.ts`.
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { WorkingCopyBackupService } from '../common/workingCopyBackupService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkingCopyBackupService } from '../common/workingCopyBackup.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { TauriWorkingCopyBackupTracker } from './workingCopyBackupTracker.js';

// TODO: Consider a Tauri-specific backup path in the future if needed.
// For now, the browser backup service uses the same userRoamingDataHome/Backups path.
export class TauriWorkingCopyBackupService extends WorkingCopyBackupService {

	constructor(
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService
	) {
		super(joinPath(environmentService.userRoamingDataHome, 'Backups', contextService.getWorkspace().id), fileService, logService);
	}
}

// Register Service
registerSingleton(IWorkingCopyBackupService, TauriWorkingCopyBackupService, InstantiationType.Eager);

// Register Backup Tracker (Tauri-specific, supports async save dialogs)
registerWorkbenchContribution2(TauriWorkingCopyBackupTracker.ID, TauriWorkingCopyBackupTracker, WorkbenchPhase.BlockStartup);
