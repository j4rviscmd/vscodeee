/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IHostService } from '../../host/browser/host.js';
import { localize } from '../../../../nls.js';
import { isTauri } from '../../../../base/common/platform.js';
import { mainWindow } from '../../../../base/browser/window.js';
import {
	ITransparencyService,
	ITransparencyConfiguration,
	DEFAULT_TRANSPARENCY_CONFIG,
	TRANSPARENCY_OPACITY_SETTING,
	TRANSPARENCY_BLUR_SETTING,
	TRANSPARENCY_BACKGROUND_IMAGE_SETTING,
	TRANSPARENCY_BACKGROUND_IMAGE_OPACITY_SETTING,
	TRANSPARENCY_BACKGROUND_IMAGE_BLUR_SETTING,
	TRANSPARENCY_NATIVE_SETTING,
	TRANSPARENCY_NATIVE_EFFECT_SETTING,
	TRANSPARENT_PART_SELECTORS,
	NativeEffect,
} from '../common/transparency.js';

// ── CSS element IDs ──
const TRANSPARENCY_STYLE_ID = 'vscodeee-transparency-style';
const TRANSPARENCY_BG_LAYER_ID = 'vscodeee-transparency-bg-layer';

/**
 * TransparencyService — Application layer service that manages
 * CSS-based and native transparency effects for the workbench.
 *
 * Architecture:
 * - Level 1: Background image via `<div>` overlay (no restart)
 * - Level 2: CSS transparency + backdrop-filter blur (no restart)
 * - Level 3: OS-native window transparency via Tauri (restart required)
 */
export class TransparencyService extends Disposable implements ITransparencyService {
	declare readonly _serviceBrand: undefined;

	private _configuration: ITransparencyConfiguration;
	get configuration(): ITransparencyConfiguration { return this._configuration; }

	private readonly _onDidChangeConfiguration = this._register(new Emitter<ITransparencyConfiguration>());
	readonly onDidChangeConfiguration: Event<ITransparencyConfiguration> = this._onDidChangeConfiguration.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IThemeService private readonly themeService: IThemeService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();

		this._configuration = this._readConfiguration();

		// Listen for setting changes
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(TRANSPARENCY_OPACITY_SETTING) ||
				e.affectsConfiguration(TRANSPARENCY_BLUR_SETTING) ||
				e.affectsConfiguration(TRANSPARENCY_BACKGROUND_IMAGE_SETTING) ||
				e.affectsConfiguration(TRANSPARENCY_BACKGROUND_IMAGE_OPACITY_SETTING) ||
				e.affectsConfiguration(TRANSPARENCY_BACKGROUND_IMAGE_BLUR_SETTING) ||
				e.affectsConfiguration(TRANSPARENCY_NATIVE_SETTING) ||
				e.affectsConfiguration(TRANSPARENCY_NATIVE_EFFECT_SETTING)
			) {
				const oldConfig = this._configuration;
				this._configuration = this._readConfiguration();
				this.apply();
				this._onDidChangeConfiguration.fire(this._configuration);

				// Show restart toast when nativeTransparency is toggled
				if (oldConfig.nativeTransparency !== this._configuration.nativeTransparency) {
					this._showRestartRequiredToast();
				}

				// Show warning toast when nativeTransparency ON + blur > 0
				if (this._configuration.nativeTransparency && this._configuration.blur > 0) {
					this._showDoubleBlurWarning();
				}
			}
		}));

		// Re-apply when theme changes (background colors change)
		this._register(this.themeService.onDidColorThemeChange(() => {
			this.apply();
		}));

		// Initial apply
		this.apply();
	}

	// ── Public API ──

	apply(): void {
		this._applyCSS();
		this._applyBackgroundImage();
		this._applyNativeTransparency();
	}

	reset(): void {
		this._removeStyleElement();
		this._removeBackgroundLayer();
	}

	async enableNativeTransparency(): Promise<void> {
		if (!isTauri) {
			return;
		}
		try {
			const { invoke } = await import('../../../../platform/tauri/common/tauriApi.js');
			await invoke('set_native_transparency', { params: { enabled: true, effect: this._configuration.nativeEffect } });
		} catch (err) {
			// TODO: Future implementation — Tauri command not yet registered
			console.warn('[TransparencyService] Native transparency not available:', err);
		}
	}

	async disableNativeTransparency(): Promise<void> {
		if (!isTauri) {
			return;
		}
		try {
			const { invoke } = await import('../../../../platform/tauri/common/tauriApi.js');
			await invoke('set_native_transparency', { params: { enabled: false, effect: NativeEffect.None } });
		} catch (err) {
			console.warn('[TransparencyService] Native transparency not available:', err);
		}
	}

	// ── Private: Read configuration ──

	private _readConfiguration(): ITransparencyConfiguration {
		const get = <T>(key: string, defaultValue: T): T =>
			this.configurationService.getValue<T>(key) ?? defaultValue;

		return {
			opacity: this._clamp(get(TRANSPARENCY_OPACITY_SETTING, DEFAULT_TRANSPARENCY_CONFIG.opacity), 0, 100),
			blur: this._clamp(get(TRANSPARENCY_BLUR_SETTING, DEFAULT_TRANSPARENCY_CONFIG.blur), 0, 50),
			backgroundImage: get(TRANSPARENCY_BACKGROUND_IMAGE_SETTING, DEFAULT_TRANSPARENCY_CONFIG.backgroundImage),
			backgroundImageOpacity: this._clamp(get(TRANSPARENCY_BACKGROUND_IMAGE_OPACITY_SETTING, DEFAULT_TRANSPARENCY_CONFIG.backgroundImageOpacity), 0, 100),
			backgroundImageBlur: this._clamp(get(TRANSPARENCY_BACKGROUND_IMAGE_BLUR_SETTING, DEFAULT_TRANSPARENCY_CONFIG.backgroundImageBlur), 0, 50),
			nativeTransparency: get(TRANSPARENCY_NATIVE_SETTING, DEFAULT_TRANSPARENCY_CONFIG.nativeTransparency),
			nativeEffect: get(TRANSPARENCY_NATIVE_EFFECT_SETTING, DEFAULT_TRANSPARENCY_CONFIG.nativeEffect),
		};
	}

	// ── Private: CSS injection (Level 2) ──

	private _applyCSS(): void {
		const doc = mainWindow.document;
		const config = this._configuration;

		// If opacity is 100 and blur is 0, remove any injected styles
		if (config.opacity === 100 && config.blur === 0) {
			this._removeStyleElement();
			return;
		}

		let styleEl = doc.getElementById(TRANSPARENCY_STYLE_ID) as HTMLStyleElement | null;
		if (!styleEl) {
			styleEl = doc.createElement('style');
			styleEl.id = TRANSPARENCY_STYLE_ID;
			doc.head.appendChild(styleEl);
		}

		const opacityValue = config.opacity / 100;
		const blurValue = config.blur; // User-specified blur (0-50px)

		const rules: string[] = [];

		// Keyframe animation to force WebKit (WKWebView in Tauri) to maintain
		// the GPU compositing layer for backdrop-filter. Without this, WebKit
		// de-promotes the layer after ~5 seconds of inactivity, causing
		// backdrop-filter to stop rendering.
		if (blurValue > 0) {
			rules.push(
				`@keyframes _vscodeee-keep-compositing { 0%, 100% { transform: translateZ(0); } }`
			);
		}

		// Generate transparency rules for each workbench part
		for (const selector of TRANSPARENT_PART_SELECTORS) {
			// Build backdrop-filter with WebKit prefix (required for WKWebView in Tauri/macOS)
			const blurCSS = blurValue > 0
				? `-webkit-backdrop-filter: blur(${blurValue}px); backdrop-filter: blur(${blurValue}px); animation: _vscodeee-keep-compositing 1s infinite;`
				: '';

			rules.push(
				`${selector} { background-color: transparent !important; opacity: ${opacityValue}; ${blurCSS} }`
			);
		}

		// Exclude the editor content area from opacity to keep text readable.
		// Only the container background is affected, not the text layer.
		rules.push(
			`.monaco-workbench .editor-instance { opacity: 1; }`,
			`.monaco-workbench .minimap { opacity: 1; }`,
		);

		styleEl.textContent = rules.join('\n');
	}

	private _removeStyleElement(): void {
		const el = mainWindow.document.getElementById(TRANSPARENCY_STYLE_ID);
		if (el) {
			el.remove();
		}
	}

	// ── Private: Native transparency (Level 3) ──

	/**
	 * Apply or remove native window transparency based on current config.
	 * This calls the Tauri `set_native_transparency` command to enable/disable
	 * OS-level window effects (vibrancy, mica, acrylic).
	 */
	private _applyNativeTransparency(): void {
		if (this._configuration.nativeTransparency) {
			this.enableNativeTransparency();
		} else {
			this.disableNativeTransparency();
		}
	}

	// ── Private: Background image layer (Level 1) ──

	private _applyBackgroundImage(): void {
		const doc = mainWindow.document;
		const config = this._configuration;

		if (!config.backgroundImage) {
			this._removeBackgroundLayer();
			return;
		}

		let bgLayer = doc.getElementById(TRANSPARENCY_BG_LAYER_ID) as HTMLDivElement | null;
		if (!bgLayer) {
			bgLayer = doc.createElement('div');
			bgLayer.id = TRANSPARENCY_BG_LAYER_ID;
			// Position as the very first child of body, behind everything
			bgLayer.style.position = 'fixed';
			bgLayer.style.top = '0';
			bgLayer.style.left = '0';
			bgLayer.style.width = '100%';
			bgLayer.style.height = '100%';
			bgLayer.style.zIndex = '-1';
			bgLayer.style.pointerEvents = 'none';
			doc.body.insertBefore(bgLayer, doc.body.firstChild);
		}

		// Sanitize and build the image URL
		// In Tauri, local files must go through vscode-file:// protocol
		const imagePath = this._sanitizeImagePath(config.backgroundImage);
		const imageOpacity = config.backgroundImageOpacity / 100;
		const imageBlur = config.backgroundImageBlur;

		bgLayer.style.backgroundImage = `url('${imagePath}')`;
		bgLayer.style.backgroundSize = 'cover';
		bgLayer.style.backgroundPosition = 'center';
		bgLayer.style.backgroundRepeat = 'no-repeat';
		bgLayer.style.opacity = String(imageOpacity);
		bgLayer.style.filter = imageBlur > 0 ? `blur(${imageBlur}px)` : '';
	}

	private _removeBackgroundLayer(): void {
		const el = mainWindow.document.getElementById(TRANSPARENCY_BG_LAYER_ID);
		if (el) {
			el.remove();
		}
	}

	/**
	 * Sanitize an image path for safe CSS url() usage.
	 * Converts local file paths to vscode-file:// protocol URIs.
	 */
	private _sanitizeImagePath(rawPath: string): string {
		// If it's already a URL (http/https/data/vscode-file), use as-is
		if (/^(https?|data|vscode-file|blob):/.test(rawPath)) {
			return CSS.escape(rawPath);
		}

		// Convert local file path to vscode-file:// protocol
		// This bypasses CSP restrictions on file:// URLs
		if (isTauri) {
			// In Tauri, use vscode-file://vscode-app/<absolute-path>
			const normalizedPath = rawPath.replace(/\\/g, '/');
			const encoded = encodeURI(normalizedPath);
			return `vscode-file://vscode-app${encoded.startsWith('/') ? '' : '/'}${encoded}`;
		}

		// Fallback: CSS-escape the path
		return CSS.escape(rawPath);
	}

	// ── Private: Toast notifications ──

	/**
	 * Show a restart-required toast when nativeTransparency is toggled.
	 * Offers a "Restart" button to apply the change immediately.
	 */
	private _showRestartRequiredToast(): void {
		const action = this._configuration.nativeTransparency
			? localize('transparency.nativeEnabled', "Native transparency has been enabled. A restart is required to apply the change.")
			: localize('transparency.nativeDisabled', "Native transparency has been disabled. A restart is required to apply the change.");

		this.notificationService.prompt(
			Severity.Info,
			action,
			[{
				label: localize('transparency.restart', "Restart"),
				run: () => this.hostService.restart(),
			}],
		);
	}

	/**
	 * Show a warning toast when nativeTransparency is ON and CSS blur > 0.
	 * Both effects blur content, leading to a double-blur visual artifact.
	 */
	private _showDoubleBlurWarning(): void {
		this.notificationService.prompt(
			Severity.Warning,
			localize('transparency.doubleBlur', "Native transparency and CSS blur are both active. This may cause a double-blur effect. Consider setting blur to 0 when native transparency is enabled."),
			[{
				label: localize('transparency.disableBlur', "Set Blur to 0"),
				run: () => this.configurationService.updateValue(TRANSPARENCY_BLUR_SETTING, 0),
			}],
		);
	}

	// ── Utility ──

	private _clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}

	override dispose(): void {
		this.reset();
		super.dispose();
	}
}
