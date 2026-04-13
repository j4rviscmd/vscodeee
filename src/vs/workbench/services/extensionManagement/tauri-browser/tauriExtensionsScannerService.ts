/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri extensions scanner service — extends the web scanner to support
 * non-web (workspace) extensions.
 *
 * The stock `WebExtensionsScannerService` rejects any extension that is not
 * marked as web-compatible (`canExecuteOnWeb`). In Tauri we have a Node.js
 * extension host (Phase 5A), so we can run workspace extensions too.
 *
 * This subclass catches the "not a web extension" error in `addExtension()`
 * and falls back to a direct JSON persistence path that skips the check.
 */

import { URI } from '../../../../base/common/uri.js';
import { areSameExtensions, getGalleryExtensionId } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { Metadata, IGalleryExtension } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType, IRelaxedExtensionManifest } from '../../../../platform/extensions/common/extensions.js';
import { IScannedExtension, IWebExtensionsScannerService } from '../common/extensionManagement.js';
import { WebExtensionsScannerService } from '../browser/webExtensionsScannerService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IBuiltinExtensionsScannerService } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IExtensionManifestPropertiesService } from '../../extensions/common/extensionManifestPropertiesService.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IExtensionStorageService } from '../../../../platform/extensionManagement/common/extensionStorage.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { TargetPlatform } from '../../../../platform/extensions/common/extensions.js';
import { UriComponents } from '../../../../base/common/uri.js';

interface IStoredWebExtension {
	readonly identifier: { id: string; uuid?: string };
	readonly version: string;
	readonly location: UriComponents;
	readonly manifest?: IRelaxedExtensionManifest;
	readonly metadata?: Metadata;
}

export class TauriExtensionsScannerService extends WebExtensionsScannerService {

	constructor(
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IBuiltinExtensionsScannerService builtinExtensionsScannerService: IBuiltinExtensionsScannerService,
		@IFileService private readonly tauriFileService: IFileService,
		@ILogService logService: ILogService,
		@IExtensionGalleryService galleryService: IExtensionGalleryService,
		@IExtensionManifestPropertiesService extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@IExtensionResourceLoaderService extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IExtensionStorageService extensionStorageService: IExtensionStorageService,
		@IStorageService storageService: IStorageService,
		@IProductService productService: IProductService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super(
			environmentService, builtinExtensionsScannerService, tauriFileService, logService,
			galleryService, extensionManifestPropertiesService, extensionResourceLoaderService,
			extensionStorageService, storageService, productService, userDataProfilesService,
			uriIdentityService, lifecycleService,
		);
	}

	/**
	 * Override to support non-web (workspace) extensions.
	 *
	 * Try the normal web flow first. If the extension is rejected because it
	 * is not a web extension, fall back to a direct JSON write that skips the
	 * compatibility check — Tauri's extension host can run it.
	 */
	override async addExtension(location: URI, metadata: Metadata, profileLocation: URI): Promise<IScannedExtension> {
		try {
			return await super.addExtension(location, metadata, profileLocation);
		} catch (e) {
			if (!(e instanceof Error && e.message.includes('not a web extension'))) {
				throw e;
			}
		}

		// Fallback for non-web extensions: persist directly to extensions.json
		const manifest = await this.scanExtensionManifest(location);
		if (!manifest || !manifest.name || !manifest.version) {
			throw new Error(`Cannot read manifest from ${location.toString()}`);
		}

		const identifier = { id: getGalleryExtensionId(manifest.publisher, manifest.name), uuid: metadata?.id };
		const webExtension = {
			identifier,
			version: manifest.version,
			location,
			manifest,
			metadata,
		};

		await this.writeInstalledExtension(webExtension, profileLocation);

		return {
			type: ExtensionType.User,
			identifier,
			location,
			manifest: manifest as IRelaxedExtensionManifest,
			isBuiltin: false,
			isValid: true,
			validations: [],
			metadata,
			targetPlatform: TargetPlatform.UNDEFINED,
			preRelease: !!metadata?.isPreReleaseVersion,
		};
	}

	/**
	 * Override gallery add to extract via Rust first, then register locally.
	 *
	 * The stock implementation stores CDN URLs. For Tauri we prefer real files
	 * on disk so the Node.js extension host can load them.
	 */
	override async addExtensionFromGallery(galleryExtension: IGalleryExtension, metadata: Metadata, profileLocation: URI): Promise<IScannedExtension> {
		// Try the web (CDN) flow first — works for pure-web extensions.
		try {
			return await super.addExtensionFromGallery(galleryExtension, metadata, profileLocation);
		} catch (e) {
			if (!(e instanceof Error && e.message.includes('not a web extension'))) {
				throw e;
			}
		}

		// Non-web extension: delegate to addExtension with a placeholder.
		// The TauriInstallExtensionTask in the management service handles
		// the actual VSIX download + extraction before this path is reached,
		// so this is a safety net for direct calls.
		throw new Error(
			`Cannot install '${galleryExtension.identifier.id}' directly from gallery. ` +
			`Use the extension management service install flow instead.`
		);
	}

	/**
	 * Directly write an extension entry to the installed extensions JSON file.
	 */
	private async writeInstalledExtension(
		webExtension: { identifier: { id: string; uuid?: string }; version: string; location: URI; manifest?: IRelaxedExtensionManifest; metadata?: Metadata },
		profileLocation: URI,
	): Promise<void> {
		let stored: IStoredWebExtension[] = [];
		try {
			const content = await this.tauriFileService.readFile(profileLocation);
			stored = JSON.parse(content.value.toString());
		} catch {
			// File does not exist yet — will be created below.
		}

		// Remove existing entry for the same extension
		const filtered = stored.filter(e => !areSameExtensions(e.identifier, webExtension.identifier));

		filtered.push({
			identifier: webExtension.identifier,
			version: webExtension.version,
			location: webExtension.location.toJSON(),
			manifest: webExtension.manifest,
			metadata: webExtension.metadata,
		});

		await this.tauriFileService.writeFile(profileLocation, VSBuffer.fromString(JSON.stringify(filtered, null, '\t')));
	}
}

// Last-wins: this replaces the stock WebExtensionsScannerService registration
// from the side-effect import in workbench.tauri.main.ts.
registerSingleton(IWebExtensionsScannerService, TauriExtensionsScannerService, InstantiationType.Delayed);
