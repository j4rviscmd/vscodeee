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
 * pattern `/node_modules/...` that VS Code expects.
 *
 * This script copies a curated subset of node_modules into a staging
 * directory (`src-tauri/target/debug/node_modules`) that Tauri then bundles
 * via `tauri.conf.json > bundle > resources`.
 *
 * The staging directory is placed inside `src-tauri/target/` so that `cargo
 * clean` automatically removes stale artifacts. The directory is NOT a
 * symlink — it is a real directory containing only the packages that VS Code
 * actually needs at runtime.
 *
 * ## Packages are copied in phases
 *
 * 1. **Core modules** — Packages that the VS Code source directly
 *    `require()`s at runtime (e.g. `vscode-oniguruma`, `xterm`).
 * 2. **Stub packages** — telemetry/analytics packages that must exist
 *    on disk but whose code is never executed (Tauri strips metrics).
 * 3. **Transitive deps of core** — Dependencies of core packages.
 * 4. **Extension dependencies** — Packages required by non-BUNDLED
 *    built-in extensions.
 *
 * Packages are read from the `node_modules/` directories of:
 *   - Root project (`./node_modules`)
 *   - Each built-in extension (extensions/.../node_modules)
 *
 * Supports a `--clean` flag to remove the staging directory before bundling.
 * Logs progress, skipped modules, and final statistics (file count, total size).
 */

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TARGET_DIR = path.join(REPO_ROOT, 'src-tauri', 'target', 'debug', 'node_modules');

// ---------------------------------------------------------------------
// Phase 1: Core modules that VS Code directly requires at runtime
// ---------------------------------------------------------------------

const CORE_MODULES = [
	{ name: 'vscode-oniguruma', sub: 'release/main.js' },
	{ name: 'vscode-oniguruma', sub: 'release/onig.wasm' },
	{ name: 'vscode-textmate', sub: 'release/main.js' },
	'minimist',
	'@vscode/proxy-agent',
	'@tootallnate/once',
	'agent-base',
	'debug',
	'http-proxy-agent',
	'https-proxy-agent',
	'socks-proxy-agent',
	'undici',
	'ms',
	'socks',
	'ip-address',
	'smart-buffer',
	'jsbn',
	'sprintf-js',
	'vscode-regexpp',
	'@vscode/ripgrep',
	'yauzl',
	'buffer-crc32',
	'pend',
	'proxy-from-env',
	'@vscode/iconv-lite-umd',
	'jschardet',
	'@xterm/xterm',
	'@xterm/addon-clipboard',
	'@xterm/addon-image',
	{ name: '@xterm/addon-ligatures', optional: true },
	'@xterm/addon-progress',
	'@xterm/addon-search',
	'@xterm/addon-serialize',
	'@xterm/addon-unicode11',
	'@xterm/addon-webgl',
	'katex',
	'@vscode/tree-sitter-wasm',
	'@vscode/vscode-languagedetection',
	'@vscode/spdlog',
	'turbo',
];

// ---------------------------------------------------------------------
// Phase 1.5: Stub packages — telemetry/analytics that must exist
// but whose code is never executed (Tauri strips all metrics).
// ---------------------------------------------------------------------

const STUB_PACKAGES = [
	'@vscode/extension-telemetry',
	'@microsoft/1ds-core-js',
	'@microsoft/1ds-post-js',
	'tas-client',
	'vscode-tas-client',
];

// ---------------------------------------------------------------------
// Phase 1.6: Transitive dependencies of core modules
// (only the ones not already covered above)
// ---------------------------------------------------------------------

const TRANSITIVE_DEPS = {
	'@xterm/addon-clipboard': ['js-base64'],
	katex: ['commander'],
	'@vscode/spdlog': ['bindings', 'mkdirp', 'node-addon-api'],
	'bindings': ['file-uri-to-path'],
};

// ---------------------------------------------------------------------
// Phase 2: Extension dependencies — packages required by non-BUNDLED
// built-in extensions (those WITHOUT esbuild.mts).
// ---------------------------------------------------------------------

// Extensions that use esbuild to bundle ALL their deps are listed here.
// Their transitive dependency trees are fully inlined and do NOT need
// to be copied to node_modules.
const BUNDLED_EXTENSIONS = new Set([
	'markdown-language-features',
	'markdown-math',
	'media-preview',
	'merge-conflict',
	'notebook-renderers',
	'references-view',
	'search-result',
	'simple-browser',
	'terminal-suggest',
	'tunnel-forwarding',
	'vscode-api-tests',
	'vscode-colorize-perf-tests',
	'vscode-colorize-tests',
	'vscode-test-resolver',
	'mermaid-chat-features',
	// very large (~10MB) — skip for now
	'mermaid',
]);

// NOTE: These are also excluded by the BUNDLED extension skip in Phase 2, but
// are listed explicitly so we can warn if they're unexpectedly missing.
const EXTENSION_DEPS = [
	'@vscode/fs-copyfile',
	'vscode-markdown-languageserver',
];

/**
 * @typedef {{ name: string, sub?: string, optional?: boolean, skipTransitive?: boolean }} PackageEntry
 */

/**
 * Build the full list of packages to copy, resolving transitive deps.
 */
function buildPackageList() {
	/** @type {PackageEntry[]} */
	const packages = [];

	for (const entry of CORE_MODULES) {
		packages.push(typeof entry === 'string' ? { name: entry } : entry);
	}

	for (const name of STUB_PACKAGES) {
		packages.push({ name, stub: true });
	}

	// BUNDLED extensions (those with esbuild.mts) are skipped because esbuild
	// inlines all their deps. We still scan them to find transitive deps of
	// core modules that aren't already covered.
	const bundledTransitive = new Set();
	for (const [parent, deps] of Object.entries(TRANSITIVE_DEPS)) {
		for (const dep of deps) {
			bundledTransitive.add(dep);
		}
	}

	// Check extension dependency manifests
	const extensionsDir = path.join(REPO_ROOT, 'extensions');
	const extensionEntries = fs.readdirSync(extensionsDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.filter(d => !BUNDLED_EXTENSIONS.has(d.name))
		.filter(d => fs.existsSync(path.join(extensionsDir, d.name, 'package.json')));

	const skipTransitiveSet = new Set();
	for (const ext of extensionEntries) {
		const pkgJsonPath = path.join(extensionsDir, ext.name, 'package.json');
		try {
			/** @type {Record<string, string>} */
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
			const deps = pkg.dependencies || {};
			const allDeps = Object.keys(deps);

			// Collect transitive deps to skip (already inlined by esbuild)
			for (const dep of allDeps) {
				if (bundledTransitive.has(dep)) {
					skipTransitiveSet.add(dep);
				}
			}

			for (const dep of EXTENSION_DEPS) {
				if (allDeps.includes(dep)) {
					packages.push({ name: dep, extension: ext.name });
				}
			}
		} catch {
			// Ignore unreadable package.json
		}
	}

	// Add transitive deps of core modules, skipping those covered by BUNDLED
	for (const [parent, deps] of Object.entries(TRANSITIVE_DEPS)) {
		const skip = skipTransitiveSet.has(parent);
		for (const dep of deps) {
			if (!skip) {
				packages.push({ name: dep, transitiveOf: parent });
			}
		}
	}

	return packages;
}

/**
 * Recursively copy a directory, skipping files whose content is unchanged.
 * @param {string} src
 * @param {string} dest
 * @returns {{ files: number, size: number, skipped: number }}
 */
function copyDir(src, dest) {
	let files = 0;
	let size = 0;
	let skipped = 0;

	const entries = fs.readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);

		if (entry.isDirectory()) {
			fs.mkdirSync(destPath, { recursive: true });
			const result = copyDir(srcPath, destPath);
			files += result.files;
			size += result.size;
			skipped += result.skipped;
		} else {
			fs.mkdirSync(path.dirname(destPath), { recursive: true });
			try {
				// Skip if the file content is identical
				if (fs.existsSync(destPath)) {
					const srcStat = fs.statSync(srcPath);
					const destStat = fs.statSync(destPath);
					if (srcStat.size === destStat.size) {
						// Quick size check before reading content
						const srcContent = fs.readFileSync(srcPath);
						const destContent = fs.readFileSync(destPath);
						if (srcContent.equals(destContent)) {
							skipped++;
							continue;
						}
					}
				}
				fs.copyFileSync(srcPath, destPath);
				files++;
				size += fs.statSync(destPath).size;
			} catch (err) {
				console.warn(`[bundle-node-modules] WARN: Failed to copy ${srcPath}: ${err.message}`);
			}
		}
	}

	return { files, size, skipped };
}

/**
 * Resolve the actual source path for a package, checking multiple locations.
 * @param {string} name
 * @returns {{ found: boolean, path?: string, isBundled?: boolean }}
 */
function resolvePackagePath(name) {
	const searchPaths = [
		path.join(REPO_ROOT, 'node_modules', name),
	];

	// Check extension node_modules directories
	const extensionsDir = path.join(REPO_ROOT, 'extensions');
	try {
		const extDirs = fs.readdirSync(extensionsDir, { withFileTypes: true })
			.filter(d => d.isDirectory())
			.map(d => path.join(extensionsDir, d.name, 'node_modules'));

		for (const extNm of extDirs) {
			const candidate = path.join(extNm, name);
			if (fs.existsSync(candidate)) {
				return { found: true, path: candidate };
			}
		}
	} catch {
		// Extensions directory may not exist in CI
	}

	for (const candidate of searchPaths) {
		if (fs.existsSync(candidate)) {
			return { found: true, path: candidate };
		}
	}

	return { found: false };
}

/**
 * Create a stub package.json that exports an empty object.
 * This is used for telemetry/analytics packages that must exist on disk
 * but whose code should never be executed.
 * @param {string} destDir
 * @param {string} pkgName
 */
function createStubPackage(destDir, pkgName) {
	const pkgJson = JSON.stringify({
		name: pkgName,
		version: '0.0.0-stub',
		main: 'index.js',
	});
	fs.mkdirSync(destDir, { recursive: true });
	fs.writeFileSync(path.join(destDir, 'package.json'), pkgJson);
	fs.writeFileSync(path.join(destDir, 'index.js'), 'module.exports = {};');
}

/**
 * Skip logic: if `--force` is not set and a stamp file exists whose
 * SHA-256 hash of `package-lock.json` matches the current hash, the
 * entire step is skipped. This avoids redundant bundling when
 * dependencies haven't changed (even if `npm install` touched mtime).
 */
const SKIP_MARKERS_DIR = path.join(REPO_ROOT, '.build', 'skip-markers');

function main() {
	const force = process.argv.includes('--force');
	const stampPath = path.join(SKIP_MARKERS_DIR, 'bundle-node-modules.stamp');

	if (!force && fs.existsSync(stampPath)) {
		const lockfile = path.join(REPO_ROOT, 'package-lock.json');
		if (fs.existsSync(lockfile)) {
			const savedHash = fs.readFileSync(stampPath, 'utf8').trim();
			const currentHash = crypto.createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex').slice(0, 16);
			if (savedHash === currentHash) {
				// allow-any-unicode-next-line
				console.log('✅ [bundle-node-modules] Skipped (no changes)');
				return;
			}
		}
	}

	console.log('[bundle-node-modules] Bundling required node_modules for Tauri build...');

	// Guard: If TARGET_DIR is a symlink (e.g. -> ../node_modules created by
	// npm install), remove it so we can create a real directory with only the
	// curated subset of packages. Without this, Tauri would follow the symlink
	// and bundle the entire root node_modules (~960MB) into the production app.
	// See: https://github.com/j4rviscmd/vscodeee/issues/312
	try {
		const stat = fs.lstatSync(TARGET_DIR);
		if (stat.isSymbolicLink()) {
			const linkTarget = fs.readlinkSync(TARGET_DIR);
			console.log(`[bundle-node-modules] Removing symlink: ${TARGET_DIR} -> ${linkTarget}`);
			fs.unlinkSync(TARGET_DIR);
		}
	} catch {
		// TARGET_DIR doesn't exist yet — that's fine
	}

	// Clean if requested
	if (force) {
		fs.rmSync(TARGET_DIR, { recursive: true, force: true });
	}

	const packages = buildPackageList();
	let totalFiles = 0;
	let totalSize = 0;
	let skipped = 0;

	// can skip them. Packages not found here may still be resolved from
	// other node_modules locations at runtime.
	for (const pkg of packages) {
		if (pkg.stub) {
			const destDir = path.join(TARGET_DIR, pkg.name);
			const stubSrc = path.join(REPO_ROOT, 'extensions', 'configuration-editing', 'node_modules', pkg.name, 'package.json');
			if (fs.existsSync(stubSrc)) {
				createStubPackage(destDir, pkg.name);
				console.log(`[bundle-node-modules]   ${pkg.name}/ (stub)`);
			} else {
				console.warn(`[bundle-node-modules] WARN: stub for ${pkg.name} not found at ${stubSrc}, skipping`);
				skipped++;
			}
			continue;
		}

		const resolved = resolvePackagePath(pkg.name);
		if (!resolved.found) {
			if (pkg.optional) {
				console.warn(`[bundle-node-modules] WARN: ${pkg.name} not found, skipping`);
				skipped++;
			} else {
				console.log(`[bundle-node-modules]   ${pkg.name}/ (0 files)`);
			}
			continue;
		}

		const srcPath = resolved.path;
		const destPath = path.join(TARGET_DIR, pkg.name);

		if (pkg.sub) {
			// Copy a single file
			const srcFile = path.join(srcPath, pkg.sub);
			const destFile = path.join(TARGET_DIR, pkg.name, pkg.sub);
			fs.mkdirSync(path.dirname(destFile), { recursive: true });
			if (fs.existsSync(srcFile)) {
				fs.copyFileSync(srcFile, destFile);
				totalFiles++;
				totalSize += fs.statSync(destFile).size;
				console.log(`[bundle-node-modules]   ${pkg.name}/${pkg.sub}`);
			} else {
				console.warn(`[bundle-node-modules] WARN: ${pkg.name}/${pkg.sub} not found, skipping`);
				skipped++;
			}
		} else {
			// Copy entire directory
			const result = copyDir(srcPath, destPath);
			totalFiles += result.files;
			totalSize += result.size;
			skipped += result.skipped;
			const transitiveLabel = pkg.transitiveOf ? ` [transitive of ${pkg.transitiveOf}]` : '';
			console.log(`[bundle-node-modules]   ${pkg.name}/ (${result.files} files)${transitiveLabel}`);
		}
	}

	// Phase 2: Extension dependencies
	console.log('[bundle-node-modules] Phase 2: Extension dependencies...');
	let extDepsCount = 0;

	const extensionsDir = path.join(REPO_ROOT, 'extensions');
	const extensionEntries = fs.readdirSync(extensionsDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.filter(d => !BUNDLED_EXTENSIONS.has(d.name));

	for (const ext of extensionEntries) {
		const pkgJsonPath = path.join(extensionsDir, ext.name, 'package.json');
		if (!fs.existsSync(pkgJsonPath)) {
			continue;
		}

		try {
			/** @type {Record<string, string>} */
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
			const deps = pkg.dependencies || {};
			const allDeps = Object.keys(deps);

			for (const dep of EXTENSION_DEPS) {
				if (!allDeps.includes(dep)) {
					continue;
				}

				const depSrc = path.join(extensionsDir, ext.name, 'node_modules', dep);
				if (!fs.existsSync(depSrc)) {
					continue;
				}

				const depDest = path.join(TARGET_DIR, dep);
				if (fs.existsSync(depDest)) {
					continue; // Already copied
				}

				const result = copyDir(depSrc, depDest);
				totalFiles += result.files;
				totalSize += result.size;
				skipped += result.skipped;
				extDepsCount++;
				console.log(`[bundle-node-modules]   ${dep}/ (${result.files} files) [from ${ext.name}]`);
			}
		} catch {
			// Ignore unreadable package.json
		}
	}

	if (extDepsCount > 0) {
		console.log(`[bundle-node-modules] Phase 2: ${extDepsCount} extension dependency packages copied`);
	}

	// Summary
	const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
	console.log(`[bundle-node-modules] Done: ${totalFiles} files copied (${sizeMB} MB)`);
	if (skipped > 0) {
		console.log(`[bundle-node-modules] ${skipped} module(s) not found (may be optional)`);
	}

	// Mark as complete for skip detection on next run
	fs.mkdirSync(SKIP_MARKERS_DIR, { recursive: true });
	const lockfile = path.join(REPO_ROOT, 'package-lock.json');
	if (fs.existsSync(lockfile)) {
		const lockHash = crypto.createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex').slice(0, 16);
		fs.writeFileSync(stampPath, lockHash);
	} else {
		fs.writeFileSync(stampPath, new Date().toISOString());
	}
}

main();
