/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { ILogService } from '../../../../platform/log/common/log.js';
import { SearchRange } from '../common/search.js';
import * as searchExtTypes from '../common/searchExtTypes.js';
import { rgPath } from '@vscode/ripgrep';

// If @vscode/ripgrep is in an .asar file, then the binary is unpacked.
const rgDiskPath = rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');

// Tauri's bundle.resources strips the execute bit from rg. Restore it once before first spawn.
let _rgChmodDone = false;
/**
 * Ensures the ripgrep binary has the execute permission bit set.
 *
 * Tauri's bundle.resources strips the execute bit from ripgrep during packaging.
 * This function restores it (chmod 755) exactly once before the first ripgrep spawn.
 * Subsequent calls are no-ops.
 */
export function ensureRgExecutable(): void {
	if (!_rgChmodDone) {
		try { fs.chmodSync(rgDiskPath, 0o755); } catch { /* may already be executable */ }
		_rgChmodDone = true;
	}
}

/**
 * Absolute file system path to the ripgrep binary, with `.asar` references resolved to
 * `.asar.unpacked` so that the actual unpacked binary is used.
 */
export { rgDiskPath };

/**
 * A type representing a value that may be `null` or `undefined`.
 *
 * @typeParam T - The underlying type of the value.
 */
export type Maybe<T> = T | null | undefined;

/**
 * Prepends a leading "/" to a glob pattern if it does not already start with "**" or "/".
 * This anchors the glob to the search root so ripgrep interprets it relative to the base folder.
 *
 * @param glob - The glob pattern to anchor.
 * @returns The anchored glob pattern.
 *
 * @example
 * anchorGlob('*.ts')      // prepends leading slash
 * anchorGlob('/src/*.ts') // unchanged, already anchored
 */
export function anchorGlob(glob: string): string {
	return glob.startsWith('**') || glob.startsWith('/') ? glob : `/${glob}`;
}

/**
 * Converts an extension API {@link searchExtTypes.Range} to an internal {@link SearchRange}.
 *
 * @param range - The extension API range to convert.
 * @returns The equivalent internal search range.
 */
export function rangeToSearchRange(range: searchExtTypes.Range): SearchRange {
	return new SearchRange(range.start.line, range.start.character, range.end.line, range.end.character);
}

/**
 * Converts an internal {@link SearchRange} to an extension API {@link searchExtTypes.Range}.
 *
 * @param range - The internal search range to convert.
 * @returns The equivalent extension API range.
 */
export function searchRangeToRange(range: SearchRange): searchExtTypes.Range {
	return new searchExtTypes.Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
}

/**
 * A minimal output channel interface used for logging ripgrep search diagnostics.
 */
export interface IOutputChannel {
	appendLine(msg: string): void;
}

/**
 * An {@link IOutputChannel} implementation that writes diagnostic messages to the VS Code log service.
 * Each message is prefixed with a configurable label and the `#search` tag for easy filtering.
 */
export class OutputChannel implements IOutputChannel {
	constructor(private prefix: string, @ILogService private readonly logService: ILogService) { }

	appendLine(msg: string): void {
		this.logService.debug(`${this.prefix}#search`, msg);
	}
}
