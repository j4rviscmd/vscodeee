/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../common/contributions.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IExtensionGalleryService } from '../../../platform/extensionManagement/common/extensionManagement.js';
import { IWorkbenchExtensionManagementService } from '../../services/extensionManagement/common/extensionManagement.js';
import { IWorkbenchThemeService, ThemeSettings } from '../../services/themes/common/workbenchThemeService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { isTauri } from '../../../base/common/platform.js';

/** Extension identifier for the default Solarized Deep theme published on the marketplace. */
const DEFAULT_THEME_EXTENSION_ID = 'j4rviscmd.solarized-deep';

/** The `settingsId` value used by the Solarized Deep theme to match in the theme registry. */
const DEFAULT_THEME_SETTINGS_ID = 'Solarized Deep';

/**
 * Storage key used to persist whether the default theme installation
 * has already been attempted across sessions.
 */
const DEFAULT_THEME_PROCESSED_KEY = 'vscodeee.defaultThemeProcessed';

/**
 * Installs and applies the solarized-deep theme on first launch when
 * the user has not explicitly chosen a color theme.
 */
export class DefaultThemeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'tauri.defaultTheme';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (!isTauri) {
			return;
		}

		this.tryInstallDefaultTheme();
	}

	/**
	 * Attempts to install and apply the default Solarized Deep theme from the
	 * extension gallery on first launch.
	 *
	 * The method implements a guard-and-retry strategy:
	 * 1. If the theme has already been processed (flag set in storage), bail out early.
	 * 2. Set the processed flag immediately to prevent re-entry or parallel execution.
	 * 3. If the user has explicitly configured any color theme setting, skip installation.
	 * 4. If the extension gallery is unavailable (e.g. offline), skip and log.
	 * 5. Query the gallery for the extension, install it, and attempt to apply the theme.
	 * 6. If the theme cannot be found in the registry immediately after install,
	 *    clear the processed flag so the attempt is retried on the next session.
	 *
	 * @returns A promise that resolves when the attempt is complete (success or failure).
	 */
	private async tryInstallDefaultTheme(): Promise<void> {
		// Skip if already processed in a previous session
		if (this.storageService.getBoolean(DEFAULT_THEME_PROCESSED_KEY, StorageScope.APPLICATION)) {
			return;
		}

		// Mark as processed immediately to prevent re-entry
		this.storageService.store(DEFAULT_THEME_PROCESSED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);

		// Skip if user has explicitly set any color theme setting
		const themeSettings = [
			ThemeSettings.COLOR_THEME,
			ThemeSettings.PREFERRED_DARK_THEME,
			ThemeSettings.PREFERRED_LIGHT_THEME,
		];
		if (themeSettings.some(s => this.configurationService.inspect<string>(s).userValue !== undefined)) {
			return;
		}

		// Skip if gallery is not available (offline)
		if (!this.extensionGalleryService.isEnabled()) {
			this.logService.info('DefaultThemeContribution: gallery not available, skipping.');
			return;
		}

		let applied = false;
		try {
			const extensions = await this.extensionGalleryService.getExtensions([{ id: DEFAULT_THEME_EXTENSION_ID }], CancellationToken.None);
			const galleryExtension = extensions[0];
			if (!galleryExtension) {
				this.logService.warn(`DefaultThemeContribution: '${DEFAULT_THEME_EXTENSION_ID}' not found in gallery.`);
				return;
			}

			this.logService.info(`DefaultThemeContribution: installing '${DEFAULT_THEME_EXTENSION_ID}'.`);
			await this.extensionManagementService.installFromGallery(galleryExtension, { isMachineScoped: false });

			// Try immediately (registry may have already updated)
			const themes = await this.themeService.getColorThemes();
			const target = themes.find(t => t.settingsId === DEFAULT_THEME_SETTINGS_ID);
			if (target) {
				// 'auto' respects autoDetectColorScheme and writes to
				// workbench.preferredDarkColorTheme when OS is in dark mode
				await this.themeService.setColorTheme(target.id, 'auto');
				this.logService.info(`DefaultThemeContribution: applied '${DEFAULT_THEME_SETTINGS_ID}'.`);
				applied = true;
			} else {
				this.logService.info('DefaultThemeContribution: theme not found in registry yet, will retry next session.');
			}
		} catch (error) {
			this.logService.error('DefaultThemeContribution: failed to install default theme.', error);
		}

		if (!applied) {
			// Clear the flag so it retries on next launch
			this.storageService.store(DEFAULT_THEME_PROCESSED_KEY, false, StorageScope.APPLICATION, StorageTarget.USER);
		}
	}
}

registerWorkbenchContribution2(DefaultThemeContribution.ID, DefaultThemeContribution, WorkbenchPhase.AfterRestored);
