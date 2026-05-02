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

	// Type-definition-only packages — these have no runtime code (empty "main" field
	// or only .d.ts files). The consuming extensions are esbuild-BUNDLED, so all
	// runtime code is already inlined into dist/. These packages are only used at
	// TypeScript compile time and are unnecessary in the production bundle.
	// NOTE: These are also excluded by the BUNDLED extension skip in Phase 2, but
	// kept here as a safety net in case the detection logic changes.
	// See: https://github.com/j4rviscmd/vscodeee/issues/274
	'@octokit/graphql-schema',   // ~7.3MB — GraphQL schema types for github extension
	'@octokit/openapi-types',    // ~5.1MB — REST API types for github extension
]);

// Extensions excluded from the production build. Their dependencies should NOT
// be collected in Phase 2 since the extensions themselves are never loaded.
// This list must be kept in sync with EXCLUDED_EXTENSIONS in build/next/index.ts.
const EXCLUDED_EXTENSIONS = new Set([
	'vscode-api-tests',
	'vscode-colorize-tests',
	'vscode-colorize-perf-tests',
	'vscode-test-resolver',
	// TODO(Phase 1): Excluded for Tauri fork - SettingsSync/RemoteTunnel not supported
	'microsoft-authentication',
	'tunnel-forwarding',
]);

// Packages from esbuild-BUNDLED extensions that are still required at runtime
// in node_modules/ (i.e., NOT inlined by esbuild). All other BUNDLED extension
// deps are fully inlined into dist/*.js and do not need to be in node_modules/.
//
// How to determine if a package needs to be here:
// 1. Check esbuild.mts for `external: [...]` — packages listed there are NOT
//    inlined and require() / import() them at runtime from node_modules.
// 2. Check if the extension loads a file from node_modules at runtime (e.g.,
//    vscode-markdown-languageserver's workerMain.js is started as a separate
//    Node.js process via LanguageClient).
//
// To verify: inspect the built dist/*.js for external require()/import() calls:
//   node -e "const c=require('fs').readFileSync('extensions/git/dist/main.js','utf8');
//     const r=c.match(/(?:require|import)\(['\"][^'\"]+['\"]\)/g)||[];
//     console.log(r.filter(x=>!x.includes('node:')&&!x.includes('./')&&!x.includes('vscode')))"
//
// Entries can be:
//   - string: package name (transitive deps will be resolved from its package.json)
//   - { name: string, skipTransitive: true }: package copied but transitive deps skipped
//     (use when the package's dist is self-contained / pre-bundled)
/** @type {Array<string | { name: string, skipTransitive: boolean }>} */
const REQUIRED_BUNDLED_EXT_PACKAGES = [
	// git extension: native addon marked as external in esbuild.mts.
	// Used via dynamic import: `const { cp } = await import('@vscode/fs-copyfile')`
	'@vscode/fs-copyfile',
	// markdown-language-features: loaded as a separate Node.js process via
	// LanguageClient (workerMain.js). The dist/node/workerMain.js is fully
	// self-contained (all deps inlined, only Node.js builtins as external requires),
	// so transitive deps are NOT needed in node_modules.
	{ name: 'vscode-markdown-languageserver', skipTransitive: true },
];

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
	// Experimentation service (Treatment Assignment Service) — this fork does not
	// use Microsoft's A/B testing. All experiment flags return default values.
	// The root node_modules has tas-client@0.3.1 (ESM, "type": "module") which
	// is incompatible with require() used by extensions. Stubbing eliminates both
	// the ESM/CJS mismatch and unnecessary HTTP calls to Microsoft's servers.
	// See: https://github.com/j4rviscmd/vscodeee/issues/296
	['tas-client', 'tas-client'],
	['vscode-tas-client', 'vscode-tas-client'],
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

	// Telemetry & experimentation — replaced with no-op stubs via STUBBED_PACKAGES.
	// The stubs are copied in the "Stub packages" phase instead of from node_modules.
	// See: #274 (telemetry), #296 (experimentation/TAS)

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
 * Detect whether an extension is "BUNDLED" — i.e., it uses esbuild to inline
 * all dependencies into dist/*.js. BUNDLED extensions do not need their
 * node_modules dependencies at runtime (except for packages explicitly listed
 * in REQUIRED_BUNDLED_EXT_PACKAGES).
 * @param {string} extName — extension directory name (e.g. "git", "emmet")
 * @returns {boolean}
 */
function isBundledExtension(extName) {
	return fs.existsSync(path.join(EXTENSIONS_DIR, extName, 'esbuild.mts'));
}

/**
 * Recursively collect all dependency package names from extension manifests,
 * including transitive dependencies. Returns a set of top-level package names
 * (e.g. "@vscode/extension-telemetry", "which") that exist in any node_modules.
 *
 * BUNDLED extensions (those with esbuild.mts) are skipped because esbuild
 * inlines all their dependencies into dist/*.js. Only packages explicitly
 * listed in REQUIRED_BUNDLED_EXT_PACKAGES are included from BUNDLED extensions.
 * @returns {Set<string>}
 */
function collectExtensionDependencies() {
	const seen = new Set();
	const queue = [];

	// Seed with direct dependencies from all extension package.json files.
	// Skip extensions in EXCLUDED_EXTENSIONS — they are never loaded in production,
	// so their dependencies (e.g. @azure/* from microsoft-authentication) are unnecessary.
	// Skip BUNDLED extensions — their deps are inlined by esbuild.
	for (const extDir of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
		if (!extDir.isDirectory()) {
			continue;
		}
		if (EXCLUDED_EXTENSIONS.has(extDir.name)) {
			continue;
		}
		// BUNDLED extensions inline all deps via esbuild — skip their dependency trees.
		// Only REQUIRED_BUNDLED_EXT_PACKAGES are needed at runtime from node_modules.
		if (isBundledExtension(extDir.name)) {
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

	// Add packages from BUNDLED extensions that are still required at runtime
	const skipTransitiveSet = new Set();
	for (const entry of REQUIRED_BUNDLED_EXT_PACKAGES) {
		const name = typeof entry === 'string' ? entry : entry.name;
		const skip = typeof entry === 'object' && entry.skipTransitive;
		if (!seen.has(name)) {
			seen.add(name);
			if (!skip) {
				queue.push(name);
			} else {
				skipTransitiveSet.add(name);
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
 * Copy a file only if the destination content differs from the source.
 * Avoids updating mtime on unchanged files so Cargo's rerun-if-changed
 * does not trigger unnecessary rebuilds.
 * @param {string} src
 * @param {string} dest
 * @returns {boolean} true if the file was actually written
 */
function copyFileIfChanged(src, dest) {
	const srcContent = fs.readFileSync(src);
	try {
		const destContent = fs.readFileSync(dest);
		if (srcContent.equals(destContent)) {
			return false;
		}
	} catch { /* dest doesn't exist */ }
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, srcContent);
	return true;
}

/**
 * Recursively copy a directory, skipping files whose content is unchanged.
 * @param {string} src
 * @param {string} dest
 * @returns {number} number of files written (changed or new)
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
			if (copyFileIfChanged(srcPath, destPath)) {
				count++;
			}
		}
	}
	return count;
}

/**
 * Copy a single file, creating parent directories as needed.
 * Only writes if the content differs from the destination.
 * @param {string} src
 * @param {string} dest
 */
function copyFile(src, dest) {
	copyFileIfChanged(src, dest);
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
 * Skip logic: if `--force` is not set and a stamp file exists that is newer
 * than `package-lock.json`, the entire step is skipped. This avoids redundant
 * copies when neither dependencies nor the bundling logic have changed.
 *
 * Executes two phases when a rebuild is needed:
 * 1. Copies core modules (specific files/directories) listed in `CORE_MODULES`
 *    from `node_modules/` to `src-tauri/node_modules/`.
 * 2. Auto-discovers all extension dependencies (including transitive ones) via
 *    BFS traversal of `package.json` dependency trees, then copies any packages
 *    not already bundled in Phase 1.
 *
 * Supports a `--clean` flag to remove the staging directory before bundling.
 * Logs progress, skipped modules, and final statistics (file count, total size).
 */
const SKIP_MARKERS_DIR = path.join(REPO_ROOT, '.build', 'skip-markers');

function main() {
	const force = process.argv.includes('--force');
	const stampPath = path.join(SKIP_MARKERS_DIR, 'bundle-node-modules.stamp');

	if (!force && fs.existsSync(stampPath)) {
		const stampTime = fs.statSync(stampPath).mtimeMs;
		const lockfile = path.join(REPO_ROOT, 'package-lock.json');
		if (!fs.existsSync(lockfile) || fs.statSync(lockfile).mtimeMs <= stampTime) {
			console.log('✅ [bundle-node-modules] Skipped (no changes)');
			return;
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
	} catch (/** @type {any} */ e) {
		// ENOENT is expected when the directory doesn't exist yet
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}

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

	// Phase 2: Auto-discover and copy extension dependencies.
	// BUNDLED extensions (with esbuild.mts) are skipped — their deps are inlined.
	// Only REQUIRED_BUNDLED_EXT_PACKAGES are included from BUNDLED extensions.
	console.log('[bundle-node-modules] Phase 2: Extension dependencies...');
	const bundledExtNames = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
		.filter(e => e.isDirectory() && isBundledExtension(e.name) && !EXCLUDED_EXTENSIONS.has(e.name))
		.map(e => e.name);
	console.log(`[bundle-node-modules]   Skipping ${bundledExtNames.length} BUNDLED extensions (deps inlined by esbuild)`);
	const requiredNames = REQUIRED_BUNDLED_EXT_PACKAGES.map(e => typeof e === 'string' ? e : e.name);
	console.log(`[bundle-node-modules]   Required from BUNDLED: ${requiredNames.join(', ')}`);
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

	// Mark as complete for skip detection on next run
	fs.mkdirSync(SKIP_MARKERS_DIR, { recursive: true });
	fs.writeFileSync(stampPath, new Date().toISOString());
}

main();
