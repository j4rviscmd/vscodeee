/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri OS Keychain backend for ISecretStorageProvider.
 *
 * Delegates actual credential storage to the Rust side (keyring crate),
 * which uses platform-native credential stores:
 * - macOS: Keychain Access
 * - Windows: Credential Manager
 * - Linux: Secret Service (GNOME Keyring / KDE Wallet)
 *
 * Since the keyring crate does not provide a reliable cross-platform
 * way to enumerate all stored entries, we maintain a key index in
 * localStorage as a secondary data structure for the keys() method.
 */

import { ISecretStorageProvider } from '../common/secrets.js';
import { invoke } from '../../tauri/common/tauriApi.js';

/**
 * localStorage key used to store the set of known secret keys.
 * This index is updated on set/delete and read on keys().
 */
const KEY_INDEX_STORAGE_KEY = 'vscodeee.secrets.keyIndex';

export class TauriSecretStorageProvider implements ISecretStorageProvider {

	readonly type = 'persisted' as const;

	async get(key: string): Promise<string | undefined> {
		const result = await invoke<string | null>('secret_get', { key });
		return result ?? undefined;
	}

	async set(key: string, value: string): Promise<void> {
		await invoke<void>('secret_set', { key, value });
		this._addKeyToIndex(key);
	}

	async delete(key: string): Promise<void> {
		await invoke<void>('secret_delete', { key });
		this._removeKeyFromIndex(key);
	}

	async keys(): Promise<string[]> {
		return this._getKeyIndex();
	}

	// ── Key index management (localStorage) ──

	private _getKeyIndex(): string[] {
		try {
			const raw = localStorage.getItem(KEY_INDEX_STORAGE_KEY);
			if (!raw) {
				return [];
			}
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed;
			}
			return [];
		} catch {
			return [];
		}
	}

	private _saveKeyIndex(keys: string[]): void {
		try {
			localStorage.setItem(KEY_INDEX_STORAGE_KEY, JSON.stringify(keys));
		} catch {
			// localStorage might be unavailable in some edge cases; ignore
		}
	}

	private _addKeyToIndex(key: string): void {
		const keys = this._getKeyIndex();
		if (!keys.includes(key)) {
			keys.push(key);
			this._saveKeyIndex(keys);
		}
	}

	private _removeKeyFromIndex(key: string): void {
		const keys = this._getKeyIndex();
		const idx = keys.indexOf(key);
		if (idx !== -1) {
			keys.splice(idx, 1);
			this._saveKeyIndex(keys);
		}
	}
}
