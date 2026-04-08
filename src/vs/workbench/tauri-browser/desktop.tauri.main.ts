/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri workbench entry point — the Tauri equivalent of `desktop.main.ts`.
 *
 * Initializes core services and creates the Workbench.
 * This file mirrors Electron's `DesktopMain` but uses Tauri-specific services.
 */

import product from '../../platform/product/common/product.js';
import { Workbench } from '../browser/workbench.js';
import { domContentLoaded } from '../../base/browser/dom.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ILogService, ILoggerService, getLogLevel, ConsoleLogger } from '../../platform/log/common/log.js';
import { FileLoggerService } from '../../platform/log/common/fileLog.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceContextService, UNKNOWN_EMPTY_WINDOW_WORKSPACE } from '../../platform/workspace/common/workspace.js';
import { IWorkbenchConfigurationService } from '../services/configuration/common/configuration.js';
import { getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from '../services/workspaces/browser/workspaces.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { WorkspaceTrustEnablementService, WorkspaceTrustManagementService } from '../services/workspaces/common/workspaceTrust.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../platform/workspace/common/workspaceTrust.js';
import { INativeHostService } from '../../platform/native/common/native.js';
import { BrowserStorageService } from '../services/storage/browser/storageService.js';
import { IRemoteAgentService } from '../services/remote/common/remoteAgentService.js';
import { RemoteAgentService } from '../services/remote/browser/remoteAgentService.js';
import { IRemoteAuthorityResolverService } from '../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../platform/remote/browser/remoteAuthorityResolverService.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { SignService } from '../../platform/sign/browser/signService.js';
import { BrowserSocketFactory } from '../../platform/remote/browser/browserSocketFactory.js';
import { RemoteSocketFactoryService, IRemoteSocketFactoryService } from '../../platform/remote/common/remoteSocketFactoryService.js';
import { RemoteConnectionType } from '../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteFileSystemProviderClient } from '../services/remote/common/remoteFileSystemProviderClient.js';
import { URI } from '../../base/common/uri.js';
import { Schemas } from '../../base/common/network.js';
import { FileUserDataProvider } from '../../platform/userData/common/fileUserDataProvider.js';
import { TauriDiskFileSystemProvider } from '../services/files/tauri-browser/diskFileSystemProvider.js';
import { IUserDataProfilesService } from '../../platform/userDataProfile/common/userDataProfile.js';
import { BrowserUserDataProfilesService } from '../../platform/userDataProfile/browser/userDataProfile.js';
import { UserDataProfileService } from '../services/userDataProfile/common/userDataProfileService.js';
import { IUserDataProfileService } from '../services/userDataProfile/common/userDataProfile.js';
import { WorkspaceService } from '../services/configuration/browser/configurationService.js';
import { ConfigurationCache } from '../services/configuration/common/configurationCache.js';
import { IPolicyService, NullPolicyService } from '../../platform/policy/common/policy.js';
import { BufferLogger } from '../../platform/log/common/bufferLog.js';
import { LogService } from '../../platform/log/common/logService.js';
import { IDefaultAccountService } from '../../platform/defaultAccount/common/defaultAccount.js';
import { DefaultAccountService } from '../services/accounts/browser/defaultAccount.js';
import { ILoggerService } from '../../platform/log/common/log.js';
import { IRequestService } from '../../platform/request/common/request.js';
import { BrowserRequestService } from '../services/request/browser/requestService.js';
import { mainWindow } from '../../base/browser/window.js';

import { TauriIPCMainProcessService } from '../../platform/ipc/tauri-browser/mainProcessService.js';
import { TauriNativeHostService } from '../../platform/native/tauri-browser/nativeHostService.js';
import { TauriWorkbenchEnvironmentService, ITauriWindowConfiguration } from '../services/environment/tauri-browser/environmentService.js';
import { IBrowserWorkbenchEnvironmentService } from '../services/environment/browser/environmentService.js';
import { IWorkbenchConstructionOptions, IWorkspace, IWorkspaceProvider } from '../browser/web.api.js';
import { isFolderToOpen, isWorkspaceToOpen } from '../../platform/window/common/window.js';
import { invoke } from '../../platform/tauri/common/tauriApi.js';

export class TauriDesktopMain extends Disposable {

	private readonly workspace: IWorkspace;

	constructor(
		private readonly tauriConfig: ITauriWindowConfiguration,
		folderUri?: string,
		workspaceUri?: string
	) {
		super();

		// Determine initial workspace from URL query params
		if (folderUri) {
			this.workspace = { folderUri: URI.parse(folderUri) };
		} else if (workspaceUri) {
			this.workspace = { workspaceUri: URI.parse(workspaceUri) };
		} else {
			this.workspace = undefined;
		}
	}

	async open(): Promise<void> {

		// Init services and wait for DOM to be ready in parallel
		const [services] = await Promise.all([this.initServices(), domContentLoaded(mainWindow)]);

		// Create Workbench
		const workbench = new Workbench(mainWindow.document.body, {
			extraClasses: ['tauri']
		}, services.serviceCollection, services.logService);

		// Listeners
		this.registerListeners(workbench, services.storageService);

		// Startup
		workbench.startup();
	}

	private registerListeners(workbench: Workbench, storageService: BrowserStorageService): void {
		this._register(workbench.onWillShutdown(() => storageService.close()));
		this._register(workbench.onDidShutdown(() => this.dispose()));
	}

	private async initServices(): Promise<{ serviceCollection: ServiceCollection; logService: ILogService; storageService: BrowserStorageService }> {
		const serviceCollection = new ServiceCollection();

		// --- Product ---
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		serviceCollection.set(IProductService, productService);

		// --- Main Process (Tauri IPC) ---
		const mainProcessService = this._register(new TauriIPCMainProcessService(this.tauriConfig.windowId));
		serviceCollection.set(IMainProcessService, mainProcessService);

		// --- Environment ---
		const appDataDir = this.tauriConfig.appDataDir ?? this.tauriConfig.tmpDir ?? '/tmp';
		const logsHome = URI.file(`${appDataDir}/logs`);
		const workspaceId = 'tauri-default';

		// Workspace provider handles Open Folder / Open Workspace by reloading
		// the page with ?folder= or ?workspace= query params (same pattern as VS Code web).
		const workspaceProvider = new TauriWorkspaceProvider(this.workspace);
		const workbenchOptions: IWorkbenchConstructionOptions = {
			workspaceProvider,
		};

		const environmentService = new TauriWorkbenchEnvironmentService(
			this.tauriConfig,
			workspaceId,
			logsHome,
			workbenchOptions,
			productService,
		);
		serviceCollection.set(IBrowserWorkbenchEnvironmentService, environmentService);

		// --- Log ---

		// Files — needed before logger service
		const fileService = this._register(new FileService(new BufferLogger()));
		serviceCollection.set(IFileService, fileService);

		// Logger Service
		const loggerService = new FileLoggerService(getLogLevel(environmentService), logsHome, fileService);
		serviceCollection.set(ILoggerService, loggerService);

		// Log Service
		const consoleLogger = new ConsoleLogger(loggerService.getLogLevel());
		const bufferLogger = new BufferLogger();
		const logService = this._register(new LogService(bufferLogger, [consoleLogger]));
		serviceCollection.set(ILogService, logService);

		// --- Default Account ---
		const defaultAccountService = this._register(new DefaultAccountService(productService));
		serviceCollection.set(IDefaultAccountService, defaultAccountService);

		// --- Policy ---
		const policyService = new NullPolicyService();
		serviceCollection.set(IPolicyService, policyService);

		// --- NativeHost ---
		const nativeHostService = new TauriNativeHostService(this.tauriConfig.windowId);
		serviceCollection.set(INativeHostService, nativeHostService);

		// --- Sign ---
		const signService = new SignService(productService);
		serviceCollection.set(ISignService, signService);

		// Local files — real disk I/O via Rust Tauri commands
		const diskFileSystemProvider = this._register(new TauriDiskFileSystemProvider(logService));
		fileService.registerProvider(Schemas.file, diskFileSystemProvider);

		// URI Identity
		const uriIdentityService = new UriIdentityService(fileService);
		serviceCollection.set(IUriIdentityService, uriIdentityService);

		// --- User Data Profiles ---
		const userDataProfilesService = new BrowserUserDataProfilesService(environmentService, fileService, uriIdentityService, logService);
		serviceCollection.set(IUserDataProfilesService, userDataProfilesService);

		const userDataProfileService = new UserDataProfileService(userDataProfilesService.defaultProfile);
		serviceCollection.set(IUserDataProfileService, userDataProfileService);

		// User data provider — wraps the same disk provider for vscodeUserData scheme
		fileService.registerProvider(Schemas.vscodeUserData, this._register(new FileUserDataProvider(Schemas.file, diskFileSystemProvider, Schemas.vscodeUserData, userDataProfilesService, uriIdentityService, logService)));

		// --- Remote ---
		const remoteAuthorityResolverService = new RemoteAuthorityResolverService(false, undefined, undefined, undefined, productService, logService);
		serviceCollection.set(IRemoteAuthorityResolverService, remoteAuthorityResolverService);

		const remoteSocketFactoryService = new RemoteSocketFactoryService();
		remoteSocketFactoryService.register(RemoteConnectionType.WebSocket, new BrowserSocketFactory(null));
		serviceCollection.set(IRemoteSocketFactoryService, remoteSocketFactoryService);

		const remoteAgentService = this._register(new RemoteAgentService(remoteSocketFactoryService, userDataProfileService, environmentService, productService, remoteAuthorityResolverService, signService, logService));
		serviceCollection.set(IRemoteAgentService, remoteAgentService);

		this._register(RemoteFileSystemProviderClient.register(remoteAgentService, fileService, logService));

		// --- Configuration ---
		// Initialize workspace from the provider — folder, workspace file, or empty
		const workspace = this.resolveWorkspaceIdentifier();
		const configurationCache = new ConfigurationCache([Schemas.file, Schemas.vscodeUserData, Schemas.tmp], environmentService, fileService);
		const configurationService = new WorkspaceService(
			{ remoteAuthority: environmentService.remoteAuthority, configurationCache },
			environmentService,
			userDataProfileService,
			userDataProfilesService,
			fileService,
			remoteAgentService,
			uriIdentityService,
			logService,
			policyService,
		);
		await configurationService.initialize(workspace);
		serviceCollection.set(IWorkspaceContextService, configurationService);
		serviceCollection.set(IWorkbenchConfigurationService, configurationService);

		// --- Request ---
		const requestService = new BrowserRequestService(remoteAgentService, configurationService, loggerService);
		serviceCollection.set(IRequestService, requestService);

		// --- Storage ---
		const storageService = new BrowserStorageService(workspace, userDataProfileService, logService);
		await storageService.initialize();
		serviceCollection.set(IStorageService, storageService);

		// --- Workspace Trust ---
		const workspaceTrustEnablementService = new WorkspaceTrustEnablementService(configurationService, environmentService);
		serviceCollection.set(IWorkspaceTrustEnablementService, workspaceTrustEnablementService);

		const workspaceTrustManagementService = new WorkspaceTrustManagementService(configurationService, remoteAuthorityResolverService, storageService, uriIdentityService, environmentService, configurationService, workspaceTrustEnablementService, fileService);
		serviceCollection.set(IWorkspaceTrustManagementService, workspaceTrustManagementService);

		configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted());
		this._register(workspaceTrustManagementService.onDidChangeTrust(() => configurationService.updateWorkspaceTrust(workspaceTrustManagementService.isWorkspaceTrusted())));

		return { serviceCollection, logService, storageService };
	}

	private resolveWorkspaceIdentifier() {
		if (this.workspace && isFolderToOpen(this.workspace)) {
			return getSingleFolderWorkspaceIdentifier(this.workspace.folderUri);
		}
		if (this.workspace && isWorkspaceToOpen(this.workspace)) {
			return getWorkspaceIdentifier(this.workspace.workspaceUri);
		}
		return UNKNOWN_EMPTY_WINDOW_WORKSPACE;
	}
}

/**
 * Workspace provider for Tauri — handles Open Folder / Open Workspace
 * by reloading the page with ?folder= or ?workspace= query params.
 * Same pattern as VS Code web's `WorkspaceProvider`.
 */
class TauriWorkspaceProvider implements IWorkspaceProvider {

	private static readonly QUERY_PARAM_FOLDER = 'folder';
	private static readonly QUERY_PARAM_WORKSPACE = 'workspace';
	private static readonly QUERY_PARAM_EMPTY_WINDOW = 'ew';

	readonly trusted = true;
	readonly payload: object | undefined = undefined;

	constructor(readonly workspace: IWorkspace) { }

	async open(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): Promise<boolean> {
		if (options?.reuse && this.isSame(this.workspace, workspace)) {
			return true;
		}

		const targetHref = this.createTargetUrl(workspace);
		if (targetHref) {
			if (options?.reuse) {
				// Reuse current window: navigate to new URL
				mainWindow.location.href = targetHref;
				return true;
			} else {
				// Open a new Tauri window via Rust command
				let folderUri: string | undefined;
				if (workspace && isFolderToOpen(workspace)) {
					folderUri = workspace.folderUri.toString();
				}
				try {
					await invoke('open_new_window', {
						options: {
							folderUri,
							forceNewWindow: true,
						}
					});
					return true;
				} catch (err) {
					console.error('[TauriWorkspaceProvider] Failed to open new window:', err);
					return false;
				}
			}
		}

		return false;
	}

	private createTargetUrl(workspace: IWorkspace): string | undefined {
		const base = `${document.location.origin}${document.location.pathname}`;

		if (!workspace) {
			return `${base}?${TauriWorkspaceProvider.QUERY_PARAM_EMPTY_WINDOW}=true`;
		}

		if (isFolderToOpen(workspace)) {
			return `${base}?${TauriWorkspaceProvider.QUERY_PARAM_FOLDER}=${encodeURIComponent(workspace.folderUri.toString())}`;
		}

		if (isWorkspaceToOpen(workspace)) {
			return `${base}?${TauriWorkspaceProvider.QUERY_PARAM_WORKSPACE}=${encodeURIComponent(workspace.workspaceUri.toString())}`;
		}

		return undefined;
	}

	private isSame(a: IWorkspace, b: IWorkspace): boolean {
		if (!a || !b) {
			return a === b;
		}
		if (isFolderToOpen(a) && isFolderToOpen(b)) {
			return a.folderUri.toString() === b.folderUri.toString();
		}
		if (isWorkspaceToOpen(a) && isWorkspaceToOpen(b)) {
			return a.workspaceUri.toString() === b.workspaceUri.toString();
		}
		return false;
	}
}
