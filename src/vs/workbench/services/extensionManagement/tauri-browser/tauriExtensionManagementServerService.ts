/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ExtensionInstallLocation, IExtensionManagementServer, IExtensionManagementServerService } from '../common/extensionManagement.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { Schemas } from '../../../../base/common/network.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtension } from '../../../../platform/extensions/common/extensions.js';
import { RemoteExtensionManagementService } from '../common/remoteExtensionManagementService.js';
import { TauriExtensionManagementService } from './tauriExtensionManagementService.js';

/**
 * Extension management server service for the Tauri desktop environment.
 *
 * Unlike the browser version, Tauri has a local Node.js process that can run
 * workspace-type extensions (like `vscode.git`). This service sets up a
 * `localExtensionManagementServer` backed by the web extension management
 * service, which ensures that:
 *
 * 1. Built-in extensions with `extensionKind: ['workspace']` are NOT disabled
 *    by `_isDisabledByExtensionKind()` in the enablement service.
 *    (Without `localExtensionManagementServer`, all built-in extensions get
 *    assigned to `webExtensionManagementServer`, causing workspace-type
 *    extensions to be disabled as "not supported in the web".)
 *
 * 2. `getExtensionInstallLocation()` returns `Local` for built-in extensions,
 *    matching the Desktop VS Code behavior.
 *
 * The key difference from the browser `ExtensionManagementServerService`:
 * - Browser: `localExtensionManagementServer = null`, `webExtensionManagementServer = non-null`
 * - Desktop: `localExtensionManagementServer = non-null`, `webExtensionManagementServer = null`
 * - Tauri:   `localExtensionManagementServer = non-null`, `webExtensionManagementServer = null`
 *
 * By setting `webExtensionManagementServer = null`, the `_isDisabledByExtensionKind()`
 * check in the enablement service skips entirely (the condition requires
 * `remoteExtensionManagementServer || webExtensionManagementServer`), which
 * means all extensions are enabled regardless of their extensionKind — matching
 * the Desktop behavior.
 */
export class TauriExtensionManagementServerService implements IExtensionManagementServerService {

	declare readonly _serviceBrand: undefined;

	readonly localExtensionManagementServer: IExtensionManagementServer | null;
	readonly remoteExtensionManagementServer: IExtensionManagementServer | null = null;
	readonly webExtensionManagementServer: IExtensionManagementServer | null = null;

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@ILabelService labelService: ILabelService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const remoteAgentConnection = remoteAgentService.getConnection();
		if (remoteAgentConnection) {
			const extensionManagementService = instantiationService.createInstance(RemoteExtensionManagementService, remoteAgentConnection.getChannel<IChannel>('extensions'));
			this.remoteExtensionManagementServer = {
				id: 'remote',
				extensionManagementService,
				get label() { return labelService.getHostLabel(Schemas.vscodeRemote, remoteAgentConnection.remoteAuthority) || localize('remote', "Remote"); },
			};
		}

		// In Tauri, we use TauriExtensionManagementService which overrides
		// getTargetPlatform() to return the native platform (e.g., darwin-arm64)
		// instead of TargetPlatform.WEB. This allows installing ALL extensions
		// from the gallery, not just web-compatible ones.
		const extensionManagementService = instantiationService.createInstance(TauriExtensionManagementService);
		this.localExtensionManagementServer = {
			id: 'local',
			extensionManagementService,
			label: localize('local', "Local"),
		};
	}

	getExtensionManagementServer(extension: IExtension): IExtensionManagementServer {
		if (extension.location.scheme === Schemas.vscodeRemote) {
			return this.remoteExtensionManagementServer!;
		}
		return this.localExtensionManagementServer!;
	}

	getExtensionInstallLocation(extension: IExtension): ExtensionInstallLocation | null {
		const server = this.getExtensionManagementServer(extension);
		if (server === this.remoteExtensionManagementServer) {
			return ExtensionInstallLocation.Remote;
		}
		return ExtensionInstallLocation.Local;
	}
}

registerSingleton(IExtensionManagementServerService, TauriExtensionManagementServerService, InstantiationType.Delayed);
