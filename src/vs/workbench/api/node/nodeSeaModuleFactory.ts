/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INodeModuleFactory } from '../common/extHostRequireInterceptor.js';
import * as nodeSeaShim from './nodeSeaShim.js';

/**
 * Factory that provides the `node:sea` stub module to extensions.
 *
 * Bun does not support `node:sea`. This factory returns a singleton stub where
 * `isSea()` is always `false` and asset methods throw, matching Node.js
 * behavior outside of a Single Executable Application.
 */
export class NodeSeaModuleFactory implements INodeModuleFactory {
	public readonly nodeModuleName = 'node:sea';

	/** Singleton module object exposing the `node:sea` stub API. */
	private readonly _module: object = {
		isSea: nodeSeaShim.isSea,
		getAsset: nodeSeaShim.getAsset,
		getAssetAsBlob: nodeSeaShim.getAssetAsBlob,
		getRawAsset: nodeSeaShim.getRawAsset,
	};

	/**
	 * Loads the `node:sea` stub module.
	 *
	 * Returns a singleton module object that exposes `isSea`, `getAsset`,
	 * `getAssetAsBlob`, and `getRawAsset` from the shim. The same instance
	 * is reused across all extension loads since the stub has no per-extension state.
	 *
	 * @param _request - The module identifier being requested (unused).
	 * @param _parent - The parent module requesting the import (unused).
	 * @param _original - The original Node.js require function (unused).
	 * @returns The `node:sea` stub module object.
	 */
	load(_request: string, _parent: unknown, _original: (id: string) => unknown): object {
		return this._module;
	}
}
