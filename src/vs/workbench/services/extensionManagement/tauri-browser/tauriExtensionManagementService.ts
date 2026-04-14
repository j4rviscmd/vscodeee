/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri-native extension management service.
 *
 * Extends `WebExtensionManagementService` with real VSIX extraction and
 * deletion via Rust backend commands. Overrides the install task to
 * extract VSIX files to disk via Rust and register with the scanner.
 *
 * Key overrides over the web version:
 * - `install()` — handles VSIX files via Rust extraction (not just directories)
 * - `createInstallExtensionTask()` — Tauri-specific task that extracts VSIX
 * - `deleteExtension()` — physically removes extension directory via Rust
 * - `getCompatibleVersion()` — allows ALL extensions (not just web-compatible)
 * - `getTargetPlatform()` — returns native platform via Rust
 */

import { URI } from '../../../../base/common/uri.js';
import { extCommands } from '../../../../platform/tauri/common/tauriExtensionCommands.js';
import { WebExtensionManagementService } from '../common/webExtensionManagementService.js';
import { IExtensionGalleryService, ILocalExtension, IGalleryExtension, InstallOperation, InstallOptions, Metadata, IProductVersion } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { TargetPlatform, IExtensionManifest, IExtension, IExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWebExtensionsScannerService, IScannedExtension } from '../common/extensionManagement.js';
import { IExtensionManifestPropertiesService } from '../../extensions/common/extensionManifestPropertiesService.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IAllowedExtensionsService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { areSameExtensions, getGalleryExtensionId } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { AbstractExtensionTask, IInstallExtensionTask, InstallExtensionTaskOptions, toExtensionManagementError } from '../../../../platform/extensionManagement/common/abstractExtensionManagementService.js';
import { isUndefined, isBoolean } from '../../../../base/common/types.js';
import { joinPath } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';

/**
 * Map a platform string returned by the Rust backend to VS Code's `TargetPlatform` enum.
 *
 * Used by both `TauriExtensionManagementService` and `TauriInstallExtensionTask`
 * to translate the native platform identifier (e.g., `"darwin-arm64"`) into
 * the enum value consumed by the workbench.
 */
function mapTargetPlatform(platform: string): TargetPlatform {
	switch (platform) {
		case 'darwin-arm64': return TargetPlatform.DARWIN_ARM64;
		case 'darwin-x64': return TargetPlatform.DARWIN_X64;
		case 'linux-arm64': return TargetPlatform.LINUX_ARM64;
		case 'linux-armhf': return TargetPlatform.LINUX_ARMHF;
		case 'linux-x64': return TargetPlatform.LINUX_X64;
		case 'win32-arm64': return TargetPlatform.WIN32_ARM64;
		case 'win32-x64': return TargetPlatform.WIN32_X64;
		case 'alpine-arm64': return TargetPlatform.ALPINE_ARM64;
		case 'alpine-x64': return TargetPlatform.ALPINE_X64;
		case 'web': return TargetPlatform.WEB;
		default: return TargetPlatform.UNKNOWN;
	}
}

function toTauriLocalExtension(extension: IExtension, targetPlatform: TargetPlatform): ILocalExtension {
	const metadata = (extension as IScannedExtension).metadata;
	return {
		...extension,
		identifier: { id: extension.identifier.id, uuid: metadata?.id ?? extension.identifier.uuid },
		isMachineScoped: !!metadata?.isMachineScoped,
		isApplicationScoped: !!metadata?.isApplicationScoped,
		publisherId: metadata?.publisherId || null,
		publisherDisplayName: metadata?.publisherDisplayName,
		installedTimestamp: metadata?.installedTimestamp,
		isPreReleaseVersion: !!metadata?.isPreReleaseVersion,
		hasPreReleaseVersion: !!metadata?.hasPreReleaseVersion,
		preRelease: extension.preRelease,
		targetPlatform,
		updated: !!metadata?.updated,
		pinned: !!metadata?.pinned,
		private: !!metadata?.private,
		isWorkspaceScoped: false,
		source: metadata?.source ?? (extension.identifier.uuid ? 'gallery' : 'resource'),
		size: metadata?.size ?? 0,
	};
}

export class TauriExtensionManagementService extends WebExtensionManagementService {

	constructor(
		@IExtensionGalleryService private readonly tauriGalleryService: IExtensionGalleryService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILogService logService: ILogService,
		@IWebExtensionsScannerService private readonly tauriScannerService: IWebExtensionsScannerService,
		@IExtensionManifestPropertiesService extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@IUserDataProfileService userDataProfileService: IUserDataProfileService,
		@IProductService productService: IProductService,
		@IAllowedExtensionsService allowedExtensionsService: IAllowedExtensionsService,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IBrowserWorkbenchEnvironmentService private readonly tauriEnvironmentService: IBrowserWorkbenchEnvironmentService,
		@IFileService private readonly tauriFileService: IFileService,
	) {
		super(
			tauriGalleryService,
			telemetryService,
			logService,
			tauriScannerService,
			extensionManifestPropertiesService,
			userDataProfileService,
			productService,
			allowedExtensionsService,
			userDataProfilesService,
			uriIdentityService,
		);
	}

	// --- Platform detection --------------------------------------------------

	override async getTargetPlatform(): Promise<TargetPlatform> {
		try {
			const info = await extCommands.getTargetPlatform();
			return this.mapTargetPlatform(info.targetPlatform);
		} catch {
			return TargetPlatform.WEB;
		}
	}

	// --- Install / Uninstall overrides ---------------------------------------

	/**
	 * Override to allow ALL extensions, not just web-compatible ones.
	 *
	 * The parent class returns `null` for non-web extensions. In Tauri we
	 * have a Node.js extension host (Phase 5A) so workspace extensions work.
	 */
	protected override async getCompatibleVersion(extension: IGalleryExtension, sameVersion: boolean, includePreRelease: boolean, productVersion: IProductVersion): Promise<IGalleryExtension | null> {
		const compatibleExtension = await super.getCompatibleVersion(extension, sameVersion, includePreRelease, productVersion);
		if (compatibleExtension) {
			return compatibleExtension;
		}
		// Tauri has a Node.js extension host — allow any extension.
		return extension;
	}

	/**
	 * Override `createInstallExtensionTask` to extract VSIX via Rust before
	 * registering with the scanner.
	 */
	protected override createInstallExtensionTask(manifest: IExtensionManifest, extension: URI | IGalleryExtension, options: InstallExtensionTaskOptions): IInstallExtensionTask {
		return new TauriInstallExtensionTask(
			manifest,
			extension,
			options,
			this.tauriGalleryService,
			this.tauriFileService,
			this.tauriEnvironmentService,
			this.tauriScannerService,
		);
	}

	/**
	 * Physical deletion of extension directory via Rust.
	 */
	protected override async deleteExtension(extension: ILocalExtension): Promise<void> {
		if (extension.location.scheme === 'file') {
			try {
				const extensionsBase = this.getExtensionsPath();
				await extCommands.deleteExtension(extension.location.fsPath, extensionsBase);
			} catch (error) {
				this.logService.error('Failed to delete extension directory:', error);
			}
		}
	}

	// --- VSIX file install override -------------------------------------------

	/**
	 * Override `install(URI)` to handle VSIX files via Rust extraction.
	 *
	 * The parent `WebExtensionManagementService.install()` calls
	 * `scanExtensionManifest(location)` which reads `{location}/package.json` —
	 * this only works for already-extracted directories, not ZIP-based VSIX files.
	 *
	 * Extensions like CodeLLDB download platform-specific VSIX packages to temp
	 * locations and install them via the `workbench.extensions.installExtension`
	 * command. Without this override those installs fail with
	 * "Cannot find a valid extension from the location".
	 */
	override async install(location: URI, options: InstallOptions = {}): Promise<ILocalExtension> {
		this.logService.trace('ExtensionManagementService#install', location.toString());

		if (this.isVsixUri(location)) {
			return this.installFromVsix(location, options);
		}

		return super.install(location, options);
	}

	private isVsixUri(location: URI): boolean {
		return location.scheme === 'file' && /\.vsix$/i.test(location.fsPath);
	}

	private async installFromVsix(vsixUri: URI, options: InstallOptions): Promise<ILocalExtension> {
		this.logService.info('Installing VSIX from file:', vsixUri.fsPath);

		// Read manifest from VSIX via Rust (no extraction needed)
		let manifest: IExtensionManifest;
		try {
			manifest = await extCommands.readVsixManifest(vsixUri.fsPath) as IExtensionManifest;
		} catch (error) {
			throw new Error(`Failed to read VSIX manifest from ${vsixUri.fsPath}: ${error}`);
		}

		if (!manifest.name || !manifest.version) {
			throw new Error(`Invalid VSIX manifest: missing name or version in ${vsixUri.fsPath}`);
		}

		// Delegate to installExtensions() → createInstallExtensionTask()
		// → TauriInstallExtensionTask handles extraction and registration.
		const result = await this.installExtensions([{ manifest, extension: vsixUri, options }]);

		if (result.length === 0 || !result[0]) {
			throw toExtensionManagementError(new Error(`No result returned while installing VSIX ${vsixUri.fsPath}`));
		}
		if (result[0].local) {
			return result[0].local;
		}
		if (result[0].error) {
			throw result[0].error;
		}
		throw toExtensionManagementError(new Error(`Unknown error while installing VSIX ${vsixUri.fsPath}`));
	}

	/**
	 * Get the user extensions directory path.
	 * `TauriWorkbenchEnvironmentService` provides this at runtime.
	 */
	private getExtensionsPath(): string {
		return (this.tauriEnvironmentService as any).extensionsPath as string;
	}

	/**
	 * Read VSIX manifest via Rust backend.
	 */
	override async getManifest(vsix: URI): Promise<IExtensionManifest> {
		if (vsix.scheme === 'file') {
			try {
				const manifest = await extCommands.readVsixManifest(vsix.fsPath);
				return manifest as IExtensionManifest;
			} catch (error) {
				throw new Error(`Failed to read VSIX manifest: ${error}`);
			}
		}
		throw new Error('unsupported');
	}

	override download(): Promise<URI> { throw new Error('unsupported'); }
	override zip(_extension: ILocalExtension): Promise<URI> { throw new Error('unsupported'); }

	private mapTargetPlatform(platform: string): TargetPlatform {
		return mapTargetPlatform(platform);
	}
}

/**
 * Tauri-specific install task that extracts VSIX via Rust backend.
 *
 * For gallery extensions:
 *   1. Download VSIX to temp location via gallery service
 *   2. Extract VSIX via Rust `ext_extract_vsix`
 *   3. Register extracted path with scanner
 *
 * For VSIX file URIs:
 *   1. Extract VSIX via Rust `ext_extract_vsix`
 *   2. Register extracted path with scanner
 */
class TauriInstallExtensionTask extends AbstractExtensionTask<ILocalExtension> implements IInstallExtensionTask {

	readonly identifier: IExtensionIdentifier;
	readonly source: URI | IGalleryExtension;

	private _profileLocation: URI;
	get profileLocation() { return this._profileLocation; }

	private _operation = InstallOperation.Install;
	get operation() { return isUndefined(this.options.operation) ? this._operation : this.options.operation; }

	constructor(
		readonly manifest: IExtensionManifest,
		private readonly extension: URI | IGalleryExtension,
		readonly options: InstallExtensionTaskOptions,
		private readonly galleryService: IExtensionGalleryService,
		private readonly fileService: IFileService,
		private readonly envService: IBrowserWorkbenchEnvironmentService,
		private readonly scannerService: IWebExtensionsScannerService,
	) {
		super();
		this._profileLocation = options.profileLocation;
		this.identifier = URI.isUri(extension) ? { id: getGalleryExtensionId(manifest.publisher, manifest.name) } : extension.identifier;
		this.source = extension;
	}

	protected async doRun(_token: CancellationToken): Promise<ILocalExtension> {
		const extensionsDir = (this.envService as any).extensionsPath as string;
		let extractedPath: string;

		if (URI.isUri(this.extension)) {
			// VSIX file install: extract directly
			const result = await extCommands.extractVsix(this.extension.fsPath, extensionsDir);
			extractedPath = result.extensionPath;
		} else {
			// Gallery install: download VSIX first, then extract
			const extensionsUri = URI.file(extensionsDir);
			const tempDir = joinPath(extensionsUri, '.temp');
			const tempFile = joinPath(tempDir, `${generateUuid()}.vsix`);

			// Ensure extensions dir and .temp directory exist
			try {
				await this.fileService.createFolder(extensionsUri);
			} catch {
				// May already exist
			}
			try {
				await this.fileService.createFolder(tempDir);
			} catch {
				// May already exist
			}

			// Download VSIX from gallery
			await this.galleryService.download(this.extension, tempFile, this.operation);

			// Extract via Rust
			try {
				const result = await extCommands.extractVsix(tempFile.fsPath, extensionsDir);
				extractedPath = result.extensionPath;
			} catch (e) {
				throw e;
			} finally {
				// Clean up temp file
				try {
					await this.fileService.del(tempFile);
				} catch {
					// Non-critical
				}
			}

		}

		// Build metadata (matching WebExtensionManagementService.InstallExtensionTask logic)
		const userExtensions = await this.scannerService.scanUserExtensions(this.options.profileLocation);
		const existingExtension = userExtensions.find(e => areSameExtensions(e.identifier, this.identifier));
		if (existingExtension) {
			this._operation = InstallOperation.Update;
		}

		const metadata: Metadata = { ...(existingExtension as IScannedExtension)?.metadata };
		if (!URI.isUri(this.extension)) {
			metadata.id = this.extension.identifier.uuid;
			metadata.publisherDisplayName = this.extension.publisherDisplayName;
			metadata.publisherId = this.extension.publisherId;
			metadata.installedTimestamp = Date.now();
			metadata.isPreReleaseVersion = this.extension.properties.isPreReleaseVersion;
			metadata.hasPreReleaseVersion = metadata.hasPreReleaseVersion || this.extension.properties.isPreReleaseVersion;
			metadata.isBuiltin = this.options.isBuiltin || existingExtension?.isBuiltin;
			metadata.updated = !!existingExtension;
			metadata.isApplicationScoped = this.options.isApplicationScoped || metadata.isApplicationScoped;
			metadata.private = this.extension.private;
			metadata.preRelease = isBoolean(this.options.preRelease)
				? this.options.preRelease
				: this.options.installPreReleaseVersion || this.extension.properties.isPreReleaseVersion || metadata.preRelease;
			metadata.source = 'gallery';
		} else {
			metadata.source = 'resource';
		}
		metadata.pinned = this.options.installGivenVersion ? true : (this.options.pinned ?? metadata.pinned);

		// Register with scanner (TauriExtensionsScannerService handles non-web extensions)
		const location = URI.file(extractedPath);
		const scannedExtension = await this.scannerService.addExtension(location, metadata, this.profileLocation);

		// Universal extensions must use TargetPlatform.UNKNOWN.
		// If the gallery reports a specific platform (e.g. darwin-arm64), use the
		// native platform. Otherwise keep UNKNOWN to avoid false "outdated" detection.
		// Universal extensions must use TargetPlatform.UNDEFINED to avoid false
		// "outdated" detection (the outdatedTargetPlatform check only skips
		// UNDEFINED and WEB, not UNKNOWN).
		let targetPlatform = TargetPlatform.UNDEFINED;
		if (!URI.isUri(this.extension)) {
			const galleryPlatform = this.extension.properties.targetPlatform;
			if (galleryPlatform && galleryPlatform !== TargetPlatform.UNKNOWN && galleryPlatform !== TargetPlatform.UNDEFINED) {
				try {
					const info = await extCommands.getTargetPlatform();
					targetPlatform = this.mapTargetPlatform(info.targetPlatform);
				} catch {
					// fallback
				}
			}
		}

		return toTauriLocalExtension(scannedExtension, targetPlatform);
	}

	private mapTargetPlatform(platform: string): TargetPlatform {
		return mapTargetPlatform(platform);
	}
}
