/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import glob from 'glob';
import gulpWatch from '../lib/watch/index.ts';
import { nlsPlugin, createNLSCollector, finalizeNLS, postProcessNLS } from './nls-plugin.ts';
import { convertPrivateFields, adjustSourceMap, type ConvertPrivateFieldsResult } from './private-to-property.ts';
import { getVersion } from '../lib/getVersion.ts';
import { getGitCommitDate } from '../lib/date.ts';
import product from '../../product.json' with { type: 'json' };
import packageJson from '../../package.json' with { type: 'json' };
import { useEsbuildTranspile } from '../buildConfig.ts';
import { isWebExtension, type IScannedBuiltinExtension } from '../lib/extensions-shared.ts';

const globAsync = promisify(glob);

// ============================================================================
// Configuration
// ============================================================================

const REPO_ROOT = path.dirname(path.dirname(import.meta.dirname));
const commit = getVersion(REPO_ROOT);
const quality = (product as { quality?: string }).quality;
const version = (quality && quality !== 'stable') ? `${packageJson.version}-${quality}` : packageJson.version;

// CLI: transpile [--watch] | bundle [--minify] [--nls] [--out <dir>]
const command = process.argv[2]; // 'transpile' or 'bundle'

function getArgValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index !== -1 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return undefined;
}

const options = {
	watch: process.argv.includes('--watch'),
	minify: process.argv.includes('--minify'),
	nls: process.argv.includes('--nls'),
	manglePrivates: process.argv.includes('--mangle-privates'),
	excludeTests: process.argv.includes('--exclude-tests'),
	force: process.argv.includes('--force'),
	out: getArgValue('--out'),
	target: getArgValue('--target') ?? 'desktop', // 'desktop' | 'server'
	sourceMapBaseUrl: getArgValue('--source-map-base-url'),
};

// Build targets
type BuildTarget = 'desktop' | 'server';

const SRC_DIR = 'src';
const OUT_DIR = 'out';
const OUT_VSCODE_DIR = 'out-vscode';

// UTF-8 BOM - added to test files with 'utf8' in the path (matches gulp build behavior)
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ============================================================================
// Entry Points (from build/buildfile.ts)
// ============================================================================

// Extension host bundles are excluded from private field mangling because they
// expose API surface to extensions where encapsulation matters.
const extensionHostEntryPoints = [
	'vs/workbench/api/node/extensionHostProcess',
	'vs/workbench/api/worker/extensionHostWorkerMain',
];

function isExtensionHostBundle(filePath: string): boolean {
	const normalized = filePath.replaceAll('\\', '/');
	return extensionHostEntryPoints.some(ep => normalized.endsWith(`${ep}.js`));
}

// Workers - shared between targets
const workerEntryPoints = [
	'vs/editor/common/services/editorWebWorkerMain',
	'vs/workbench/api/worker/extensionHostWorkerMain',
	'vs/workbench/contrib/notebook/common/services/notebookWebWorkerMain',
	'vs/workbench/services/languageDetection/browser/languageDetectionWebWorkerMain',
	'vs/workbench/services/search/worker/localFileSearchMain',
	'vs/workbench/contrib/output/common/outputLinkComputerMain',
	'vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain',
];

// Desktop-only workers (use electron-browser)
const desktopWorkerEntryPoints = [
	'vs/platform/profiling/electron-browser/profileAnalysisWorkerMain',
];

// Desktop workbench and code entry points
const desktopEntryPoints = [
	'vs/workbench/workbench.desktop.main',
	'vs/sessions/sessions.desktop.main',
	'vs/workbench/contrib/debug/node/telemetryApp',
	'vs/platform/files/node/watcher/watcherMain',
	'vs/platform/terminal/node/ptyHostMain',
	'vs/platform/agentHost/node/agentHostMain',
	'vs/workbench/api/node/extensionHostProcess',
];

const codeEntryPoints = [
	'vs/code/node/cliProcessMain',
	'vs/code/electron-browser/workbench/workbench',
	'vs/sessions/electron-browser/sessions',
];

// Server entry points (reh)
const serverEntryPoints = [
	'vs/workbench/api/node/extensionHostProcess',
	'vs/platform/files/node/watcher/watcherMain',
	'vs/platform/terminal/node/ptyHostMain',
	'vs/platform/agentHost/node/agentHostMain',
];

// Bootstrap files per target
const bootstrapEntryPointsDesktop = [
	'main',
	'cli',
	'bootstrap-fork',
];

const bootstrapEntryPointsServer = [
	'server-main',
	'server-cli',
	'bootstrap-fork',
];

/**
 * Get entry points for a build target.
 */
function getEntryPointsForTarget(target: BuildTarget): string[] {
	switch (target) {
		case 'desktop':
			return [
				...workerEntryPoints,
				...desktopWorkerEntryPoints,
				...desktopEntryPoints,
				...codeEntryPoints,
			];
		case 'server':
			return [
				...serverEntryPoints,
			];
		default:
			throw new Error(`Unknown target: ${target}`);
	}
}

/**
 * Get bootstrap entry points for a build target.
 */
function getBootstrapEntryPointsForTarget(target: BuildTarget): string[] {
	switch (target) {
		case 'desktop':
			return bootstrapEntryPointsDesktop;
		case 'server':
			return bootstrapEntryPointsServer;
		default:
			throw new Error(`Unknown target: ${target}`);
	}
}

/**
 * Get entry points that should bundle CSS (workbench mains).
 */
function getCssBundleEntryPointsForTarget(target: BuildTarget): Set<string> {
	switch (target) {
		case 'desktop':
			return new Set([
				'vs/workbench/workbench.desktop.main',
				'vs/code/electron-browser/workbench/workbench',
				'vs/sessions/sessions.desktop.main',
				'vs/sessions/electron-browser/sessions',
			]);
		case 'server':
			return new Set(); // Server has no UI
		default:
			throw new Error(`Unknown target: ${target}`);
	}
}

// ============================================================================
// Resource Patterns (files to copy, not transpile/bundle)
// ============================================================================

// Common resources needed by all targets
const commonResourcePatterns = [
	// Tree-sitter queries
	'vs/editor/common/languages/highlights/*.scm',
	'vs/editor/common/languages/injections/*.scm',

	// SVGs referenced from CSS (needed for transpile/dev builds where CSS is copied as-is)
	'vs/workbench/browser/media/code-icon.svg',
	'vs/workbench/browser/parts/editor/media/letterpress*.svg',
	'vs/sessions/contrib/chat/browser/media/*.svg'
];

// Resources for desktop target
const desktopResourcePatterns = [
	...commonResourcePatterns,

	// HTML
	'vs/code/electron-browser/workbench/workbench.html',
	'vs/code/electron-browser/workbench/workbench-dev.html',
	'vs/sessions/electron-browser/sessions.html',
	'vs/sessions/electron-browser/sessions-dev.html',
	'vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html',
	'vs/workbench/contrib/webview/browser/pre/*.html',

	// Webview pre scripts
	'vs/workbench/contrib/webview/browser/pre/*.js',

	// Shell scripts
	'vs/base/node/*.sh',
	'vs/workbench/contrib/terminal/common/scripts/*.sh',
	'vs/workbench/contrib/terminal/common/scripts/*.ps1',
	'vs/workbench/contrib/terminal/common/scripts/*.psm1',
	'vs/workbench/contrib/terminal/common/scripts/*.fish',
	'vs/workbench/contrib/terminal/common/scripts/*.zsh',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.psd1',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.psm1',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.dll',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.ps1xml',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/net6plus/*.dll',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/netstd/*.dll',
	'vs/workbench/contrib/externalTerminal/**/*.scpt',

	// Media - audio
	'vs/platform/accessibilitySignal/browser/media/*.mp3',

	// Media - images
	'vs/workbench/contrib/welcomeGettingStarted/common/media/**/*.svg',
	'vs/workbench/contrib/welcomeGettingStarted/common/media/**/*.png',
	'vs/workbench/contrib/extensions/browser/media/{theme-icon.png,language-icon.svg}',
	'vs/workbench/services/extensionManagement/common/media/*.svg',
	'vs/workbench/services/extensionManagement/common/media/*.png',
	'vs/workbench/browser/parts/editor/media/*.png',
	'vs/workbench/contrib/debug/browser/media/*.png',

	// Sessions - built-in prompts and skills
	'vs/sessions/prompts/*.prompt.md',
	'vs/sessions/skills/**/SKILL.md',
];

// Resources for server target (minimal - no UI)
const serverResourcePatterns = [
	// Shell scripts for process monitoring
	'vs/base/node/cpuUsage.sh',
	'vs/base/node/ps.sh',

	// External Terminal
	'vs/workbench/contrib/externalTerminal/**/*.scpt',

	// Terminal shell integration
	'vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1',
	'vs/workbench/contrib/terminal/common/scripts/CodeTabExpansion.psm1',
	'vs/workbench/contrib/terminal/common/scripts/GitTabExpansion.psm1',
	'vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh',
	'vs/workbench/contrib/terminal/common/scripts/shellIntegration-env.zsh',
	'vs/workbench/contrib/terminal/common/scripts/shellIntegration-profile.zsh',
	'vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh',
	'vs/workbench/contrib/terminal/common/scripts/shellIntegration-login.zsh',
	'vs/workbench/contrib/terminal/common/scripts/shellIntegration.fish',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.psd1',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.psm1',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.dll',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/*.ps1xml',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/net6plus/*.dll',
	'vs/workbench/contrib/terminal/common/scripts/psreadline/netstd/*.dll',
];

/**
 * Get resource patterns for a build target.
 */
function getResourcePatternsForTarget(target: BuildTarget): string[] {
	switch (target) {
		case 'desktop':
			return desktopResourcePatterns;
		case 'server':
			return serverResourcePatterns;
		default:
			throw new Error(`Unknown target: ${target}`);
	}
}

// ============================================================================
// Utilities
// ============================================================================

async function cleanDir(dir: string): Promise<void> {
	const fullPath = path.join(REPO_ROOT, dir);
	console.log(`[clean] ${dir}`);
	await fs.promises.rm(fullPath, { recursive: true, force: true });
	await fs.promises.mkdir(fullPath, { recursive: true });
}

// ============================================================================
// Skip Logic (mtime-based incremental build)
// ============================================================================

const SKIP_MARKERS_DIR = path.join(REPO_ROOT, '.build', 'skip-markers');

/** Escape special regex characters in a string for use in a RegExp constructor. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Check if any file under `sourceDir` has been modified after the marker's mtime.
 * Returns true if a source file is newer than the stamp (rebuild needed).
 *
 * @param sourceDir - Directory to scan for changes
 * @param stampPath - Path to the timestamp marker file
 * @param ignorePatterns - Glob-like patterns to exclude from the check
 */
async function hasSourceChanged(sourceDir: string, stampPath: string, ignorePatterns?: string[]): Promise<boolean> {
	let stampTime: number;
	try {
		stampTime = fs.statSync(stampPath).mtimeMs;
	} catch {
		return true; // no stamp → must build
	}

	const ignoreRe = ignorePatterns?.length
		? new RegExp(ignorePatterns.map(escapeRegExp).join('|'))
		: undefined;
	const files = await globAsync('**/*', { cwd: sourceDir, nodir: true });
	for (const file of files) {
		if (ignoreRe && ignoreRe.test(file)) {
			continue;
		}
		const filePath = path.join(sourceDir, file);
		try {
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs > stampTime) {
				return true;
			}
		} catch {
			// file may have been removed between glob and stat
		}
	}
	return false;
}

/**
 * Determine whether a build step can be skipped based on source file mtimes.
 * Returns true when `--force` is not set, a stamp file exists, and no source
 * file in any of `sourceDirs` has been modified since the stamp was written.
 *
 * @param stepName - Identifier used for the stamp file name (e.g. 'transpile')
 * @param sourceDirs - Directories whose mtime is checked against the stamp
 * @param ignorePatterns - Glob-like patterns to exclude from the mtime check
 */
async function canSkip(stepName: string, sourceDirs: string[], ignorePatterns?: string[]): Promise<boolean> {
	if (options.force) {
		return false;
	}
	const stampPath = path.join(SKIP_MARKERS_DIR, `${stepName}.stamp`);
	if (!fs.existsSync(stampPath)) {
		return false;
	}
	const results = await Promise.all(sourceDirs.map(d => hasSourceChanged(d, stampPath, ignorePatterns)));
	return !results.some(Boolean);
}

/** Write a timestamp stamp file so future runs can skip this step via `canSkip()`. */
function markComplete(stepName: string): void {
	fs.mkdirSync(SKIP_MARKERS_DIR, { recursive: true });
	const stampPath = path.join(SKIP_MARKERS_DIR, `${stepName}.stamp`);
	fs.writeFileSync(stampPath, new Date().toISOString());
	console.log(`[skip] ${stepName} marked complete`);
}

/**
 * Scan for built-in extensions in the given directory.
 * Returns an array of extension entries for the builtinExtensionsScannerService.
 */
function scanBuiltinExtensions(extensionsRoot: string): Array<IScannedBuiltinExtension> {
	const scannedExtensions: Array<IScannedBuiltinExtension> = [];
	const extensionsPath = path.join(REPO_ROOT, extensionsRoot);

	if (!fs.existsSync(extensionsPath)) {
		return scannedExtensions;
	}

	for (const extensionFolder of fs.readdirSync(extensionsPath)) {
		const packageJSONPath = path.join(extensionsPath, extensionFolder, 'package.json');
		if (!fs.existsSync(packageJSONPath)) {
			continue;
		}
		try {
			const packageJSON = JSON.parse(fs.readFileSync(packageJSONPath, 'utf8'));
			if (!isWebExtension(packageJSON)) {
				continue;
			}
			const children = fs.readdirSync(path.join(extensionsPath, extensionFolder));
			const packageNLSPath = children.filter(child => child === 'package.nls.json')[0];
			const packageNLS = packageNLSPath ? JSON.parse(fs.readFileSync(path.join(extensionsPath, extensionFolder, packageNLSPath), 'utf8')) : undefined;
			const readme = children.filter(child => /^readme(\.txt|\.md|)$/i.test(child))[0];
			const changelog = children.filter(child => /^changelog(\.txt|\.md|)$/i.test(child))[0];

			scannedExtensions.push({
				extensionPath: extensionFolder,
				packageJSON,
				packageNLS,
				readmePath: readme ? path.join(extensionFolder, readme) : undefined,
				changelogPath: changelog ? path.join(extensionFolder, changelog) : undefined,
			});
		} catch (e) {
			// Skip invalid extensions
		}
	}

	return scannedExtensions;
}

/**
 * Get the date from the out directory date file, or return the git commit date.
 */
function readISODate(outDir: string): string {
	try {
		return fs.readFileSync(path.join(REPO_ROOT, outDir, 'date'), 'utf8');
	} catch {
		return getGitCommitDate();
	}
}

/**
 * Only used to make encoding tests happy. The source files don't have a BOM but the
 * tests expect one... so we add it here.
 */
function needsBomAdded(filePath: string): boolean {
	return /([\/\\])test\1.*utf8/.test(filePath);
}

async function copyFile(srcPath: string, destPath: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

	if (needsBomAdded(srcPath)) {
		const content = await fs.promises.readFile(srcPath);
		if (content[0] !== 0xef || content[1] !== 0xbb || content[2] !== 0xbf) {
			await fs.promises.writeFile(destPath, Buffer.concat([UTF8_BOM, content]));
			return;
		}
	}
	await fs.promises.copyFile(srcPath, destPath);
}

/**
 * Standalone TypeScript files that need to be compiled separately (not bundled).
 * These run in special contexts (e.g., Electron preload) where bundling isn't appropriate.
 * Only needed for desktop target.
 */
const desktopStandaloneFiles = [
	'vs/base/parts/sandbox/electron-browser/preload.ts',
	'vs/base/parts/sandbox/electron-browser/preload-aux.ts',
	'vs/platform/browserView/electron-browser/preload-browserView.ts',
];

async function compileStandaloneFiles(outDir: string, doMinify: boolean, target: BuildTarget): Promise<void> {
	// Only desktop needs preload scripts
	if (target !== 'desktop') {
		return;
	}

	console.log(`[standalone] Compiling ${desktopStandaloneFiles.length} standalone files...`);

	const banner = `/*!--------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/`;

	await Promise.all(desktopStandaloneFiles.map(async (file) => {
		const entryPath = path.join(REPO_ROOT, SRC_DIR, file);
		const outPath = path.join(REPO_ROOT, outDir, file.replace(/\.ts$/, '.js'));

		await esbuild.build({
			entryPoints: [entryPath],
			outfile: outPath,
			bundle: false, // Don't bundle - these are standalone scripts
			format: 'cjs', // CommonJS for Electron preload
			platform: 'node',
			target: ['es2024'],
			sourcemap: 'linked',
			sourcesContent: false,
			minify: doMinify,
			banner: { js: banner },
			logLevel: 'warning',
		});
	}));

	console.log(`[standalone] Done`);
}

/**
 * Copy ALL non-TypeScript files from src/ to the output directory.
 * This matches the old gulp build behavior where `gulp.src('src/**')` streams
 * every file and non-TS files bypass the compiler via tsFilter.restore.
 * Used for development/transpile builds only - production bundles use
 * copyResources() with curated per-target patterns instead.
 */
async function copyAllNonTsFiles(outDir: string, excludeTests: boolean): Promise<void> {
	console.log(`[resources] Copying all non-TS files to ${outDir}...`);

	const ignorePatterns = [
		// Exclude .ts files but keep .d.ts files (they're needed at runtime for type references)
		'**/*.ts',
		// Exclude pty-poc entirely — it's a standalone PoC not used by the production workbench
		'**/pty-poc/**',
	];
	if (excludeTests) {
		ignorePatterns.push('**/test/**');
	}

	const files = await globAsync('**/*', {
		cwd: path.join(REPO_ROOT, SRC_DIR),
		nodir: true,
		ignore: ignorePatterns,
	});

	// Re-include .d.ts files that were excluded by the *.ts ignore
	const dtsIgnore = ['**/pty-poc/**'];
	if (excludeTests) {
		dtsIgnore.push('**/test/**');
	}
	const dtsFiles = await globAsync('**/*.d.ts', {
		cwd: path.join(REPO_ROOT, SRC_DIR),
		ignore: dtsIgnore,
	});

	const allFiles = [...new Set([...files, ...dtsFiles])];

	await Promise.all(allFiles.map(file => {
		const srcPath = path.join(REPO_ROOT, SRC_DIR, file);
		const destPath = path.join(REPO_ROOT, outDir, file);
		return copyFile(srcPath, destPath);
	}));

	console.log(`[resources] Copied ${allFiles.length} files`);
}

/**
 * Copy codicon.ttf from node_modules to out/ directory.
 * This font is gitignored in src/ and normally copied by a gulp task.
 */
async function copyCodiconFont(outDir: string): Promise<void> {
	const src = path.join(REPO_ROOT, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf');
	const dest = path.join(REPO_ROOT, outDir, 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf');
	try {
		await copyFile(src, dest);
		console.log('[codicons] Copied codicon.ttf');
	} catch (e) {
		console.error('[codicons] Failed to copy codicon.ttf:', e);
	}
}

/**
 * Build the console-interceptor mini-package that forwards all console.*
 * calls to the Rust backend via tauri-plugin-log.
 *
 * The source lives in src/vs/code/tauri-browser/workbench/console-interceptor/
 * and the HTML references console-interceptor/dist/console-interceptor.js.
 * We use esbuild (already available as a dependency) to bundle the TypeScript
 * source into a single IIFE script in the output directory.
 */
async function buildConsoleInterceptor(outDir: string): Promise<void> {
	const entryPath = path.join(REPO_ROOT, SRC_DIR, 'vs/code/tauri-browser/workbench/console-interceptor/src/index.ts');
	const outPath = path.join(REPO_ROOT, outDir, 'vs/code/tauri-browser/workbench/console-interceptor/dist/console-interceptor.js');

	if (!fs.existsSync(entryPath)) {
		console.log('[console-interceptor] Source not found, skipping');
		return;
	}

	await esbuild.build({
		entryPoints: [entryPath],
		outfile: outPath,
		bundle: true,
		format: 'iife',
		target: ['es2020'],
		minify: false,
		sourcemap: 'inline',
		logLevel: 'warning',
	});

	console.log('[console-interceptor] Built dist/console-interceptor.js');
}

/**
 * Copy curated resource files for production bundles.
 * Uses specific per-target patterns matching the old build's vscodeResourceIncludes,
 * serverResourceIncludes, etc. Only called by bundle() - transpile uses copyAllNonTsFiles().
 */
async function copyResources(outDir: string, target: BuildTarget): Promise<void> {
	console.log(`[resources] Copying to ${outDir} for target '${target}'...`);
	let copied = 0;

	const ignorePatterns = ['**/test/**', '**/*-dev.html'];

	const resourcePatterns = getResourcePatternsForTarget(target);
	for (const pattern of resourcePatterns) {
		const files = await globAsync(pattern, {
			cwd: path.join(REPO_ROOT, SRC_DIR),
			ignore: ignorePatterns,
		});

		for (const file of files) {
			const srcPath = path.join(REPO_ROOT, SRC_DIR, file);
			const destPath = path.join(REPO_ROOT, outDir, file);

			await copyFile(srcPath, destPath);
			copied++;
		}
	}

	console.log(`[resources] Copied ${copied} files`);
}

// ============================================================================
// Plugins
// ============================================================================

function inlineMinimistPlugin(): esbuild.Plugin {
	return {
		name: 'inline-minimist',
		setup(build) {
			build.onResolve({ filter: /^minimist$/ }, () => ({
				path: path.join(REPO_ROOT, 'node_modules/minimist/index.js'),
				external: false,
			}));
		},
	};
}

function cssExternalPlugin(): esbuild.Plugin {
	// Mark CSS imports as external so they stay as import statements
	// The CSS files are copied separately and loaded by the browser at runtime
	return {
		name: 'css-external',
		setup(build) {
			build.onResolve({ filter: /\.css$/ }, (args) => ({
				path: args.path,
				external: true,
			}));
		},
	};
}

/**
 * esbuild plugin that transforms source files to inject build-time configuration.
 * This runs during onLoad so the transformation happens before esbuild processes the content,
 * ensuring placeholders like `/*BUILD->INSERT_PRODUCT_CONFIGURATION* /` are replaced
 * before esbuild strips them as non-legal comments.
 */
function fileContentMapperPlugin(outDir: string, _target: BuildTarget): esbuild.Plugin {
	// Cache the replacement strings (computed once)
	let productConfigReplacement: string | undefined;
	let builtinExtensionsReplacement: string | undefined;

	return {
		name: 'file-content-mapper',
		setup(build) {
			build.onLoad({ filter: /\.ts$/ }, async (args) => {
				// Skip .d.ts files
				if (args.path.endsWith('.d.ts')) {
					return undefined;
				}

				let contents = await fs.promises.readFile(args.path, 'utf-8');
				let modified = false;

				// Inject product configuration
				if (contents.includes('/*BUILD->INSERT_PRODUCT_CONFIGURATION*/')) {
					if (productConfigReplacement === undefined) {
						const productConfiguration = JSON.stringify({
							...product,
							version,
							commit,
							date: readISODate(outDir)
						});
						// Remove the outer braces since the placeholder is inside an object literal
						productConfigReplacement = productConfiguration.substring(1, productConfiguration.length - 1);
					}
					contents = contents.replace('/*BUILD->INSERT_PRODUCT_CONFIGURATION*/', () => productConfigReplacement!);
					modified = true;
				}

				// Inject built-in extensions list
				if (contents.includes('/*BUILD->INSERT_BUILTIN_EXTENSIONS*/')) {
					if (builtinExtensionsReplacement === undefined) {
						// Web target uses .build/web/extensions (from compileWebExtensionsBuildTask)
						// Other targets use .build/extensions
						const extensionsRoot = '.build/extensions';
						const builtinExtensions = JSON.stringify(scanBuiltinExtensions(extensionsRoot));
						// Remove the outer brackets since the placeholder is inside an array literal
						builtinExtensionsReplacement = builtinExtensions.substring(1, builtinExtensions.length - 1);
					}
					contents = contents.replace('/*BUILD->INSERT_BUILTIN_EXTENSIONS*/', () => builtinExtensionsReplacement!);
					modified = true;
				}

				if (modified) {
					return { contents, loader: 'ts' };
				}

				// No modifications, let esbuild handle normally
				return undefined;
			});
		},
	};
}

// ============================================================================
// Transpile (Goal 1: TS → JS using esbuild.transform for maximum speed)
// ============================================================================

// Shared transform options for single-file transpilation
const transformOptions: esbuild.TransformOptions = {
	loader: 'ts',
	format: 'esm',
	target: 'es2024',
	sourcemap: 'inline',
	sourcesContent: false,
	tsconfigRaw: JSON.stringify({
		compilerOptions: {
			experimentalDecorators: true,
			useDefineForClassFields: false
		}
	}),
};

async function transpileFile(srcPath: string, destPath: string): Promise<void> {
	const source = await fs.promises.readFile(srcPath, 'utf-8');
	const result = await esbuild.transform(source, {
		...transformOptions,
		sourcefile: srcPath,
	});

	await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
	// Skip write when content is unchanged to avoid updating mtime,
	// which would trigger Cargo's rerun-if-changed and cause full rebuilds.
	let existing: string | null = null;
	try {
		existing = await fs.promises.readFile(destPath, 'utf-8');
	} catch { /* file doesn't exist yet */ }
	if (existing !== result.code) {
		await fs.promises.writeFile(destPath, result.code);
	}
}

async function transpile(outDir: string, excludeTests: boolean): Promise<void> {
	// Find all .ts files
	const ignorePatterns = [
		'**/*.d.ts',
		// Exclude pty-poc entirely — it's a standalone PoC not used by the production workbench
		'**/pty-poc/**',
	];
	if (excludeTests) {
		ignorePatterns.push('**/test/**');
	}

	const files = await globAsync('**/*.ts', {
		cwd: path.join(REPO_ROOT, SRC_DIR),
		ignore: ignorePatterns,
	});

	console.log(`[transpile] Found ${files.length} files`);

	// Transpile all files in parallel using esbuild.transform (fastest approach)
	await Promise.all(files.map(file => {
		const srcPath = path.join(REPO_ROOT, SRC_DIR, file);
		const destPath = path.join(REPO_ROOT, outDir, file.replace(/\.ts$/, '.js'));
		return transpileFile(srcPath, destPath);
	}));
}

/**
 * Transpile built-in extensions under extensions/ that have a tsconfig.json.
 * Each extension is compiled in parallel using esbuild single-file transform,
 * which is much faster than running tsc for each extension separately.
 *
 * Extensions with `"type": "module"` in package.json are transpiled as ESM;
 * all others are transpiled as CJS. This matches the behavior of the gulp
 * ESBuildTranspiler in build/lib/tsb/transpiler.ts and ensures that CJS
 * extensions can be loaded via require() in Node.js without
 * --experimental-require-module.
 */
async function transpileExtensions(): Promise<void> {
	const extensionsDir = path.join(REPO_ROOT, 'extensions');
	const entries = await fs.promises.readdir(extensionsDir, { withFileTypes: true });

	// Each transpile target is { baseDir, tsconfigPath, label } where:
	// - baseDir: directory containing tsconfig.json (used to resolve rootDir/outDir)
	// - tsconfigPath: absolute path to tsconfig.json
	// - label: human-readable name for logging (e.g. "json-language-features/client")
	interface TranspileTarget {
		baseDir: string;
		tsconfigPath: string;
		label: string;
	}

	const targets: TranspileTarget[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const extDir = path.join(extensionsDir, entry.name);
		const rootTsconfig = path.join(extDir, 'tsconfig.json');
		try {
			await fs.promises.access(rootTsconfig);
			targets.push({ baseDir: extDir, tsconfigPath: rootTsconfig, label: entry.name });
		} catch {
			// No root tsconfig.json — check for client/server sub-projects
			// (e.g. json-language-features, css-language-features, html-language-features)
			for (const subDir of ['client', 'server']) {
				const subTsconfig = path.join(extDir, subDir, 'tsconfig.json');
				try {
					await fs.promises.access(subTsconfig);
					targets.push({ baseDir: path.join(extDir, subDir), tsconfigPath: subTsconfig, label: `${entry.name}/${subDir}` });
				} catch {
					// No tsconfig in sub-directory either — skip
				}
			}
		}
	}

	console.log(`[transpile-extensions] Found ${targets.length} transpile targets`);

	let totalFiles = 0;
	let esmCount = 0;

	await Promise.all(targets.map(async ({ baseDir, tsconfigPath, label: _label }) => {
		// Read tsconfig to determine rootDir and outDir (JSONC — strip comments and trailing commas)
		const tsconfigRaw = await fs.promises.readFile(tsconfigPath, 'utf-8');
		const tsconfigClean = tsconfigRaw
			.replace(/\/\/.*$/gm, '')         // strip line comments
			.replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
			.replace(/,\s*([\]}])/g, '$1');   // strip trailing commas
		let tsconfig: { compilerOptions?: { rootDir?: string; outDir?: string } };
		try {
			tsconfig = JSON.parse(tsconfigClean);
		} catch {
			return; // Unparseable tsconfig — skip
		}
		const rootDir = tsconfig.compilerOptions?.rootDir ?? './src';
		const outDir = tsconfig.compilerOptions?.outDir ?? './out';

		const srcDir = path.resolve(baseDir, rootDir);
		const destDir = path.resolve(baseDir, outDir);

		// Check if srcDir exists
		try {
			await fs.promises.access(srcDir);
		} catch {
			return; // No source directory
		}

		// Determine output format from package.json "type" field.
		// Extensions with "type": "module" use ESM; all others use CJS.
		// Look for package.json in the base directory first, then fall back to the
		// extension root (parent of client/server).
		let isESM = false;
		for (const pkgDir of [baseDir, path.dirname(baseDir)]) {
			const packageJsonPath = path.join(pkgDir, 'package.json');
			try {
				const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf-8'));
				isESM = packageJson.type === 'module';
				break;
			} catch {
				// No package.json or parse error — try next
			}
		}

		if (isESM) {
			esmCount++;
		}

		// Build extension-specific transform options matching the gulp
		// ESBuildTranspiler behavior (build/lib/tsb/transpiler.ts:330-348)
		const extTransformOptions: esbuild.TransformOptions = {
			loader: 'ts',
			format: isESM ? 'esm' : 'cjs',
			platform: isESM ? undefined : 'node',
			target: 'es2024',
			sourcemap: 'inline',
			sourcesContent: false,
			tsconfigRaw: JSON.stringify({
				compilerOptions: {
					experimentalDecorators: true,
					useDefineForClassFields: false,
				}
			}),
		};

		// Find all .ts files in the extension source
		const files = await globAsync('**/*.ts', {
			cwd: srcDir,
			ignore: ['**/*.d.ts'],
		});

		if (files.length === 0) {
			return;
		}

		totalFiles += files.length;

		// Transpile each file using esbuild with extension-specific options
		await Promise.all(files.map(async (file) => {
			const srcPath = path.join(srcDir, file);
			const destPath = path.join(destDir, file.replace(/\.ts$/, '.js'));

			const source = await fs.promises.readFile(srcPath, 'utf-8');
			const result = await esbuild.transform(source, {
				...extTransformOptions,
				sourcefile: srcPath,
			});

			await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
			await fs.promises.writeFile(destPath, result.code);
		}));
	}));

	console.log(`[transpile-extensions] Transpiled ${totalFiles} files across ${targets.length} targets (${esmCount} ESM, ${targets.length - esmCount} CJS)`);
}

// ============================================================================
// Compile Extensions with esbuild (for production bundles)
// ============================================================================

/**
 * Run `esbuild.mts` for each extension that has one, producing bundled
 * output in each extension's `dist/` directory.
 *
 * This is a prerequisite for `packageExtensions()` which will then use
 * the `dist/` output instead of `out/` (tsc-compiled) output. The esbuild
 * bundles inline all dependencies, eliminating the need for per-extension
 * `node_modules/` in the production build.
 *
 * Extensions without `esbuild.mts` are skipped (they continue to use
 * `out/` + `node_modules/`).
 */
async function compileExtensionsEsbuild(): Promise<void> {
	const extensionsDir = path.join(REPO_ROOT, 'extensions');
	const entries = await fs.promises.readdir(extensionsDir, { withFileTypes: true });
	const extensionDirs = entries.filter(e => e.isDirectory() && !EXCLUDED_EXTENSIONS.has(e.name));

	let succeeded = 0;
	let failed = 0;
	let skipped = 0;

	// Run esbuild for all extensions in parallel (with concurrency limit)
	const CONCURRENCY = 8;
	const queue = [...extensionDirs];
	const results: Array<{ name: string; success: boolean; error?: string }> = [];

	async function processNext(): Promise<void> {
		while (queue.length > 0) {
			const entry = queue.shift()!;
			const extName = entry.name;
			const extDir = path.join(extensionsDir, extName);
			const esbuildPath = path.join(extDir, 'esbuild.mts');
			const esbuildNotebookPath = path.join(extDir, 'esbuild.notebook.mts');

			const hasMain = await fileExists(esbuildPath);
			const hasNotebook = await fileExists(esbuildNotebookPath);

			if (!hasMain && !hasNotebook) {
				skipped++;
				continue;
			}

			// Run esbuild.mts (main extension bundle) if present
			if (hasMain) {
				const result = await runExtensionEsbuild(extDir, extName, 'esbuild.mts');
				results.push(result);
				if (result.success) {
					succeeded++;
					console.log(`[compile-extensions-esbuild]   ${extName} OK`);
				} else {
					failed++;
					console.warn(`[compile-extensions-esbuild]   ${extName} FAIL - ${result.error}`);
				}
			}

			// Run esbuild.notebook.mts (notebook renderer bundle) if present
			if (hasNotebook) {
				const result = await runExtensionEsbuild(extDir, extName, 'esbuild.notebook.mts');
				if (result.success) {
					console.log(`[compile-extensions-esbuild]   ${extName} (notebook) OK`);
				} else {
					console.warn(`[compile-extensions-esbuild]   ${extName} (notebook) FAIL - ${result.error}`);
				}
				// Notebook build failures don't count as extension failures
				// since the main esbuild.mts build already covers the critical path
			}
		}
	}

	// Start workers
	const workers = Array.from({ length: CONCURRENCY }, () => processNext());
	await Promise.all(workers);

	console.log(`[compile-extensions-esbuild] Results: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped (no esbuild.mts)`);

	if (failed > 0) {
		const failedNames = results.filter(r => !r.success).map(r => r.name);
		console.warn(`[compile-extensions-esbuild] Failed extensions (will fall back to out/ + node_modules): ${failedNames.join(', ')}`);
	}
}

/**
 * Run `node --experimental-strip-types <script>` for a single extension.
 */
function runExtensionEsbuild(extDir: string, extName: string, script: string = 'esbuild.mts'): Promise<{ name: string; success: boolean; error?: string }> {
	return new Promise((resolve) => {
		childProcess.execFile(
			'node',
			['--experimental-strip-types', script],
			{ cwd: extDir, timeout: 60_000 },
			(error, _stdout, stderr) => {
				if (error) {
					resolve({ name: extName, success: false, error: stderr || error.message });
				} else {
					resolve({ name: extName, success: true });
				}
			}
		);
	});
}

/**
 * Compute the `dist/`-based `main` field for an extension.
 *
 * Given the current `main` field (e.g., `"./out/extension"`) and the
 * extension's source directory, determines the corresponding `dist/` path.
 *
 * Returns `null` if no matching dist/ file is found. Paths include the
 * `.js` extension because the extension host uses ESM `import()` which
 * requires explicit file extensions.
 *
 * @example
 *   // Standard: ./out/extension → ./dist/extension.js
 *   computeDistMain('./out/extension', '/path/to/ext') → './dist/extension.js'
 *
 *   // Client-server: ./client/out/node/cssClientMain → ./client/dist/node/cssClientMain.js
 *   computeDistMain('./client/out/node/cssClientMain', '/path/to/ext') → './client/dist/node/cssClientMain.js'
 *
 *   // Flattened: ./out/node/emmetNodeMain → ./dist/emmetNodeMain.js
 *   computeDistMain('./out/node/emmetNodeMain', '/path/to/ext') → './dist/emmetNodeMain.js'
 */
function computeDistMain(mainField: string, extDir: string): string | null {
	// Strip leading './' and trailing '.js' for normalization
	const normalized = mainField.replace(/^\.\//, '').replace(/\.js$/, '');
	const basename = path.basename(normalized);

	// Strategy 1: Replace 'out' with 'dist' in the path
	// e.g., "client/out/node/cssClientMain" → "client/dist/node/cssClientMain"
	const distPath = normalized.replace(/\bout\b/, 'dist');
	if (fs.existsSync(path.join(extDir, `${distPath}.js`))) {
		return `./${distPath}.js`;
	}

	// Strategy 2: Flat dist/ directory (esbuild often flattens subdirectories)
	// e.g., "out/node/emmetNodeMain" → "dist/emmetNodeMain"
	if (fs.existsSync(path.join(extDir, 'dist', `${basename}.js`))) {
		return `./dist/${basename}.js`;
	}

	return null;
}

// ============================================================================
// Package Extensions (for Tauri bundle)
// ============================================================================

/**
 * Excluded extensions that should not be shipped in production builds.
 * These are test/development-only extensions.
 */
const EXCLUDED_EXTENSIONS = new Set([
	'vscode-api-tests',
	'vscode-colorize-tests',
	'vscode-colorize-perf-tests',
	'vscode-test-resolver',
	// TODO(Phase 1): Excluded for Tauri fork - SettingsSync/RemoteTunnel not supported
	'microsoft-authentication',
	'tunnel-forwarding',
]);

/**
 * Patterns of files/directories to exclude when packaging extensions.
 * These reduce the bundle size by removing development-only artifacts.
 */
const PACKAGE_EXCLUDE_PATTERNS = new Set([
	'node_modules',
	'src',
	'test',
	'tests',
	'test-workspace',
	'build',
	'.vscode',
	'.github',
]);

/**
 * File extensions/names to exclude from packaging.
 */
const PACKAGE_EXCLUDE_FILES = new Set([
	'tsconfig.json',
	'tsconfig.browser.json',
	'tsconfig.web.json',
	'.vscodeignore',
	'cgmanifest.json',
	'package-lock.json',
	'yarn.lock',
	'.eslintrc.json',
	'.npmrc',
	'CONTRIBUTING.md',
]);

/**
 * File extensions to exclude from packaging.
 */
const PACKAGE_EXCLUDE_EXTS = new Set([
	'.ts',   // TypeScript source (but keep .d.ts)
	'.mts',  // esbuild configs
]);

/**
 * Package built-in extensions into .build/extensions/ for Tauri bundling.
 *
 * This is the Tauri equivalent of the gulp `compile-extensions-build` pipeline.
 * It copies only the runtime-necessary files from each extension, excluding:
 * - Test extensions (vscode-api-tests, etc.)
 * - Source files (.ts, but not .d.ts)
 * - Test directories, build scripts, config files
 *
 * For extensions with esbuild `dist/` output:
 * - Uses `dist/` instead of `out/` (bundled, all deps inlined)
 * - Excludes `node_modules/` and `out/` (not needed with bundled output)
 * - Rewrites `main` in package.json to point to `dist/` path
 *
 * For extensions without `dist/` output (fallback):
 * - Uses `out/` with `node_modules/` preserved for runtime dependencies
 */
async function packageExtensions(): Promise<void> {
	const extensionsDir = path.join(REPO_ROOT, 'extensions');
	const outputDir = path.join(REPO_ROOT, '.build', 'extensions');

	// Step 1: Compile extensions with esbuild to produce dist/ output
	console.log('[package-extensions] Step 1: Compiling extensions with esbuild...');
	await compileExtensionsEsbuild();

	// Step 2: Clean output directory and package
	console.log('[package-extensions] Step 2: Packaging extensions...');
	await fs.promises.rm(outputDir, { recursive: true, force: true });
	await fs.promises.mkdir(outputDir, { recursive: true });

	const entries = await fs.promises.readdir(extensionsDir, { withFileTypes: true });
	const extensionDirs = entries.filter(e => e.isDirectory() && !EXCLUDED_EXTENSIONS.has(e.name));

	console.log(`[package-extensions] Packaging ${extensionDirs.length} extensions...`);

	let totalFiles = 0;
	let totalSize = 0;
	let distCount = 0;
	let fallbackCount = 0;

	await Promise.all(extensionDirs.map(async (entry) => {
		const extName = entry.name;
		const srcDir = path.join(extensionsDir, extName);
		const destDir = path.join(outputDir, extName);

		// Check for package.json — required for a valid extension
		const pkgJsonPath = path.join(srcDir, 'package.json');
		try {
			await fs.promises.access(pkgJsonPath);
		} catch {
			return; // Skip directories without package.json (e.g., node_modules)
		}

		// Read package.json to get the main field
		const pkgJson = JSON.parse(await fs.promises.readFile(pkgJsonPath, 'utf8'));
		const mainField: string | undefined = pkgJson.main;

		// Determine if this extension has a usable dist/ output
		const distMain = mainField ? computeDistMain(mainField, srcDir) : null;

		// Extensions without a `main` field and with no runtime `dependencies`
		// are renderer-only extensions (e.g., notebook-renderers).  Their webview
		// bundles live in renderer-out/ and all heavy node_modules are devDeps
		// used only at build time, so we can safely strip node_modules/.
		const hasNoDeps = !pkgJson.dependencies || Object.keys(pkgJson.dependencies).length === 0;
		const isRendererOnly = !mainField && !pkgJson.browser && hasNoDeps;
		const useDistBundle = distMain !== null || isRendererOnly;

		if (useDistBundle) {
			distCount++;
		} else {
			fallbackCount++;
		}

		// Copy the extension, filtering out unnecessary files
		const { files, size } = await copyExtension(srcDir, destDir, extName, useDistBundle);
		totalFiles += files;
		totalSize += size;

		// Rewrite package.json main field to use dist/ path
		if (useDistBundle && distMain) {
			const destPkgJsonPath = path.join(destDir, 'package.json');
			const destPkgJson = JSON.parse(await fs.promises.readFile(destPkgJsonPath, 'utf8'));
			destPkgJson.main = distMain;
			await fs.promises.writeFile(destPkgJsonPath, JSON.stringify(destPkgJson, null, '  ') + '\n', 'utf8');
			console.log(`[package-extensions]   ${extName}: main rewritten ${mainField} → ${distMain}`);
		}
	}));

	console.log(`[package-extensions] Packaged ${totalFiles} files (${(totalSize / 1024 / 1024).toFixed(1)} MB) into .build/extensions/`);
	console.log(`[package-extensions]   dist-bundled: ${distCount}, fallback (out+node_modules): ${fallbackCount}`);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Copy an extension directory, filtering out development-only files.
 *
 * When `useDistBundle` is true (extension has esbuild dist/ output):
 * - Excludes `out/` and `node_modules/` entirely (deps are bundled in dist/)
 * - Includes `dist/` directory with the bundled output
 *
 * When `useDistBundle` is false (fallback mode):
 * - Includes `out/` and `node_modules/` for runtime dependency resolution
 * - Excludes `dist/` to avoid shipping both bundled and unbundled code
 */
async function copyExtension(
	srcDir: string,
	destDir: string,
	_extName: string,
	useDistBundle: boolean,
): Promise<{ files: number; size: number }> {
	return copyDirectory(srcDir, destDir, (relPath) => {
		const parts = relPath.split(path.sep);
		const fileName = parts[parts.length - 1];
		const firstDir = parts[0];

		// Exclude TypeScript source files first (applies everywhere, including node_modules)
		// Keep .d.ts declaration files as they may be needed at runtime
		const ext = path.extname(fileName);
		if (ext === '.ts' && !fileName.endsWith('.d.ts')) {
			return false;
		}
		if (PACKAGE_EXCLUDE_EXTS.has(ext) && ext !== '.ts') {
			return false;
		}

		if (useDistBundle) {
			// dist-bundle mode: exclude out/ and node_modules/ at any level
			// This handles both top-level out/ and nested out/ (e.g., client/out/, server/out/)
			// and nested node_modules/ (e.g., server/node_modules/)
			if (parts.includes('out') || parts.includes('node_modules')) {
				return false;
			}
		}

		if (PACKAGE_EXCLUDE_PATTERNS.has(firstDir)) {
			// In fallback mode, allow node_modules (they need runtime deps)
			if (firstDir === 'node_modules' && !useDistBundle) {
				// But still exclude test directories within node_modules
				if (parts.some(p => p === 'test' || p === 'tests' || p === '.github')) {
					return false;
				}
				return true;
			}
			return false;
		}

		// Exclude specific files
		if (PACKAGE_EXCLUDE_FILES.has(fileName)) {
			return false;
		}

		return true;
	});
}

/**
 * Recursively copy a directory, applying a filter function to each relative path.
 */
async function copyDirectory(
	srcDir: string,
	destDir: string,
	filter: (relPath: string) => boolean,
): Promise<{ files: number; size: number }> {
	let files = 0;
	let size = 0;

	async function walk(currentSrc: string, currentDest: string, relBase: string): Promise<void> {
		const entries = await fs.promises.readdir(currentSrc, { withFileTypes: true });

		for (const entry of entries) {
			const relPath = relBase ? path.join(relBase, entry.name) : entry.name;

			if (!filter(relPath)) {
				continue;
			}

			const srcPath = path.join(currentSrc, entry.name);
			const destPath = path.join(currentDest, entry.name);

			if (entry.isSymbolicLink()) {
				// Preserve symlinks (e.g., node_modules/.bin/ entries)
				try {
					const linkTarget = await fs.promises.readlink(srcPath);
					await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
					await fs.promises.symlink(linkTarget, destPath);
					files++;
				} catch {
					// Skip broken or unresolvable symlinks
				}
			} else if (entry.isDirectory()) {
				await fs.promises.mkdir(destPath, { recursive: true });
				await walk(srcPath, destPath, relPath);
			} else if (entry.isFile()) {
				await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
				await fs.promises.copyFile(srcPath, destPath);
				const stat = await fs.promises.stat(srcPath);
				size += stat.size;
				files++;
			}
		}
	}

	await walk(srcDir, destDir, '');
	return { files, size };
}

// ============================================================================
// Bundle (Goal 2: JS → bundled JS)
// ============================================================================

async function bundle(outDir: string, doMinify: boolean, doNls: boolean, doManglePrivates: boolean, target: BuildTarget, sourceMapBaseUrl?: string): Promise<void> {
	await cleanDir(outDir);

	// Write build date file (used by packaging to embed in product.json).
	// Reuse the date from out-build/date if it exists (written by the gulp
	// writeISODate task) so that all parallel bundle outputs share the same
	// timestamp - this is required for deterministic builds (e.g. macOS Universal).
	const outDirPath = path.join(REPO_ROOT, outDir);
	await fs.promises.mkdir(outDirPath, { recursive: true });
	let buildDate: string;
	try {
		buildDate = await fs.promises.readFile(path.join(REPO_ROOT, 'out-build', 'date'), 'utf8');
	} catch {
		buildDate = getGitCommitDate();
	}
	await fs.promises.writeFile(path.join(outDirPath, 'date'), buildDate, 'utf8');

	console.log(`[bundle] ${SRC_DIR} → ${outDir} (target: ${target})${doMinify ? ' (minify)' : ''}${doNls ? ' (nls)' : ''}${doManglePrivates ? ' (mangle-privates)' : ''}`);
	const t1 = Date.now();

	// Read TSLib for banner
	const tslibPath = path.join(REPO_ROOT, 'node_modules/tslib/tslib.es6.js');
	const tslib = await fs.promises.readFile(tslibPath, 'utf-8');
	const banner = {
		js: `/*!--------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
${tslib}`,
		css: `/*!--------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/`,
	};

	// Shared TypeScript options for bundling directly from source
	const tsconfigRaw = JSON.stringify({
		compilerOptions: {
			experimentalDecorators: true,
			useDefineForClassFields: false
		}
	});

	// Create shared NLS collector (only used if doNls is true)
	const nlsCollector = createNLSCollector();
	const preserveEnglish = false; // Production mode: replace messages with null

	// Get entry points based on target
	const allEntryPoints = getEntryPointsForTarget(target);
	const bootstrapEntryPoints = getBootstrapEntryPointsForTarget(target);
	const bundleCssEntryPoints = getCssBundleEntryPointsForTarget(target);

	// Collect all build results (with write: false)
	const buildResults: { outPath: string; result: esbuild.BuildResult }[] = [];

	// Create the file content mapper plugin (injects product config, builtin extensions)
	const contentMapperPlugin = fileContentMapperPlugin(outDir, target);

	// Bundle each entry point directly from TypeScript source
	await Promise.all(allEntryPoints.map(async (entryPoint) => {
		const entryPath = path.join(REPO_ROOT, SRC_DIR, `${entryPoint}.ts`);
		const outPath = path.join(REPO_ROOT, outDir, `${entryPoint}.js`);

		// Use CSS external plugin for entry points that don't need bundled CSS
		const plugins: esbuild.Plugin[] = bundleCssEntryPoints.has(entryPoint) ? [] : [cssExternalPlugin()];
		// Add content mapper plugin to inject product config and builtin extensions
		plugins.push(contentMapperPlugin);
		if (doNls) {
			plugins.unshift(nlsPlugin({
				baseDir: path.join(REPO_ROOT, SRC_DIR),
				collector: nlsCollector,
			}));
		}

		// For entry points that bundle CSS, we need to use outdir instead of outfile
		// because esbuild can't produce multiple output files (JS + CSS) with outfile
		const needsCssBundling = bundleCssEntryPoints.has(entryPoint);

		const buildOptions: esbuild.BuildOptions = {
			entryPoints: needsCssBundling
				? [{ in: entryPath, out: entryPoint }]
				: [entryPath],
			...(needsCssBundling
				? { outdir: path.join(REPO_ROOT, outDir) }
				: { outfile: outPath }),
			bundle: true,
			format: 'esm',
			platform: 'neutral',
			target: ['es2024'],
			packages: 'external',
			sourcemap: 'linked',
			sourcesContent: true,
			minify: doMinify,
			treeShaking: true,
			banner,
			loader: {
				'.ttf': 'file',
				'.svg': 'file',
				'.png': 'file',
				'.sh': 'file',
			},
			assetNames: 'media/[name]',
			plugins,
			write: false, // Don't write yet, we need to post-process
			logLevel: 'warning',
			logOverride: {
				'unsupported-require-call': 'silent',
			},
			tsconfigRaw,
		};

		const result = await esbuild.build(buildOptions);

		buildResults.push({ outPath, result });
	}));

	// Bundle bootstrap files (with minimist inlined) directly from TypeScript source
	for (const entry of bootstrapEntryPoints) {
		const entryPath = path.join(REPO_ROOT, SRC_DIR, `${entry}.ts`);
		if (!fs.existsSync(entryPath)) {
			console.log(`[bundle] Skipping ${entry} (not found)`);
			continue;
		}

		const outPath = path.join(REPO_ROOT, outDir, `${entry}.js`);

		const bootstrapPlugins: esbuild.Plugin[] = [inlineMinimistPlugin(), contentMapperPlugin];
		if (doNls) {
			bootstrapPlugins.unshift(nlsPlugin({
				baseDir: path.join(REPO_ROOT, SRC_DIR),
				collector: nlsCollector,
			}));
		}

		const result = await esbuild.build({
			entryPoints: [entryPath],
			outfile: outPath,
			bundle: true,
			format: 'esm',
			platform: 'node',
			target: ['es2024'],
			packages: 'external',
			sourcemap: 'linked',
			sourcesContent: true,
			minify: doMinify,
			treeShaking: true,
			banner,
			plugins: bootstrapPlugins,
			write: false, // Don't write yet, we need to post-process
			logLevel: 'warning',
			logOverride: {
				'unsupported-require-call': 'silent',
			},
			tsconfigRaw,
		});

		buildResults.push({ outPath, result });
	}

	// Finalize NLS: sort entries, assign indices, write metadata files
	let indexMap = new Map<string, number>();
	if (doNls) {
		// Also write NLS files to out-build for backwards compatibility with test runner
		const nlsResult = await finalizeNLS(
			nlsCollector,
			path.join(REPO_ROOT, outDir),
			[path.join(REPO_ROOT, 'out-build')]
		);
		indexMap = nlsResult.indexMap;
	}

	// Post-process and write all output files
	let bundled = 0;
	const mangleStats: { file: string; result: ConvertPrivateFieldsResult }[] = [];
	// Map from JS file path to pre-mangle content + edits, for source map adjustment
	const mangleEdits = new Map<string, { preMangleCode: string; edits: readonly import('./private-to-property.ts').TextEdit[] }>();
	// Map from JS file path to pre-NLS content + edits, for source map adjustment
	const nlsEdits = new Map<string, { preNLSCode: string; edits: readonly import('./private-to-property.ts').TextEdit[] }>();
	// Defer .map files until all .js files are processed, because esbuild may
	// emit the .map file in a different build result than the .js file (e.g.
	// code-split chunks), and we need the NLS/mangle edits from the .js pass
	// to be available when adjusting the .map.
	const deferredMaps: { path: string; text: string; contents: Uint8Array }[] = [];
	for (const { result } of buildResults) {
		if (!result.outputFiles) {
			continue;
		}

		for (const file of result.outputFiles) {
			await fs.promises.mkdir(path.dirname(file.path), { recursive: true });

			if (file.path.endsWith('.js') || file.path.endsWith('.css')) {
				let content = file.text;

				// Convert native #private fields to regular properties BEFORE NLS
				// post-processing, so that the edit offsets align with esbuild's
				// source map coordinate system (both reference the raw esbuild output).
				// Skip extension host bundles - they expose API surface to extensions
				// where true encapsulation matters more than the perf gain.
				if (file.path.endsWith('.js') && doManglePrivates && !isExtensionHostBundle(file.path)) {
					const preMangleCode = content;
					const mangleResult = convertPrivateFields(content, file.path);
					content = mangleResult.code;
					if (mangleResult.editCount > 0) {
						mangleStats.push({ file: path.relative(path.join(REPO_ROOT, outDir), file.path), result: mangleResult });
						mangleEdits.set(file.path, { preMangleCode, edits: mangleResult.edits });
					}
				}

				// Apply NLS post-processing if enabled (JS only)
				if (file.path.endsWith('.js') && doNls && indexMap.size > 0) {
					const preNLSCode = content;
					const nlsResult = postProcessNLS(content, indexMap, preserveEnglish);
					content = nlsResult.code;
					if (nlsResult.edits.length > 0) {
						nlsEdits.set(file.path, { preNLSCode, edits: nlsResult.edits });
					}
				}

				// Rewrite sourceMappingURL to CDN URL if configured
				if (sourceMapBaseUrl) {
					const relativePath = path.relative(path.join(REPO_ROOT, outDir), file.path);
					content = content.replace(
						/\/\/# sourceMappingURL=.+$/m,
						`//# sourceMappingURL=${sourceMapBaseUrl}/${relativePath}.map`
					);
					content = content.replace(
						/\/\*# sourceMappingURL=.+\*\/$/m,
						`/*# sourceMappingURL=${sourceMapBaseUrl}/${relativePath}.map*/`
					);
				}

				await fs.promises.writeFile(file.path, content);
			} else if (file.path.endsWith('.map')) {
				// Defer .map processing until all .js files have been handled
				deferredMaps.push({ path: file.path, text: file.text, contents: file.contents });
			} else {
				// Write other files (assets, etc.) as-is
				await fs.promises.writeFile(file.path, file.contents);
			}
		}
		bundled++;
	}

	// Second pass: process deferred .map files now that all mangle/NLS edits
	// have been collected from .js processing above.
	for (const mapFile of deferredMaps) {
		const jsPath = mapFile.path.replace(/\.map$/, '');
		const mangle = mangleEdits.get(jsPath);
		const nls = nlsEdits.get(jsPath);

		if (mangle || nls) {
			let mapJson = JSON.parse(mapFile.text);
			if (mangle) {
				mapJson = adjustSourceMap(mapJson, mangle.preMangleCode, mangle.edits);
			}
			if (nls) {
				mapJson = adjustSourceMap(mapJson, nls.preNLSCode, nls.edits);
			}
			await fs.promises.writeFile(mapFile.path, JSON.stringify(mapJson));
		} else {
			await fs.promises.writeFile(mapFile.path, mapFile.contents);
		}
	}

	// Log mangle-privates stats
	if (doManglePrivates && mangleStats.length > 0) {
		let totalClasses = 0, totalFields = 0, totalEdits = 0, totalElapsed = 0;
		for (const { file, result } of mangleStats) {
			console.log(`[mangle-privates] ${file}: ${result.classCount} classes, ${result.fieldCount} fields, ${result.editCount} edits, ${result.elapsed}ms`);
			totalClasses += result.classCount;
			totalFields += result.fieldCount;
			totalEdits += result.editCount;
			totalElapsed += result.elapsed;
		}
		console.log(`[mangle-privates] Total: ${totalClasses} classes, ${totalFields} fields, ${totalEdits} edits, ${totalElapsed}ms`);
	}

	// Copy resources (curated per-target patterns for production)
	await copyResources(outDir, target);

	// Build console-interceptor (Tauri-specific, forwards console.* to Rust backend)
	await buildConsoleInterceptor(outDir);

	// Compile standalone TypeScript files (like Electron preload scripts) that cannot be bundled
	await compileStandaloneFiles(outDir, doMinify, target);

	console.log(`[bundle] Done in ${Date.now() - t1}ms (${bundled} bundles)`);
}

// ============================================================================
// Watch Mode
// ============================================================================

async function watch(): Promise<void> {
	if (!useEsbuildTranspile) {
		console.log('Starting transpilation...');
		console.log('Finished transpilation with 0 errors after 0 ms');
		console.log('[watch] esbuild transpile disabled (useEsbuildTranspile=false). Keeping process alive as no-op.');
		await new Promise(() => { }); // keep alive
		return;
	}

	console.log('Starting transpilation...');

	const outDir = OUT_DIR;

	// Initial setup
	await cleanDir(outDir);
	console.log(`[transpile] ${SRC_DIR} → ${outDir}`);

	// Initial full build
	const t1 = Date.now();
	try {
		await transpile(outDir, false);
		await copyAllNonTsFiles(outDir, false);
		await copyCodiconFont(outDir);
		await buildConsoleInterceptor(outDir);
		console.log(`Finished transpilation with 0 errors after ${Date.now() - t1} ms`);
	} catch (err) {
		console.error('[watch] Initial build failed:', err);
		console.log(`Finished transpilation with 1 errors after ${Date.now() - t1} ms`);
		// Continue watching anyway
	}

	let pendingTsFiles: Set<string> = new Set();
	let pendingCopyFiles: Set<string> = new Set();

	const processChanges = async () => {
		console.log('Starting transpilation...');
		const t1 = Date.now();
		const tsFiles = [...pendingTsFiles];
		const filesToCopy = [...pendingCopyFiles];
		pendingTsFiles = new Set();
		pendingCopyFiles = new Set();

		try {
			// Transform changed TypeScript files in parallel
			if (tsFiles.length > 0) {
				console.log(`[watch] Transpiling ${tsFiles.length} file(s)...`);
				await Promise.all(tsFiles.map(srcPath => {
					const relativePath = path.relative(path.join(REPO_ROOT, SRC_DIR), srcPath);
					const destPath = path.join(REPO_ROOT, outDir, relativePath.replace(/\.ts$/, '.js'));
					return transpileFile(srcPath, destPath);
				}));
			}

			// Rebuild console-interceptor if its source changed
			if (tsFiles.some(f => f.includes('console-interceptor'))) {
				await buildConsoleInterceptor(outDir);
			}

			// Copy changed resource files in parallel
			if (filesToCopy.length > 0) {
				await Promise.all(filesToCopy.map(async (srcPath) => {
					const relativePath = path.relative(path.join(REPO_ROOT, SRC_DIR), srcPath);
					const destPath = path.join(REPO_ROOT, outDir, relativePath);
					await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
					await fs.promises.copyFile(srcPath, destPath);
					console.log(`[watch] Copied ${relativePath}`);
				}));
			}

			if (tsFiles.length > 0 || filesToCopy.length > 0) {
				console.log(`Finished transpilation with 0 errors after ${Date.now() - t1} ms`);
			}
		} catch (err) {
			console.error('[watch] Rebuild failed:', err);
			console.log(`Finished transpilation with 1 errors after ${Date.now() - t1} ms`);
			// Continue watching
		}
	};

	// Watch src directory using existing gulp-watch based watcher
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const srcDir = path.join(REPO_ROOT, SRC_DIR);
	const watchStream = gulpWatch('src/**', { base: srcDir, readDelay: 200 });

	watchStream.on('data', (file: { path: string }) => {
		if (file.path.endsWith('.ts') && !file.path.endsWith('.d.ts')) {
			pendingTsFiles.add(file.path);
		} else {
			// Copy any non-TS file (matches old gulp build's `src/**` behavior)
			pendingCopyFiles.add(file.path);
		}

		if (pendingTsFiles.size > 0 || pendingCopyFiles.size > 0) {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(processChanges, 200);
		}
	});

	console.log('[watch] Watching src/**/*.{ts,css,...} (Ctrl+C to stop)');

	// Keep process alive
	process.on('SIGINT', () => {
		console.log('\n[watch] Stopping...');
		watchStream.end();
		process.exit(0);
	});
}

// ============================================================================
// Main
// ============================================================================

function printUsage(): void {
	console.log(`Usage: npx tsx build/next/index.ts <command> [options]

Commands:
	transpile          Transpile TypeScript to JavaScript (single-file, fast)
	transpile-extensions  Transpile built-in extensions under extensions/
	compile-extensions-esbuild  Compile extensions with esbuild (produces dist/ bundles)
	package-extensions    Package built-in extensions for Tauri bundling
	bundle             Bundle entry points into optimized bundles

Options for 'transpile':
	--watch            Watch for changes and rebuild incrementally
	--out <dir>        Output directory (default: out)
	--exclude-tests    Exclude test files from transpilation

Options for 'bundle':
	--minify           Minify the output bundles
	--nls              Process NLS (localization) strings
	--mangle-privates  Convert native #private fields to regular properties
	--out <dir>        Output directory (default: out-vscode)
	--target <target>  Build target: desktop (default), server
	--source-map-base-url <url>  Rewrite sourceMappingURL to CDN URL

Examples:
	npx tsx build/next/index.ts transpile
	npx tsx build/next/index.ts transpile --watch
	npx tsx build/next/index.ts transpile --out out-build
	npx tsx build/next/index.ts transpile --out out-build --exclude-tests
	npx tsx build/next/index.ts bundle
	npx tsx build/next/index.ts bundle --minify --nls
	npx tsx build/next/index.ts bundle --nls --out out-vscode-min
	npx tsx build/next/index.ts bundle --minify --nls --target server --out out-vscode-reh-min
`);
}

async function main(): Promise<void> {
	const t1 = Date.now();
	let skipped = false;

	try {
		switch (command) {
			case 'transpile':
				if (options.watch) {
					await watch();
				} else if (await canSkip('transpile', [path.join(REPO_ROOT, SRC_DIR)])) {
					// allow-any-unicode-next-line
					console.log('✅ [transpile] Skipped (no source changes)');
					skipped = true;
				} else {
					const outDir = options.out ?? OUT_DIR;
					await cleanDir(outDir);

					// Write build date file (used by packaging to embed in product.json)
					const outDirPath = path.join(REPO_ROOT, outDir);
					await fs.promises.mkdir(outDirPath, { recursive: true });
					await fs.promises.writeFile(path.join(outDirPath, 'date'), getGitCommitDate(), 'utf8');

					console.log(`[transpile] ${SRC_DIR} → ${outDir}${options.excludeTests ? ' (excluding tests)' : ''}`);
					const t1 = Date.now();
					await transpile(outDir, options.excludeTests);
					await copyAllNonTsFiles(outDir, options.excludeTests);
					await copyCodiconFont(outDir);
					await buildConsoleInterceptor(outDir);
					console.log(`[transpile] Done in ${Date.now() - t1}ms`);
					markComplete('transpile');
				}
				break;

		case 'transpile-extensions': {
				if (await canSkip('transpile-extensions', [path.join(REPO_ROOT, 'extensions')], ['dist/', '/out/', 'node_modules/'])) {
					// allow-any-unicode-next-line
					console.log('✅ [transpile-extensions] Skipped (no source changes)');
					skipped = true;
				} else {
					console.log(`[transpile-extensions] Transpiling built-in extensions...`);
					const t1 = Date.now();
					await transpileExtensions();
					console.log(`[transpile-extensions] Done in ${Date.now() - t1}ms`);
					markComplete('transpile-extensions');
				}
				break;
			}

			case 'compile-extensions-esbuild': {
				console.log(`[compile-extensions-esbuild] Compiling extensions with esbuild...`);
				const t1 = Date.now();
				await compileExtensionsEsbuild();
				console.log(`[compile-extensions-esbuild] Done in ${Date.now() - t1}ms`);
				break;
			}

			case 'package-extensions': {
				if (await canSkip('package-extensions', [path.join(REPO_ROOT, 'extensions')], ['dist/', '/out/', 'node_modules/'])) {
					// allow-any-unicode-next-line
					console.log('✅ [package-extensions] Skipped (no source changes)');
					skipped = true;
				} else {
					console.log(`[package-extensions] Packaging built-in extensions for Tauri...`);
					const t1 = Date.now();
					await packageExtensions();
					console.log(`[package-extensions] Done in ${Date.now() - t1}ms`);
					markComplete('package-extensions');
				}
				break;
			}

			case 'bundle':
				await bundle(options.out ?? OUT_VSCODE_DIR, options.minify, options.nls, options.manglePrivates, options.target as BuildTarget, options.sourceMapBaseUrl);
				break;

			default:
				printUsage();
				process.exit(command ? 1 : 0);
		}

		if (!options.watch && !skipped) {
			console.log(`\n✓ Total: ${Date.now() - t1}ms`);
		}
	} catch (err) {
		console.error('Build failed:', err);
		process.exit(1);
	}
}

main();
