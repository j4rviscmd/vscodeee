/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IExtensionGalleryService, IExtensionManagementService, IGlobalExtensionEnablementService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { IExtensionStorageService } from '../../../../platform/extensionManagement/common/extensionStorage.js';
import { migrateUnsupportedExtensions, uninstallUnsupportedExtensions } from '../../../../platform/extensionManagement/common/unsupportedExtensionsMigration.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IExtensionManagementServerService } from '../../../services/extensionManagement/common/extensionManagement.js';

export class UnsupportedExtensionsMigrationContrib implements IWorkbenchContribution {

	constructor(
		@IExtensionManagementServerService extensionManagementServerService: IExtensionManagementServerService,
		@IExtensionGalleryService extensionGalleryService: IExtensionGalleryService,
		@IExtensionStorageService extensionStorageService: IExtensionStorageService,
		@IGlobalExtensionEnablementService extensionEnablementService: IGlobalExtensionEnablementService,
		@IProductService productService: IProductService,
		@ILogService logService: ILogService,
	) {
		// Unsupported extensions are not migrated for local extension management server, because it is done in shared process
		if (extensionManagementServerService.remoteExtensionManagementServer) {
			migrateUnsupportedExtensions(undefined, extensionManagementServerService.remoteExtensionManagementServer.extensionManagementService, extensionGalleryService, extensionStorageService, extensionEnablementService, logService);
		}
		if (extensionManagementServerService.webExtensionManagementServer) {
			migrateUnsupportedExtensions(undefined, extensionManagementServerService.webExtensionManagementServer.extensionManagementService, extensionGalleryService, extensionStorageService, extensionEnablementService, logService);
		}
		// Tauri: no shared process, so uninstall unsupported extensions for local server directly
		if (extensionManagementServerService.localExtensionManagementServer) {
			uninstallUnsupportedExtensions(undefined, extensionManagementServerService.localExtensionManagementServer.extensionManagementService, logService);
		}

		// Auto-install the default chat agent extension when chat UI is hidden but
		// non-chat Copilot features (inline completions, NES, SCM) are desired.
		if (productService.chatHidden && productService.defaultChatAgent?.chatExtensionId) {
			const extensionManagementService = extensionManagementServerService.localExtensionManagementServer?.extensionManagementService;
			if (extensionManagementService) {
				this.ensureChatExtensionInstalled(
					productService.defaultChatAgent.chatExtensionId,
					extensionManagementService,
					extensionGalleryService,
					logService
				);
			}
		}
	}

	private async ensureChatExtensionInstalled(
		chatExtensionId: string,
		extensionManagementService: IExtensionManagementService,
		galleryService: IExtensionGalleryService,
		logService: ILogService
	): Promise<void> {
		try {
			const installed = await extensionManagementService.getInstalled(ExtensionType.User);
			const isInstalled = installed.some(ext => areSameExtensions(ext.identifier, { id: chatExtensionId }));
			if (isInstalled) {
				return;
			}

			logService.info(`[chatHidden] Default chat agent extension '${chatExtensionId}' is not installed. Installing from gallery...`);
			const [gallery] = await galleryService.getExtensions([{ id: chatExtensionId }], CancellationToken.None);
			if (!gallery) {
				logService.warn(`[chatHidden] Could not find extension '${chatExtensionId}' in the gallery.`);
				return;
			}

			await extensionManagementService.installFromGallery(gallery, { isMachineScoped: false });
			logService.info(`[chatHidden] Successfully installed '${chatExtensionId}' extension.`);
		} catch (error) {
			logService.error(`[chatHidden] Failed to auto-install '${chatExtensionId}':`, error);
		}
	}

}
