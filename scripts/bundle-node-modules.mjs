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

// Manifest of required node_modules
//
// Each entry is either:
//   - A specific file:      "pkg/path/to/file.ext"
//   - An entire directory:  "pkg/path/to/dir/"  (trailing slash)
//
// Files are loaded at runtime via importAMDNodeModule() or
// resolveAmdNodeModulePath() in src/vs/**/*.ts.

// Packages that should NOT be bundled (native modules incompatible with
// plain Node.js sidecar, or too large / unnecessary for production).
const EXCLUDED_PACKAGES = new Set([
	'mermaid',      // very large (~10MB) — skip for now

	// Telemetry transitive dependencies — excluded because we replace the top-level
	// telemetry packages with no-op stubs (see STUBBED_PACKAGES below).
	// This eliminates ~80MB of unnecessary packages from the bundle.
	// See: https://github.com/j4rviscmd/vscodeee/issues/274
	'@microsoft/applicationinsights-channel-js',
	'@microsoft/applicationinsights-common',
	'@microsoft/applicationinsights-core-js',
	'@microsoft/applicationinsights-shims',
	'@microsoft/applicationinsights-web-basic',
	'@microsoft/dynamicproto-js',
	'@nevware21/ts-async',
	'@nevware21/ts-utils',
]);

// Directory containing no-op stub packages that replace real implementations.
// Stubs maintain the same API surface but have zero dependencies and minimal size.
const STUBS_DIR = path.join(REPO_ROOT, 'scripts', 'stubs');

// Packages that should be replaced with no-op stubs in the bundle.
// Key: package name, Value: relative path within STUBS_DIR.
// The stub is copied instead of the real package from node_modules.
// See: https://github.com/j4rviscmd/vscodeee/issues/274
const STUBBED_PACKAGES = new Map([
	['@vscode/extension-telemetry', '@vscode/extension-telemetry'],
	['@microsoft/1ds-core-js', '@microsoft/1ds-core-js'],
	['@microsoft/1ds-post-js', '@microsoft/1ds-post-js'],
]);

// Core platform modules used by the Extension Host process and VS Code runtime.
// Each entry is either a specific file or a directory (trailing slash).
const CORE_MODULES = [
	// TextMate syntax highlighting (critical)
	'vscode-oniguruma/release/main.js',
	'vscode-oniguruma/release/onig.wasm',
	'vscode-textmate/release/main.js',

	// Extension Host (critical — imported by extensionHostProcess.js)
	'minimist/index.js',
	'minimist/package.json',

	// Extension Host — HTTP proxy support (imported by proxyResolver.js at startup)
	'@vscode/proxy-agent/',
	'@tootallnate/once/',
	'agent-base/',
	'debug/',
	'http-proxy-agent/',
	'https-proxy-agent/',
	'socks-proxy-agent/',
	'undici/',
	'ms/',
	'socks/',
	'ip-address/',
	'smart-buffer/',
	'jsbn/',
	'sprintf-js/',

	// Extension Host — search (imported by ripgrepTextSearchEngine.js)
	'vscode-regexpp/',
	'@vscode/ripgrep/',
	'yauzl/',
	'buffer-crc32/',
	'pend/',
	'proxy-from-env/',

	// Text encoding
	'@vscode/iconv-lite-umd/lib/iconv-lite-umd.js',
	'jschardet/dist/jschardet.min.js',

	// Terminal (xterm)
	'@xterm/xterm/lib/xterm.js',
	'@xterm/addon-clipboard/lib/addon-clipboard.js',
	'@xterm/addon-image/lib/addon-image.js',
	'@xterm/addon-ligatures/lib/addon-ligatures.js',
	'@xterm/addon-progress/lib/addon-progress.js',
	'@xterm/addon-search/lib/addon-search.js',
	'@xterm/addon-serialize/lib/addon-serialize.js',
	'@xterm/addon-unicode11/lib/addon-unicode11.js',
	'@xterm/addon-webgl/lib/addon-webgl.js',

	// Math rendering (Markdown preview) — full package needed for require('katex')
	'katex/',

	// Telemetry — replaced with no-op stubs via STUBBED_PACKAGES (see #274).
	// The stubs are copied in the "Stub packages" phase instead of from node_modules.

	// Experimentation service — full package needed for require('tas-client')
	'tas-client/',

	// Tree-sitter (syntax parsing)
	'@vscode/tree-sitter-wasm/wasm/',

	// Language detection
	'@vscode/vscode-languagedetection/dist/',
	'@vscode/vscode-languagedetection/model/',

	// Core platform logging (imported by spdlogLog.js in Extension Host)
	'@vscode/spdlog/',
];

const EXTENSIONS_DIR = path.join(REPO_ROOT, 'extensions');

const args = process.argv.slice(2);
const clean = args.includes('--clean');

/**
 * Collect all directories that may contain node_modules packages:
 * root node_modules/ + each extension's node_modules/.
 * @returns {string[]}
 */
function collectNodeModulesDirs() {
	const dirs = [SOURCE_DIR];
	for (const extDir of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
		if (!extDir.isDirectory()) {
			continue;
		}
		const nm = path.join(EXTENSIONS_DIR, extDir.name, 'node_modules');
		if (fs.existsSync(nm)) {
			dirs.push(nm);
		}
	}
	return dirs;
}

/** @type {string[] | null} */
let _nmDirs = null;

/**
 * Find the first node_modules directory that contains `pkgName`.
 * @param {string} pkgName
 * @returns {string|null}
 */
function findPackageDir(pkgName) {
	if (!_nmDirs) {
		_nmDirs = collectNodeModulesDirs();
	}
	for (const dir of _nmDirs) {
		if (fs.existsSync(path.join(dir, pkgName, 'package.json'))) {
			return dir;
		}
	}
	return null;
}

/**
 * Recursively collect all dependency package names from extension manifests,
 * including transitive dependencies. Returns a set of top-level package names
 * (e.g. "@vscode/extension-telemetry", "which") that exist in any node_modules.
 * @returns {Set<string>}
 */
function collectExtensionDependencies() {
	const seen = new Set();
	const queue = [];

	// Seed with direct dependencies from all extension package.json files
	for (const extDir of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
		if (!extDir.isDirectory()) {
			continue;
		}
		const pkgPath = path.join(EXTENSIONS_DIR, extDir.name, 'package.json');
		if (!fs.existsSync(pkgPath)) {
			continue;
		}
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		for (const dep of Object.keys(pkg.dependencies || {})) {
			if (!seen.has(dep)) {
				seen.add(dep);
				queue.push(dep);
			}
		}
	}

	// Resolve transitive dependencies (BFS)
	while (queue.length > 0) {
		const dep = queue.shift();
		// Skip transitive resolution for excluded packages
		if (EXCLUDED_PACKAGES.has(dep)) {
			continue;
		}
		const srcDir = findPackageDir(dep);
		if (!srcDir) {
			continue;
		}
		const depPkgPath = path.join(srcDir, dep, 'package.json');
		if (!fs.existsSync(depPkgPath)) {
			continue;
		}
		const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
		for (const sub of Object.keys(depPkg.dependencies || {})) {
			if (!seen.has(sub) && !EXCLUDED_PACKAGES.has(sub)) {
				seen.add(sub);
				queue.push(sub);
			}
		}
	}

	return seen;
}

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

/**
 * Copy a package directory from any available node_modules to TARGET_DIR.
 * Returns the number of files copied, or -1 if not found.
 * @param {string} pkgName — e.g. "@vscode/extension-telemetry" or "which"
 * @returns {number}
 */
function copyPackage(pkgName) {
	const srcDir = findPackageDir(pkgName);
	if (!srcDir) {
		return -1;
	}
	const srcPath = path.join(srcDir, pkgName);
	const destPath = path.join(TARGET_DIR, pkgName);
	return copyDirRecursive(srcPath, destPath);
}

/**
 * Main entry point for the node_modules bundling script.
 *
 * Executes two phases:
 * 1. Copies core modules (specific files/directories) listed in `CORE_MODULES`
 *    from `node_modules/` to `src-tauri/node_modules/`.
 * 2. Auto-discovers all extension dependencies (including transitive ones) via
 *    BFS traversal of `package.json` dependency trees, then copies any packages
 *    not already bundled in Phase 1.
 *
 * Supports a `--clean` flag to remove the staging directory before bundling.
 * Logs progress, skipped modules, and final statistics (file count, total size).
 */
function main() {
	console.log('[bundle-node-modules] Bundling required node_modules for Tauri build...');

	if (clean && fs.existsSync(TARGET_DIR)) {
		console.log(`[bundle-node-modules] Cleaning ${TARGET_DIR}`);
		fs.rmSync(TARGET_DIR, { recursive: true });
	}

	let totalFiles = 0;
	let skipped = 0;

	// Phase 1: Copy core modules (specific files/directories).
	// Track which top-level packages were successfully bundled so Phase 2
	// can skip them. Packages not found here may still be resolved from
	// extension node_modules/ by Phase 2.
	const bundledPkgs = new Set();
	console.log('[bundle-node-modules] Phase 1: Core modules...');
	for (const entry of CORE_MODULES) {
		const isDir = entry.endsWith('/');
		const srcPath = path.join(SOURCE_DIR, entry);
		const destPath = path.join(TARGET_DIR, entry);

		if (!fs.existsSync(srcPath)) {
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

		// Track top-level package name for Phase 2 dedup
		const parts = entry.split('/');
		if (parts[0].startsWith('@') && parts.length > 1) {
			bundledPkgs.add(`${parts[0]}/${parts[1]}`);
		} else {
			bundledPkgs.add(parts[0]);
		}
	}

	// Phase 1.5: Copy no-op stub packages (replaces real telemetry packages)
	console.log('[bundle-node-modules] Phase 1.5: Stub packages...');
	for (const [pkgName, stubRelPath] of STUBBED_PACKAGES) {
		const stubSrc = path.join(STUBS_DIR, stubRelPath);
		const destPath = path.join(TARGET_DIR, pkgName);
		if (!fs.existsSync(stubSrc)) {
			console.warn(`[bundle-node-modules] WARN: stub for ${pkgName} not found at ${stubSrc}, skipping`);
			skipped++;
			continue;
		}
		const count = copyDirRecursive(stubSrc, destPath);
		console.log(`[bundle-node-modules]   ${pkgName}/ (${count} files) [stub]`);
		totalFiles += count;
		bundledPkgs.add(pkgName);
	}

	// Phase 1.6: Resolve transitive deps of CORE_MODULES (e.g. @vscode/spdlog → mkdirp)
	console.log('[bundle-node-modules] Phase 1.6: Core module transitive deps...');
	const coreTransitiveQueue = [...bundledPkgs];
	const coreTransitiveSeen = new Set(bundledPkgs);
	while (coreTransitiveQueue.length > 0) {
		const pkg = coreTransitiveQueue.shift();
		const srcDir = findPackageDir(pkg);
		if (!srcDir) {
			continue;
		}
		const pkgJsonPath = path.join(srcDir, pkg, 'package.json');
		if (!fs.existsSync(pkgJsonPath)) {
			continue;
		}
		const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
		for (const sub of Object.keys(pkgJson.dependencies || {})) {
			if (!coreTransitiveSeen.has(sub) && !EXCLUDED_PACKAGES.has(sub) && !bundledPkgs.has(sub)) {
				coreTransitiveSeen.add(sub);
				coreTransitiveQueue.push(sub);
				const count = copyPackage(sub);
				if (count < 0) {
					console.warn(`[bundle-node-modules] WARN: ${sub} not found, skipping`);
					skipped++;
				} else {
					console.log(`[bundle-node-modules]   ${sub}/ (${count} files) [transitive of ${pkg}]`);
					totalFiles += count;
					bundledPkgs.add(sub);
				}
			}
		}
	}

	// Phase 2: Auto-discover and copy extension dependencies
	console.log('[bundle-node-modules] Phase 2: Extension dependencies...');
	const extDeps = collectExtensionDependencies();

	let extCopied = 0;
	for (const dep of [...extDeps].sort()) {
		if (EXCLUDED_PACKAGES.has(dep)) {
			console.log(`[bundle-node-modules]   SKIP (excluded): ${dep}`);
			continue;
		}
		if (bundledPkgs.has(dep)) {
			continue;
		}
		const count = copyPackage(dep);
		if (count < 0) {
			console.warn(`[bundle-node-modules] WARN: ${dep} not found in node_modules, skipping`);
			skipped++;
		} else {
			console.log(`[bundle-node-modules]   ${dep}/ (${count} files)`);
			totalFiles += count;
			extCopied++;
		}
	}
	console.log(`[bundle-node-modules] Phase 2: ${extCopied} extension dependency packages copied`);

	// Compute total size of the staged node_modules directory
	/**
	 * Recursively compute the total byte size of all files under `dir`.
	 * @param {string} dir - Absolute path to the directory to measure.
	 * @returns {number} Total size in bytes, or 0 if the directory does not exist.
	 */
	function computeDirSize(dir) {
		if (!fs.existsSync(dir)) {
			return 0;
		}
		let size = 0;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				size += computeDirSize(fullPath);
			} else {
				size += fs.statSync(fullPath).size;
			}
		}
		return size;
	}
	const totalSize = computeDirSize(TARGET_DIR);

	const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
	console.log(`[bundle-node-modules] Done: ${totalFiles} files copied (${sizeMB} MB)`);
	if (skipped > 0) {
		console.log(`[bundle-node-modules] ${skipped} module(s) not found (may be optional)`);
	}
}

main();
