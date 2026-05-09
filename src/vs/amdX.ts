/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AppResourcePath, FileAccess, nodeModulesAsarPath, nodeModulesPath, Schemas, VSCODE_AUTHORITY } from './base/common/network.js';
import * as platform from './base/common/platform.js';
import { IProductConfiguration } from './base/common/product.js';
import { URI } from './base/common/uri.js';
import { generateUuid } from './base/common/uuid.js';

export const canASAR = false; // TODO@esm: ASAR disabled in ESM

declare const window: any;
declare const document: any;
declare const self: any;
declare const globalThis: any;

/**
 * Represents a single AMD `define()` call captured from a loaded script.
 *
 * Stores the module ID (if provided), the dependency list, and the factory
 * callback. These are collected during script evaluation and consumed by
 * `AMDModuleImporter.load()` to resolve exports.
 */
class DefineCall {
	constructor(
		public readonly id: string | null | undefined,
		public readonly dependencies: string[] | null | undefined,
		public readonly callback: any
	) { }
}

/** Tracks the initialization state of the AMD define shim. */
enum AMDModuleImporterState {
	Uninitialized = 1,
	InitializedInternal,
	InitializedExternal
}

/**
 * AMD module loader that dynamically loads scripts and resolves their exports.
 *
 * Intercepts `globalThis.define()` calls from AMD-formatted scripts and
 * resolves their exported values. Supports three runtime contexts:
 *
 * - **Renderer** (browser): loads scripts via `<script>` element injection.
 * - **Web Worker**: loads scripts via dynamic `import()`.
 * - **Node.js**: loads scripts via `fs` + `vm` module.
 *
 * When an external AMD loader (e.g., from a test harness) is already present,
 * delegates to it instead of installing a custom shim.
 */
class AMDModuleImporter {
	public static INSTANCE = new AMDModuleImporter();

	private readonly _isWebWorker = (typeof self === 'object' && self.constructor && self.constructor.name === 'DedicatedWorkerGlobalScope');
	private readonly _isRenderer = typeof document === 'object';

	private readonly _defineCalls: DefineCall[] = [];
	private _state = AMDModuleImporterState.Uninitialized;
	private _amdPolicy: Pick<TrustedTypePolicy, 'name' | 'createScriptURL'> | undefined;

	constructor() { }

	/**
	 * Install the AMD `define()` shim if not already initialized.
	 *
	 * If an external AMD loader is detected (`globalThis.define` exists before
	 * initialization), marks the state as `InitializedExternal` and defers all
	 * `define()` calls to the existing loader. Otherwise installs a custom shim
	 * that captures define calls into `_defineCalls`.
	 * Also creates a Trusted Types policy for script URL validation in the renderer.
	 */
	private _initialize(): void {
		if (this._state === AMDModuleImporterState.Uninitialized) {
			if (globalThis.define) {
				this._state = AMDModuleImporterState.InitializedExternal;
				return;
			}
		} else {
			return;
		}

		this._state = AMDModuleImporterState.InitializedInternal;

		globalThis.define = (id: any, dependencies: any, callback: any) => {
			if (typeof id !== 'string') {
				callback = dependencies;
				dependencies = id;
				id = null;
			}
			if (typeof dependencies !== 'object' || !Array.isArray(dependencies)) {
				callback = dependencies;
				dependencies = null;
			}
			// if (!dependencies) {
			// 	dependencies = ['require', 'exports', 'module'];
			// }
			this._defineCalls.push(new DefineCall(id, dependencies, callback));
		};

		globalThis.define.amd = true;

		if (this._isRenderer) {
			this._amdPolicy = globalThis._VSCODE_WEB_PACKAGE_TTP ?? window.trustedTypes?.createPolicy('amdLoader', {
				createScriptURL(value: any) {
					if (value.startsWith(window.location.origin)) {
						return value;
					}
					if (value.startsWith(`${Schemas.vscodeFileResource}://${VSCODE_AUTHORITY}`)) {
						return value;
					}
					const fileServerUrl = (globalThis as Record<string, unknown>)._VSCODE_FILE_SERVER_URL;
					if (typeof fileServerUrl === 'string' && fileServerUrl && value.startsWith(fileServerUrl)) {
						return value;
					}
					throw new Error(`[trusted_script_src] Invalid script url: ${value}`);
				}
			});
		} else if (this._isWebWorker) {
			this._amdPolicy = globalThis._VSCODE_WEB_PACKAGE_TTP ?? globalThis.trustedTypes?.createPolicy('amdLoader', {
				createScriptURL(value: string) {
					return value;
				}
			});
		}
	}

	/**
	 * Load an AMD-formatted script and resolve its exported value.
	 *
	 * @param scriptSrc - The URL of the script to load.
	 * @returns The value exported by the script's `define()` callback.
	 * @throws If the script has unresolved dependencies or fails to load.
	 */
	public async load<T>(scriptSrc: string): Promise<T> {
		this._initialize();

		if (this._state === AMDModuleImporterState.InitializedExternal) {
			return new Promise<T>(resolve => {
				const tmpModuleId = generateUuid();
				globalThis.define(tmpModuleId, [scriptSrc], function (moduleResult: T) {
					resolve(moduleResult);
				});
			});
		}

		const defineCall = await (this._isWebWorker ? this._workerLoadScript(scriptSrc) : this._isRenderer ? this._rendererLoadScript(scriptSrc) : this._nodeJSLoadScript(scriptSrc));
		if (!defineCall) {
			console.warn(`Did not receive a define call from script ${scriptSrc}`);
			return <T>undefined;
		}
		// TODO@esm require, module
		const exports = {};
		const dependencyObjs: any[] = [];
		const dependencyModules: string[] = [];

		if (Array.isArray(defineCall.dependencies)) {

			for (const mod of defineCall.dependencies) {
				if (mod === 'exports') {
					dependencyObjs.push(exports);
				} else {
					dependencyModules.push(mod);
				}
			}
		}

		if (dependencyModules.length > 0) {
			throw new Error(`Cannot resolve dependencies for script ${scriptSrc}. The dependencies are: ${dependencyModules.join(', ')}`);
		}
		if (typeof defineCall.callback === 'function') {
			return defineCall.callback(...dependencyObjs) ?? exports;
		} else {
			return defineCall.callback;
		}
	}

	/**
	 * Load a script in the renderer (browser) context by injecting a `<script>` element.
	 *
	 * Applies Trusted Types policy to the script URL if available.
	 *
	 * @param scriptSrc - The URL of the script to load.
	 * @returns The `DefineCall` captured from the script, or `undefined` if none was emitted.
	 */
	private _rendererLoadScript(scriptSrc: string): Promise<DefineCall | undefined> {
		return new Promise<DefineCall | undefined>((resolve, reject) => {
			const scriptElement = document.createElement('script');
			scriptElement.setAttribute('async', 'async');
			scriptElement.setAttribute('type', 'text/javascript');

			const unbind = () => {
				scriptElement.removeEventListener('load', loadEventListener);
				scriptElement.removeEventListener('error', errorEventListener);
			};

			const loadEventListener = (e: any) => {
				unbind();
				resolve(this._defineCalls.pop());
			};

			const errorEventListener = (e: any) => {
				unbind();
				reject(e);
			};

			scriptElement.addEventListener('load', loadEventListener);
			scriptElement.addEventListener('error', errorEventListener);
			if (this._amdPolicy) {
				scriptSrc = this._amdPolicy.createScriptURL(scriptSrc) as unknown as string;
			}
			scriptElement.setAttribute('src', scriptSrc);
			window.document.getElementsByTagName('head')[0].appendChild(scriptElement);
		});
	}

	/**
	 * Load a script in a Web Worker context via dynamic `import()`.
	 *
	 * Applies Trusted Types policy to the script URL if available.
	 *
	 * @param scriptSrc - The URL of the script to load.
	 * @returns The `DefineCall` captured from the script, or `undefined` if none was emitted.
	 */
	private async _workerLoadScript(scriptSrc: string): Promise<DefineCall | undefined> {
		if (this._amdPolicy) {
			scriptSrc = this._amdPolicy.createScriptURL(scriptSrc) as unknown as string;
		}
		await import(/* webpackIgnore: true */ /* @vite-ignore */ scriptSrc);
		return this._defineCalls.pop();
	}

	/**
	 * Load a script in a Node.js context by reading the file and evaluating it via `vm.Script`.
	 *
	 * Strips shebang lines (`#!...`) before evaluation.
	 *
	 * @param scriptSrc - The file URI of the script to load.
	 * @returns The `DefineCall` captured from the script, or `undefined` if none was emitted.
	 * @throws If the file cannot be read, parsed, or evaluated.
	 */
	private async _nodeJSLoadScript(scriptSrc: string): Promise<DefineCall | undefined> {
		try {
			const fs = (await import(/* webpackIgnore: true */ /* @vite-ignore */ `${'fs'}`)).default;
			const vm = (await import(/* webpackIgnore: true */ /* @vite-ignore */ `${'vm'}`)).default;
			const module = (await import(/* webpackIgnore: true */ /* @vite-ignore */ `${'module'}`)).default;

			const filePath = URI.parse(scriptSrc).fsPath;
			const content = fs.readFileSync(filePath).toString();
			const scriptSource = module.wrap(content.replace(/^#!.*/, ''));
			const script = new vm.Script(scriptSource);
			const compileWrapper = script.runInThisContext();
			compileWrapper.apply();
			return this._defineCalls.pop();
		} catch (error) {
			throw error;
		}
	}
}

const cache = new Map<string, Promise<any>>();

/**
 * Utility for importing an AMD node module. This util supports AMD and ESM contexts and should be used while the ESM adoption
 * is on its way.
 *
 * e.g. pass in `vscode-textmate/release/main.js`
 */
export async function importAMDNodeModule<T>(nodeModuleName: string, pathInsideNodeModule: string, isBuilt?: boolean): Promise<T> {
	if (isBuilt === undefined) {
		const product = globalThis._VSCODE_PRODUCT_JSON as unknown as IProductConfiguration;
		isBuilt = Boolean((product ?? globalThis.vscode?.context?.configuration()?.product)?.commit);
	}

	const nodeModulePath = pathInsideNodeModule ? `${nodeModuleName}/${pathInsideNodeModule}` : nodeModuleName;
	if (cache.has(nodeModulePath)) {
		return cache.get(nodeModulePath)!;
	}
	let scriptSrc: string;
	if (/^\w[\w\d+.-]*:\/\//.test(nodeModulePath)) {
		// looks like a URL
		// bit of a special case for: src/vs/workbench/services/languageDetection/browser/languageDetectionWebWorker.ts
		scriptSrc = nodeModulePath;
	} else {
		const useASAR = (canASAR && isBuilt && !platform.isWeb);
		const actualNodeModulesPath = (useASAR ? nodeModulesAsarPath : nodeModulesPath);
		const resourcePath: AppResourcePath = `${actualNodeModulesPath}/${nodeModulePath}`;
		scriptSrc = FileAccess.asBrowserUri(resourcePath).toString(true);
	}
	const result = AMDModuleImporter.INSTANCE.load<T>(scriptSrc);
	cache.set(nodeModulePath, result);
	return result;
}

/**
 * Resolve the browser URL for an AMD node module without loading it.
 *
 * Computes the same URL that `importAMDNodeModule` would use for the given
 * module, but returns it as a string instead of dynamically importing the module.
 *
 * @param nodeModuleName - The npm package name (e.g., `vscode-textmate`).
 * @param pathInsideNodeModule - The path within the package (e.g., `release/main.js`).
 * @returns The fully resolved browser URL as a string.
 */
export function resolveAmdNodeModulePath(nodeModuleName: string, pathInsideNodeModule: string): string {
	const product = globalThis._VSCODE_PRODUCT_JSON as unknown as IProductConfiguration;
	const isBuilt = Boolean((product ?? globalThis.vscode?.context?.configuration()?.product)?.commit);
	const useASAR = (canASAR && isBuilt && !platform.isWeb);

	const nodeModulePath = `${nodeModuleName}/${pathInsideNodeModule}`;
	const actualNodeModulesPath = (useASAR ? nodeModulesAsarPath : nodeModulesPath);
	const resourcePath: AppResourcePath = `${actualNodeModulesPath}/${nodeModulePath}`;
	return FileAccess.asBrowserUri(resourcePath).toString(true);
}
