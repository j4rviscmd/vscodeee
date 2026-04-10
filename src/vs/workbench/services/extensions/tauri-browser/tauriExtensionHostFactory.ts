/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IWorkbenchExtensionEnablementService } from '../../extensionManagement/common/extensionManagement.js';
import { IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IExtensionHostFactory } from '../common/abstractExtensionService.js';
import { ExtensionDescriptionRegistrySnapshot } from '../common/extensionDescriptionRegistry.js';
import { ExtensionHostKind } from '../common/extensionHostKind.js';
import { ExtensionRunningLocation, LocalProcessRunningLocation } from '../common/extensionRunningLocation.js';
import { ExtensionRunningLocationTracker, filterExtensionDescriptions } from '../common/extensionRunningLocationTracker.js';
import { ExtensionHostExtensions, ExtensionHostStartup, IExtensionHost } from '../common/extensions.js';
import { ExtensionsProposedApi } from '../common/extensionsProposedApi.js';
import { checkEnabledAndProposedAPI } from '../common/abstractExtensionService.js';
import { IRemoteExtensionHostDataProvider, IRemoteExtensionHostInitData, RemoteExtensionHost } from '../common/remoteExtensionHost.js';
import { IWebWorkerExtensionHostDataProvider, IWebWorkerExtensionHostInitData, WebWorkerExtensionHost } from '../browser/webWorkerExtensionHost.js';
import { TauriLocalProcessExtensionHost, ITauriLocalProcessExtensionHostDataProvider } from './tauriLocalProcessExtensionHost.js';

/**
 * Extension host factory for the Tauri desktop environment.
 *
 * Unlike BrowserExtensionHostFactory (which returns null for LocalProcess),
 * this factory creates TauriLocalProcessExtensionHost instances for
 * LocalProcess running locations.
 */
export class TauriExtensionHostFactory implements IExtensionHostFactory {

	constructor(
		private readonly _extensionsProposedApi: ExtensionsProposedApi,
		private readonly _scanWebExtensions: () => Promise<IExtensionDescription[]>,
		private readonly _getExtensionRegistrySnapshotWhenReady: () => Promise<ExtensionDescriptionRegistrySnapshot>,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IRemoteAuthorityResolverService private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IWorkbenchExtensionEnablementService private readonly _extensionEnablementService: IWorkbenchExtensionEnablementService,
		@ILogService private readonly _logService: ILogService,
	) { }

	/**
	 * Create an extension host for the given running location.
	 *
	 * Handles all three extension host kinds:
	 * - `LocalProcess` → {@link TauriLocalProcessExtensionHost} (Tauri-specific)
	 * - `LocalWebWorker` → {@link WebWorkerExtensionHost}
	 * - `Remote` → {@link RemoteExtensionHost}
	 *
	 * @returns The created extension host, or `null` if the kind is unsupported.
	 */
	createExtensionHost(runningLocations: ExtensionRunningLocationTracker, runningLocation: ExtensionRunningLocation, isInitialStart: boolean): IExtensionHost | null {
		switch (runningLocation.kind) {
			case ExtensionHostKind.LocalProcess: {
				if (!(runningLocation instanceof LocalProcessRunningLocation)) {
					return null;
				}
				return this._instantiationService.createInstance(
					TauriLocalProcessExtensionHost,
					runningLocation,
					this._createLocalProcessExtensionHostDataProvider(runningLocations, runningLocation, isInitialStart)
				);
			}
			case ExtensionHostKind.LocalWebWorker: {
				const startup = (
					isInitialStart
						? ExtensionHostStartup.EagerManualStart
						: ExtensionHostStartup.EagerAutoStart
				);
				return this._instantiationService.createInstance(
					WebWorkerExtensionHost,
					runningLocation,
					startup,
					this._createLocalWebWorkerExtensionHostDataProvider(runningLocations, runningLocation, isInitialStart)
				);
			}
			case ExtensionHostKind.Remote: {
				const remoteAgentConnection = this._remoteAgentService.getConnection();
				if (remoteAgentConnection) {
					return this._instantiationService.createInstance(
						RemoteExtensionHost,
						runningLocation,
						this._createRemoteExtensionHostDataProvider(runningLocations, remoteAgentConnection.remoteAuthority)
					);
				}
				return null;
			}
		}
	}

	/**
	 * Create a data provider that resolves the set of extensions to run in the
	 * local process extension host. Filters extensions by their computed running
	 * location to determine which ones belong to this host instance.
	 */
	private _createLocalProcessExtensionHostDataProvider(runningLocations: ExtensionRunningLocationTracker, desiredRunningLocation: ExtensionRunningLocation, isInitialStart: boolean): ITauriLocalProcessExtensionHostDataProvider {
		return {
			getInitData: async () => {
				if (isInitialStart) {
					const localExtensions = checkEnabledAndProposedAPI(this._logService, this._extensionEnablementService, this._extensionsProposedApi, await this._scanWebExtensions(), /* ignore workspace trust */true);
					const runningLocation = runningLocations.computeRunningLocation(localExtensions, [], false);
					const myExtensions = filterExtensionDescriptions(localExtensions, runningLocation, extRunningLocation => desiredRunningLocation.equals(extRunningLocation));
					const extensions = new ExtensionHostExtensions(0, localExtensions, myExtensions.map(extension => extension.identifier));
					return { extensions };
				} else {
					const snapshot = await this._getExtensionRegistrySnapshotWhenReady();
					const myExtensions = runningLocations.filterByRunningLocation(snapshot.extensions, desiredRunningLocation);
					const extensions = new ExtensionHostExtensions(snapshot.versionId, snapshot.extensions, myExtensions.map(extension => extension.identifier));
					return { extensions };
				}
			}
		};
	}

	private _createLocalWebWorkerExtensionHostDataProvider(runningLocations: ExtensionRunningLocationTracker, desiredRunningLocation: ExtensionRunningLocation, isInitialStart: boolean): IWebWorkerExtensionHostDataProvider {
		return {
			getInitData: async (): Promise<IWebWorkerExtensionHostInitData> => {
				if (isInitialStart) {
					const localExtensions = checkEnabledAndProposedAPI(this._logService, this._extensionEnablementService, this._extensionsProposedApi, await this._scanWebExtensions(), /* ignore workspace trust */true);
					const runningLocation = runningLocations.computeRunningLocation(localExtensions, [], false);
					const myExtensions = filterExtensionDescriptions(localExtensions, runningLocation, extRunningLocation => desiredRunningLocation.equals(extRunningLocation));
					const extensions = new ExtensionHostExtensions(0, localExtensions, myExtensions.map(extension => extension.identifier));
					return { extensions };
				} else {
					const snapshot = await this._getExtensionRegistrySnapshotWhenReady();
					const myExtensions = runningLocations.filterByRunningLocation(snapshot.extensions, desiredRunningLocation);
					const extensions = new ExtensionHostExtensions(snapshot.versionId, snapshot.extensions, myExtensions.map(extension => extension.identifier));
					return { extensions };
				}
			}
		};
	}

	private _createRemoteExtensionHostDataProvider(runningLocations: ExtensionRunningLocationTracker, remoteAuthority: string): IRemoteExtensionHostDataProvider {
		return {
			remoteAuthority: remoteAuthority,
			getInitData: async (): Promise<IRemoteExtensionHostInitData> => {
				const snapshot = await this._getExtensionRegistrySnapshotWhenReady();
				const remoteEnv = await this._remoteAgentService.getEnvironment();
				if (!remoteEnv) {
					throw new Error('Cannot provide init data for remote extension host!');
				}
				const myExtensions = runningLocations.filterByExtensionHostKind(snapshot.extensions, ExtensionHostKind.Remote);
				const extensions = new ExtensionHostExtensions(snapshot.versionId, snapshot.extensions, myExtensions.map(extension => extension.identifier));
				return {
					connectionData: this._remoteAuthorityResolverService.getConnectionData(remoteAuthority),
					pid: remoteEnv.pid,
					appRoot: remoteEnv.appRoot,
					extensionHostLogsPath: remoteEnv.extensionHostLogsPath,
					globalStorageHome: remoteEnv.globalStorageHome,
					workspaceStorageHome: remoteEnv.workspaceStorageHome,
					extensions,
				};
			}
		};
	}
}
