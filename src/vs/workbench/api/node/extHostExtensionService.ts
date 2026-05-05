/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as performance from '../../../base/common/performance.js';
import { createApiFactoryAndRegisterActors } from '../common/extHost.api.impl.js';
import { RequireInterceptor } from '../common/extHostRequireInterceptor.js';
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
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ExtHostChildProcessInterceptor } from './extHostChildProcessInterceptor.js';
import { NodeSqliteModuleFactory } from './nodeSqliteModuleFactory.js';
import { NodeSeaModuleFactory } from './nodeSeaModuleFactory.js';

const nodeRequire = nodeModule.createRequire(import.meta.url);
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const os = nodeRequire('os');

/** Type signature for Node.js Module._resolveFilename, used by both the stored original and the replacement. */
type ResolveFilenameFn = (request: string, parent: { filename?: string } | unknown, isMain: boolean, options?: { paths?: string[] }) => string;

/**
 * Register best-effort cleanup of a directory on process exit signals.
 * Shared by both CJS and ESM interceptors.
 */
function registerProcessCleanup(dir: string): void {
	const cleanup = () => {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	};
	process.on('exit', cleanup);
	process.on('SIGTERM', cleanup);
	process.on('SIGINT', cleanup);
}

/**
 * Node.js/Bun-specific require() interceptor for the extension host.
 *
 * Intercepts `Module._resolveFilename` so that when an extension calls
 * `require('vscode')` (or other registered module names), the call is
 * redirected to the per-extension API factory. On Bun, a per-module shim
 * file mechanism is used because Bun does not invoke `Module._load`.
 */
class NodeModuleRequireInterceptor extends RequireInterceptor {

	protected _installInterceptor(): void {
		const node_module = nodeRequire('module');

		this._installBunInterceptor(node_module);

		const originalLookup = node_module._resolveLookupPaths;
		node_module._resolveLookupPaths = (request: string, parent: unknown) => {
			return originalLookup.call(this, this._applyAlternatives(request), parent);
		};
	}

	/**
	 * Interception via Module._resolveFilename + per-module shim files.
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
	private _installBunInterceptor(node_module: Record<string, unknown>): void {
		const that = this;
		const originalResolveFilename = node_module._resolveFilename as ResolveFilenameFn;

		// Global keys for Bun shim communication
		const parentKey = '__VSCODEEE_BUN_PARENT__';
		const loaderKey = '__VSCODEEE_BUN_LOADER__';

		// Expose a loader function globally. The shim files call this with
		// the module name and receive the factory result. This keeps URI and
		// factory references inside the closure — no need to import them in shims.
		(globalThis as Record<string, unknown>)[parentKey] = '';
		(globalThis as Record<string, unknown>)[loaderKey] = (moduleName: string, shimRequire: (id: string) => unknown): unknown => {
			const factory = that._factories.get(moduleName);
			const parentFilename = (globalThis as Record<string, unknown>)[parentKey] as string || 'unknown';
			if (factory) {
				return factory.load(
					moduleName,
					URI.file(realpathSync(parentFilename)),
					shimRequire as (id: string) => unknown
				);
			}
			return {};
		};

		// Create shim directory
		const shimDir = this._createBunShimDir();

		node_module._resolveFilename = function resolveFilename(request: string, parent: { filename?: string } | unknown, isMain: boolean, options?: { paths?: string[] }): string {
			request = that._applyAlternatives(request);

			// Check if this module should be intercepted
			if (that._factories.has(request)) {
				// Store caller context for the shim to read synchronously
				const parentFilename = (parent as { filename?: string })?.filename || 'unknown';
				(globalThis as Record<string, unknown>)[parentKey] = parentFilename;

				// Get or create the shim file for this module
				const shimPath = that._getBunShimPath(shimDir, request, loaderKey);

				// Delete from require cache so Bun re-evaluates the shim
				// (otherwise it returns the cached result from the first call)
				delete nodeRequire.cache[shimPath];

				return shimPath;
			}

			// vsda compatibility fix (same as Node.js)
			if (request === 'vsda' && Array.isArray(options?.paths) && options.paths.length === 0) {
				options.paths = (node_module._nodeModulePaths as (dir: string) => string[])(import.meta.dirname);
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
		const tmpDir = os.tmpdir();
		const shimDir = path.join(tmpDir, `vscodeee-bun-shims-${process.pid}`);
		fs.mkdirSync(shimDir, { recursive: true });

		registerProcessCleanup(shimDir);

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
	 *
	 * Iterates through the registered alternative module name mappers and
	 * returns the first non-null mapping result, or the original request
	 * string if no mapping applies.
	 *
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

/**
 * ESM import interceptor for the Bun-based extension host.
 *
 * Since Bun does not support `module.register()` loader hooks, this class
 * creates a physical `node_modules/vscode/` CJS package at well-known
 * locations. Before each `import('vscode')`, the global API instance is
 * updated and the CJS module cache is busted so the package re-evaluates
 * with the correct per-extension API.
 */
class NodeModuleESMInterceptor extends RequireInterceptor {

	private readonly _store = new DisposableStore();

	/** Dispose registered cleanup handlers. */
	dispose(): void {
		this._store.dispose();
	}

	protected override _installInterceptor(): void {
		this._installBunESMInterceptor();
	}

	/**
	 * ESM interception via physical node_modules/vscode/ CJS package.
	 *
	 * Bun's module.register() is a no-op, so we cannot intercept ESM imports
	 * via loader hooks. Instead, we create a physical CJS package that Bun's
	 * standard ESM resolution finds on disk. Before each extension load, we
	 * set a global with the correct API instance and clear the CJS module cache
	 * so the package re-evaluates with the new API.
	 */
	private _installBunESMInterceptor(): void {
		// Create node_modules/vscode/ in the same shim directory as the CJS interceptor
		const tmpDir = os.tmpdir();
		const shimDir = path.join(tmpDir, `vscodeee-bun-shims-${process.pid}`);
		fs.mkdirSync(shimDir, { recursive: true });
		const vscodeDir = path.join(shimDir, 'node_modules', 'vscode');
		fs.mkdirSync(vscodeDir, { recursive: true });

		fs.writeFileSync(path.join(vscodeDir, 'package.json'), JSON.stringify({
			name: 'vscode',
			version: '0.0.0',
			main: 'index.js'
		}));

		// CJS module that reads the API from a global at load time.
		// Before each import(), we set the global and clear require.cache
		// so this module re-evaluates with the correct per-extension API.
		fs.writeFileSync(path.join(vscodeDir, 'index.js'), `'use strict';
module.exports = globalThis.__VSCODEEE_ESM_API__ || {};
`);

		// Place symlinks at locations Bun's ESM resolver will find.
		this._createBunESMSymlink('vscode', vscodeDir);

		// Register singleton modules (node:sqlite, node:sea) for ESM import resolution.
		// These are not per-extension — the global is set once during initialization.
		this._installBunESMSingletonModule(shimDir, 'node:sqlite', '__VSCODEEE_NODE_SQLITE_MODULE__');
		this._installBunESMSingletonModule(shimDir, 'node:sea', '__VSCODEEE_NODE_SEA_MODULE__');

		// Register a global function that _doLoadModule calls before each ESM import.
		// It looks up the per-extension API, sets the global, and busts the CJS cache.
		(globalThis as Record<string, unknown>).__VSCODEEE_PREPARE_ESM__ = (moduleUri: string) => {
			const factory = this._factories.get('vscode');
			if (!factory) {
				return;
			}
			const uri = URI.parse(moduleUri);
			const apiInstance = factory.load('_not_used', uri, () => { throw new Error('Cannot load module from here.'); });
			(globalThis as Record<string, unknown>).__VSCODEEE_ESM_API__ = apiInstance;

			// Clear CJS cache so the vscode module re-evaluates with the new API.
			// Use the known path directly since require.resolve('vscode') may fail
			// (the shim dir is not on NODE_PATH).
			try {
				delete nodeRequire.cache[path.join(vscodeDir, 'index.js')];
			} catch {
				// Module not yet loaded — first import will pick it up
			}
		};

		registerProcessCleanup(shimDir);
	}

	/**
	 * Create a singleton ESM module package for a factory-registered module.
	 *
	 * Creates node_modules/<moduleName>/ with a package.json and index.js that
	 * reads from a global variable, loads the module from the factory once,
	 * and places symlinks for Bun's ESM resolver.
	 */
	private _installBunESMSingletonModule(shimDir: string, moduleName: string, globalKey: string): void {
		const factory = this._factories.get(moduleName);
		if (!factory) {
			return;
		}

		const moduleDir = path.join(shimDir, 'node_modules', moduleName);
		fs.mkdirSync(moduleDir, { recursive: true });

		fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({
			name: moduleName,
			version: '0.0.0',
			main: 'index.js'
		}));

		const loadedModule = factory.load(moduleName, URI.parse(`file:///${moduleName}`), () => { throw new Error('Cannot load module from here.'); });
		(globalThis as Record<string, unknown>)[globalKey] = loadedModule;

		fs.writeFileSync(path.join(moduleDir, 'index.js'), `'use strict';
	module.exports = globalThis.${globalKey} || {};
`);

		this._createBunESMSymlink(moduleName, moduleDir);
	}

	/**
	 * Create symlinks to the vscode package at locations Bun's ESM resolver searches.
	 *
	 * Bun walks up the directory tree looking for node_modules/vscode/.
	 * Built-in extensions live under extensions/ and user extensions under
	 * ~/.vscodeee/extensions/, so we symlink at both roots.
	 */
	private _createBunESMSymlink(moduleName: string, packageDir: string): void {
		const createSymlink = (targetDir: string) => {
			const nodeModulesDir = path.join(targetDir, 'node_modules');
			const symlinkPath = path.join(nodeModulesDir, moduleName);
			try {
				fs.mkdirSync(nodeModulesDir, { recursive: true });
				// Remove stale symlink from a previous process and recreate
				try { fs.rmSync(symlinkPath, { force: true }); } catch { /* not a symlink or doesn't exist */ }
				fs.symlinkSync(packageDir, symlinkPath, 'junction');
			} catch { /* best-effort: may fail due to permissions */ }
		};

		// Built-in extensions: extensions/node_modules/vscode
		createSymlink(path.join(process.cwd(), 'extensions'));

		// User-installed extensions: ~/.vscodeee/extensions/node_modules/vscode
		const homeExtDir = path.join(os.homedir(), '.vscodeee', 'extensions');
		if (fs.existsSync(homeExtDir)) {
			createSymlink(homeExtDir);
		}
	}
}

/**
 * Node.js/Bun implementation of the extension host extension service.
 *
 * Manages the lifecycle of extensions in the extension host process,
 * including console forwarding, proxy resolution, module interception
 * (both CJS require() and ESM import()), and child process interception.
 */
export class ExtHostExtensionService extends AbstractExtHostExtensionService {

	/** Indicates this extension host runs on the Node.js/Bun runtime. */
	readonly extensionRuntime = ExtensionRuntime.Node;

	/**
	 * One-time initialization performed before extensions are activated.
	 *
	 * Sets up console forwarding, the extension API factory, download service,
	 * CLI server (for remote extensions), local disk file system provider,
	 * CJS and ESM module interceptors, child process interceptor, and
	 * the proxy resolver.
	 */
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

		// Module loading tricks — register built-in Node.js module polyfills
		const sqliteFactory = new NodeSqliteModuleFactory();
		const seaFactory = new NodeSeaModuleFactory();
		const requireInterceptor = this._instaService.createInstance(NodeModuleRequireInterceptor, extensionApiFactory, { mine: this._myRegistry, all: this._globalRegistry });
		requireInterceptor.register(sqliteFactory);
		requireInterceptor.register(seaFactory);
		await requireInterceptor.install();

		// ESM loading tricks
		const esmInterceptor = this._store.add(this._instaService.createInstance(NodeModuleESMInterceptor, extensionApiFactory, { mine: this._myRegistry, all: this._globalRegistry }));
		esmInterceptor.register(sqliteFactory);
		esmInterceptor.register(seaFactory);
		await esmInterceptor.install();

		// Child process interceptor — injects --no-experimental-require-module
		// into fork()ed child processes (vscode-languageclient resets execArgv to []),
		// captures stderr for diagnostics, and tracks process lifecycle.
		const childProcessInterceptor = this._store.add(this._instaService.createInstance(ExtHostChildProcessInterceptor));
		childProcessInterceptor.install();

		performance.mark('code/extHost/didInitAPI');

		// Do this when extension service exists, but extensions are not being activated yet.
		const configProvider = await this._extHostConfiguration.getConfigProvider();
		await connectProxyResolver(this._extHostWorkspace, configProvider, this, this._logService, this._mainThreadTelemetryProxy, this._initData, this._store);
		performance.mark('code/extHost/didInitProxyResolver');
	}

	/** Return the CJS main entry point path from the extension manifest. */
	protected _getEntryPoint(extensionDescription: IExtensionDescription): string | undefined {
		return extensionDescription.main;
	}

	/**
	 * Load a module using either ESM dynamic import or CJS require.
	 *
	 * For ESM modules, invokes the `__VSCODEEE_PREPARE_ESM__` global to set
	 * the per-extension API instance before importing. Records performance
	 * marks around the load and initializes localized messages for the extension.
	 *
	 * @param extension - The extension description, or `null` for non-extension modules.
	 * @param module - The file-scheme URI of the module to load.
	 * @param activationTimesBuilder - Builder for tracking extension activation timing.
	 * @param mode - Whether to load as `'esm'` (dynamic import) or `'cjs'` (require).
	 */
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
				((globalThis as Record<string, unknown>).__VSCODEEE_PREPARE_ESM__ as ((uri: string) => void) | undefined)?.(module.toString(true));
				r = <T>await import(module.toString(true));
			} else {
				r = <T>nodeRequire(module.fsPath);
			}
		} finally {
			if (extensionId) {
				performance.mark(`code/extHost/didLoadExtensionCode/${extensionId}`);
			}
			activationTimesBuilder.codeLoadingStop();
		}
		return r;
	}

	/** Load a CommonJS module via `require()`. */
	protected async _loadCommonJSModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T> {
		return this._doLoadModule<T>(extension, module, activationTimesBuilder, 'cjs');
	}

	/** Load an ESM module via dynamic `import()`. */
	protected async _loadESMModule<T>(extension: IExtensionDescription | null, module: URI, activationTimesBuilder: ExtensionActivationTimesBuilder): Promise<T> {
		return this._doLoadModule<T>(extension, module, activationTimesBuilder, 'esm');
	}

	/**
	 * Apply environment variable changes from the remote extension host connection.
	 *
	 * Sets or deletes process environment variables based on the provided map.
	 * Values of `null` indicate the variable should be removed from `process.env`.
	 * No-op when not running as a remote extension host.
	 *
	 * @param env - Map of environment variable names to their new values, or `null` to unset.
	 */
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
