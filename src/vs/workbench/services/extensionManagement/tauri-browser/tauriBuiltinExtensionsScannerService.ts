/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IBuiltinExtensionsScannerService, ExtensionType, IExtensionManifest, TargetPlatform, IExtension } from '../../../../platform/extensions/common/extensions.js';
import { Language } from '../../../../base/common/platform.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { getGalleryExtensionId } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { URI } from '../../../../base/common/uri.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITranslations, localizeManifest } from '../../../../platform/extensionManagement/common/extensionNls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { invoke } from '../../../../platform/tauri/common/tauriApi.js';

interface IBundledExtension {
	extensionPath: string;
	packageJSON: IExtensionManifest;
	packageNLS?: ITranslations;
	readmePath?: string;
	changelogPath?: string;
}

interface IBuiltinExtensionsResult {
	extensionsDir: string;
	extensions: IBundledExtension[];
}

/**
 * Tauri-specific built-in extension scanner service.
 *
 * In VS Code's web mode, built-in extensions are injected into the HTML by
 * the dev server. In Tauri, there is no such server, so we scan the
 * `extensions/` directory via a Rust command and construct `file://` URIs
 * for each extension.
 *
 * The `file://` URIs work for extension resource loading because
 * `readExtensionResource()` dispatches non-HTTP URIs through
 * `fileService.readFile()`, which chains to `TauriDiskFileSystemProvider`.
 *
 * TODO: Some extension assets (contributed CSS, walkthrough icons) are loaded
 * directly into the DOM via browser URLs. `file://` URIs won't work for those
 * in a web-origin context. For full asset support, extension locations should
 * use a browser-loadable scheme (e.g., `vscode-file://`) with a corresponding
 * file system provider or protocol handler.
 */
export class TauriBuiltinExtensionsScannerService implements IBuiltinExtensionsScannerService {

	declare readonly _serviceBrand: undefined;

	private scanPromise: Promise<IExtension[]> | undefined;
	private nlsUrl: URI | undefined;

	constructor(
		@IWorkbenchEnvironmentService _environmentService: IWorkbenchEnvironmentService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IExtensionResourceLoaderService private readonly extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IProductService productService: IProductService,
		@ILogService private readonly logService: ILogService
	) {
		const nlsBaseUrl = productService.extensionsGallery?.nlsBaseUrl;
		if (nlsBaseUrl && productService.commit && !Language.isDefaultVariant()) {
			this.nlsUrl = URI.joinPath(URI.parse(nlsBaseUrl), productService.commit, productService.version, Language.value());
		}
	}

	async scanBuiltinExtensions(): Promise<IExtension[]> {
		if (!this.scanPromise) {
			this.scanPromise = this.doScanBuiltinExtensions();
		}
		return this.scanPromise;
	}

	private async doScanBuiltinExtensions(): Promise<IExtension[]> {
		let result: IBuiltinExtensionsResult;
		try {
			result = await invoke<IBuiltinExtensionsResult>('list_builtin_extensions');
		} catch (error) {
			this.logService.error('[TauriBuiltinExtensionsScannerService] Failed to scan built-in extensions:', error);
			return [];
		}

		this.logService.info(
			`[TauriBuiltinExtensionsScannerService] Found ${result.extensions.length} built-in extensions in ${result.extensionsDir}`
		);

		const extensionsDirUri = URI.file(result.extensionsDir);

		const extensionPromises: Promise<IExtension | undefined>[] = result.extensions.map(async (e): Promise<IExtension | undefined> => {
			// Skip extensions without required manifest fields
			if (!e.packageJSON?.publisher || !e.packageJSON?.name) {
				return undefined;
			}

			const id = getGalleryExtensionId(e.packageJSON.publisher, e.packageJSON.name);
			const extensionLocation = this.uriIdentityService.extUri.joinPath(extensionsDirUri, e.extensionPath);

			return {
				identifier: { id },
				location: extensionLocation,
				type: ExtensionType.System,
				isBuiltin: true,
				manifest: e.packageNLS ? await this.localizeManifest(id, e.packageJSON, e.packageNLS) : e.packageJSON,
				readmeUrl: e.readmePath ? this.uriIdentityService.extUri.joinPath(extensionsDirUri, e.readmePath) : undefined,
				changelogUrl: e.changelogPath ? this.uriIdentityService.extUri.joinPath(extensionsDirUri, e.changelogPath) : undefined,
				targetPlatform: TargetPlatform.WEB,
				validations: [],
				isValid: true,
				preRelease: false,
			};
		});

		const resolved = await Promise.all(extensionPromises);
		const extensions = resolved.filter((e): e is IExtension => e !== undefined);

		this.logService.info(
			`[TauriBuiltinExtensionsScannerService] ${extensions.length} of ${result.extensions.length} extensions have valid manifests`
		);

		return extensions;
	}

	private async localizeManifest(extensionId: string, manifest: IExtensionManifest, fallbackTranslations: ITranslations): Promise<IExtensionManifest> {
		if (!this.nlsUrl) {
			return localizeManifest(this.logService, manifest, fallbackTranslations);
		}
		const uri = URI.joinPath(this.nlsUrl, extensionId, 'package');
		try {
			const res = await this.extensionResourceLoaderService.readExtensionResource(uri);
			const json = JSON.parse(res.toString());
			return localizeManifest(this.logService, manifest, json, fallbackTranslations);
		} catch (e) {
			this.logService.error(e);
			return localizeManifest(this.logService, manifest, fallbackTranslations);
		}
	}
}

registerSingleton(IBuiltinExtensionsScannerService, TauriBuiltinExtensionsScannerService, InstantiationType.Delayed);
