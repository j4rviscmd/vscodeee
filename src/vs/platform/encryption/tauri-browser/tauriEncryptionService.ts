/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEncryptionService, KnownStorageProvider } from '../common/encryptionService.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { invoke } from '../../tauri/common/tauriApi.js';

/**
 * Tauri implementation of `IEncryptionService`.
 *
 * Delegates AES-256-GCM encryption/decryption to the Rust backend, which
 * manages a single master encryption key stored in the OS credential store
 * (macOS Keychain / Windows Credential Manager / Linux Secret Service).
 *
 * Architecture:
 * - Master key: 1 Keychain item with permissive ACL (macOS debug builds)
 * - Encryption: AES-256-GCM with random 96-bit nonce per operation
 * - Storage: Encrypted blobs are persisted in SQLite via `BaseSecretStorageService`
 *
 * This replaces the previous `TauriSecretStorageProvider` which stored each
 * secret as a separate Keychain item, triggering multiple ACL dialogs.
 */
export class TauriEncryptionService implements IEncryptionService {

	declare readonly _serviceBrand: undefined;

	private _isAvailable: boolean | undefined;

	async encrypt(value: string): Promise<string> {
		return invoke<string>('encryption_encrypt', { value });
	}

	async decrypt(value: string): Promise<string> {
		return invoke<string>('encryption_decrypt', { value });
	}

	async isEncryptionAvailable(): Promise<boolean> {
		if (this._isAvailable === undefined) {
			try {
				this._isAvailable = await invoke<boolean>('encryption_is_available');
			} catch {
				this._isAvailable = false;
			}
		}
		return this._isAvailable;
	}

	async getKeyStorageProvider(): Promise<KnownStorageProvider> {
		if (await this.isEncryptionAvailable()) {
			return KnownStorageProvider.keychainAccess;
		}
		return KnownStorageProvider.basicText;
	}

	async setUsePlainTextEncryption(): Promise<void> {
		// No-op — the encryption availability is determined by the OS credential store.
	}
}

registerSingleton(IEncryptionService, TauriEncryptionService, InstantiationType.Delayed);
