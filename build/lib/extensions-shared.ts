/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shared types and utilities for extensions that are used by both the gulp build
// system (build/lib/extensions.ts) and the esbuild-based build (build/next/index.ts).
// This module is intentionally kept free of heavy dependencies (like gulp-vinyl-zip)
// so it can be imported without pulling in the full gulp build infrastructure.

type ExtensionKind = 'ui' | 'workspace' | 'web';

export interface IExtensionManifest {
	main?: string;
	browser?: string;
	extensionKind?: ExtensionKind | ExtensionKind[];
	extensionPack?: string[];
	extensionDependencies?: string[];
	contributes?: { [id: string]: any };
}

/**
 * Loosely based on `getExtensionKind` from `src/vs/workbench/services/extensions/common/extensionManifestPropertiesService.ts`
 */
export function isWebExtension(manifest: IExtensionManifest): boolean {
	if (Boolean(manifest.browser)) {
		return true;
	}
	if (Boolean(manifest.main)) {
		return false;
	}
	// neither browser nor main
	if (typeof manifest.extensionKind !== 'undefined') {
		const extensionKind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
		if (extensionKind.indexOf('web') >= 0) {
			return true;
		}
	}
	if (typeof manifest.contributes !== 'undefined') {
		for (const id of ['debuggers', 'terminal', 'typescriptServerPlugins']) {
			if (manifest.contributes.hasOwnProperty(id)) {
				return false;
			}
		}
	}
	return true;
}

export interface IScannedBuiltinExtension {
	readonly extensionPath: string;
	readonly packageJSON: unknown;
	readonly packageNLS: unknown | undefined;
	readonly readmePath: string | undefined;
	readonly changelogPath: string | undefined;
}
