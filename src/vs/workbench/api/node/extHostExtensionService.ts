/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as performance from '../../../base/common/performance.js';
import type * as vscode from 'vscode';
import { createApiFactoryAndRegisterActors } from '../common/extHost.api.impl.js';
import { INodeModuleFactory, RequireInterceptor } from '../common/extHostRequireInterceptor.js';
import { ExtensionActivationTimesBuilder } from '../common/extHostExtensionActivator.js';
import { connectProxyResolver } from './proxyResolver.js';
import { AbstractExtHostExtensionService } from '../common/extHostExtensionService.js';
import { ExtHostDownloadService } from './extHostDownloadService.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ExtensionRuntime } from '../common/extHostTypes.js';
import { CLIServer } from './extHostCLIServer.js';
import { realpathSync } from '../../../base/node/pfs.js';
import { ExtHostConsoleForwarder } from './extHostConsoleForwarder.js';
import { ExtHostDiskFileSystemProvider } from './extHostDiskFileSystemProvider.js';
import nodeModule from 'node:module';
import { assertType } from '../../../base/common/types.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { BidirectionalMap } from '../../../base/common/map.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostChildProcessInterceptor } from './extHostChildProcessInterceptor.js';

const require = nodeModule.createRequire(import.meta.url);

/**
 * Detect if the current runtime is Bun.
 *
 * Bun provides `Module._load` and `Module._resolveFilename` as compatibility
 * stubs, but only `_resolveFilename` is actually invoked during `require()`.
 * `Module._load` patches are silently ignored by Bun's native module pipeline.
 */
const isBunRuntime = typeof (globalThis as any).Bun !== 'undefined';

class NodeModuleRequireInterceptor extends RequireInterceptor {

	protected _installInterceptor(): void {
		const that = this;
		const node_module = require('module');

		if (isBunRuntime) {
			// Bun: Module._load is NOT called by Bun's native require() pipeline.
			// Instead, we use Module._resolveFilename to redirect intercepted modules
			// to a shim file that calls back into our factory.
			this._installBunInterceptor(node_module);
		} else {
			// Node.js: Classic Module._load patching (proven approach)
			this._installNodeInterceptor(node_module);
		}

		// _resolveLookupPaths patch works on both runtimes
		const originalLookup = node_module._resolveLookupPaths;
		node_module._resolveLookupPaths = (request: string, parent: unknown) => {
			return originalLookup.call(this, applyAlternatives(request), parent);
		};

		// _resolveFilename patch for vsda compatibility (both runtimes)
		const existingResolveFilename = node_module._resolveFilename;
		if (!isBunRuntime) {
			// On Node.js, only add the vsda fix (Bun path handles this in its own interceptor)
			node_module._resolveFilename = function resolveFilename(request: string, parent: unknown, isMain: boolean, options?: { paths?: string[] }) {
				if (request === 'vsda' && Array.isArray(options?.paths) && options.paths.length === 0) {
					options.paths = node_module._nodeModulePaths(import.meta.dirname);
				}
				return existingResolveFilename.call(this, request, parent, isMain, options);
			};
		}

		const applyAlternatives = (request: string) => {
			for (const alternativeModuleName of that._alternatives) {
				const alternative = alternativeModuleName(request);
				if (alternative) {
					request = alternative;
					break;
				}
			}
			return request;
		};
	}

	/**
	 * Node.js-specific interception via Module._load.
	 *
	 * This is the original VS Code approach. Module._load is the central
	 * entry point for all require() calls in Node.js, making it ideal for
	 * intercepting module requests before they hit the filesystem.
	 */
	private _installNodeInterceptor(node_module: any): void {
		const that = this;
		const originalLoad = node_module._load;
		node_module._load = function load(request: string, parent: { filename: string }, isMain: boolean) {
			request = that._applyAlternatives(request);
			if (!that._factories.has(request)) {
				return originalLoad.apply(this, arguments);
			}
			return that._factories.get(request)!.load(
				request,
				URI.file(realpathSync(parent.filename)),
				request => originalLoad.apply(this, [request, parent, isMain])
			);
		};
	}

	/**
	 * Bun-specific interception via Module._resolveFilename + per-module shim files.
	 *
	 * Bun's native module system does NOT call Module._load during require().
	 * However, Module._resolveFilename IS invoked. We exploit this by:
	 * 1. Intercepting _resolveFilename for registered module names ('vscode', etc.)
	 * 2. Storing the caller's parent filename in a global (synchronous, no race)
	 * 3. Returning a per-module shim file path that calls a global loader function
	 *
	 * Key insight: Bun evaluates the shim file AFTER _resolveFilename returns,
	 * and `delete require.cache[shimPath]` forces re-evaluation each time.
	 * The shim calls a global loader function that has closure access to the
	 * factories map and URI class, avoiding the need to import them in the shim.
	 */
	private _installBunInterceptor(node_module: any): void {
		const that = this;
		const originalResolveFilename = node_module._resolveFilename;

		// Global keys for Bun shim communication
		const parentKey = '__VSCODEEE_BUN_PARENT__';
		const loaderKey = '__VSCODEEE_BUN_LOADER__';

		// Expose a loader function globally. The shim files call this with
		// the module name and receive the factory result. This keeps URI and
		// factory references inside the closure — no need to import them in shims.
		(globalThis as any)[parentKey] = '';
		(globalThis as any)[loaderKey] = (moduleName: string, shimRequire: (id: string) => any): any => {
			const factory = that._factories.get(moduleName);
			const parentFilename = (globalThis as any)[parentKey] || 'unknown';
			if (factory) {
				return factory.load(
					moduleName,
					URI.file(realpathSync(parentFilename)),
					shimRequire
				);
			}
			return {};
		};

		// Create shim directory
		const shimDir = this._createBunShimDir();

		node_module._resolveFilename = function resolveFilename(request: string, parent: { filename?: string } | unknown, isMain: boolean, options?: { paths?: string[] }) {
			request = that._applyAlternatives(request);

			// Check if this module should be intercepted
			if (that._factories.has(request)) {
				// Store caller context for the shim to read synchronously
				const parentFilename = (parent as { filename?: string })?.filename || 'unknown';
				(globalThis as any)[parentKey] = parentFilename;

				// Get or create the shim file for this module
				const shimPath = that._getBunShimPath(shimDir, request, loaderKey);

				// Delete from require cache so Bun re-evaluates the shim
				// (otherwise it returns the cached result from the first call)
				delete require.cache[shimPath];

				return shimPath;
			}

			// vsda compatibility fix (same as Node.js)
			if (request === 'vsda' && Array.isArray(options?.paths) && options.paths.length === 0) {
				options.paths = node_module._nodeModulePaths(import.meta.dirname);
			}

			return originalResolveFilename.call(this, request, parent, isMain, options);
		};
	}

	/**
	 * Create the directory for Bun shim files.
	 * Also registers cleanup on process exit and removes stale shim dirs
	 * from dead processes to prevent gradual disk accumulation.
	 */
	private _createBunShimDir(): string {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		const tmpDir = os.tmpdir();
		const shimDir = path.join(tmpDir, `vscodeee-bun-shims-${process.pid}`);
		fs.mkdirSync(shimDir, { recursive: true });

		// Register cleanup on process exit
		const cleanup = () => {
			try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		};
		process.on('exit', cleanup);
		process.on('SIGTERM', cleanup);
		process.on('SIGINT', cleanup);

		// Remove stale shim directories from dead processes (best-effort)
		try {
			const prefix = 'vscodeee-bun-shims-';
			for (const entry of fs.readdirSync(tmpDir)) {
				if (entry.startsWith(prefix) && entry !== `${prefix}${process.pid}`) {
					const pid = parseInt(entry.slice(prefix.length), 10);
					if (!isNaN(pid) && !this._isProcessAlive(pid)) {
						fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
					}
				}
			}
		} catch { /* best-effort: ignore errors during stale cleanup */ }

		return shimDir;
	}

	/**
	 * Check if a process with the given PID is still alive.
	 */
	private _isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get or create a shim file for a specific intercepted module name.
	 *
	 * Each intercepted module gets its own shim file with the module name
	 * hard-coded. The shim calls the global loader function, which has closure
	 * access to the factories map and URI class.
	 */
	private _getBunShimPath(shimDir: string, moduleName: string, loaderKey: string): string {
		const fs = require('fs');
		const path = require('path');

		// Sanitize module name for use as filename
		const safeName = moduleName.replace(/[^a-zA-Z0-9_-]/g, '_');
		const shimPath = path.join(shimDir, `${safeName}.js`);

		if (!fs.existsSync(shimPath)) {
			// The shim calls the global loader function with the module name.
			// The loader has closure access to factories/URI — no imports needed.
			const shimContent = `'use strict';
const loader = globalThis['${loaderKey}'];
module.exports = loader ? loader('${moduleName}', require) : {};
`;
			fs.writeFileSync(shimPath, shimContent);
		}

		return shimPath;
	}

	/**
	 * Apply alternative module name mappings.
	 * Extracted as instance method for use by both Node and Bun interceptors.
	 */
	private _applyAlternatives(request: string): string {
		for (const alternativeModuleName of this._alternatives) {
			const alternative = alternativeModuleName(request);
			if (alternative) {
				return alternative;
			}
		}
		return request;
	}
}

class NodeModuleESMInterceptor extends RequireInterceptor {

	private static _createDataUri(scriptContent: string): string {
		return `data:text/javascript;base64,${Buffer.from(scriptContent).toString('base64')}`;
	}

	// This string is a script that runs in the loader thread of NodeJS.
	private static _loaderScript = `
	let lookup;
	export const initialize = async (context) => {
		let requestIds = 0;
		const { port } = context;
		const pendingRequests = new Map();
		port.onmessage = (event) => {
			const { id, url } = event.data;
			pendingRequests.get(id)?.(url);
		};
		lookup = url => {
			// debugger;
			const myId = requestIds++;
			return new Promise((resolve) => {
				pendingRequests.set(myId, resolve);
				port.postMessage({ id: myId, url, });
			});
		};
	};
	export const resolve = async (specifier, context, nextResolve) => {
		if (specifier !== 'vscode' || !context.parentURL) {
			return nextResolve(specifier, context);
		}
		const otherUrl = await lookup(context.parentURL);
		return {
			url: otherUrl,
			shortCircuit: true,
		};
	};`;

	private static _vscodeImportFnName = `_VSCODE_IMPORT_VSCODE_API`;

	private readonly _store = new DisposableStore();

	dispose(): void {
		this._store.dispose();
	}

	protected override _installInterceptor(): void {
		if (isBunRuntime) {
			// Bun: module.register() exists but is a no-op (the loader hook is never invoked).
			// For ESM extensions using `import 'vscode'`, Bun will resolve via the filesystem.
			// We create a physical node_modules/vscode/ shim package that calls our API factory.
			// TODO(Phase 2): Implement physical ESM shim package generation for Bun.
			// For now, most extensions use CJS (require('vscode')) which is handled by
			// NodeModuleRequireInterceptor. ESM extensions on Bun are not yet supported.
			this._installBunESMInterceptor();
			return;
		}

		// Node.js: Use the proven module.register() approach
		this._installNodeESMInterceptor();
	}

	/**
	 * Node.js ESM interception via module.register() + MessageChannel.
	 *
	 * Registers a loader hook that intercepts `import 'vscode'` by communicating
	 * with the main thread via MessagePort to resolve the per-extension API.
	 */
	private _installNodeESMInterceptor(): void {

		type Message = { id: string; url: string };

		const apiInstances = new BidirectionalMap<typeof vscode, string>();
		const apiImportDataUrl = new Map<string, string>();

		// define a global function that can be used to get API instances given a random key
		Object.defineProperty(globalThis, NodeModuleESMInterceptor._vscodeImportFnName, {
			enumerable: false,
			configurable: false,
			writable: false,
			value: (key: string) => {
				return apiInstances.getKey(key);
			}
		});

		const { port1, port2 } = new MessageChannel();

		let apiModuleFactory: INodeModuleFactory | undefined;

		// this is a workaround for the fact that the layer checker does not understand
		// that onmessage is NodeJS API here
		const port1LayerCheckerWorkaround: any = port1;

		port1LayerCheckerWorkaround.onmessage = (e: { data: Message }) => {

			// Get the vscode-module factory - which is the same logic that's also used by
			// the CommonJS require interceptor
			if (!apiModuleFactory) {
				apiModuleFactory = this._factories.get('vscode');
				assertType(apiModuleFactory);
			}

			const { id, url } = e.data;
			const uri = URI.parse(url);

			// Get or create the API instance. The interface is per extension and extensions are
			// looked up by the uri (e.data.url) and path containment.
			const apiInstance = apiModuleFactory.load('_not_used', uri, () => { throw new Error('CANNOT LOAD MODULE from here.'); });
			let key = apiInstances.get(apiInstance);
			if (!key) {
				key = generateUuid();
				apiInstances.set(apiInstance, key);
			}

			// Create and cache a data-url which is the import script for the API instance
			let scriptDataUrlSrc = apiImportDataUrl.get(key);
			if (!scriptDataUrlSrc) {
				const jsCode = `const _vscodeInstance = globalThis.${NodeModuleESMInterceptor._vscodeImportFnName}('${key}');\n\n${Object.keys(apiInstance).map((name => `export const ${name} = _vscodeInstance['${name}'];`)).join('\n')}`;
				scriptDataUrlSrc = NodeModuleESMInterceptor._createDataUri(jsCode);
				apiImportDataUrl.set(key, scriptDataUrlSrc);
			}

			port1.postMessage({
				id,
				url: scriptDataUrlSrc
			});
		};

		nodeModule.register(NodeModuleESMInterceptor._createDataUri(NodeModuleESMInterceptor._loaderScript), {
			parentURL: import.meta.url,
			data: { port: port2 },
			transferList: [port2],
		});

		this._store.add(toDisposable(() => {
			port1.close();
			port2.close();
		}));
	}

	/**
	 * Bun ESM interception via physical shim package.
	 *
	 * Since module.register() is a no-op in Bun, we cannot use ESM loader hooks.
	 * Instead, we rely on the CJS interceptor (Module._resolveFilename) which
	 * handles `require('vscode')` for the majority of extensions.
	 *
	 * For ESM extensions that use `import 'vscode'`, a physical
	 * `node_modules/vscode/` package would need to be generated at runtime.
	 * This is deferred to a future phase since most VS Code extensions still
	 * use CJS as their module format.
	 *
	 * TODO(Phase 3): Generate physical ESM shim package for Bun ESM support.
	 */
	private _installBunESMInterceptor(): void {
		// Define the global API accessor function (same interface as Node.js path)
		// This allows a physical shim package to call back for the API instance.
		Object.defineProperty(globalThis, NodeModuleESMInterceptor._vscodeImportFnName, {
			enumerable: false,
			configurable: true,
			writable: false,
			value: (key: string) => {
				// For Bun ESM, this would be called by the physical shim package
				return undefined;
			}
		});
	}
}

export class ExtHostExtensionService extends AbstractExtHostExtensionService {

	readonly extensionRuntime = ExtensionRuntime.Node;

	protected async _beforeAlmostReadyToRunExtensions(): Promise<void> {
		// make sure console.log calls make it to the render
		this._instaService.createInstance(ExtHostConsoleForwarder);

		// initialize API and register actors
		const extensionApiFactory = this._instaService.invokeFunction(createApiFactoryAndRegisterActors);

		// Register Download command
		this._instaService.createInstance(ExtHostDownloadService);

		// Register CLI Server for ipc
		if (this._initData.remote.isRemote && this._initData.remote.authority) {
			const cliServer = this._instaService.createInstance(CLIServer);
			process.env['VSCODE_IPC_HOOK_CLI'] = cliServer.ipcHandlePath;
		}

		// Register local file system shortcut
		this._instaService.createInstance(ExtHostDiskFileSystemProvider);

		// Module loading tricks
		await this._instaService.createInstance(NodeModuleRequireInterceptor, extensionApiFactory, { mine: this._myRegistry, all: this._globalRegistry })
			.install();

		// ESM loading tricks
		await this._store.add(this._instaService.createInstance(NodeModuleESMInterceptor, extensionApiFactory, { mine: this._myRegistry, all: this._globalRegistry }))
			.install();

		// Child process interceptor — ensures all child processes forked by
		// extensions inherit --no-experimental-require-module and their stderr is captured.
		// This fixes Language Server crashes in the Tauri migration where cp.fork() children
		// lose the Node.js flag because vscode-languageclient sets execArgv: [].
		// TODO(Phase 5-D): Remove once all extensions use stdio transport or Tauri is stable.
		const childProcessInterceptor = this._store.add(this._instaService.createInstance(ExtHostChildProcessInterceptor));
		childProcessInterceptor.install();

		performance.mark('code/extHost/didInitAPI');

		// Do this when extension service exists, but extensions are not being activated yet.
		const configProvider = await this._extHostConfiguration.getConfigProvider();
		await connectProxyResolver(this._extHostWorkspace, configProvider, this, this._logService, this._mainThreadTelemetryProxy, this._initData, this._store);
		performance.mark('code/extHost/didInitProxyResolver');
	}

	protected _getEntryPoint(extensionDescription: IExtensionDescription): string | undefined {
		return extensionDescription.main;
	}

	private async _doLoadModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder, mode: 'esm' | 'cjs'): Promise<T> {
		if (module.scheme !== Schemas.file) {
			throw new Error(`Cannot load URI: '${module}', must be of file-scheme`);
		}
		let r: T | null = null;
		activationTimesBuilder.codeLoadingStart();
		this._logService.trace(`ExtensionService#loadModule [${mode}] -> ${module.toString(true)}`);
		this._logService.flush();
		const extensionId = extension?.identifier.value;
		if (extension) {
			await this._extHostLocalizationService.initializeLocalizedMessages(extension);
		}
		try {
			if (extensionId) {
				performance.mark(`code/extHost/willLoadExtensionCode/${extensionId}`);
			}
			if (mode === 'esm') {
				r = <T>await import(module.toString(true));
			} else {
				r = <T>require(module.fsPath);
			}
		} finally {
			if (extensionId) {
				performance.mark(`code/extHost/didLoadExtensionCode/${extensionId}`);
			}
			activationTimesBuilder.codeLoadingStop();
		}
		return r;
	}

	protected async _loadCommonJSModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T> {
		return this._doLoadModule<T>(extension, module, activationTimesBuilder, 'cjs');
	}

	protected async _loadESMModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T> {
		return this._doLoadModule<T>(extension, module, activationTimesBuilder, 'esm');
	}

	public async $setRemoteEnvironment(env: { [key: string]: string | null }): Promise<void> {
		if (!this._initData.remote.isRemote) {
			return;
		}

		for (const key in env) {
			const value = env[key];
			if (value === null) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}
