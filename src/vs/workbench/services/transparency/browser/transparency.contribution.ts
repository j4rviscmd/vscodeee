/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ITransparencyService } from '../common/transparency.js';
import { TransparencyService } from './transparencyService.js';

// ── Register settings schema ──

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

configurationRegistry.registerConfiguration({
	id: 'vscodeee.transparency',
	order: 150,
	title: localize('transparencyConfigurationTitle', "Transparency"),
	type: 'object',
	properties: {
		'vscodeee.transparency.opacity': {
			type: 'number',
			minimum: 0,
			maximum: 100,
			default: 100,
			order: 1,
			description: localize('transparency.opacity', "Controls the background opacity of workbench parts (0 = fully transparent, 100 = fully opaque)."),
			scope: ConfigurationScope.APPLICATION,
		},
		'vscodeee.transparency.blur': {
			type: 'number',
			minimum: 0,
			maximum: 50,
			default: 0,
			order: 2,
			description: localize('transparency.blur', "Controls the backdrop-filter blur radius in pixels applied to workbench parts."),
			scope: ConfigurationScope.APPLICATION,
		},
		'vscodeee.transparency.nativeTransparency': {
			type: 'boolean',
			default: false,
			order: 3,
			markdownDescription: localize('transparency.nativeTransparency', "Enable OS-native window transparency using Tauri window effects. **Requires application restart.** On macOS, this uses the Private API and may not be compatible with App Store distribution."),
			scope: ConfigurationScope.APPLICATION,
			tags: ['usesOnlineServices'],
		},
		'vscodeee.transparency.nativeEffect': {
			type: 'string',
			enum: ['auto', 'mica', 'acrylic', 'vibrancy', 'none'],
			enumDescriptions: [
				localize('transparency.nativeEffect.auto', "Automatically select the best effect for the current platform (macOS: vibrancy, Windows 11: Mica, Windows 10: Acrylic, Linux: Tabbed)."),
				localize('transparency.nativeEffect.mica', "Windows 11 Mica effect. Provides a subtle, dynamic background that incorporates the desktop wallpaper."),
				localize('transparency.nativeEffect.acrylic', "Windows 10/11 Acrylic effect. Provides a translucent, blurred background."),
				localize('transparency.nativeEffect.vibrancy', "macOS vibrancy effect (NSVisualEffectView). Provides a native frosted-glass appearance. Combine with CSS opacity < 100 to see the effect through workbench parts."),
				localize('transparency.nativeEffect.none', "No native effect. CSS-based transparency only."),
			],
			default: 'auto',
			order: 4,
			markdownDescription: localize('transparency.nativeEffect', "Specifies the native window effect type to use when native transparency is enabled.\n\n**Platform compatibility:**\n- macOS: `auto` (vibrancy), `vibrancy`\n- Windows 11: `auto` (Mica), `mica`, `acrylic`\n- Windows 10: `auto` (Acrylic), `acrylic`\n- Linux: `auto` (Tabbed)"),
			scope: ConfigurationScope.APPLICATION,
		},
		'vscodeee.transparency.backgroundImage': {
			type: 'string',
			default: '',
			order: 5,
			description: localize('transparency.backgroundImage', "Path to a background image displayed behind the workbench. Supports local file paths and URLs."),
			scope: ConfigurationScope.APPLICATION,
		},
		'vscodeee.transparency.backgroundImageOpacity': {
			type: 'number',
			minimum: 0,
			maximum: 100,
			default: 30,
			order: 6,
			description: localize('transparency.backgroundImageOpacity', "Controls the opacity of the background image (0 = fully transparent, 100 = fully opaque)."),
			scope: ConfigurationScope.APPLICATION,
		},
		'vscodeee.transparency.backgroundImageBlur': {
			type: 'number',
			minimum: 0,
			maximum: 50,
			default: 0,
			order: 7,
			description: localize('transparency.backgroundImageBlur', "Controls the blur radius in pixels applied to the background image."),
			scope: ConfigurationScope.APPLICATION,
		},
	}
});

// ── Register service ──

registerSingleton(ITransparencyService, TransparencyService, InstantiationType.Eager);

// ── Workbench contribution to force service instantiation ──
// ITransparencyService has no consumers, so we need a contribution to
// request it and trigger the Eager singleton creation.

class TransparencyContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.transparency';

	constructor(
		@ITransparencyService transparencyService: ITransparencyService,
	) {
		super();
		// Service instantiation is sufficient — the constructor handles
		// configuration watching and initial CSS application.
		void transparencyService.configuration;
	}
}

registerWorkbenchContribution2(TransparencyContribution.ID, TransparencyContribution, WorkbenchPhase.AfterRestored);
