/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Promises } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IStorage, Storage } from '../../../../base/parts/storage/common/storage.js';
import { AbstractStorageService, isProfileUsingDefaultStorage, IS_NEW_KEY, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { isUserDataProfile, IUserDataProfile } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { TauriFileStorageDatabase } from './fileStorageDatabase.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';

/**
 * File-based storage service for the Tauri desktop build.
 *
 * Replaces `BrowserStorageService` (IndexedDB-backed) with a service that
 * persists state as JSON files on disk via Tauri's native filesystem.
 * This eliminates the IndexedDB data-loss issue where `close()` ran before
 * `flush(SHUTDOWN)` could persist data.
 *
 * File layout:
 *   APPLICATION: {appDataDir}/User/globalStorage/state.json
 *   PROFILE:     same as APPLICATION (default profile) or {profileDir}/state.json
 *   WORKSPACE:   {appDataDir}/User/workspaceStorage/{workspaceId}/state.json
 */
export class TauriStorageService extends AbstractStorageService {

	private static readonly TAURI_FLUSH_INTERVAL = 5 * 1000;

	private applicationStorage: IStorage | undefined;
	private profileStorage: IStorage | undefined;
	private profileStorageProfile: IUserDataProfile;
	private readonly profileStorageDisposables = this._register(new DisposableStore());

	private workspaceStorage: IStorage | undefined;

	constructor(
		private readonly workspace: IAnyWorkspaceIdentifier,
		private readonly userDataProfileService: IUserDataProfileService,
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super({ flushInterval: TauriStorageService.TAURI_FLUSH_INTERVAL });

		this.profileStorageProfile = this.userDataProfileService.currentProfile;
		this.registerListeners();
		this.logService.info('[TauriStorageService] Created — file-based storage');
	}

	private registerListeners(): void {
		this._register(this.userDataProfileService.onDidChangeCurrentProfile(e => e.join(this.switchToProfile(e.profile))));
	}

	protected async doInitialize(): Promise<void> {
		this.logService.info(`[TauriStorageService] Initializing — appPath: ${this.applicationStoragePath()}, wsPath: ${this.workspaceStoragePath()}`);
		await Promises.settled([
			this.createApplicationStorage(),
			this.createProfileStorage(this.profileStorageProfile),
			this.createWorkspaceStorage(),
		]);
	}

	private applicationStoragePath(): string {
		const appDataDir = this.environmentService.userRoamingDataHome.fsPath;
		return `${appDataDir}/globalStorage/state.json`;
	}

	private profileStoragePath(profile: IUserDataProfile): string {
		if (isProfileUsingDefaultStorage(profile)) {
			return this.applicationStoragePath();
		}
		return `${profile.globalStorageHome.fsPath}/state.json`;
	}

	private workspaceStoragePath(): string {
		const workspaceStorageHome = this.environmentService.workspaceStorageHome?.fsPath;
		if (!workspaceStorageHome) {
			this.logService.warn('[TauriStorageService] workspaceStorageHome is not available, using tmpDir fallback');
			return `${this.environmentService.userRoamingDataHome.fsPath}/workspaceStorage/${this.workspace.id}/state.json`;
		}
		return `${workspaceStorageHome}/${this.workspace.id}/state.json`;
	}

	private async createApplicationStorage(): Promise<void> {
		const database = this._register(new TauriFileStorageDatabase(this.applicationStoragePath(), this.logService));
		this.applicationStorage = this._register(new Storage(database));

		this._register(this.applicationStorage.onDidChangeStorage(e => this.emitDidChangeValue(StorageScope.APPLICATION, e)));

		await this.applicationStorage.init();

		this.updateIsNew(this.applicationStorage);
	}

	private async createProfileStorage(profile: IUserDataProfile): Promise<void> {
		this.profileStorageDisposables.clear();
		this.profileStorageProfile = profile;

		if (isProfileUsingDefaultStorage(profile)) {
			// Default profile shares APPLICATION storage
			this.profileStorage = this.applicationStorage;
		} else {
			const database = this.profileStorageDisposables.add(new TauriFileStorageDatabase(this.profileStoragePath(profile), this.logService));
			this.profileStorage = this.profileStorageDisposables.add(new Storage(database));

			this.profileStorageDisposables.add(this.profileStorage.onDidChangeStorage(e => this.emitDidChangeValue(StorageScope.PROFILE, e)));

			await this.profileStorage.init();

			this.updateIsNew(this.profileStorage);
		}
	}

	private async createWorkspaceStorage(): Promise<void> {
		const database = this._register(new TauriFileStorageDatabase(this.workspaceStoragePath(), this.logService));
		this.workspaceStorage = this._register(new Storage(database));

		this._register(this.workspaceStorage.onDidChangeStorage(e => this.emitDidChangeValue(StorageScope.WORKSPACE, e)));

		await this.workspaceStorage.init();

		this.updateIsNew(this.workspaceStorage);
	}

	private updateIsNew(storage: IStorage): void {
		const firstOpen = storage.getBoolean(IS_NEW_KEY);
		if (firstOpen === undefined) {
			storage.set(IS_NEW_KEY, true);
		} else if (firstOpen) {
			storage.set(IS_NEW_KEY, false);
		}
	}

	protected getStorage(scope: StorageScope): IStorage | undefined {
		switch (scope) {
			case StorageScope.APPLICATION:
				return this.applicationStorage;
			case StorageScope.PROFILE:
				return this.profileStorage;
			default:
				return this.workspaceStorage;
		}
	}

	protected getLogDetails(scope: StorageScope): string | undefined {
		switch (scope) {
			case StorageScope.APPLICATION:
				return this.applicationStoragePath();
			case StorageScope.PROFILE:
				return this.profileStoragePath(this.profileStorageProfile);
			default:
				return this.workspaceStoragePath();
		}
	}

	protected async switchToProfile(toProfile: IUserDataProfile): Promise<void> {
		if (!this.canSwitchProfile(this.profileStorageProfile, toProfile)) {
			return;
		}

		const oldProfileStorage = this.profileStorage!;
		const oldItems = oldProfileStorage.items;

		if (oldProfileStorage !== this.applicationStorage) {
			await oldProfileStorage.close();
		}

		await this.createProfileStorage(toProfile);

		this.switchData(oldItems, this.profileStorage!, StorageScope.PROFILE);
	}

	protected async switchToWorkspace(_toWorkspace: IAnyWorkspaceIdentifier, _preserveData: boolean): Promise<void> {
		throw new Error('Migrating storage is currently unsupported in Tauri');
	}

	protected override shouldFlushWhenIdle(): boolean {
		return true;
	}

	/**
	 * Close all storages, flushing pending data to disk first.
	 *
	 * Unlike `BrowserStorageService.close()` which only flushes on Safari
	 * and then disposes (potentially cancelling pending writes), this
	 * implementation ALWAYS flushes and awaits completion before closing.
	 */
	async close(): Promise<void> {
		this.logService.info('[TauriStorageService] close() called — flushing and closing storages');
		const storages: IStorage[] = [];
		if (this.applicationStorage) {
			storages.push(this.applicationStorage);
		}
		if (this.profileStorage && this.profileStorage !== this.applicationStorage) {
			storages.push(this.profileStorage);
		}
		if (this.workspaceStorage) {
			storages.push(this.workspaceStorage);
		}

		await Promises.settled(storages.map(s => s.close()));

		this.dispose();
	}

	async clear(): Promise<void> {
		for (const scope of [StorageScope.APPLICATION, StorageScope.PROFILE, StorageScope.WORKSPACE]) {
			for (const target of [StorageTarget.USER, StorageTarget.MACHINE]) {
				for (const key of this.keys(scope, target)) {
					this.remove(key, scope);
				}
			}
			await this.getStorage(scope)?.whenFlushed();
		}
	}

	hasScope(scope: IAnyWorkspaceIdentifier | IUserDataProfile): boolean {
		if (isUserDataProfile(scope)) {
			return this.profileStorageProfile.id === scope.id;
		}
		return this.workspace.id === scope.id;
	}
}
