/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../../base/common/async.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISecretStorageProvider, ISecretStorageService, BaseSecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';

/**
 * Browser-compatible secret storage service.
 *
 * When an embedder-provided `ISecretStorageProvider` is configured via
 * `IWorkbenchConstructionOptions.secretStorageProvider`, all get/set/delete
 * operations are delegated to that provider and `BaseSecretStorageService`
 * is bypassed entirely.
 *
 * When no provider is set (Tauri desktop), this service delegates to
 * `BaseSecretStorageService`, which checks `IEncryptionService.isEncryptionAvailable()`
 * and persists encrypted blobs in SQLite if encryption is available,
 * or falls back to in-memory storage otherwise. This matches Electron's
 * `NativeSecretStorageService` behavior.
 */
export class BrowserSecretStorageService extends BaseSecretStorageService {

	private readonly _secretStorageProvider: ISecretStorageProvider | undefined;
	private readonly _embedderSequencer: SequencerByKey<string> | undefined;

	/**
	 * Create a new `BrowserSecretStorageService`.
	 *
	 * @param storageService - The storage service used for persisted secret storage.
	 * @param encryptionService - The encryption service used to encrypt/decrypt secrets.
	 * @param environmentService - The workbench environment service; its `options.secretStorageProvider`
	 *   determines whether an embedder provider or `BaseSecretStorageService` is used.
	 * @param logService - The log service for diagnostic output.
	 */
	constructor(
		@IStorageService storageService: IStorageService,
		@IEncryptionService encryptionService: IEncryptionService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@ILogService logService: ILogService
	) {
		// When an embedder-provided secretStorageProvider is set, all get/set/delete
		// calls are delegated to it and BaseSecretStorageService is bypassed entirely,
		// so the _useInMemoryStorage flag has no effect. Pass true for that case.
		//
		// When no provider is set (Tauri desktop), we let BaseSecretStorageService
		// decide: it checks isEncryptionAvailable() and uses persisted SQLite storage
		// if encryption is available, otherwise falls back to in-memory.
		// This matches Electron's NativeSecretStorageService behavior.
		const useInMemory = !!environmentService.options?.secretStorageProvider;
		super(useInMemory, storageService, encryptionService, logService);

		if (environmentService.options?.secretStorageProvider) {
			this._secretStorageProvider = environmentService.options.secretStorageProvider;
			this._embedderSequencer = new SequencerByKey<string>();
		}
	}

	/**
	 * Retrieve a secret by key.
	 *
	 * If an embedder provider is configured, the call is sequenced per-key
	 * to prevent race conditions and delegated to the provider.
	 * Otherwise delegates to `BaseSecretStorageService`.
	 *
	 * @param key - The secret key to look up.
	 * @returns The secret value, or `undefined` if not found.
	 */
	override get(key: string): Promise<string | undefined> {
		if (this._secretStorageProvider) {
			return this._embedderSequencer!.queue(key, () => this._secretStorageProvider!.get(key));
		}

		return super.get(key);
	}

	/**
	 * Store a secret by key.
	 *
	 * If an embedder provider is configured, the call is sequenced per-key
	 * and a `onDidChangeSecret` event is fired after successful storage.
	 * Otherwise delegates to `BaseSecretStorageService`.
	 *
	 * @param key - The secret key to store.
	 * @param value - The secret value.
	 */
	override set(key: string, value: string): Promise<void> {
		if (this._secretStorageProvider) {
			return this._embedderSequencer!.queue(key, async () => {
				await this._secretStorageProvider!.set(key, value);
				this.onDidChangeSecretEmitter.fire(key);
			});
		}

		return super.set(key, value);
	}

	/**
	 * Delete a secret by key.
	 *
	 * If an embedder provider is configured, the call is sequenced per-key
	 * and a `onDidChangeSecret` event is fired after successful deletion.
	 * Otherwise delegates to `BaseSecretStorageService`.
	 *
	 * @param key - The secret key to delete.
	 */
	override delete(key: string): Promise<void> {
		if (this._secretStorageProvider) {
			return this._embedderSequencer!.queue(key, async () => {
				await this._secretStorageProvider!.delete(key);
				this.onDidChangeSecretEmitter.fire(key);
			});
		}

		return super.delete(key);
	}

	/**
	 * The type identifier of the underlying secret storage.
	 *
	 * Returns the embedder provider's type if available,
	 * otherwise delegates to `BaseSecretStorageService`.
	 */
	override get type() {
		if (this._secretStorageProvider) {
			return this._secretStorageProvider.type;
		}

		return super.type;
	}

	/**
	 * List all stored secret keys.
	 *
	 * If an embedder provider is configured, delegates to its `keys()` method.
	 * Throws if the provider does not implement `keys()`.
	 * Otherwise delegates to `BaseSecretStorageService`.
	 *
	 * @returns An array of stored secret keys.
	 * @throws {Error} If the embedder provider does not support the `keys()` method.
	 */
	override keys(): Promise<string[]> {
		if (this._secretStorageProvider) {
			if (!this._secretStorageProvider.keys) {
				throw new Error('Secret storage provider does not support keys() method');
			}
			return this._secretStorageProvider!.keys();
		}

		return super.keys();
	}
}

registerSingleton(ISecretStorageService, BrowserSecretStorageService, InstantiationType.Delayed);
