/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @module bootstrap-esm-resolve
 *
 * ESM loader hooks for built-in extension module resolution.
 *
 * This module registers custom Node.js ESM `resolve` and `load` hooks via
 * `module.register()` to handle two problems that arise when built-in
 * extensions (bundled by esbuild into CJS with code-splitting) are loaded
 * in an ESM context:
 *
 * 1. Bare specifiers without `.js` extensions cause `ERR_MODULE_NOT_FOUND`.
 * 2. CJS modules accessed via `import()` return `{ default: module.exports }`
 *    instead of the raw exports object, breaking named export access.
 *
 * The hooks are scoped exclusively to files under `/extensions/` directories
 * so that normal application code resolution remains unaffected.
 */

import * as module from 'node:module';

/**
 * File suffixes probed during ESM module resolution.
 *
 * Node.js ESM requires explicit file extensions on relative import specifiers.
 * When esbuild bundles extensions into CJS with code-splitting, the generated
 * chunks use bare specifiers (e.g., `import("./chunk")`). This list mirrors
 * the standard Node.js resolution algorithm: each suffix is tried in order,
 * including directory index fallbacks (`/index.js`, `/index.mjs`, `/index.cjs`).
 *
 * @constant
 * @type {readonly string[]}
 */
const PROBE_SUFFIXES = ['.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'];

/**
 * Register ESM loader hooks (resolve + load) for built-in extensions.
 *
 * Two custom hooks are registered with Node.js via `module.register()`:
 *
 * - **resolve hook** — Appends `.js` extensions to bare specifiers when
 *   resolving from within `/extensions/` directories. Handles both relative
 *   specifiers (`./chunk`) and absolute specifiers (`/path/to/extensions/...`).
 *
 * - **load hook** — Detects esbuild-bundled CJS files in extensions by looking
 *   for the `__export(xxx_exports, { ... })` pattern. For matching files, it
 *   generates an ESM wrapper that uses `createRequire` + `require()` to load
 *   the CJS module and re-exports all named exports. This ensures `import()`
 *   returns `{ default, register, ... }` with proper named exports instead of
 *   the default-only `{ default: module.exports }`.
 *
 * @remarks
 * The hook code is embedded as a `data:` URL (base64-encoded) so that it
 * can be registered without a separate file on disk. The hooks are scoped
 * exclusively to files under `/extensions/` directories; all other module
 * resolution falls through to the default Node.js ESM loader unchanged.
 *
 * This function must be called once during the bootstrap phase, before any
 * built-in extension code is loaded.
 *
 * @see {@link PROBE_SUFFIXES} for the list of file extensions probed during resolution.
 * @see {@link https://nodejs.org/api/esm.html#resolvespecifier-context-nextresolve | Node.js ESM resolve hook}
 * @see {@link https://nodejs.org/api/esm.html#loadurl-context-nextload | Node.js ESM load hook}
 */
export function registerExtensionResolver(): void {
	const jsCode = `
	import { statSync, readFileSync } from 'node:fs';
	import { fileURLToPath, pathToFileURL } from 'node:url';
	import { createRequire } from 'node:module';

	const SUFFIXES = ${JSON.stringify(PROBE_SUFFIXES)};

	/**
	 * Probe the filesystem for a module path by appending common suffixes.
	 * Returns the resolved file:// URL on success, or undefined if not found.
	 */
	function probe(basePath) {
		for (const suffix of SUFFIXES) {
			try {
				const candidate = basePath + suffix;
				const candidateUrl = pathToFileURL(candidate);
				statSync(candidateUrl);
				return candidateUrl.href;
			} catch {}
		}
		return undefined;
	}

	/**
	 * Parse esbuild's __export() call to extract named export identifiers.
	 * Pattern: __export(xxx_exports, { name: () => name, ... })
	 * Returns an array of export names, or empty array if not an esbuild CJS bundle.
	 */
	function parseEsbuildNamedExports(source) {
		const headerMatch = source.match(/__export\\(\\w+_exports,\\s*\\{/);
		if (!headerMatch) {
			return [];
		}
		const tail = source.slice(headerMatch.index + headerMatch[0].length);
		const closeBrace = tail.indexOf('}');
		if (closeBrace === -1) {
			return [];
		}
		return [...tail.slice(0, closeBrace).matchAll(/\\b(\\w+)(?=\\s*:)/g)].map(m => m[1]);
	}

	export async function resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('./') || specifier.startsWith('../')) {
			// Relative specifiers: only intercept from /extensions/ directories
			const parentDir = new URL(context.parentURL).pathname;
			const segments = parentDir.split(/[\\\\/]/);
			if (segments.includes('extensions')) {
				const parent = new URL('.', context.parentURL);
				const base = parent.pathname + specifier;
				const resolved = probe(base);
				if (resolved) {
					return { shortCircuit: true, url: resolved };
				}
			}
		} else if (specifier.startsWith('/') && specifier.includes('/extensions/')) {
			// Absolute specifiers pointing into /extensions/ (e.g. extension entry points)
			const resolved = probe(specifier);
			if (resolved) {
				return { shortCircuit: true, url: resolved };
			}
		}

		return nextResolve(specifier, context);
	}

	export async function load(url, context, nextLoad) {
		// Only intercept file:// URLs within /extensions/ directories
		if (!url.startsWith('file://') || (!url.includes('/extensions/') && !url.includes('\\\\extensions\\\\'))) {
			return nextLoad(url, context);
		}

		// Only handle .js files (skip .mjs, .cjs, etc.)
		const filePath = fileURLToPath(url);
		if (!filePath.endsWith('.js')) {
			return nextLoad(url, context);
		}

		let source;
		try {
			source = readFileSync(filePath, 'utf-8');
		} catch {
			return nextLoad(url, context);
		}

		// Detect esbuild CJS bundle pattern: __export(xxx_exports, { ... })
		const namedExports = parseEsbuildNamedExports(source);
		if (namedExports.length === 0) {
			return nextLoad(url, context);
		}

		// Generate ESM wrapper that loads the CJS module via require()
		// and re-exports all named exports. Since require() uses the CJS
		// loader (not ESM hooks), there is no circular dependency.
		const wrapperSource = [
			'import { createRequire as __cr } from \\'node:module\\';',
			'const __req = __cr(import.meta.url);',
			'const __m = __req(' + JSON.stringify(filePath) + ');',
			'export default __m;',
			...namedExports.map(n => 'export const ' + n + ' = __m.' + n + ';')
		].join('\\n');

		return { format: 'module', source: wrapperSource, shortCircuit: true };
	}`;

	module.register(
		`data:text/javascript;base64,${Buffer.from(jsCode).toString('base64')}`,
		import.meta.url
	);
}
