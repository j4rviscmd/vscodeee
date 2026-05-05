/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stub shim for the `node:sea` (Single Executable Applications) module.
 *
 * Bun does not support `node:sea`. Since the extension host always runs as
 * a regular process (never as a SEA), `isSea()` returns `false` and all
 * asset-retrieval methods throw — matching Node.js behavior when not running
 * inside a single executable.
 */

/**
 * Whether the Node.js application is running from a Single Executable Application.
 * Always `false` in the extension host because it runs as a standard Bun process.
 */
export function isSea(): false {
	return false;
}

/**
 * Throws because the process is not a Single Executable Application.
 *
 * @param _key - The asset key (unused — always throws).
 * @throws {Error} Always throws.
 */
export function getAsset(_key: string): never {
	throw new Error('[node:sea shim] getAsset() is not available because this process is not a Single Executable Application');
}

/**
 * Throws because the process is not a Single Executable Application.
 *
 * @param _key - The asset key (unused — always throws).
 * @throws {Error} Always throws.
 */
export function getAssetAsBlob(_key: string, _options?: { type?: string }): never {
	throw new Error('[node:sea shim] getAssetAsBlob() is not available because this process is not a Single Executable Application');
}

/**
 * Throws because the process is not a Single Executable Application.
 *
 * @param _key - The asset key (unused — always throws).
 * @throws {Error} Always throws.
 */
export function getRawAsset(_key: string): never {
	throw new Error('[node:sea shim] getRawAsset() is not available because this process is not a Single Executable Application');
}
