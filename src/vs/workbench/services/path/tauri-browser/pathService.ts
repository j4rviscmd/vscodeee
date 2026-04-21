/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { IPathService, AbstractPathService } from '../common/pathService.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { TauriWorkbenchEnvironmentService } from '../../environment/tauri-browser/environmentService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/**
 * Resolves the user home directory URI from the environment service.
 *
 * When the environment service is a {@link TauriWorkbenchEnvironmentService},
 * the real user home directory provided by the Rust backend (`dirs::home_dir`)
 * is returned directly. Otherwise falls back to `userRoamingDataHome`, which
 * is less accurate but always available.
 *
 * @param environmentService - The workbench environment service.
 * @returns The URI of the user home directory.
 */
function resolveUserHome(environmentService: IWorkbenchEnvironmentService): URI {
  // TauriWorkbenchEnvironmentService exposes the real user home from Rust (dirs::home_dir).
  if (environmentService instanceof TauriWorkbenchEnvironmentService) {
    return environmentService.userHome;
  }

  // Fallback: derive from userRoamingDataHome (less accurate but safe)
  return environmentService.userRoamingDataHome;
}

/**
 * Tauri-specific path service.
 *
 * Extends {@link AbstractPathService} with a user-home resolution strategy
 * that prefers the real home directory exposed by the Tauri Rust backend
 * over the generic browser fallback.
 *
 * Registered as a delayed singleton for {@link IPathService}.
 */
export class TauriPathService extends AbstractPathService {

  constructor(
    @IRemoteAgentService remoteAgentService: IRemoteAgentService,
    @IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
    @IWorkspaceContextService contextService: IWorkspaceContextService,
  ) {
    super(
      resolveUserHome(environmentService),
      remoteAgentService,
      environmentService,
      contextService,
    );
  }
}

registerSingleton(IPathService, TauriPathService, InstantiationType.Delayed);
