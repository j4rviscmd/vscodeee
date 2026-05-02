/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Download a Node.js binary for the current (or specified) platform and place it
 * into `src-tauri/binaries/` with the Tauri sidecar naming convention:
 *
 *   node-<target-triple>[.exe]
 *
 * Usage:
 *   node scripts/download-node.mjs                    # auto-detect platform
 *   node scripts/download-node.mjs --target aarch64-apple-darwin
 *   node scripts/download-node.mjs --node-version 22.22.1
 *
 * The Node.js version defaults to the value in `.nvmrc` (trimmed).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BINARIES_DIR = path.join(REPO_ROOT, 'src-tauri', 'binaries');

/**
 * Map from Rust target triple to Node.js download platform/arch.
 * @type {Record<string, { platform: string; arch: string }>}
 */
const TARGET_MAP = {
	'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
	'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
	'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
	'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64' },
	'armv7-unknown-linux-gnueabihf': { platform: 'linux', arch: 'armv7l' },
	'x86_64-pc-windows-msvc': { platform: 'win', arch: 'x64' },
	'aarch64-pc-windows-msvc': { platform: 'win', arch: 'arm64' },
};

/**
 * Detect the Rust target triple for the current host.
 * Prefers `TAURI_ENV_TARGET_TRIPLE` (set by Tauri CLI during cross-compilation)
 * over the host triple from `rustc`.
 * @returns {string}
 */
function detectTargetTriple() {
	// Tauri CLI sets this during `tauri build --target <triple>` for cross-compilation.
	// The beforeBuildCommand inherits this env var, ensuring the correct binary is downloaded.
	const tauriTarget = process.env.TAURI_ENV_TARGET_TRIPLE;
	if (tauriTarget) {
		console.log(`[download-node] Using TAURI_ENV_TARGET_TRIPLE: ${tauriTarget}`);
		return tauriTarget;
	}
	return execSync('rustc --print host-tuple').toString().trim();
}

/**
 * Read the Node.js version from `.nvmrc`.
 * @returns {string}
 */
function readNodeVersion() {
	const nvmrcPath = path.join(REPO_ROOT, '.nvmrc');
	return fs.readFileSync(nvmrcPath, 'utf-8').trim().replace(/^v/, '');
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
 * Extract the `node` binary from a `.tar.gz` archive stream.
 *
 * We use a simple tar parser since we only need one file (`bin/node`).
 * The tar format has 512-byte headers followed by data blocks.
 *
 * @param {import('stream').Readable} stream - Gunzipped tar stream
 * @param {string} destPath - Where to write the extracted binary
 * @returns {Promise<void>}
 */
async function extractNodeFromTarGz(stream, destPath) {
	const gunzip = createGunzip();
	const chunks = /** @type {Buffer[]} */ ([]);

	// Collect the entire gunzipped tar into memory (~65MB)
	// This is simpler than streaming tar parsing and acceptable for a build script
	await pipeline(stream, gunzip, async function* (source) {
		for await (const chunk of source) {
			chunks.push(Buffer.from(chunk));
		}
	});

	const tar = Buffer.concat(chunks);
	let offset = 0;

	while (offset < tar.length - 512) {
		// Read tar header (512 bytes)
		const header = tar.subarray(offset, offset + 512);

		// Check for end-of-archive (two consecutive zero blocks)
		if (header.every((b) => b === 0)) {
			break;
		}

		// Extract filename (bytes 0-99, null-terminated)
		const nameEnd = header.indexOf(0, 0);
		const name = header.subarray(0, Math.min(nameEnd, 100)).toString('utf-8');

		// Extract file size (bytes 124-135, octal, null/space-terminated)
		const sizeStr = header.subarray(124, 136).toString('utf-8').trim();
		const size = parseInt(sizeStr, 8) || 0;

		offset += 512; // Move past header

		// Check if this is the node binary (e.g., "node-v22.22.1-darwin-arm64/bin/node")
		if (name.endsWith('/bin/node') || name === 'bin/node') {
			const data = tar.subarray(offset, offset + size);
			await fs.promises.writeFile(destPath, data);
			await fs.promises.chmod(destPath, 0o755);
			console.log(`[download-node] Extracted ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
			return;
		}

		// Skip to next header (data is padded to 512-byte blocks)
		offset += Math.ceil(size / 512) * 512;
	}

	throw new Error('Could not find bin/node in the tar archive');
}

/**
 * Download and extract Node.js for Windows (zip archive).
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
async function downloadWindowsNode(url, destPath) {
	// For Windows, we download the .zip and extract node.exe
	// Using a simpler approach: download the standalone node.exe directly
	const exeUrl = url.replace('.zip', '').replace(/node-v[\d.]+-win-\w+/, '') + '/node.exe';

	// Actually, let's download the node.exe directly from the dist
	const version = url.match(/v([\d.]+)/)?.[1];
	const arch = url.includes('x64') ? 'x64' : 'arm64';
	const directUrl = `https://nodejs.org/dist/v${version}/win-${arch}/node.exe`;

	console.log(`[download-node] Downloading ${directUrl}`);
	const res = await download(directUrl);
	const writeStream = fs.createWriteStream(destPath);
	await pipeline(res, writeStream);
	console.log(`[download-node] Saved ${destPath}`);
}

async function main() {
	const args = process.argv.slice(2);
	let targetTriple = '';
	let nodeVersion = '';

	// Parse CLI arguments
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--target' && args[i + 1]) {
			targetTriple = args[++i];
		} else if (args[i] === '--node-version' && args[i + 1]) {
			nodeVersion = args[++i];
		}
	}

	if (!targetTriple) {
		targetTriple = detectTargetTriple();
	}
	if (!nodeVersion) {
		nodeVersion = readNodeVersion();
	}

	const mapping = TARGET_MAP[targetTriple];
	if (!mapping) {
		console.error(`[download-node] Unsupported target triple: ${targetTriple}`);
		console.error(`[download-node] Supported: ${Object.keys(TARGET_MAP).join(', ')}`);
		process.exit(1);
	}

	const { platform, arch } = mapping;
	const isWindows = platform === 'win';
	const ext = isWindows ? '.exe' : '';
	const destPath = path.join(BINARIES_DIR, `node-${targetTriple}${ext}`);

	// Check if already downloaded
	// A valid Node.js binary is at least 10 MB. Anything smaller is likely a
	// stub / placeholder (e.g. created by `touch` in CI) and should be replaced.
	const MIN_VALID_SIZE = 10 * 1024 * 1024; // 10 MB

	if (fs.existsSync(destPath)) {
		const stat = fs.statSync(destPath);
		const sizeMB = stat.size / 1024 / 1024;

		if (stat.size >= MIN_VALID_SIZE) {
			console.log(`✅ [download-node] Already exists (${sizeMB.toFixed(1)} MB)`);
			return;
		}

		// File exists but is too small - remove and re-download
		console.log(`[download-node] Existing binary is too small (${sizeMB.toFixed(1)} MB), re-downloading...`);
		fs.unlinkSync(destPath);
	}

	// Ensure binaries directory exists
	await fs.promises.mkdir(BINARIES_DIR, { recursive: true });

	if (isWindows) {
		const url = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-${arch}.zip`;
		await downloadWindowsNode(url, destPath);
	} else {
		const archiveName = `node-v${nodeVersion}-${platform}-${arch}.tar.gz`;
		const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;

		console.log(`[download-node] Downloading ${url}`);
		const res = await download(url);
		await extractNodeFromTarGz(res, destPath);
	}

	// Verify the binary works
	try {
		const version = execSync(`"${destPath}" --version`).toString().trim();
		console.log(`[download-node] Verified: ${version}`);
	} catch {
		console.warn(`[download-node] Warning: Could not verify binary (cross-compilation target?)`);
	}

	const stat = fs.statSync(destPath);
	console.log(`[download-node] Done: ${destPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
	console.error(`[download-node] Fatal: ${err.message}`);
	process.exit(1);
});
