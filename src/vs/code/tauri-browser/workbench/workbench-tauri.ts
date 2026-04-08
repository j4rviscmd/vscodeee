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

	function showSplash(): void {
		performance.mark('code/willShowPartsSplash');

		const baseTheme = 'vs-dark';
		const shellBackground = '#1E1E1E';
		const shellForeground = '#CCCCCC';

		const style = document.createElement('style');
		style.className = 'initialShellColors';
		document.head.appendChild(style);
		style.textContent = `
			body {
				background-color: ${shellBackground};
				color: ${shellForeground};
				margin: 0;
				padding: 0;
			}
		`;

		document.body.className = `monaco-workbench ${baseTheme}`;

		performance.mark('code/didShowPartsSplash');
	}

	showSplash();

	//#endregion

	//#region Tauri API — use window.__TAURI__ directly (no npm imports)

	interface ITauriGlobal {
		core: {
			invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
		};
	}

	function getTauri(): ITauriGlobal {
		const tauri = (window as any).__TAURI__;
		if (!tauri) {
			throw new Error('Tauri API not available. Ensure withGlobalTauri is true.');
		}
		return tauri as ITauriGlobal;
	}

	const tauri = getTauri();

	//#endregion

	//#region Configuration

	interface ITauriWindowConfig {
		windowId: number;
		logLevel: number;
		resourceDir: string;
		frontendDist: string;
		appDataDir: string;
	}

	interface ITauriHostInfo {
		homeDir: string;
		tmpDir: string;
		platform: string;
		arch: string;
		hostname: string;
	}

	const windowConfig = await tauri.core.invoke<ITauriWindowConfig>('get_window_configuration');
	const hostInfo = await tauri.core.invoke<ITauriHostInfo>('get_native_host_info');

	const tauriConfig = {
		windowId: windowConfig.windowId,
		logLevel: windowConfig.logLevel,
		resourceDir: windowConfig.resourceDir,
		frontendDist: windowConfig.frontendDist,
		appDataDir: windowConfig.appDataDir,
		homeDir: hostInfo.homeDir,
		tmpDir: hostInfo.tmpDir,
	};

	//#endregion

	//#region NLS — must be set before importing any workbench modules

	(globalThis as any)._VSCODE_NLS_MESSAGES = [];
	(globalThis as any)._VSCODE_NLS_LANGUAGE = 'en';
	document.documentElement.setAttribute('lang', 'en');

	//#endregion

	//#region File Root — required by FileAccess (network.ts)

	// frontendDist is "../out" relative to src-tauri/, so Tauri serves `out/`
	// as the root. Module IDs are like `vs/workbench/...`, and the served path
	// is `/vs/workbench/...`, so _VSCODE_FILE_ROOT should be the origin root.
	const baseUrl = `${window.location.origin}/`;
	(globalThis as any)._VSCODE_FILE_ROOT = baseUrl;

	//#endregion

	//#region CSS Import Maps

	// Port of Electron's setupCSSImportMaps (workbench.ts:452-495).
	// In dev mode (transpile), CSS imports in JS modules are preserved as-is.
	// We create an import map that intercepts each CSS URL and redirects it
	// to a blob URL containing `globalThis._VSCODE_CSS_LOAD(url)`, which
	// inserts a <link> element to load the actual CSS.
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
		(globalThis as any)._VSCODE_CSS_LOAD = function (url: string): void {
			const link = document.createElement('link');
			link.setAttribute('rel', 'stylesheet');
			link.setAttribute('type', 'text/css');
			link.setAttribute('href', url);
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
		document.head.appendChild(importMapScript);

		console.log(`[Tauri Bootstrap] CSS import map installed with ${cssModules.length} modules`);
		performance.mark('code/didAddCssLoader');
	}

	await setupCSSImportMaps();

	//#endregion

	//#region Parse workspace from URL query params

	// When a folder/workspace is opened, the page is reloaded with ?folder=<uri>
	// or ?workspace=<uri> in the URL. Parse these to pass to the workbench.
	const query = new URL(document.location.href).searchParams;
	const folderParam = query.get('folder');
	const workspaceParam = query.get('workspace');

	//#endregion

	//#region Load Workbench

	try {
		performance.mark('code/willLoadWorkbenchMain');

		// Dynamic import of the compiled workbench module (side-effect imports)
		await import('../../../workbench/workbench.tauri.main.js');
		const desktopModule = await import('../../../workbench/tauri-browser/desktop.tauri.main.js');

		performance.mark('code/didLoadWorkbenchMain');

		const main = new desktopModule.TauriDesktopMain(tauriConfig, folderParam ?? undefined, workspaceParam ?? undefined);
		await main.open();

		performance.mark('code/didStartWorkbench');
	} catch (error) {
		console.error('[Tauri Bootstrap] Failed to load workbench:', error);

		// Show error in the body so the user sees something
		document.body.textContent = '';
		const errorEl = document.createElement('div');
		errorEl.style.cssText = 'padding: 20px; font-family: monospace; white-space: pre-wrap;';
		errorEl.textContent = `Failed to start workbench:\n\n${error instanceof Error ? error.stack || error.message : String(error)}`;
		document.body.appendChild(errorEl);
	}

	//#endregion
})();
