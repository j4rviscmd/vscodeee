/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri workbench bootstrap script.
 *
 * This is the entry point loaded by `workbench-tauri.html` as a regular
 * (non-module) script. It must:
 *
 * 1. Show a splash screen immediately
 * 2. Initialize NLS globals (`_VSCODE_NLS_MESSAGES`, `_VSCODE_NLS_LANGUAGE`)
 * 3. Set `_VSCODE_FILE_ROOT` for `FileAccess` module path resolution
 * 4. Set up CSS import maps so that `import './foo.css'` in transpiled
 *    ESM modules works in the browser (port of Electron's `setupCSSImportMaps`)
 * 5. Dynamically `import()` the workbench entry module
 *
 * This script uses `window.__TAURI__` globals directly (no npm imports)
 * and must remain self-contained (no top-level ESM imports) because
 * CSS import maps must be installed BEFORE any ES module is loaded.
 */

/* eslint-disable no-restricted-globals */

(async function () {

  // Performance marker
  performance.mark('code/didStartRenderer');

  //#region Splash Screen

  /**
	 * Display the initial splash screen with VS Code dark theme defaults.
	 *
	 * Injects minimal CSS (background/foreground colors) and sets the
	 * `monaco-workbench vs-dark` class on the body. Must run synchronously
	 * before any async work to avoid a white flash.
	 */
  function showSplash(): void {
    performance.mark('code/willShowPartsSplash');

    const baseTheme = 'vs-dark';
    const shellBackground = '#1E1E1E';
    const shellForeground = '#CCCCCC';

    const style = document.createElement('style');
    style.className = 'initialShellColors';
    // eslint-disable-next-line no-restricted-syntax
    document.head.appendChild(style);
    style.textContent = `
			body {
				background-color: ${shellBackground};
				color: ${shellForeground};
				margin: 0;
				padding: 0;
			}
		`;

    // eslint-disable-next-line no-restricted-syntax
    document.body.className = `monaco-workbench ${baseTheme}`;

    performance.mark('code/didShowPartsSplash');
  }

  showSplash();

  //#endregion

  //#region Tauri API — use window.__TAURI__ directly (no npm imports)

  /**
	 * Minimal type definition for the `window.__TAURI__` global API.
	 *
	 * Only declares the `core.invoke` method used by the bootstrap script.
	 * The full Tauri API types are available in `@tauri-apps/api` but are
	 * not imported here to keep this script self-contained.
	 */
  interface ITauriGlobal {
    core: {
      invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    };
  }

  /**
	 * Retrieve the Tauri global API from `window.__TAURI__`.
	 *
	 * @returns The Tauri global API object.
	 * @throws {Error} If the Tauri API is not available (e.g., running outside a Tauri WebView).
	 */
  function getTauri(): ITauriGlobal {
    const tauri = (globalThis as Record<string, unknown>).__TAURI__;
    if (!tauri) {
      throw new Error('Tauri API not available. Ensure withGlobalTauri is true.');
    }
    return tauri as ITauriGlobal;
  }

  const tauri = getTauri();

  //#endregion

  //#region Configuration

  /**
	 * Window configuration returned by the `get_window_configuration` Tauri command.
	 *
	 * Provides the minimal set of values needed for workbench bootstrap,
	 * including paths, window identity, and any restored workspace URIs
	 * from the previous session.
	 */
  interface ITauriWindowConfig {
    windowId: number;
    logLevel: number;
    resourceDir: string;
    frontendDist: string;
    appDataDir: string;
    restoredFolderUri?: string;
    restoredWorkspaceUri?: string;
    isDevBuild?: boolean;
  }

  /**
	 * Native host information returned by the `get_native_host_info` Tauri command.
	 *
	 * Provides OS-level environment details (platform, architecture, paths)
	 * that the workbench uses for feature detection and file system access.
	 */
  interface ITauriHostInfo {
    homeDir: string;
    tmpDir: string;
    platform: string;
    arch: string;
    hostname: string;
  }

  const windowConfig = await tauri.core.invoke<ITauriWindowConfig>('get_window_configuration');
  const hostInfo = await tauri.core.invoke<ITauriHostInfo>('get_native_host_info');

  /**
 * Merged configuration object passed to `TauriDesktopMain`.
 *
 * Combines window-level settings (id, log level) from the Rust backend
 * with host-level settings (home/tmp directories) to provide the
 * workbench with all environment information it needs at startup.
 */
  const tauriConfig = {
    windowId: windowConfig.windowId,
    logLevel: windowConfig.logLevel,
    resourceDir: windowConfig.resourceDir,
    frontendDist: windowConfig.frontendDist,
    appDataDir: windowConfig.appDataDir,
    homeDir: hostInfo.homeDir,
    tmpDir: hostInfo.tmpDir,
    windowLabel: new URL(document.location.href).searchParams.get('windowLabel') ?? 'main',
    isDevBuild: windowConfig.isDevBuild,
  };

  //#endregion

  //#region NLS — must be set before importing any workbench modules

  (globalThis as Record<string, unknown>)._VSCODE_NLS_MESSAGES = [];
  (globalThis as Record<string, unknown>)._VSCODE_NLS_LANGUAGE = 'en';
  // eslint-disable-next-line no-restricted-syntax
  document.documentElement.setAttribute('lang', 'en');

  //#endregion

  //#region File Root — required by FileAccess (network.ts)

  // _VSCODE_FILE_ROOT must be a file:// path so that FileAccess.asBrowserUri()
  // can convert resource URIs to vscode-file:// scheme, which is served by
  // Tauri's custom protocol handler (handle_vscode_file_protocol).
  //
  // Using window.location.origin (http://127.0.0.1:1430/) would cause
  // FileAccess to generate http:// URLs for node_modules resources like
  // vscode-oniguruma and vscode-textmate. The dev server doesn't serve
  // node_modules, resulting in 404 errors for TextMate tokenizer resources.
  //
  // frontendDist is the absolute path to the `out/` directory where
  // transpiled VS Code modules live (e.g., out/vs/workbench/...).
  // Module IDs like `vs/../../node_modules/vscode-oniguruma/release/main.js`
  // resolve correctly relative to this path.
  const baseUrl = `${window.location.origin}/`;
  (globalThis as Record<string, unknown>)._VSCODE_FILE_ROOT = windowConfig.frontendDist;

  //#endregion

  //#region CSS Import Maps

  // Port of Electron's setupCSSImportMaps (workbench.ts:452-495).
  // In dev mode (transpile), CSS imports in JS modules are preserved as-is.
  // We create an import map that intercepts each CSS URL and redirects it
  // to a blob URL containing `globalThis._VSCODE_CSS_LOAD(url)`, which
  // inserts a <link> element to load the actual CSS.
  /**
	 * Set up CSS import maps for ES module CSS imports.
	 *
	 * Port of Electron's `setupCSSImportMaps` mechanism. Fetches the list
	 * of `.css` files from the Rust backend, then creates a `<script type="importmap">`
	 * element that maps each CSS URL to a blob URL containing a
	 * `globalThis._VSCODE_CSS_LOAD(url)` call. This allows transpiled ESM
	 * modules to `import './foo.css'` and have it converted to a `<link>` injection.
	 *
	 * **Must be called before any `<script type="module">` is loaded.**
	 */
  async function setupCSSImportMaps(): Promise<void> {
    performance.mark('code/willAddCssLoader');

    // Fetch list of CSS modules from Rust backend
    const cssModules = await tauri.core.invoke<string[]>('list_css_modules');

    if (!cssModules || cssModules.length === 0) {
      console.warn('[Tauri Bootstrap] No CSS modules found — styling may be missing');
      performance.mark('code/didAddCssLoader');
      return;
    }

    // Install CSS loader function
    (globalThis as Record<string, unknown>)._VSCODE_CSS_LOAD = function (url: string): void {
      const link = document.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('type', 'text/css');
      link.setAttribute('href', url);
      // eslint-disable-next-line no-restricted-syntax
      document.head.appendChild(link);
    };

    // Build import map: each CSS URL → blob URL that triggers _VSCODE_CSS_LOAD
    const importMap: { imports: Record<string, string> } = { imports: {} };
    for (const cssModule of cssModules) {
      const cssUrl = new URL(cssModule, baseUrl).href;
      const jsSrc = `globalThis._VSCODE_CSS_LOAD('${cssUrl}');\n`;
      const blob = new Blob([jsSrc], { type: 'application/javascript' });
      importMap.imports[cssUrl] = URL.createObjectURL(blob);
    }

    // Inject import map script element (must be before any <script type="module">)
    const importMapSrc = JSON.stringify(importMap, undefined, 2);
    const importMapScript = document.createElement('script');
    importMapScript.type = 'importmap';
    importMapScript.textContent = importMapSrc;
    // eslint-disable-next-line no-restricted-syntax
    document.head.appendChild(importMapScript);

    console.log(`[Tauri Bootstrap] CSS import map installed with ${cssModules.length} modules`);
    performance.mark('code/didAddCssLoader');
  }

  await setupCSSImportMaps();

  //#endregion

  //#region Parse workspace from URL query params

  // When a folder/workspace is opened, the page is reloaded with ?folder=<uri>
  // or ?workspace=<uri> in the URL. Parse these to pass to the workbench.
  // Fall back to restored URIs from the session if no URL params are present.
  const query = new URL(document.location.href).searchParams;
  const folderParam = query.get('folder') ?? windowConfig.restoredFolderUri ?? null;
  const workspaceParam = query.get('workspace') ?? windowConfig.restoredWorkspaceUri ?? null;

  // Remote authority for remote development scenarios (e.g., "ssh-remote+raspi").
  // Passed via query parameter when Remote-SSH opens a new window.
  // Fallback: extract from vscode-remote:// URI (session restore via restoredFolderUri).
  let remoteAuthorityParam = query.get('remoteAuthority');
  if (!remoteAuthorityParam) {
    const remoteUri = folderParam ?? workspaceParam;
    if (remoteUri?.startsWith('vscode-remote://')) {
      const afterScheme = remoteUri.substring('vscode-remote://'.length);
      const slashIdx = afterScheme.indexOf('/');
      remoteAuthorityParam = slashIdx > 0 ? afterScheme.substring(0, slashIdx) : afterScheme || null;
    }
  }

  // Notify the Rust backend of the current workspace URI so it can be
  // persisted in sessions.json when the app quits.
  const effectiveUri = folderParam ?? workspaceParam ?? null;
  tauri.core.invoke('set_workspace_uri', { uri: effectiveUri }).catch(() => { /* best-effort */ });

  //#endregion

  //#region Product Configuration — must be set before importing workbench modules

  // product.ts checks globalThis._VSCODE_PRODUCT_JSON and _VSCODE_PACKAGE_JSON
  // to configure services like the Extension Gallery (marketplace).
  // Without this, the fallback path provides a hardcoded default without extensionsGallery.
  try {
    const productPackage = await tauri.core.invoke<{ product: object; package: object }>('get_product_json');
    (globalThis as Record<string, unknown>)._VSCODE_PRODUCT_JSON = productPackage.product;
    (globalThis as Record<string, unknown>)._VSCODE_PACKAGE_JSON = productPackage.package;
  } catch (err) {
    console.warn('[Tauri Bootstrap] Failed to load product.json, using defaults:', err);
  }

  //#endregion

  //#region Load Workbench

  try {
    performance.mark('code/willLoadWorkbenchMain');

    // Dynamic import of the compiled workbench module (side-effect imports)
    await import('../../../workbench/workbench.tauri.main.js');
    const desktopModule = await import('../../../workbench/tauri-browser/desktop.tauri.main.js');

    performance.mark('code/didLoadWorkbenchMain');

    const main = new desktopModule.TauriDesktopMain(tauriConfig, folderParam ?? undefined, workspaceParam ?? undefined, remoteAuthorityParam ?? undefined);
    await main.open();

    // Notify the Rust backend that the workbench is ready to be shown.
    // The window is created hidden (visible: false) and only becomes
    // visible after this call, preventing the "stretching on restore"
    // effect where the window resizes from default to saved geometry.
    await tauri.core.invoke('notify_ready');

    performance.mark('code/didStartWorkbench');
  } catch (error) {
    console.error('[Tauri Bootstrap] Failed to load workbench:', error);

    // Show error in the body so the user sees something
    // eslint-disable-next-line no-restricted-syntax
    document.body.textContent = '';
    const errorEl = document.createElement('div');
    errorEl.style.cssText = 'padding: 20px; font-family: monospace; white-space: pre-wrap;';
    errorEl.textContent = `Failed to start workbench:\n\n${error instanceof Error ? error.stack || error.message : String(error)}`;
    // eslint-disable-next-line no-restricted-syntax
    document.body.appendChild(errorEl);

    // Show the window even on error so the user can see the error message
    tauri.core.invoke('notify_ready').catch(() => { /* best-effort */ });
  }

  //#endregion
})();
