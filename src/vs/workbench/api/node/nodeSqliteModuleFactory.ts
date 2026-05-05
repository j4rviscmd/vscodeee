/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INodeModuleFactory } from '../common/extHostRequireInterceptor.js';
import * as nodeSqliteShim from './nodeSqliteShim.js';

/**
 * Factory that provides the `node:sqlite` polyfill module to extensions.
 *
 * Returns a singleton module object wrapping `bun:sqlite` to provide
 * `node:sqlite` compatibility. Unlike the `vscode` module factory,
 * this does NOT need per-extension API instances — the same SQLite
 * shim is shared across all extensions.
 */
export class NodeSqliteModuleFactory implements INodeModuleFactory {
	public readonly nodeModuleName = 'node:sqlite';

	private _module: object | null = null;

	/**
	 * Loads the `node:sqlite` polyfill module.
	 *
	 * Returns a singleton module object that exposes `DatabaseSync`,
	 * `StatementSync`, `backup`, and `constants` from the shim.
	 * The same instance is reused across all extension loads.
	 *
	 * @param _request - The module identifier being requested (unused).
	 * @param _parent - The parent module requesting the import (unused).
	 * @param _original - The original Node.js require function (unused).
	 * @returns The `node:sqlite` compatible module object.
	 */
	load(_request: string, _parent: unknown, _original: (id: string) => unknown): object {
		if (!this._module) {
			this._module = {
				DatabaseSync: nodeSqliteShim.DatabaseSync,
				StatementSync: nodeSqliteShim.StatementSync,
				backup: nodeSqliteShim.backup,
				constants: nodeSqliteShim.constants,
			};
		}
		return this._module;
	}
}
