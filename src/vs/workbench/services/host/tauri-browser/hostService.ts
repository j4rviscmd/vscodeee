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
    @IWorkspaceContextService contextService: IWorkspaceContextService,
    @IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
    @INativeHostService private readonly nativeHostService: INativeHostService,
  ) {
    super(
      layoutService, configurationService, fileService, labelService,
      environmentService, instantiationService, lifecycleService as unknown as BrowserLifecycleService,
      _logService, dialogService, contextService, userDataProfilesService,
    );
  }

  /**
   * Toggles the native window fullscreen state.
   */
  override async toggleFullScreen(_targetWindow: Window): Promise<void> {
    return this.nativeHostService.toggleFullScreen();
  }

  /**
   * Brings the application window to the front of the OS window stack.
   */
  override async moveTop(_targetWindow: Window): Promise<void> {
    return this.nativeHostService.moveWindowTop();
  }

  /**
   * Relaunches the entire application.
   */
  override async restart(): Promise<void> {
    return this.nativeHostService.relaunch();
  }

  /**
   * Reloads the window with an immediate splash overlay to prevent flicker.
   */
  override async reload(): Promise<void> {
    this.injectReloadSplash();
    await super.reload();
  }

  /**
   * Injects a full-screen splash overlay into the DOM.
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
   * Returns the cursor position in screen coordinates and the display bounds.
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
   * Opens a window with special handling for remote authority.
   *
   * Defaults to reusing the current window for remote connections
   * (matching VS Code behavior). A new window is only opened when
   * `forceNewWindow` or `preferNewWindow` is explicitly set on the
   * folder/workspace openable overload (e.g., Ctrl+Enter in QuickPick).
   *
   * `IOpenEmptyWindowOptions` has no `forceNewWindow`, so the empty
   * window path always reuses. The "new window" intent goes through
   * the folder/workspace openable overload with `IOpenWindowOptions`.
   */
  override openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
  override openWindow(toOpen: IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
  override async openWindow(arg1?: IOpenEmptyWindowOptions | IWindowOpenable[], arg2?: IOpenWindowOptions): Promise<void> {
    // Empty window with remoteAuthority -- Remote-SSH uses this path.
    // IOpenEmptyWindowOptions has no forceNewWindow, so we always reuse.
    if (!Array.isArray(arg1)) {
      const emptyOptions = arg1 as IOpenEmptyWindowOptions | undefined;
      if (emptyOptions?.remoteAuthority) {
        await this.openRemoteInCurrentWindow(emptyOptions.remoteAuthority);
        return;
      }
    }

    // Folder/workspace openables with vscode-remote:// URIs
    if (Array.isArray(arg1) && arg1.length > 0) {
      const openable = arg1[0];
      let remoteAuthority: string | undefined;
      let folderUri: string | undefined;
      let workspaceUri: string | undefined;

      if (isFolderToOpen(openable)) {
        folderUri = openable.folderUri.toString();
        if (openable.folderUri.scheme === Schemas.vscodeRemote) {
          remoteAuthority = openable.folderUri.authority;
        }
      } else if (isWorkspaceToOpen(openable)) {
        workspaceUri = openable.workspaceUri.toString();
        if (openable.workspaceUri.scheme === Schemas.vscodeRemote) {
          remoteAuthority = openable.workspaceUri.authority;
        }
      }

      if (remoteAuthority) {
        const forceNew = (arg2?.forceNewWindow || arg2?.preferNewWindow) && !arg2?.forceReuseWindow;
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
        return;
      }
    }

    // Fall back to browser implementation for local windows
    if (Array.isArray(arg1)) {
      return super.openWindow(arg1, arg2);
    }
    return super.openWindow(arg1);
  }

  /**
   * Opens a remote connection in the current window by navigating to a new URL.
   *
   * Signals an expected shutdown (LOAD) so state is flushed before navigation.
   */
  private async openRemoteInCurrentWindow(remoteAuthority: string, folderUri?: string, workspaceUri?: string): Promise<void> {
    const targetUrl = this.buildRemoteUrl(remoteAuthority, folderUri, workspaceUri);
    await this.handleExpectedShutdown(ShutdownReason.LOAD);
    mainWindow.location.href = targetUrl;
  }

  /**
   * Builds the workbench URL for a remote connection.
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
