/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as browser from './browser.js';
import { EVENT_KEY_CODE_MAP, isModifierKey, KeyCode, KeyCodeUtils, KeyMod } from '../common/keyCodes.js';
import { KeyCodeChord } from '../common/keybindings.js';
import * as platform from '../common/platform.js';

/**
 * Extracts a {@link KeyCode} from a native browser `KeyboardEvent`.
 *
 * Handles browser-specific quirks (Firefox, WebKit) and IME composition
 * processing (keyCode 229) by mapping to {@link KeyCode.Unknown}.
 *
 * @param e - The native browser keyboard event.
 * @returns The resolved `KeyCode`, or `KeyCode.Unknown` if no mapping exists.
 */
function extractKeyCode(e: KeyboardEvent): KeyCode {
	if (e.charCode) {
		// "keypress" events mostly
		const char = String.fromCharCode(e.charCode).toUpperCase();
		return KeyCodeUtils.fromString(char);
	}

	const keyCode = e.keyCode;

	// keyCode 229 = IME processing. Keep as Unknown so IME confirmation
	// Enter does not match any keybinding.
	if (keyCode === 229) {
		return KeyCode.Unknown;
	}

	// browser quirks
	if (keyCode === 3) {
		return KeyCode.PauseBreak;
	} else if (browser.isFirefox) {
		switch (keyCode) {
			case 59: return KeyCode.Semicolon;
			case 60:
				if (platform.isLinux) { return KeyCode.IntlBackslash; }
				break;
			case 61: return KeyCode.Equal;
			// based on: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/keyCode#numpad_keys
			case 107: return KeyCode.NumpadAdd;
			case 109: return KeyCode.NumpadSubtract;
			case 173: return KeyCode.Minus;
			case 224:
				if (platform.isMacintosh) { return KeyCode.Meta; }
				break;
		}
	} else if (browser.isWebKit) {
		if (platform.isMacintosh && keyCode === 93) {
			// the two meta keys in the Mac have different key codes (91 and 93)
			return KeyCode.Meta;
		} else if (!platform.isMacintosh && keyCode === 92) {
			return KeyCode.Meta;
		}
	}

	// cross browser keycodes:
	return EVENT_KEY_CODE_MAP[keyCode] || KeyCode.Unknown;
}

/**
 * Standardized keyboard event interface used throughout the codebase.
 *
 * Wraps a native browser `KeyboardEvent` and provides a platform-agnostic
 * representation of modifier keys, key codes, and IME composition state.
 */
export interface IKeyboardEvent {

	/** Branding field for type narrowing. */
	readonly _standardKeyboardEventBrand: true;

	/** The underlying native browser keyboard event. */
	readonly browserEvent: KeyboardEvent;
	/** The DOM element that was the target of the keyboard event. */
	readonly target: HTMLElement;

	/** Whether the Ctrl (or Cmd on macOS) modifier key was pressed. */
	readonly ctrlKey: boolean;
	/** Whether the Shift modifier key was pressed. */
	readonly shiftKey: boolean;
	/** Whether the Alt modifier key was pressed. */
	readonly altKey: boolean;
	/** Whether the Meta (Cmd on macOS, Win on others) modifier key was pressed. */
	readonly metaKey: boolean;
	/** Whether the AltGraph modifier key was pressed. */
	readonly altGraphKey: boolean;
	/** The resolved {@link KeyCode} for this event. */
	readonly keyCode: KeyCode;
	/** The physical key code string from the `KeyboardEvent.code` property. */
	readonly code: string;
	/** Whether an IME composition session is active for this event. */
	readonly isComposing: boolean;

	/**
	 * @internal
	 */
	toKeyCodeChord(): KeyCodeChord;
	equals(keybinding: number): boolean;

	preventDefault(): void;
	stopPropagation(): void;
}

const ctrlKeyMod = (platform.isMacintosh ? KeyMod.WinCtrl : KeyMod.CtrlCmd);
const altKeyMod = KeyMod.Alt;
const shiftKeyMod = KeyMod.Shift;
const metaKeyMod = (platform.isMacintosh ? KeyMod.CtrlCmd : KeyMod.WinCtrl);

/**
 * Returns a human-readable string representation of a native browser `KeyboardEvent`,
 * including modifier keys, code, keyCode, and key values.
 *
 * @param e - The native browser keyboard event.
 * @returns A formatted string describing the event.
 */
export function printKeyboardEvent(e: KeyboardEvent): string {
	const modifiers: string[] = [];
	if (e.ctrlKey) {
		modifiers.push(`ctrl`);
	}
	if (e.shiftKey) {
		modifiers.push(`shift`);
	}
	if (e.altKey) {
		modifiers.push(`alt`);
	}
	if (e.metaKey) {
		modifiers.push(`meta`);
	}
	return `modifiers: [${modifiers.join(',')}], code: ${e.code}, keyCode: ${e.keyCode}, key: ${e.key}`;
}

/**
 * Returns a human-readable string representation of a {@link StandardKeyboardEvent},
 * including modifier keys, code, keyCode, and the resolved `KeyCode` string label.
 *
 * @param e - The standardized keyboard event.
 * @returns A formatted string describing the event.
 */
export function printStandardKeyboardEvent(e: StandardKeyboardEvent): string {
	const modifiers: string[] = [];
	if (e.ctrlKey) {
		modifiers.push(`ctrl`);
	}
	if (e.shiftKey) {
		modifiers.push(`shift`);
	}
	if (e.altKey) {
		modifiers.push(`alt`);
	}
	if (e.metaKey) {
		modifiers.push(`meta`);
	}
	return `modifiers: [${modifiers.join(',')}], code: ${e.code}, keyCode: ${e.keyCode} ('${KeyCodeUtils.toString(e.keyCode)}')`;
}

/**
 * Checks whether any modifier key (Ctrl, Shift, Alt, or Meta) is pressed.
 *
 * @param keyStatus - An object with boolean modifier key properties.
 * @returns `true` if at least one modifier key is active.
 */
export function hasModifierKeys(keyStatus: {
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
}): boolean {
	return keyStatus.ctrlKey || keyStatus.shiftKey || keyStatus.altKey || keyStatus.metaKey;
}

/**
 * A standardized, platform-agnostic representation of a keyboard event.
 *
 * Wraps a native `KeyboardEvent` and resolves browser-specific quirks into
 * a consistent `KeyCode` and modifier key state. Also tracks IME composition
 * state at the class level via static methods.
 *
 * On macOS, `CtrlCmd` maps to `KeyMod.CtrlCmd`; on other platforms it maps
 * to `KeyMod.WinCtrl`. This ensures keybindings are resolved correctly
 * regardless of the host OS.
 */
export class StandardKeyboardEvent implements IKeyboardEvent {

	readonly _standardKeyboardEventBrand = true;

	private static _compositionState = false;
	private static _compositionEndTime = 0;
	private static _compositionInitialized = false;

	/**
		 * Initializes IME composition tracking on the given window.
		 *
		 * Listens for `compositionstart` and `compositionend` events to maintain
		 * a global composition state that supplements the unreliable `e.isComposing`
		 * property in some WebView environments (e.g. WKWebView).
		 *
		 * This method is idempotent; calling it multiple times has no additional effect.
		 *
		 * @param window - The browser window to attach composition listeners to.
		 */
		public static initCompositionTracking(window: Window): void {
		if (StandardKeyboardEvent._compositionInitialized) {
			return;
		}
		StandardKeyboardEvent._compositionInitialized = true;
		window.addEventListener('compositionstart', () => {
			StandardKeyboardEvent._compositionState = true;
		});
		window.addEventListener('compositionend', () => {
			StandardKeyboardEvent._compositionEndTime = Date.now();
			setTimeout(() => {
				StandardKeyboardEvent._compositionState = false;
			}, 0);
		});
	}

		/** Whether an IME composition session is currently active. */
		public static get isComposingActive(): boolean {
		return StandardKeyboardEvent._compositionState;
	}

		/**
		 * Whether an IME composition session ended very recently (within 200ms).
		 *
		 * This grace period accounts for the delay between `compositionend`
		 * and the browser committing the composed text to the input value,
		 * particularly in WKWebView environments.
		 */
		public static get recentlyComposed(): boolean {
		return (Date.now() - StandardKeyboardEvent._compositionEndTime) < 200;
	}

	public readonly browserEvent: KeyboardEvent;
	public readonly target: HTMLElement;

	public readonly ctrlKey: boolean;
	public readonly shiftKey: boolean;
	public readonly altKey: boolean;
	public readonly metaKey: boolean;
	public readonly altGraphKey: boolean;
	public readonly keyCode: KeyCode;
	public readonly code: string;
	public readonly isComposing: boolean;

	private _asKeybinding: number;
	private _asKeyCodeChord: KeyCodeChord;

	/**
		 * Creates a new `StandardKeyboardEvent` from a native `KeyboardEvent`.
		 *
		 * Extracts modifier keys, resolves the `KeyCode` using platform-specific
		 * mappings, and computes the keybinding representation. The `isComposing`
		 * flag is set to `true` if either the native event's `isComposing` is true
		 * or the static composition tracking state is active.
		 *
		 * @param source - The native browser keyboard event.
		 */
		constructor(source: KeyboardEvent) {
		const e = source;

		this.browserEvent = e;
		this.target = <HTMLElement>e.target;

		this.ctrlKey = e.ctrlKey;
		this.shiftKey = e.shiftKey;
		this.altKey = e.altKey;
		this.metaKey = e.metaKey;
		this.altGraphKey = e.getModifierState?.('AltGraph');
		this.keyCode = extractKeyCode(e);
		this.code = e.code;
		this.isComposing = e.isComposing || StandardKeyboardEvent._compositionState;

		// console.info(e.type + ": keyCode: " + e.keyCode + ", which: " + e.which + ", charCode: " + e.charCode + ", detail: " + e.detail + " ====> " + this.keyCode + ' -- ' + KeyCode[this.keyCode]);

		this.ctrlKey = this.ctrlKey || this.keyCode === KeyCode.Ctrl;
		this.altKey = this.altKey || this.keyCode === KeyCode.Alt;
		this.shiftKey = this.shiftKey || this.keyCode === KeyCode.Shift;
		this.metaKey = this.metaKey || this.keyCode === KeyCode.Meta;

		this._asKeybinding = this._computeKeybinding();
		this._asKeyCodeChord = this._computeKeyCodeChord();

		// console.log(`code: ${e.code}, keyCode: ${e.keyCode}, key: ${e.key}`);
	}

	public preventDefault(): void {
		if (this.browserEvent && this.browserEvent.preventDefault) {
			this.browserEvent.preventDefault();
		}
	}

	public stopPropagation(): void {
		if (this.browserEvent && this.browserEvent.stopPropagation) {
			this.browserEvent.stopPropagation();
		}
	}

		/**
		 * Returns this keyboard event as a {@link KeyCodeChord}, combining
		 * modifier key states with the resolved key code.
		 */
		public toKeyCodeChord(): KeyCodeChord {
		return this._asKeyCodeChord;
	}

		/**
		 * Tests whether this keyboard event matches the given keybinding number.
		 *
		 * @param other - The keybinding number to compare against.
		 * @returns `true` if the computed keybinding matches.
		 */
		public equals(other: number): boolean {
		return this._asKeybinding === other;
	}

	/**
		 * Computes the numeric keybinding representation from modifier keys and the key code.
		 * Modifier-only key events produce `KeyCode.Unknown`.
		 */
		private _computeKeybinding(): number {
		let key = KeyCode.Unknown;
		if (!isModifierKey(this.keyCode)) {
			key = this.keyCode;
		}

		let result = 0;
		if (this.ctrlKey) {
			result |= ctrlKeyMod;
		}
		if (this.altKey) {
			result |= altKeyMod;
		}
		if (this.shiftKey) {
			result |= shiftKeyMod;
		}
		if (this.metaKey) {
			result |= metaKeyMod;
		}
		result |= key;

		return result;
	}

	/**
		 * Computes a {@link KeyCodeChord} from the current modifier keys and key code.
		 * Modifier-only key events produce `KeyCode.Unknown`.
		 */
		private _computeKeyCodeChord(): KeyCodeChord {
		let key = KeyCode.Unknown;
		if (!isModifierKey(this.keyCode)) {
			key = this.keyCode;
		}
		return new KeyCodeChord(this.ctrlKey, this.shiftKey, this.altKey, this.metaKey, key);
	}
}
