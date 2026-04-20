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

import { URI, UriComponents } from '../../../../base/common/uri.js';
import { areSameExtensions, getGalleryExtensionId } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { Metadata, IGalleryExtension, IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType, IRelaxedExtensionManifest, IBuiltinExtensionsScannerService, TargetPlatform } from '../../../../platform/extensions/common/extensions.js';
import { IScannedExtension, IWebExtensionsScannerService, ScanOptions } from '../common/extensionManagement.js';
import { WebExtensionsScannerService } from '../browser/webExtensionsScannerService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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
import { joinPath } from '../../../../base/common/resources.js';
import { localizeManifest } from '../../../../platform/extensionManagement/common/extensionNls.js';

interface IStoredWebExtension {
	readonly identifier: { id: string; uuid?: string };
	readonly version: string;
	readonly location: UriComponents;
	readonly manifest?: IRelaxedExtensionManifest;
	readonly fallbackPackageNLSUri?: UriComponents;
	readonly metadata?: Metadata;
}

export class TauriExtensionsScannerService extends WebExtensionsScannerService {

	constructor(
		@IBrowserWorkbenchEnvironmentService tauriEnvironmentService: IBrowserWorkbenchEnvironmentService,
		@IBuiltinExtensionsScannerService builtinExtensionsScannerService: IBuiltinExtensionsScannerService,
		@IFileService private readonly tauriFileService: IFileService,
		@ILogService private readonly tauriLogService: ILogService,
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
			tauriEnvironmentService, builtinExtensionsScannerService, tauriFileService, tauriLogService,
			galleryService, extensionManifestPropertiesService, extensionResourceLoaderService,
			extensionStorageService, storageService, productService, userDataProfilesService,
			uriIdentityService, lifecycleService,
		);
	}

	/**
	 * Override to repair NLS placeholders in already-installed extensions.
	 *
	 * Older installations may have been persisted without a `fallbackPackageNLSUri`,
	 * so `toScannedExtension()` could not translate their manifests. This override
	 * detects surviving `%…%` placeholders and resolves them from the on-disk
	 * `package.nls.json`, then patches `extensions.json` so the fix is persistent.
	 */
	override async scanUserExtensions(profileLocation: URI, scanOptions?: ScanOptions): Promise<IScannedExtension[]> {
		const extensions = await super.scanUserExtensions(profileLocation, scanOptions);

		for (const ext of extensions) {
			if (!this.manifestHasNlsPlaceholders(ext.manifest)) {
				continue;
			}

			// Try to resolve NLS from the on-disk package.nls.json
			try {
				const nlsUri = joinPath(ext.location, 'package.nls.json');
				const nlsContent = await this.tauriFileService.readFile(nlsUri);
				const translations = JSON.parse(nlsContent.value.toString());
				const translatedManifest = localizeManifest(this.tauriLogService, ext.manifest, translations);

				// Mutate the scanned extension in-place
				(ext as { manifest: IRelaxedExtensionManifest }).manifest = translatedManifest;

				// Persist the fix: update extensions.json with translated manifest and fallbackPackageNLSUri
				await this.repairStoredExtension(ext, nlsUri, profileLocation);
				this.tauriLogService.info(`[TauriExtScanner] Repaired NLS placeholders for ${ext.identifier.id}`);
			} catch {
				// No package.nls.json on disk — cannot repair, leave as-is
			}
		}

		return extensions;
	}

	/**
	 * Check if a manifest still contains unresolved NLS `%…%` placeholders.
	 */
	private manifestHasNlsPlaceholders(manifest: IRelaxedExtensionManifest): boolean {
		const commands = manifest.contributes?.commands;
		if (!Array.isArray(commands)) {
			return false;
		}
		return commands.some(cmd => {
			const title = typeof cmd.title === 'string' ? cmd.title : cmd.title?.value;
			return typeof title === 'string' && title.startsWith('%') && title.endsWith('%');
		});
	}

	/**
	 * Patch an existing entry in extensions.json with the translated manifest
	 * and the fallbackPackageNLSUri so future scans don't need this repair.
	 */
	private async repairStoredExtension(ext: IScannedExtension, fallbackNlsUri: URI, profileLocation: URI): Promise<void> {
		let stored: IStoredWebExtension[] = [];
		try {
			const content = await this.tauriFileService.readFile(profileLocation);
			stored = JSON.parse(content.value.toString());
		} catch {
			return; // Cannot read — skip repair
		}

		let updated = false;
		for (const entry of stored) {
			if (areSameExtensions(entry.identifier, ext.identifier)) {
				// Patch in-place (readonly fields — use Object.assign)
				Object.assign(entry, {
					manifest: ext.manifest,
					fallbackPackageNLSUri: fallbackNlsUri.toJSON(),
				});
				updated = true;
				break;
			}
		}

		if (updated) {
			await this.tauriFileService.writeFile(profileLocation, VSBuffer.fromString(JSON.stringify(stored, null, '\t')));
		}
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
		let manifest = await this.scanExtensionManifest(location);
		if (!manifest || !manifest.name || !manifest.version) {
			throw new Error(`Cannot read manifest from ${location.toString()}`);
		}

		// Resolve NLS placeholders (e.g. %github.copilot.command.xxx%) from package.nls.json
		try {
			const nlsUri = joinPath(location, 'package.nls.json');
			const nlsContent = await this.tauriFileService.readFile(nlsUri);
			const translations = JSON.parse(nlsContent.value.toString());
			manifest = localizeManifest(this.tauriLogService, manifest, translations);
		} catch {
			// No package.nls.json or failed to read — use manifest as-is
		}

		const identifier = { id: getGalleryExtensionId(manifest.publisher, manifest.name), uuid: metadata?.id };

		// Determine the fallback NLS URI for future scans
		let fallbackPackageNLSUri: URI | undefined;
		try {
			const nlsUri = joinPath(location, 'package.nls.json');
			await this.tauriFileService.readFile(nlsUri);
			fallbackPackageNLSUri = nlsUri;
		} catch {
			// No package.nls.json available
		}

		const webExtension = {
			identifier,
			version: manifest.version,
			location,
			manifest,
			fallbackPackageNLSUri,
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
	 * Override gallery add with disk-based fallback for non-web extensions.
	 *
	 * The stock implementation stores CDN URLs. For Tauri we prefer real files
	 * on disk so the Node.js extension host can load them. When the web flow
	 * fails (non-web extension or network error), we fall back to looking up
	 * the extension on disk and re-registering it from there.
	 */
	override async addExtensionFromGallery(galleryExtension: IGalleryExtension, metadata: Metadata, profileLocation: URI): Promise<IScannedExtension> {
		// Try the web (CDN) flow first — works for pure-web extensions.
		try {
			return await super.addExtensionFromGallery(galleryExtension, metadata, profileLocation);
		} catch (e) {
			const isWebRejection = e instanceof Error && e.message.includes('not a web extension');
			const isNetworkError = e instanceof Error && (
				e.message.includes('Failed to fetch') ||
				e.message.includes('NetworkError') ||
				e.message.includes('net::ERR')
			);
			if (!isWebRejection && !isNetworkError) {
				throw e;
			}

			this.tauriLogService.info(
				`[TauriExtScanner] Gallery add failed for '${galleryExtension.identifier.id}' (${isWebRejection ? 'non-web' : 'network error'}), trying disk fallback`
			);
		}

		// Fallback: find the extension on disk from a previous installation.
		// The TauriInstallExtensionTask extracts VSIX files to the extensions
		// directory before calling addExtension(), so the files should exist.
		const existing = await this.scanUserExtensions(profileLocation, { skipInvalidExtensions: true });
		const extensionId = galleryExtension.identifier.id.toLowerCase();
		const match = existing.find(e => e.identifier.id.toLowerCase() === extensionId);

		if (match && match.location.scheme === 'file') {
			this.tauriLogService.info(
				`[TauriExtScanner] Disk fallback: re-registering '${extensionId}' from ${match.location.toString()}`
			);
			return this.addExtension(match.location, metadata, profileLocation);
		}

		// No on-disk installation found — the install flow must extract first.
		throw new Error(
			`Cannot register '${galleryExtension.identifier.id}' from gallery: ` +
			`not a web extension and no on-disk extraction found. ` +
			`Use the extension management service install flow for first-time installation.`
		);
	}

	/**
	 * Directly write an extension entry to the installed extensions JSON file.
	 */
	private async writeInstalledExtension(
		webExtension: { identifier: { id: string; uuid?: string }; version: string; location: URI; manifest?: IRelaxedExtensionManifest; fallbackPackageNLSUri?: URI; metadata?: Metadata },
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
			fallbackPackageNLSUri: webExtension.fallbackPackageNLSUri?.toJSON(),
			metadata: webExtension.metadata,
		});

		await this.tauriFileService.writeFile(profileLocation, VSBuffer.fromString(JSON.stringify(filtered, null, '\t')));
	}
}

// Last-wins: this replaces the stock WebExtensionsScannerService registration
// from the side-effect import in workbench.tauri.main.ts.
registerSingleton(IWebExtensionsScannerService, TauriExtensionsScannerService, InstantiationType.Delayed);
