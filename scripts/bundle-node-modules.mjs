/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Bundle required node_modules for the Tauri production build.
 *
 * VS Code dynamically imports several node_modules at runtime via
 * `importAMDNodeModule()` and `resolveAmdNodeModulePath()`. In the Electron
 * build, these are available from the packaged `node_modules/` directory.
 * In our Tauri build, we use `bundle.resources` to place them in the app's
 * `Contents/Resources/node_modules/` directory, which matches the URL path
 * that the `vscode-file://` protocol handler resolves.
 *
 * This script copies only the specific files needed from the project's
 * `node_modules/` into `src-tauri/node_modules/`, which is then bundled
 * via the `"node_modules/"` entry in `tauri.conf.json` → `bundle.resources`.
 *
 * Usage:
 *   node scripts/bundle-node-modules.mjs
 *   node scripts/bundle-node-modules.mjs --clean   # remove staging dir first
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'node_modules');
const TARGET_DIR = path.join(REPO_ROOT, 'src-tauri', 'node_modules');

// ── Manifest of required node_modules ──────────────────────────────────
//
// Each entry is either:
//   - A specific file:      "pkg/path/to/file.ext"
//   - An entire directory:  "pkg/path/to/dir/"  (trailing slash)
//
// Files are loaded at runtime via importAMDNodeModule() or
// resolveAmdNodeModulePath() in src/vs/**/*.ts.

const REQUIRED_MODULES = [
	// ── TextMate syntax highlighting (critical) ──
	'vscode-oniguruma/release/main.js',
	'vscode-oniguruma/release/onig.wasm',
	'vscode-textmate/release/main.js',

	// ── Text encoding ──
	'@vscode/iconv-lite-umd/lib/iconv-lite-umd.js',
	'jschardet/dist/jschardet.min.js',

	// ── Terminal (xterm) ──
	'@xterm/xterm/lib/xterm.js',
	'@xterm/addon-clipboard/lib/addon-clipboard.js',
	'@xterm/addon-image/lib/addon-image.js',
	'@xterm/addon-ligatures/lib/addon-ligatures.js',
	'@xterm/addon-progress/lib/addon-progress.js',
	'@xterm/addon-search/lib/addon-search.js',
	'@xterm/addon-serialize/lib/addon-serialize.js',
	'@xterm/addon-unicode11/lib/addon-unicode11.js',
	'@xterm/addon-webgl/lib/addon-webgl.js',

	// ── Math rendering (Markdown preview) ──
	'katex/dist/katex.min.js',
	'katex/dist/katex.min.css',

	// ── Telemetry ──
	'@microsoft/1ds-core-js/bundle/ms.core.min.js',
	'@microsoft/1ds-post-js/bundle/ms.post.min.js',

	// ── Experimentation service ──
	'tas-client/dist/tas-client.min.js',

	// ── Tree-sitter (syntax parsing) ──
	'@vscode/tree-sitter-wasm/wasm/',

	// ── Language detection ──
	'@vscode/vscode-languagedetection/dist/',
	'@vscode/vscode-languagedetection/model/',
];

// ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const clean = args.includes('--clean');

/**
 * Recursively copy a directory.
 * @param {string} src
 * @param {string} dest
 * @returns {number} number of files copied
 */
function copyDirRecursive(src, dest) {
	if (!fs.existsSync(src)) {
		return 0;
	}
	let count = 0;
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			count += copyDirRecursive(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
			count++;
		}
	}
	return count;
}

/**
 * Copy a single file, creating parent directories as needed.
 * @param {string} src
 * @param {string} dest
 */
function copyFile(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
}

function main() {
	console.log('[bundle-node-modules] Bundling required node_modules for Tauri build...');

	if (clean && fs.existsSync(TARGET_DIR)) {
		console.log(`[bundle-node-modules] Cleaning ${TARGET_DIR}`);
		fs.rmSync(TARGET_DIR, { recursive: true });
	}

	let totalFiles = 0;
	let skipped = 0;

	for (const entry of REQUIRED_MODULES) {
		const isDir = entry.endsWith('/');
		const srcPath = path.join(SOURCE_DIR, entry);
		const destPath = path.join(TARGET_DIR, entry);

		if (!fs.existsSync(srcPath)) {
			// Some packages may not be installed (e.g., vsda is Microsoft-internal)
			console.warn(`[bundle-node-modules] WARN: ${entry} not found, skipping`);
			skipped++;
			continue;
		}

		if (isDir) {
			const count = copyDirRecursive(srcPath, destPath);
			console.log(`[bundle-node-modules]   ${entry} (${count} files)`);
			totalFiles += count;
		} else {
			copyFile(srcPath, destPath);
			console.log(`[bundle-node-modules]   ${entry}`);
			totalFiles++;
		}
	}

	// Compute total size
	let totalSize = 0;
	function sumSize(dir) {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				sumSize(fullPath);
			} else {
				totalSize += fs.statSync(fullPath).size;
			}
		}
	}
	sumSize(TARGET_DIR);

	const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
	console.log(`[bundle-node-modules] Done: ${totalFiles} files copied (${sizeMB} MB)`);
	if (skipped > 0) {
		console.log(`[bundle-node-modules] ${skipped} module(s) not found (may be optional)`);
	}
}

main();
