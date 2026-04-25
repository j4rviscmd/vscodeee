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
import { domContentLoaded, addDisposableListener, EventHelper, EventType } from '../../base/browser/dom.js';
import { setZoomLevel, getZoomLevel } from '../../base/browser/browser.js';
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
import { TauriStorageService } from '../services/storage/tauri-browser/tauriStorageService.js';
import { IRemoteAgentService } from '../services/remote/common/remoteAgentService.js';
import { RemoteAgentService } from '../services/remote/browser/remoteAgentService.js';
import { IRemoteAuthorityResolverService, RemoteConnectionType } from '../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../platform/remote/browser/remoteAuthorityResolverService.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { SignService } from '../../platform/sign/browser/signService.js';
import { BrowserSocketFactory } from '../../platform/remote/browser/browserSocketFactory.js';
import { RemoteSocketFactoryService, IRemoteSocketFactoryService } from '../../platform/remote/common/remoteSocketFactoryService.js';
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
import { IRequestService } from '../../platform/request/common/request.js';
import { BrowserRequestService } from '../services/request/browser/requestService.js';
import { mainWindow } from '../../base/browser/window.js';
import { IWorkbenchLayoutService } from '../services/layout/browser/layoutService.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';

import { TauriIPCMainProcessService } from '../../platform/ipc/tauri-browser/mainProcessService.js';
import { TauriNativeHostService } from '../../platform/native/tauri-browser/nativeHostService.js';
import { TauriWorkbenchEnvironmentService, ITauriWindowConfiguration } from '../services/environment/tauri-browser/environmentService.js';
import { IBrowserWorkbenchEnvironmentService } from '../services/environment/browser/environmentService.js';
import { IWorkbenchConstructionOptions, IWorkspace, IWorkspaceProvider } from '../browser/web.api.js';
import { isFolderToOpen, isWorkspaceToOpen, zoomLevelToZoomFactor } from '../../platform/window/common/window.js';
import { invoke, listen } from '../../platform/tauri/common/tauriApi.js';
import { ITauriWindowService, TauriWindowService } from '../../platform/window/tauri-browser/windowService.js';
import { TauriURLCallbackProvider } from './urlCallbackProvider.js';

/**
 * Tauri equivalent of Electron's `DesktopMain`.
 *
 * Owns the full workbench lifecycle for a single Tauri window:
 * service initialization, Workbench creation, event wiring, and
 * shutdown coordination.
 */
export class TauriDesktopMain extends Disposable {

  private readonly workspace: IWorkspace;

  /**
   * @param tauriConfig - Window configuration resolved from the Rust backend
   *     via `get_extended_window_configuration`.
   * @param folderUri - Optional folder URI to open on startup (from URL query param).
   * @param workspaceUri - Optional `.code-workspace` URI to open on startup (from URL query param).
   * @param remoteAuthority - Optional remote authority for remote development (e.g. `"ssh-remote+host"`).
   */
  constructor(
    private readonly tauriConfig: ITauriWindowConfiguration,
    folderUri?: string,
    workspaceUri?: string,
    private readonly remoteAuthority?: string,
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

  /**
   * Bootstrap the workbench: initialize services, create the Workbench instance,
   * wire up event listeners (resize, maximize, zoom, external opener), and start
   * the workbench.
   *
   * Services and DOM readiness are initialized in parallel for faster startup.
   */
  async open(): Promise<void> {

    // Init services and wait for DOM to be ready in parallel
    const [services] = await Promise.all([this.initServices(), domContentLoaded(mainWindow)]);

    // Create Workbench
    const workbench = new Workbench(mainWindow.document.body, {
      extraClasses: ['tauri'],
    }, services.serviceCollection, services.logService);

    // Listeners
    this.registerListeners(workbench, services.storageService);

    // Startup — returns the instantiation service with all resolved services
    const instantiationService = workbench.startup();

    // Wire window events to trigger layout recalculation.
    // Two listeners are needed for complete coverage:
    // - tauri://resize: OS-level window resize (Tauri native API)
    // - DOM resize: viewport changes that don't resize the window (e.g., DevTools dock/undock)
    instantiationService.invokeFunction(accessor => {
      const layoutService = accessor.get(IWorkbenchLayoutService);
      const nativeHostService = accessor.get(INativeHostService);
      const openerService = accessor.get(IOpenerService);
      const configurationService = accessor.get(IWorkbenchConfigurationService);

      listen('tauri://resize', () => layoutService.layout())
        .then(unlisten => this._register({ dispose: unlisten }));
      this._register(addDisposableListener(mainWindow, EventType.RESIZE, () => layoutService.layout()));

      // Prevent native WebView behaviors — mirrors BrowserWindow in window.ts.
      const mainContainer = layoutService.mainContainer;
      const preventEvent = (e: Event) => EventHelper.stop(e, true);
      this._register(addDisposableListener(mainContainer, EventType.CONTEXT_MENU, preventEvent));
      this._register(addDisposableListener(mainContainer, EventType.DROP, preventEvent));
      this._register(addDisposableListener(mainContainer, EventType.WHEEL, e => e.preventDefault(), { passive: false }));

      this._register(nativeHostService.onDidMaximizeWindow(() => {
        layoutService.updateWindowMaximizedState(mainWindow, true);
      }));
      this._register(nativeHostService.onDidUnmaximizeWindow(() => {
        layoutService.updateWindowMaximizedState(mainWindow, false);
      }));

      // Override the default external opener to use Tauri's native host service
      // instead of window.open(), which doesn't work in Tauri WebView.
      // This ensures OAuth sign-in flows (e.g., Copilot) open the system browser.
      openerService.setDefaultExternalOpener({
        openExternal: async (href: string) => {
          await nativeHostService.openExternal(href);
          return true;
        },
      });

      // Apply window zoom level via Tauri's native WebView zoom.
      // In Electron, webFrame.setZoomLevel() changes the Chromium page zoom factor,
      // which correctly updates window.innerWidth/innerHeight and reflows the layout.
      // Tauri's Webview::set_zoom() provides the same native behavior via WKWebView
      // on macOS, unlike CSS zoom which doesn't update viewport dimensions.
      const applyWindowZoom = async (): Promise<void> => {
        let zoomLevel = configurationService.getValue<number>('window.zoomLevel') ?? 0;
        zoomLevel = Math.max(-8, Math.min(24, zoomLevel));
        if (getZoomLevel(mainWindow) === zoomLevel) {
          return;
        }
        setZoomLevel(zoomLevel, mainWindow);
        await invoke('set_webview_zoom', { scaleFactor: zoomLevelToZoomFactor(zoomLevel) });
        layoutService.layout();
      };
      applyWindowZoom();
      this._register(configurationService.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('window.zoomLevel')) {
          applyWindowZoom();
        }
      }));
    });
  }

  /**
   * Register lifecycle listeners on the Workbench instance.
   *
   * Storage is closed on `onDidShutdown` (which fires *after* the lifecycle
   * service flush) rather than `onWillShutdown` (which fires *before* flush)
   * to avoid data loss.
   *
   * @param workbench - The Workbench instance to listen on.
   * @param storageService - The Tauri storage service to close on shutdown.
   */
  private registerListeners(workbench: Workbench, storageService: TauriStorageService): void {
    // Close storage AFTER flush — onWillShutdown fires BEFORE the lifecycle
    // service's flush(SHUTDOWN), so closing there would dispose the Storage
    // instances and cause the flush to be a no-op (data loss).
    // onDidShutdown fires AFTER flush, so close() is safe here.
    this._register(workbench.onDidShutdown(() => storageService.close()));
    this._register(workbench.onDidShutdown(() => this.dispose()));
  }

  /**
   * Initialize the full service collection required by the Workbench.
   *
   * Registration order matters because later services may depend on earlier ones.
   * The general order is:
   *
   * 1. Product & Main Process (IPC)
   * 2. Environment & Workspace Provider
   * 3. Logging
   * 4. Native Host & Window Service
   * 5. File System (disk I/O via Tauri commands)
   * 6. User Data Profiles
   * 7. Remote Agent (extension host over WebSocket)
   * 8. Configuration
   * 9. Request Service
   * 10. Storage
   * 11. Workspace Trust
   *
   * @returns The populated service collection, log service, and storage service.
   * @throws {Error} If `appDataDir` or `tmpDir` is not provided in the Tauri configuration.
   */
  private async initServices(): Promise<{ serviceCollection: ServiceCollection; logService: ILogService; storageService: TauriStorageService }> {
    const serviceCollection = new ServiceCollection();

    // --- Product ---
    const productService: IProductService = { _serviceBrand: undefined, ...product };
    serviceCollection.set(IProductService, productService);

    // --- Main Process (Tauri IPC) ---
    const mainProcessService = this._register(new TauriIPCMainProcessService(this.tauriConfig.windowId));
    serviceCollection.set(IMainProcessService, mainProcessService);

    // --- Environment ---
    const appDataDir = this.tauriConfig.appDataDir ?? this.tauriConfig.tmpDir;
    if (!appDataDir) {
      throw new Error('appDataDir or tmpDir must be provided in Tauri window configuration');
    }
    const logsHome = URI.file(`${appDataDir}/logs`);
    const workspaceId = 'tauri-default';

    // Workspace provider handles Open Folder / Open Workspace by reloading
    // the page with ?folder= or ?workspace= query params (same pattern as VS Code web).
    const workspaceProvider = new TauriWorkspaceProvider(this.workspace);

    // URL callback provider — bridges Tauri deep-link events to VS Code's IURLService.
    // This enables OAuth callback flows (GitHub authentication, etc.).
    const urlCallbackProvider = new TauriURLCallbackProvider(product.urlProtocol, listen);
    const deepLinkDisposable = await urlCallbackProvider.startListening();
    this._register(deepLinkDisposable);
    this._register(urlCallbackProvider);

    // Secret storage now uses master-key encryption (TauriEncryptionService)
    // registered via the singleton pattern, so no explicit provider is needed here.
    const workbenchOptions: IWorkbenchConstructionOptions = {
      remoteAuthority: this.remoteAuthority,
      workspaceProvider,
      urlCallbackProvider,
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
    const nativeHostService = this._register(new TauriNativeHostService(this.tauriConfig.windowId));
    serviceCollection.set(INativeHostService, nativeHostService);

    // --- Tauri Window Service ---
    const tauriWindowService = this._register(new TauriWindowService());
    serviceCollection.set(ITauriWindowService, tauriWindowService);

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
    const storageService = new TauriStorageService(workspace, userDataProfileService, environmentService, logService);
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

  /**
   * Resolve the workspace identifier from the initial workspace configuration.
   *
   * Returns a single-folder identifier, a workspace-file identifier, or
   * `UNKNOWN_EMPTY_WINDOW_WORKSPACE` when no workspace is open.
   */
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
 * by reloading the page with `?folder=` or `?workspace=` query params.
 * Same pattern as VS Code web's `WorkspaceProvider`.
 *
 * When opening in a new window (not reusing), delegates to the Rust
 * `open_new_window` command via `WindowManager`.
 */
class TauriWorkspaceProvider implements IWorkspaceProvider {

  /** Query parameter key for a folder URI. */
  private static readonly QUERY_PARAM_FOLDER = 'folder';
  /** Query parameter key for a workspace file URI. */
  private static readonly QUERY_PARAM_WORKSPACE = 'workspace';
  /** Query parameter key indicating an empty window. */
  private static readonly QUERY_PARAM_EMPTY_WINDOW = 'ew';

  readonly trusted = true;
  readonly payload: object | undefined = undefined;

  constructor(readonly workspace: IWorkspace) { }

  /**
   * Open a workspace in the current or a new window.
   *
   * - If `options.reuse` is true and the workspace matches the current one, this is a no-op.
   * - If `options.reuse` is true but the workspace differs, navigates the current window.
   * - Otherwise, opens a new Tauri window via the `open_new_window` Rust command,
   *   extracting `remoteAuthority` from `vscode-remote://` URIs when present.
   *
   * @param workspace - The workspace to open (folder, workspace file, or empty).
   * @param options - Optional reuse and payload options.
   * @returns `true` if the workspace was opened successfully, `false` otherwise.
   */
  async open(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): Promise<boolean> {
    if (options?.reuse && this.isSame(this.workspace, workspace)) {
      return true;
    }

    const targetHref = this.createTargetUrl(workspace);
    if (!targetHref) {
      return false;
    }

    if (options?.reuse) {
      // Reuse current window: navigate to new URL
      mainWindow.location.href = targetHref;
      return true;
    }

    // Open a new Tauri window via Rust command
    const folderUri = workspace && isFolderToOpen(workspace) ? workspace.folderUri.toString() : undefined;
    const workspaceUri = workspace && isWorkspaceToOpen(workspace) ? workspace.workspaceUri.toString() : undefined;

    // Extract remoteAuthority from vscode-remote:// URIs so the new window
    // can initialize its extension host with the correct remote resolver.
    // e.g., vscode-remote://ssh-remote+raspi/home/user → "ssh-remote+raspi"
    let remoteAuthority: string | undefined;
    if (workspace && isFolderToOpen(workspace) && workspace.folderUri.scheme === Schemas.vscodeRemote) {
      remoteAuthority = workspace.folderUri.authority;
    } else if (workspace && isWorkspaceToOpen(workspace) && workspace.workspaceUri.scheme === Schemas.vscodeRemote) {
      remoteAuthority = workspace.workspaceUri.authority;
    }

    try {
      await invoke('open_new_window', {
        options: {
          folderUri,
          workspaceUri,
          remoteAuthority,
          forceNewWindow: true,
        },
      });
      return true;
    } catch (err) {
      console.error('[TauriWorkspaceProvider] Failed to open new window:', err);
      return false;
    }
  }

  /**
   * Build a URL with the appropriate query parameter for the given workspace.
   *
   * @param workspace - The workspace to encode in the URL.
   * @returns The full URL string, or `undefined` if the workspace type is unrecognized.
   */
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

  /**
   * Determine whether two workspace references point to the same location.
   *
   * Compares folder URIs or workspace file URIs depending on the workspace type.
   * Two `undefined` (empty) workspaces are considered the same.
   */
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
