/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Typed IPC protocol for extension management commands.
 *
 * This is the single source of truth for all extension-related Tauri IPC calls.
 * Every `invoke()` call is typed with input/output interfaces matching the
 * Rust command serde schemas in `commands/extension_management.rs`.
 */

import { invoke } from './tauriApi.js';

// ---------------------------------------------------------------------------
// Response types (must match Rust serde schemas)
// ---------------------------------------------------------------------------

export interface ExtractResult {
	extensionPath: string;
	manifest: /* IExtensionManifest */ any;
}

export interface ScannedExtension {
	id: string;
	version: string;
	location: string;
	manifest: /* IExtensionManifest */ any;
	installedTimestamp: number | undefined;
	targetPlatform: string;
}

export interface PlatformInfo {
	targetPlatform: string;
}

// ---------------------------------------------------------------------------
// Command invokers
// ---------------------------------------------------------------------------

export const extCommands = {
	/**
	 * Extract a VSIX (ZIP) file to a target directory.
	 * Returns the extracted extension path and parsed manifest.
	 */
	extractVsix: (vsixPath: string, targetDir: string) =>
		invoke<ExtractResult>('ext_extract_vsix', { vsixPath, targetDir }),

	/**
	 * Read the manifest (package.json) from a VSIX without full extraction.
	 */
	readVsixManifest: (vsixPath: string) =>
		invoke</* IExtensionManifest */ any>('ext_read_vsix_manifest', { vsixPath }),

	/**
	 * Recursively delete an extension directory.
	 * Validates that the path is within the extensions base directory.
	 */
	deleteExtension: (extensionPath: string, extensionsBase: string) =>
		invoke<void>('ext_delete_extension', { extensionPath, extensionsBase }),

	/**
	 * Scan the user-installed extensions directory for all installed extensions.
	 */
	scanInstalled: (extensionsDir: string) =>
		invoke<ScannedExtension[]>('ext_scan_installed', { extensionsDir }),

	/**
	 * Get the current platform's target identifier (e.g., `darwin-arm64`).
	 */
	getTargetPlatform: () =>
		invoke<PlatformInfo>('ext_get_target_platform'),

	/**
	 * Compute the total size (bytes) of an extension directory on disk.
	 */
	computeExtensionSize: (extensionPath: string) =>
		invoke<number>('ext_compute_extension_size', { extensionPath }),
};
