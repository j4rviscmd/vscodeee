/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as path from '../../../../base/common/path.js';
import * as glob from '../../../../base/common/glob.js';
import { normalizeNFD } from '../../../../base/common/normalization.js';
import * as extpath from '../../../../base/common/extpath.js';
import { isMacintosh as isMac } from '../../../../base/common/platform.js';
import * as strings from '../../../../base/common/strings.js';
import { IFileQuery, IFolderQuery } from '../common/search.js';
import { anchorGlob, ensureRgExecutable, rgDiskPath } from './ripgrepSearchUtils.js';

/**
 * Spawns a ripgrep child process configured for file search (not text search).
 *
 * @param config - The file search query configuration.
 * @param folderQuery - The root folder to search within.
 * @param includePattern - Optional glob patterns to include (merged with folder-level includes).
 * @param excludePattern - Optional glob patterns to exclude (merged with folder-level excludes).
 * @param numThreads - Optional number of ripgrep threads.
 * @returns An object containing the spawned child process, the rg disk path, sibling clauses,
 *          the constructed argument list, and the working directory.
 */
export function spawnRipgrepCmd(config: IFileQuery, folderQuery: IFolderQuery, includePattern?: glob.IExpression, excludePattern?: glob.IExpression, numThreads?: number) {
	const rgArgs = getRgArgs(config, folderQuery, includePattern, excludePattern, numThreads);
	const cwd = folderQuery.folder.fsPath;
	ensureRgExecutable();
	return {
		cmd: cp.spawn(rgDiskPath, rgArgs.args, { cwd }),
		rgDiskPath,
		siblingClauses: rgArgs.siblingClauses,
		rgArgs,
		cwd
	};
}

/**
 * Builds the ripgrep command-line arguments for a file search.
 *
 * @param config - The file search query configuration.
 * @param folderQuery - The root folder to search within.
 * @param includePattern - Optional glob patterns to include.
 * @param excludePattern - Optional glob patterns to exclude.
 * @param numThreads - Optional number of ripgrep threads.
 * @returns The argument array and any sibling clauses derived from the exclude patterns.
 */
function getRgArgs(config: IFileQuery, folderQuery: IFolderQuery, includePattern?: glob.IExpression, excludePattern?: glob.IExpression, numThreads?: number) {
	const args = ['--files', '--hidden', '--case-sensitive', '--no-require-git'];

	if (config.ignoreGlobCase || folderQuery.ignoreGlobCase) {
		args.push('--glob-case-insensitive');
		args.push('--ignore-file-case-insensitive');
	}

	// includePattern can't have siblingClauses
	foldersToIncludeGlobs([folderQuery], includePattern, false).forEach(globArg => {
		const inclusion = anchorGlob(globArg);
		args.push('-g', inclusion);
		if (isMac) {
			const normalized = normalizeNFD(inclusion);
			if (normalized !== inclusion) {
				args.push('-g', normalized);
			}
		}
	});

	const rgGlobs = foldersToRgExcludeGlobs([folderQuery], excludePattern, undefined, false);
	rgGlobs.globArgs.forEach(globArg => {
		const exclusion = `!${anchorGlob(globArg)}`;
		args.push('-g', exclusion);
		if (isMac) {
			const normalized = normalizeNFD(exclusion);
			if (normalized !== exclusion) {
				args.push('-g', normalized);
			}
		}
	});
	if (folderQuery.disregardIgnoreFiles !== false) {
		// Don't use .gitignore or .ignore
		args.push('--no-ignore');
	} else if (folderQuery.disregardParentIgnoreFiles !== false) {
		args.push('--no-ignore-parent');
	}

	// Follow symlinks
	if (!folderQuery.ignoreSymlinks) {
		args.push('--follow');
	}

	if (config.exists) {
		args.push('--quiet');
	}

	if (numThreads) {
		args.push('--threads', `${numThreads}`);
	}

	args.push('--no-config');
	if (folderQuery.disregardGlobalIgnoreFiles) {
		args.push('--no-ignore-global');
	}

	return {
		args,
		siblingClauses: rgGlobs.siblingClauses
	};
}

/**
 * Result of converting glob expressions to ripgrep-compatible glob arguments.
 */
interface IRgGlobResult {
	globArgs: string[];
	siblingClauses: glob.IExpression;
}

/**
 * Converts folder-level and global exclude patterns into ripgrep glob arguments.
 *
 * @param folderQueries - The folder queries whose exclude patterns to merge.
 * @param globalExclude - Additional global exclude patterns.
 * @param excludesToSkip - A set of pattern keys to skip during conversion.
 * @param absoluteGlobs - Whether to produce absolute glob paths.
 * @returns The ripgrep glob arguments and any sibling clauses extracted from the patterns.
 */
function foldersToRgExcludeGlobs(folderQueries: IFolderQuery[], globalExclude?: glob.IExpression, excludesToSkip?: Set<string>, absoluteGlobs = true): IRgGlobResult {
	const globArgs: string[] = [];
	let siblingClauses: glob.IExpression = {};
	folderQueries.forEach(folderQuery => {
		const totalExcludePattern = Object.assign({}, folderQuery.excludePattern || {}, globalExclude || {});
		const result = globExprsToRgGlobs(totalExcludePattern, absoluteGlobs ? folderQuery.folder.fsPath : undefined, excludesToSkip);
		globArgs.push(...result.globArgs);
		if (result.siblingClauses) {
			siblingClauses = Object.assign(siblingClauses, result.siblingClauses);
		}
	});

	return { globArgs, siblingClauses };
}

/**
 * Converts folder-level and global include patterns into ripgrep glob arguments.
 *
 * @param folderQueries - The folder queries whose include patterns to merge.
 * @param globalInclude - Additional global include patterns.
 * @param absoluteGlobs - Whether to produce absolute glob paths.
 * @returns The ripgrep include glob argument strings.
 */
function foldersToIncludeGlobs(folderQueries: IFolderQuery[], globalInclude?: glob.IExpression, absoluteGlobs = true): string[] {
	const globArgs: string[] = [];
	folderQueries.forEach(folderQuery => {
		const totalIncludePattern = Object.assign({}, globalInclude || {}, folderQuery.includePattern || {});
		const result = globExprsToRgGlobs(totalIncludePattern, absoluteGlobs ? folderQuery.folder.fsPath : undefined);
		globArgs.push(...result.globArgs);
	});

	return globArgs;
}

/**
 * Converts a glob expression object (key-value map of patterns to boolean/sibling-clause values)
 * into ripgrep-compatible glob arguments.
 *
 * Handles Windows drive-letter normalization, UNC path edge cases, and sibling clauses.
 *
 * @param patterns - A glob expression where keys are glob patterns and values indicate inclusion
 *                   (boolean) or conditional sibling clauses (object with a `when` property).
 * @param folder - Optional base folder to make globs absolute.
 * @param excludesToSkip - A set of pattern keys to skip during conversion.
 * @returns The ripgrep glob arguments and any sibling clauses.
 */
function globExprsToRgGlobs(patterns: glob.IExpression, folder?: string, excludesToSkip?: Set<string>): IRgGlobResult {
	const globArgs: string[] = [];
	const siblingClauses: glob.IExpression = {};
	Object.keys(patterns)
		.forEach(key => {
			if (excludesToSkip && excludesToSkip.has(key)) {
				return;
			}

			if (!key) {
				return;
			}

			const value = patterns[key];
			key = trimTrailingSlash(folder ? getAbsoluteGlob(folder, key) : key);

			// glob.ts requires forward slashes, but a UNC path still must start with \\
			// #38165 and #38151
			if (key.startsWith('\\\\')) {
				key = '\\\\' + key.substr(2).replace(/\\/g, '/');
			} else {
				key = key.replace(/\\/g, '/');
			}

			if (typeof value === 'boolean' && value) {
				if (key.startsWith('\\\\')) {
					// Absolute globs UNC paths don't work properly, see #58758
					key += '**';
				}

				globArgs.push(fixDriveC(key));
			} else if (value && value.when) {
				siblingClauses[key] = value;
			}
		});

	return { globArgs, siblingClauses };
}

/**
 * Resolves a glob like "node_modules/**" in "/foo/bar" to "/foo/bar/node_modules/**".
 * Special cases C:/foo paths to write the glob like /foo instead - see https://github.com/BurntSushi/ripgrep/issues/530.
 *
 * Exported for testing
 */
export function getAbsoluteGlob(folder: string, key: string): string {
	return path.isAbsolute(key) ?
		key :
		path.join(folder, key);
}

/**
 * Removes trailing backslashes and forward slashes from a path string.
 *
 * @param str - The path string to trim.
 * @returns The path string without trailing slashes.
 */
function trimTrailingSlash(str: string): string {
	str = strings.rtrim(str, '\\');
	return strings.rtrim(str, '/');
}

/**
 * Normalizes a Windows path on the C: drive to use a leading "/" instead of "C:/".
 * This works around a ripgrep issue where C: drive paths are not handled correctly.
 * See https://github.com/BurntSushi/ripgrep/issues/530.
 *
 * @param path - The file path to normalize.
 * @returns The normalized path, or the original path if it is not on the C: drive.
 */
export function fixDriveC(path: string): string {
	const root = extpath.getRoot(path);
	return root.toLowerCase() === 'c:/' ?
		path.replace(/^c:[/\\]/i, '/') :
		path;
}
