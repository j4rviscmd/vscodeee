/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Download a Bun binary for the current (or specified) platform and place it
 * into `src-tauri/binaries/` with the Tauri sidecar naming convention:
 *
 *   bun-<target-triple>[.exe]
 *
 * Usage:
 *   node scripts/download-bun.mjs                    # auto-detect platform
 *   node scripts/download-bun.mjs --target aarch64-apple-darwin
 *   node scripts/download-bun.mjs --bun-version 1.3.5
 *
 * The Bun version defaults to the value in `.bun-version` (trimmed),
 * falling back to "1.3.5" if the file does not exist.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BINARIES_DIR = path.join(REPO_ROOT, 'src-tauri', 'binaries');

/**
 * Map from Rust target triple to Bun download platform/arch.
 * @type {Record<string, { platform: string; arch: string }>}
 */
const TARGET_MAP = {
	'aarch64-apple-darwin': { platform: 'darwin', arch: 'aarch64' },
	'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
	'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
	'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'aarch64' },
	'armv7-unknown-linux-gnueabihf': { platform: 'linux', arch: 'armv7' },
	'x86_64-pc-windows-msvc': { platform: 'windows', arch: 'x64' },
	'aarch64-pc-windows-msvc': { platform: 'windows', arch: 'aarch64' },
};

/**
 * Detect the Rust target triple for the current host.
 * @returns {string}
 */
function detectTargetTriple() {
	const tauriTarget = process.env.TAURI_ENV_TARGET_TRIPLE;
	if (tauriTarget) {
		console.log(`[download-bun] Using TAURI_ENV_TARGET_TRIPLE: ${tauriTarget}`);
		return tauriTarget;
	}
	return execFileSync('rustc', ['--print', 'host-tuple']).toString().trim();
}

/**
 * Read the Bun version from `.bun-version`, falling back to a default.
 * @returns {string}
 */
function readBunVersion() {
	const versionFile = path.join(REPO_ROOT, '.bun-version');
	if (fs.existsSync(versionFile)) {
		return fs.readFileSync(versionFile, 'utf-8').trim();
	}
	return '1.3.5';
}

/**
 * Download a file from a URL, following redirects.
 * @param {string} url
 * @returns {Promise<import('http').IncomingMessage>}
 */
function download(url) {
	return new Promise((resolve, reject) => {
		https.get(url, (res) => {
			if (res.statusCode === 302 || res.statusCode === 301) {
				const location = res.headers.location;
				if (!location) {
					reject(new Error(`Redirect without Location header from ${url}`));
					return;
				}
				resolve(download(location));
				return;
			}
			if (res.statusCode !== 200) {
				reject(new Error(`HTTP ${res.statusCode} for ${url}`));
				return;
			}
			resolve(res);
		}).on('error', reject);
	});
}

/**
 * Extract the `bun` binary from a zip archive using system unzip.
 * @param {string} zipPath - Path to the downloaded zip file
 * @param {string} destPath - Where to write the extracted binary
 * @returns {Promise<void>}
 */
async function extractBunFromZip(zipPath, destPath) {
	const destDir = path.dirname(destPath);

	// Bun zip structure: bun-{platform}-{arch}/bun
	// Use -j to flatten paths, -o to overwrite
	execFileSync('unzip', ['-o', '-j', zipPath, '*/bun', '-d', destDir], { stdio: 'pipe' });

	// unzip -j extracts as just "bun" in destDir
	const extractedName = path.join(destDir, 'bun');
	if (extractedName !== destPath && fs.existsSync(extractedName)) {
		fs.renameSync(extractedName, destPath);
	}

	await fs.promises.chmod(destPath, 0o755);
}

/**
 * Extract the `bun.exe` binary from a Windows zip archive.
 * @param {string} zipPath
 * @param {string} destPath
 */
async function extractBunWindowsZip(zipPath, destPath) {
	const destDir = path.dirname(destPath);

	execFileSync('powershell', [
		'-Command',
		`Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force; ` +
		`Get-ChildItem -Recurse -Filter 'bun.exe' '${destDir}' | ` +
		`Move-Item -Destination '${destPath}' -Force`
	], { stdio: 'pipe' });
}

async function main() {
	const args = process.argv.slice(2);
	let targetTriple = '';
	let bunVersion = '';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--target' && args[i + 1]) {
			targetTriple = args[++i];
		} else if (args[i] === '--bun-version' && args[i + 1]) {
			bunVersion = args[++i];
		}
	}

	if (!targetTriple) {
		targetTriple = detectTargetTriple();
	}
	if (!bunVersion) {
		bunVersion = readBunVersion();
	}

	const mapping = TARGET_MAP[targetTriple];
	if (!mapping) {
		console.error(`[download-bun] Unsupported target triple: ${targetTriple}`);
		console.error(`[download-bun] Supported: ${Object.keys(TARGET_MAP).join(', ')}`);
		process.exit(1);
	}

	const { platform, arch } = mapping;
	const isWindows = platform === 'windows';
	const ext = isWindows ? '.exe' : '';
	const destPath = path.join(BINARIES_DIR, `bun-${targetTriple}${ext}`);

	// Check if already downloaded (Bun binary is ~30MB minimum)
	const MIN_VALID_SIZE = 5 * 1024 * 1024; // 5 MB

	if (fs.existsSync(destPath)) {
		const stat = fs.statSync(destPath);
		const sizeMB = stat.size / 1024 / 1024;

		if (stat.size >= MIN_VALID_SIZE) {
			console.log(`✅ [download-bun] Already exists (${sizeMB.toFixed(1)} MB)`);
			return;
		}

		console.log(`[download-bun] Existing binary is too small (${sizeMB.toFixed(1)} MB), re-downloading...`);
		fs.unlinkSync(destPath);
	}

	await fs.promises.mkdir(BINARIES_DIR, { recursive: true });

	const archiveName = `bun-${platform}-${arch}.zip`;
	const url = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${archiveName}`;

	console.log(`[download-bun] Downloading ${url}`);
	const res = await download(url);

	// Save to temp file then extract
	const tmpZip = path.join(BINARIES_DIR, `_bun-download-${Date.now()}.zip`);
	const writeStream = createWriteStream(tmpZip);
	await pipeline(res, writeStream);

	console.log(`[download-bun] Downloaded, extracting...`);

	if (isWindows) {
		await extractBunWindowsZip(tmpZip, destPath);
	} else {
		await extractBunFromZip(tmpZip, destPath);
	}

	// Cleanup temp zip
	try { fs.unlinkSync(tmpZip); } catch { /* best-effort */ }

	// Verify the binary works
	try {
		const version = execFileSync(destPath, ['--version']).toString().trim();
		console.log(`[download-bun] Verified: ${version}`);
	} catch {
		console.warn(`[download-bun] Warning: Could not verify binary (cross-compilation target?)`);
	}

	const stat = fs.statSync(destPath);
	console.log(`[download-bun] Done: ${destPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
	console.error(`[download-bun] Fatal: ${err.message}`);
	process.exit(1);
});
