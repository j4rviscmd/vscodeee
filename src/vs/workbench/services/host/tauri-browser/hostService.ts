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
import { ILifecycleService, ShutdownReason } from '../../lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from '../../lifecycle/browser/lifecycleService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IOpenEmptyWindowOptions, IOpenWindowOptions, IWindowOpenable, isFolderToOpen, isWorkspaceToOpen, IPoint, IRectangle } from '../../../../platform/window/common/window.js';
import { invoke } from '../../../../platform/tauri/common/tauriApi.js';
import { Schemas } from '../../../../base/common/network.js';
import { mainWindow } from '../../../../base/browser/window.js';

// NOTE: BrowserHostService's singleton registration is triggered by the named import above (line 6).
// The last registration wins (Map.set semantics), so our Tauri service overrides the browser one.

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
 * - {@link reload}: injects a splash overlay before reloading to avoid UI flicker
 * - {@link getCursorScreenPoint}: returns cursor position via native API for D&D positioning
 *
 * Registered as a delayed singleton so that it overrides the browser
 * implementation loaded by `workbench.common.main.js`.
 */
export class TauriHostService extends BrowserHostService {

  /**
   * Creates a new Tauri host service.
   *
   * @param layoutService - Service for accessing the workbench layout
   * @param configurationService - Service for reading workspace/user configuration
   * @param fileService - Service for file system operations
   * @param labelService - Service for formatting URIs and resource labels
   * @param environmentService - Service providing the browser workbench environment
   * @param instantiationService - Service for creating instances via dependency injection
   * @param lifecycleService - Service managing application lifecycle and shutdown
   * @param _logService - Service for writing diagnostic log messages
   * @param dialogService - Service for showing modal dialogs and confirmations
   * @param _contextService - Service providing the current workspace context
   * @param userDataProfilesService - Service managing user data profiles
   * @param nativeHostService - Native host service providing OS-level window operations
   */
  constructor(
    @ILayoutService layoutService: ILayoutService,
    @IConfigurationService configurationService: IConfigurationService,
    @IFileService fileService: IFileService,
    @ILabelService labelService: ILabelService,
    @IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
    @IInstantiationService instantiationService: IInstantiationService,
    @ILifecycleService lifecycleService: ILifecycleService,
    @ILogService private readonly _logService: ILogService,
    @IDialogService dialogService: IDialogService,
    @IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
    @IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
    @INativeHostService private readonly nativeHostService: INativeHostService,
  ) {
    super(
      layoutService, configurationService, fileService, labelService,
      environmentService, instantiationService, lifecycleService as unknown as BrowserLifecycleService,
      _logService, dialogService, _contextService, userDataProfilesService,
    );
  }

  /**
   * Toggles the native window fullscreen state via the OS window manager
   * instead of the DOM Fullscreen API.
   *
   * @param _targetWindow - Ignored; always operates on the native application window
   */
  override async toggleFullScreen(_targetWindow: Window): Promise<void> {
    return this.nativeHostService.toggleFullScreen();
  }

  /**
   * Brings the application window to the front of the OS window stack
   * and restores it if minimized.
   *
   * @param _targetWindow - Ignored; always operates on the native application window
   */
  override async moveTop(_targetWindow: Window): Promise<void> {
    return this.nativeHostService.moveWindowTop();
  }

  /**
   * Relaunches the entire application process (not just a WebView reload).
   *
   * Delegates to the native host service which spawns a new process
   * and gracefully shuts down the current one.
   */
  override async restart(): Promise<void> {
    return this.nativeHostService.relaunch();
  }

  /**
   * Reloads the workbench window.
   *
   * Injects a splash overlay into the DOM before performing the reload
   * to prevent a flash of blank content between unload and reload.
   */
  override async reload(): Promise<void> {
    this.injectReloadSplash();
    await super.reload();
  }

  /**
   * Injects a full-screen splash overlay into the DOM to mask the
   * brief blank state that occurs during a workbench reload.
   *
   * The overlay reads `--vscode-editor-background` from the computed
   * body style and renders a semi-transparent backdrop with the
   * `<eee/>` logo and a CSS spinner animation.
   */
  private injectReloadSplash(): void {
    const doc = mainWindow.document;

    const style = doc.createElement('style');
    style.textContent = `
      @keyframes reload-splash-spin {
        to { transform: rotate(360deg); }
      }
    `;
    doc.head.appendChild(style);

    const bg = mainWindow.getComputedStyle(doc.body).getPropertyValue('--vscode-editor-background').trim() || '#1E1E1E';

    const overlay = doc.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 99999;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background-color: ${bg}BF;
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    `;

    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '120');
    svg.setAttribute('height', '120');
    svg.setAttribute('viewBox', '0 0 260 260');
    svg.style.cssText = 'opacity: 0.4; margin-bottom: 24px; user-select: none; -webkit-user-select: none; pointer-events: none;';
    const text = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '130');
    text.setAttribute('y', '148');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-family', 'SF Mono, Menlo, Consolas, Courier New, monospace');
    text.setAttribute('font-size', '52');
    text.setAttribute('font-weight', '600');
    text.setAttribute('fill', '#808080');
    text.textContent = '<eee/>';
    svg.appendChild(text);

    const spinner = doc.createElement('div');
    spinner.style.cssText = `
      width: 28px; height: 28px; border-radius: 50%;
      border: 2px solid rgba(204, 204, 204, 0.2); border-top-color: #CCCCCC;
      animation: reload-splash-spin 0.8s linear infinite;
    `;

    overlay.appendChild(svg);
    overlay.appendChild(spinner);
    doc.body.appendChild(overlay);
  }

  /**
   * Returns the cursor position in screen coordinates and the bounds
   * of the display containing the cursor.
   *
   * Delegates to the native host service. Returns `undefined` if the
   * native API call fails (e.g., permission denied on macOS).
   *
   * @returns An object with the cursor {@link IPoint} and display
   *          {@link IRectangle}, or `undefined` on failure
   */
  override async getCursorScreenPoint(): Promise<{ readonly point: IPoint; readonly display: IRectangle } | undefined> {
    try {
      return await this.nativeHostService.getCursorScreenPoint();
    } catch (err) {
      this._logService.error('[TauriHostService] getCursorScreenPoint failed:', err);
      return undefined;
    }
  }

  /**
   * Opens a window, with special handling for remote authority URIs.
   *
   * For remote connections (URIs with the `vscode-remote` scheme), the
   * default behavior is to reuse the current window by navigating to the
   * remote URL, matching VS Code's built-in behavior. A new native window
   * is only opened when `forceNewWindow` or `preferNewWindow` is explicitly
   * set via the {@link IOpenWindowOptions} overload (e.g., Ctrl+Enter in
   * the Remote Explorer QuickPick).
   *
   * The {@link IOpenEmptyWindowOptions} overload has no `forceNewWindow`
   * flag, so the empty-window path always reuses the current window.
   *
   * @param options - Options for opening an empty window
   * @param toOpen - Array of folder, workspace, or file openables
   * @param options - Options controlling how the openables are displayed
   */
  override openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
  override openWindow(toOpen: IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
  override async openWindow(arg1?: IOpenEmptyWindowOptions | IWindowOpenable[], arg2?: IOpenWindowOptions): Promise<void> {
    // --- Array path: folder/workspace openables ---
    if (Array.isArray(arg1)) {
      if (arg1.length > 0) {
        // Guard: skip if the openable is already the current workspace
        if (this.isOpenableCurrentWorkspace(arg1[0])) {
          return;
        }

        // Remote authority extraction
        const openable = arg1[0];
        const extracted = this.extractRemoteAuthority(openable);

        if (extracted.remoteAuthority) {
          await this.openRemoteWindow(extracted.remoteAuthority, extracted.folderUri, extracted.workspaceUri, arg2);
          return;
        }
      }

      // Fall back to browser implementation for local windows
      return super.openWindow(arg1, arg2);
    }

    // --- Non-array path: empty window options ---
    // IOpenEmptyWindowOptions has no forceNewWindow, so we always reuse.
    if (arg1?.remoteAuthority) {
      await this.openRemoteInCurrentWindow(arg1.remoteAuthority);
      return;
    }

    return super.openWindow(arg1);
  }

  /**
   * Extracts the remote authority and relevant URI strings from a window openable.
   *
   * If the openable's URI uses the `vscode-remote` scheme, the authority
   * (e.g., `ssh-remote+host`) is extracted; otherwise `remoteAuthority` is
   * `undefined`. Exactly one of `folderUri` or `workspaceUri` is populated
   * depending on the openable type.
   *
   * @param openable - The window openable to inspect
   * @returns An object containing the remote authority and the
   *          stringified folder or workspace URI
   */
  private extractRemoteAuthority(openable: IWindowOpenable): { remoteAuthority: string | undefined; folderUri: string | undefined; workspaceUri: string | undefined } {
    if (isFolderToOpen(openable)) {
      return {
        remoteAuthority: openable.folderUri.scheme === Schemas.vscodeRemote ? openable.folderUri.authority : undefined,
        folderUri: openable.folderUri.toString(),
        workspaceUri: undefined,
      };
    }
    if (isWorkspaceToOpen(openable)) {
      return {
        remoteAuthority: openable.workspaceUri.scheme === Schemas.vscodeRemote ? openable.workspaceUri.authority : undefined,
        folderUri: undefined,
        workspaceUri: openable.workspaceUri.toString(),
      };
    }
    return { remoteAuthority: undefined, folderUri: undefined, workspaceUri: undefined };
  }

  /**
   * Opens a remote folder or workspace, either in the current window or
   * in a new native window depending on the caller's options.
   *
   * When `forceNewWindow` or `preferNewWindow` is set (and not overridden
   * by `forceReuseWindow`), the Tauri `open_new_window` command is invoked
   * to create a new native window. Otherwise, the connection is opened in
   * the current window via navigation.
   *
   * @param remoteAuthority - The remote connection authority (e.g., `ssh-remote+host`)
   * @param folderUri - Stringified folder URI to open, if applicable
   * @param workspaceUri - Stringified workspace URI to open, if applicable
   * @param options - Window open options that may request a new window
   */
  private async openRemoteWindow(remoteAuthority: string, folderUri: string | undefined, workspaceUri: string | undefined, options?: IOpenWindowOptions): Promise<void> {
    const forceNew = (options?.forceNewWindow || options?.preferNewWindow) && !options?.forceReuseWindow;
    if (!forceNew) {
      await this.openRemoteInCurrentWindow(remoteAuthority, folderUri, workspaceUri);
    } else {
      try {
        await invoke('open_new_window', {
          options: {
            folderUri,
            workspaceUri,
            remoteAuthority,
            forceNewWindow: true,
          },
        });
      } catch (err) {
        this._logService.error('[TauriHostService] Failed to open remote folder/workspace window:', err);
      }
    }
  }

  /**
   * Opens a remote connection in the current window by navigating to
   * the remote workbench URL.
   *
   * Before navigation, signals an expected shutdown with reason
   * {@link ShutdownReason.LOAD} so that the lifecycle service flushes
   * persisted state (e.g., storage, dirty editors).
   *
   * @param remoteAuthority - The remote connection authority
   * @param folderUri - Optional stringified folder URI to pass as a query parameter
   * @param workspaceUri - Optional stringified workspace URI to pass as a query parameter
   */
  private async openRemoteInCurrentWindow(remoteAuthority: string, folderUri?: string, workspaceUri?: string): Promise<void> {
    const targetUrl = this.buildRemoteUrl(remoteAuthority, folderUri, workspaceUri);
    await this.handleExpectedShutdown(ShutdownReason.LOAD);
    mainWindow.location.href = targetUrl;
  }

  /**
   * Checks whether the given openable refers to the same workspace
   * that is currently open.
   *
   * For folders, matches when the workspace has exactly one folder and
   * its URI equals the openable's folder URI. For workspaces, matches
   * when the current workspace configuration URI equals the openable's
   * workspace URI.
   *
   * @param openable - The window openable to compare against the current workspace
   * @returns `true` if the openable is already the active workspace
   */
  private isOpenableCurrentWorkspace(openable: IWindowOpenable): boolean {
    const workspace = this._contextService.getWorkspace();
    if (isFolderToOpen(openable)) {
      return workspace.folders.length === 1
        && !workspace.configuration
        && workspace.folders[0].uri.toString() === openable.folderUri.toString();
    }
    if (isWorkspaceToOpen(openable)) {
      return !!workspace.configuration
        && workspace.configuration.toString() === openable.workspaceUri.toString();
    }
    return false;
  }

  /**
   * Builds the workbench URL for opening a remote connection.
   *
   * Preserves the current origin and pathname, then appends `folder`
   * or `workspace` and `remoteAuthority` as query parameters.
   *
   * @param remoteAuthority - The remote connection authority to include
   * @param folderUri - Optional folder URI to pass as the `folder` query param
   * @param workspaceUri - Optional workspace URI to pass as the `workspace` query param
   * @returns The fully qualified URL string for the remote workbench
   */
  private buildRemoteUrl(remoteAuthority: string, folderUri?: string, workspaceUri?: string): string {
    const base = `${mainWindow.location.origin}${mainWindow.location.pathname}`;
    const params = new URLSearchParams();

    if (folderUri) {
      params.set('folder', folderUri);
    } else if (workspaceUri) {
      params.set('workspace', workspaceUri);
    }

    params.set('remoteAuthority', remoteAuthority);

    return `${base}?${params.toString()}`;
  }
}

registerSingleton(IHostService, TauriHostService, InstantiationType.Delayed);
