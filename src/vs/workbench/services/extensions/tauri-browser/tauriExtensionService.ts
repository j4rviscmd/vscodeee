/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Schemas } from '../../../../base/common/network.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IBuiltinExtensionsScannerService, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAutomatedWindow, getLogs } from '../../../../platform/log/browser/log.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IRemoteAuthorityResolverService, RemoteAuthorityResolverError, ResolverResult } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteExtensionsScannerService } from '../../../../platform/remote/common/remoteExtensionsScanner.js';
import { getRemoteName } from '../../../../platform/remote/common/remoteHosts.js';
import { localize } from '../../../../nls.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IWebExtensionsScannerService, IWorkbenchExtensionEnablementService, IWorkbenchExtensionManagementService } from '../../extensionManagement/common/extensionManagement.js';
import { FetchFileSystemProvider } from '../browser/webWorkerFileSystemProvider.js';
import { AbstractExtensionService, LocalExtensions, RemoteExtensions, ResolvedExtensions, ResolverExtensions, isResolverExtension } from '../common/abstractExtensionService.js';
import { ExtensionHostKind } from '../common/extensionHostKind.js';
import { IExtensionManifestPropertiesService } from '../common/extensionManifestPropertiesService.js';
import { IExtensionService, toExtensionDescription } from '../common/extensions.js';
import { ExtensionsProposedApi } from '../common/extensionsProposedApi.js';
import { dedupExtensions } from '../common/extensionsUtil.js';
import { ILifecycleService, LifecyclePhase } from '../../lifecycle/common/lifecycle.js';
import { IRemoteAgentService } from '../../remote/common/remoteAgentService.js';
import { IRemoteExplorerService } from '../../remote/common/remoteExplorerService.js';
import { IUserDataInitializationService } from '../../userData/browser/userDataInit.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { AsyncIterableEmitter, AsyncIterableProducer } from '../../../../base/common/async.js';
import { TauriExtensionHostFactory } from './tauriExtensionHostFactory.js';
import { TauriExtensionHostKindPicker } from './tauriExtensionHostKindPicker.js';

/**
 * Extension service for the Tauri desktop environment.
 *
 * Extends AbstractExtensionService with `{ hasLocalProcess: true }` to enable
 * routing extensions to TauriLocalProcessExtensionHost via the Rust WS relay.
 */
export class TauriExtensionService extends AbstractExtensionService implements IExtensionService {

  /**
   * Creates a new {@link TauriExtensionService} instance.
   *
   * Configures the extension host factory to route extensions through the Tauri
   * LocalProcess extension host (Rust WS relay). Registers fetch-based file
   * system providers for HTTP/HTTPS schemes and schedules initialization on
   * {@link LifecyclePhase.Ready}.
   */
  constructor(
    @IInstantiationService instantiationService: IInstantiationService,
    @INotificationService notificationService: INotificationService,
    @IBrowserWorkbenchEnvironmentService private readonly _browserEnvironmentService: IBrowserWorkbenchEnvironmentService,
    @ITelemetryService telemetryService: ITelemetryService,
    @IWorkbenchExtensionEnablementService extensionEnablementService: IWorkbenchExtensionEnablementService,
    @IFileService fileService: IFileService,
    @IProductService productService: IProductService,
    @IWorkbenchExtensionManagementService extensionManagementService: IWorkbenchExtensionManagementService,
    @IWorkspaceContextService contextService: IWorkspaceContextService,
    @IConfigurationService configurationService: IConfigurationService,
    @IExtensionManifestPropertiesService extensionManifestPropertiesService: IExtensionManifestPropertiesService,
    @IWebExtensionsScannerService private readonly _webExtensionsScannerService: IWebExtensionsScannerService,
    @ILogService logService: ILogService,
    @IRemoteAgentService remoteAgentService: IRemoteAgentService,
    @IRemoteExtensionsScannerService remoteExtensionsScannerService: IRemoteExtensionsScannerService,
    @ILifecycleService lifecycleService: ILifecycleService,
    @IRemoteAuthorityResolverService remoteAuthorityResolverService: IRemoteAuthorityResolverService,
    @IUserDataInitializationService private readonly _userDataInitializationService: IUserDataInitializationService,
    @IUserDataProfileService private readonly _userDataProfileService: IUserDataProfileService,
    @IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
    @IRemoteExplorerService private readonly _remoteExplorerService: IRemoteExplorerService,
    @IDialogService dialogService: IDialogService,
    @IBuiltinExtensionsScannerService private readonly _builtinExtensionsScannerService: IBuiltinExtensionsScannerService,
  ) {
    const extensionsProposedApi = instantiationService.createInstance(ExtensionsProposedApi);
    const extensionHostFactory = new TauriExtensionHostFactory(
      extensionsProposedApi,
      () => this._scanWebExtensions(),
      () => this._getExtensionRegistrySnapshotWhenReady(),
      instantiationService,
      remoteAgentService,
      remoteAuthorityResolverService,
      extensionEnablementService,
      logService,
    );
    super(
      // hasLocalProcess: true — enables LocalProcess extension host routing
      { hasLocalProcess: true, allowRemoteExtensionsInLocalWebWorker: true },
      extensionsProposedApi,
      extensionHostFactory,
      new TauriExtensionHostKindPicker(logService),
      instantiationService,
      notificationService,
      _browserEnvironmentService,
      telemetryService,
      extensionEnablementService,
      fileService,
      productService,
      extensionManagementService,
      contextService,
      configurationService,
      extensionManifestPropertiesService,
      logService,
      remoteAgentService,
      remoteExtensionsScannerService,
      lifecycleService,
      remoteAuthorityResolverService,
      dialogService,
    );

    lifecycleService.when(LifecyclePhase.Ready).then(async () => {
      await this._initializeIfNeeded();
    });

    this._initFetchFileSystem();
  }

  /**
	 * Register HTTP/HTTPS fetch-based file system providers for loading
	 * remote extension resources.
	 */
  private _initFetchFileSystem(): void {
    const provider = new FetchFileSystemProvider();
    this._register(this._fileService.registerProvider(Schemas.http, provider));
    this._register(this._fileService.registerProvider(Schemas.https, provider));
  }

  /**
   * Initialize the extension service.
   *
   * Ensures user-data installed extensions are initialized before delegating
   * to the base class initialization which starts extension hosts and resolves
   * extensions.
   */
  protected override async _initialize(): Promise<void> {
    await this._userDataInitializationService.initializeInstalledExtensions(this._instantiationService);
    await super._initialize();
  }

  /**
	 * Scan all extensions (system, user, and under-development) and return
	 * a deduplicated list. Results are cached after the first call.
	 *
	 * Unlike the browser version, this uses IBuiltinExtensionsScannerService
	 * directly for system extensions to ensure Node.js-only extensions
	 * (those with only a `main` field, no `browser` field) like `vscode.git`
	 * are included. The WebExtensionsScannerService would filter these out
	 * because they cannot execute on the web.
	 */
  private _scanWebExtensionsPromise: Promise<IExtensionDescription[]> | undefined;
  private async _scanWebExtensions(): Promise<IExtensionDescription[]> {
    if (!this._scanWebExtensionsPromise) {
      this._scanWebExtensionsPromise = (async () => {
        const system: IExtensionDescription[] = [], user: IExtensionDescription[] = [], development: IExtensionDescription[] = [];
        try {
          await Promise.all([
            // Use IBuiltinExtensionsScannerService directly instead of
            // _webExtensionsScannerService.scanSystemExtensions() to include
            // Node.js-only extensions (main-only, no browser field) like git.
            this._builtinExtensionsScannerService.scanBuiltinExtensions().then(extensions => {
              system.push(...extensions.map(e => toExtensionDescription(e)));
            }),
            this._webExtensionsScannerService.scanUserExtensions(this._userDataProfileService.currentProfile.extensionsResource, { skipInvalidExtensions: true }).then(extensions => user.push(...extensions.map(e => toExtensionDescription(e)))),
            this._webExtensionsScannerService.scanExtensionsUnderDevelopment().then(extensions => development.push(...extensions.map(e => toExtensionDescription(e, true)))),
          ]);
        } catch (error) {
          this._logService.error(error);
        }
        return dedupExtensions(system, user, [], development, this._logService);
      })();
    }
    return this._scanWebExtensionsPromise;
  }

  /**
	 * Default extension resolution: scan local web extensions and remote
	 * extensions in parallel, then emit them to the resolver pipeline.
	 */
  private async _resolveExtensionsDefault(emitter: AsyncIterableEmitter<ResolvedExtensions>) {
    const [localExtensions, remoteExtensions] = await Promise.all([
      this._scanWebExtensions(),
      this._remoteExtensionsScannerService.scanExtensions(),
    ]);

    if (remoteExtensions.length) {
      emitter.emitOne(new RemoteExtensions(remoteExtensions));
    }
    emitter.emitOne(new LocalExtensions(localExtensions));
  }

  /**
   * Returns an async iterable that yields {@link ResolvedExtensions} events.
   *
   * Delegates to {@link _doResolveExtensions} which handles both the default
   * resolution path and the resolver-extension path (e.g. Remote-SSH).
   */
  protected _resolveExtensions(): AsyncIterable<ResolvedExtensions> {
    return new AsyncIterableProducer(emitter => this._doResolveExtensions(emitter));
  }

  /**
   * Core extension resolution logic.
   *
   * Two paths:
   * 1. **Default** (no resolver extension) -- scans local and remote extensions
   *    in parallel and emits them directly.
   * 2. **Resolver extension** -- filters local extensions for resolver candidates,
   *    resolves the remote authority via the LocalProcess extension host (which
   *    provides Node.js APIs like `child_process` and `net`), sets up tunnel
   *    information and connection-loss listeners, then falls through to the
   *    default path.
   *
   * If the authority resolution fails with a handled error, the error is stored
   * via {@link IRemoteAuthorityResolverService._setResolvedAuthorityError} and
   * resolution proceeds with the default (local-only) path.
   *
   * @param emitter - Emitter used to yield {@link ResolvedExtensions} events to
   *   the base-class pipeline.
   */
  private async _doResolveExtensions(emitter: AsyncIterableEmitter<ResolvedExtensions>): Promise<void> {
    if (!this._browserEnvironmentService.expectsResolverExtension) {
      return this._resolveExtensionsDefault(emitter);
    }

    const remoteAuthority = this._environmentService.remoteAuthority!;

    await this._workspaceTrustManagementService.workspaceResolved;

    const localExtensions = await this._scanWebExtensions();
    const resolverExtensions = localExtensions.filter(extension => isResolverExtension(extension));
    if (resolverExtensions.length) {
      emitter.emitOne(new ResolverExtensions(resolverExtensions));
    }

    let resolverResult: ResolverResult;
    try {
      const remoteName = getRemoteName(remoteAuthority) || remoteAuthority;
      const progressService = this._instantiationService.invokeFunction(accessor => accessor.get(IProgressService));
      resolverResult = await progressService.withProgress(
        {
          location: ProgressLocation.Notification,
          title: localize('connectingToRemote', "Connecting to {0}...", remoteName),
        },
        () => this._resolveAuthorityInitial(remoteAuthority)
      );
    } catch (err) {
      if (RemoteAuthorityResolverError.isHandled(err)) {
        console.log('Error handled: Not showing a notification for the error');
      }
      this._remoteAuthorityResolverService._setResolvedAuthorityError(remoteAuthority, err);
      return this._resolveExtensionsDefault(emitter);
    }

    this._remoteAuthorityResolverService._setResolvedAuthority(resolverResult.authority, resolverResult.options);
    this._remoteExplorerService.setTunnelInformation(resolverResult.tunnelInformation);

    const connection = this._remoteAgentService.getConnection();
    if (connection) {
      this._register(connection.onDidStateChange(async (e) => {
        if (e.type === PersistentConnectionEventType.ConnectionLost) {
          this._remoteAuthorityResolverService._clearResolvedAuthority(remoteAuthority);
        }
      }));
      this._register(connection.onReconnecting(() => this._resolveAuthorityAgain()));
    }

    return this._resolveExtensionsDefault(emitter);
  }

  /**
	 * Handle extension host exit by stopping all extension hosts.
	 * Also triggers code automation exit if running in an automated test window.
	 */
  protected async _onExtensionHostExit(code: number): Promise<void> {
    await this._doStopExtensionHosts();

    const automatedWindow = mainWindow as unknown as IAutomatedWindow;
    if (typeof automatedWindow.codeAutomationExit === 'function') {
      automatedWindow.codeAutomationExit(code, await getLogs(this._fileService, this._environmentService));
    }
  }

  /**
	 * Resolve a remote authority by delegating to the LocalProcess extension host.
	 *
	 * Uses LocalProcess (Node.js sidecar) instead of LocalWebWorker because
	 * resolver extensions (e.g., Remote-SSH) require Node.js APIs such as
	 * `child_process` and `net` that are unavailable in Web Workers.
	 * This matches the behavior of VS Code Desktop (Electron).
	 */
  protected async _resolveAuthority(remoteAuthority: string): Promise<ResolverResult> {
    return this._resolveAuthorityOnExtensionHosts(ExtensionHostKind.LocalProcess, remoteAuthority);
  }
}

/** Register {@link TauriExtensionService} as the eager singleton for {@link IExtensionService}. */
registerSingleton(IExtensionService, TauriExtensionService, InstantiationType.Eager);
