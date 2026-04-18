/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspacesService, IWorkspaceFolderCreationData, IEnterWorkspaceResult, IRecentlyOpened, restoreRecentlyOpened, IRecent, isRecentFile, isRecentFolder, toStoreData, IStoredWorkspaceFolder, getStoredWorkspaceFolder, IStoredWorkspace, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter } from '../../../../base/common/event.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isTemporaryWorkspace, IWorkspaceContextService, IWorkspaceFoldersChangeEvent, IWorkspaceIdentifier, WorkbenchState, WORKSPACE_EXTENSION } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getWorkspaceIdentifier } from '../browser/workspaces.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceBackupInfo, IFolderBackupInfo } from '../../../../platform/backup/common/backup.js';

/**
 * Tauri-specific WorkspacesService.
 *
 * Unlike the browser version, this does NOT filter out `file://` scheme
 * folders from the recently opened list because Tauri's
 * TauriDiskFileSystemProvider handles local file access natively via
 * Rust commands.
 */
export class TauriWorkspacesService extends Disposable implements IWorkspacesService {

	/** Storage key used to persist the recently opened workspaces and files list. */
	static readonly RECENTLY_OPENED_KEY = 'recently.opened';

	declare readonly _serviceBrand: undefined;

	private readonly _onRecentlyOpenedChange = this._register(new Emitter<void>());
	/** An event that fires when the recently opened list changes. */
	readonly onDidChangeRecentlyOpened = this._onRecentlyOpenedChange.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();

		// Opening a workspace should push it as most
		// recently used to the workspaces history
		this.addWorkspaceToRecentlyOpened();

		this.registerListeners();
	}

	/**
	 * Registers event listeners for storage changes and workspace folder changes.
	 *
	 * - Fires `onDidChangeRecentlyOpened` when the stored recently opened data
	 *   is modified externally (e.g., by another window).
	 * - Updates the recently opened list when workspace folders change within
	 *   a temporary workspace.
	 */
	private registerListeners(): void {

		// Storage
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, TauriWorkspacesService.RECENTLY_OPENED_KEY, this._store)(() => this._onRecentlyOpenedChange.fire()));

		// Workspace
		this._register(this.contextService.onDidChangeWorkspaceFolders(e => this.onDidChangeWorkspaceFolders(e)));
	}

	/**
	 * Handles workspace folder changes by adding newly added folders to the
	 * recently opened list, but only when the current workspace is temporary.
	 *
	 * @param e - The workspace folders change event containing added and removed folders.
	 */
	private onDidChangeWorkspaceFolders(e: IWorkspaceFoldersChangeEvent): void {
		if (!isTemporaryWorkspace(this.contextService.getWorkspace())) {
			return;
		}

		for (const folder of e.added) {
			this.addRecentlyOpened([{ folderUri: folder.uri }]);
		}
	}

	/**
	 * Adds the current workspace to the recently opened history.
	 *
	 * Handles both single-folder workspaces and multi-root workspace files,
	 * associating each entry with the current remote authority when present.
	 */
	private addWorkspaceToRecentlyOpened(): void {
		const workspace = this.contextService.getWorkspace();
		const remoteAuthority = this.environmentService.remoteAuthority;
		switch (this.contextService.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				this.addRecentlyOpened([{ folderUri: workspace.folders[0].uri, remoteAuthority }]);
				break;
			case WorkbenchState.WORKSPACE:
				this.addRecentlyOpened([{ workspace: { id: workspace.id, configPath: workspace.configuration! }, remoteAuthority }]);
				break;
		}
	}

	//#region Workspaces History

	/**
	 * Retrieves the list of recently opened workspaces and files from storage.
	 *
	 * Filters out temporary workspaces from the history to prevent them from
	 * appearing in the "Open Recent" menu.
	 *
	 * @returns A promise that resolves to the recently opened workspaces and files.
	 *          Returns empty arrays if no data is stored.
	 */
	async getRecentlyOpened(): Promise<IRecentlyOpened> {
		const recentlyOpenedRaw = this.storageService.get(TauriWorkspacesService.RECENTLY_OPENED_KEY, StorageScope.APPLICATION);
		if (recentlyOpenedRaw) {
			const recentlyOpened = restoreRecentlyOpened(JSON.parse(recentlyOpenedRaw), this.logService);
			recentlyOpened.workspaces = recentlyOpened.workspaces.filter(recent => {

				// Never offer temporary workspaces in the history
				if (isRecentWorkspace(recent) && isTemporaryWorkspace(recent.workspace.configPath)) {
					return false;
				}

				return true;
			});

			return recentlyOpened;
		}

		return { workspaces: [], files: [] };
	}

	/**
	 * Adds entries to the recently opened list.
	 *
	 * Each entry is moved to the top of the list (most recent position) and
	 * any existing duplicate entry is removed first to avoid duplicates.
	 * Supports files, folders, and workspace configurations.
	 *
	 * @param recents - An array of recent entries (files, folders, or workspaces) to add.
	 * @returns A promise that resolves when the updated list has been persisted.
	 */
	async addRecentlyOpened(recents: IRecent[]): Promise<void> {
		const recentlyOpened = await this.getRecentlyOpened();

		for (const recent of recents) {
			if (isRecentFile(recent)) {
				this.doRemoveRecentlyOpened(recentlyOpened, [recent.fileUri]);
				recentlyOpened.files.unshift(recent);
			} else if (isRecentFolder(recent)) {
				this.doRemoveRecentlyOpened(recentlyOpened, [recent.folderUri]);
				recentlyOpened.workspaces.unshift(recent);
			} else {
				this.doRemoveRecentlyOpened(recentlyOpened, [recent.workspace.configPath]);
				recentlyOpened.workspaces.unshift(recent);
			}
		}

		return this.saveRecentlyOpened(recentlyOpened);
	}

	/**
	 * Removes entries from the recently opened list matching the given URIs.
	 *
	 * @param paths - An array of URIs identifying the entries to remove.
	 * @returns A promise that resolves when the updated list has been persisted.
	 */
	async removeRecentlyOpened(paths: URI[]): Promise<void> {
		const recentlyOpened = await this.getRecentlyOpened();

		this.doRemoveRecentlyOpened(recentlyOpened, paths);

		return this.saveRecentlyOpened(recentlyOpened);
	}

	/**
	 * Removes entries matching the given URIs from the recently opened data in-place.
	 *
	 * Filters both the files and workspaces arrays. For workspace entries,
	 * the comparison is performed against the config path (for workspace files)
	 * or the folder URI (for single-folder entries).
	 *
	 * @param recentlyOpened - The recently opened data to filter.
	 * @param paths - The URIs of the entries to remove.
	 */
	private doRemoveRecentlyOpened(recentlyOpened: IRecentlyOpened, paths: URI[]): void {
		recentlyOpened.files = recentlyOpened.files.filter(file => {
			return !paths.some(path => path.toString() === file.fileUri.toString());
		});

		recentlyOpened.workspaces = recentlyOpened.workspaces.filter(workspace => {
			return !paths.some(path => path.toString() === (isRecentFolder(workspace) ? workspace.folderUri.toString() : workspace.workspace.configPath.toString()));
		});
	}

	/**
	 * Persists the recently opened data to application-scoped storage.
	 *
	 * @param data - The recently opened workspaces and files to store.
	 * @returns A promise that resolves when the data has been written.
	 */
	private async saveRecentlyOpened(data: IRecentlyOpened): Promise<void> {
		return this.storageService.store(TauriWorkspacesService.RECENTLY_OPENED_KEY, JSON.stringify(toStoreData(data)), StorageScope.APPLICATION, StorageTarget.USER);
	}

	/**
	 * Clears all entries from the recently opened list by removing
	 * the stored data from application-scoped storage.
	 */
	async clearRecentlyOpened(): Promise<void> {
		this.storageService.remove(TauriWorkspacesService.RECENTLY_OPENED_KEY, StorageScope.APPLICATION);
	}

	//#endregion

	//#region Workspace Management

	/**
	 * Opens a workspace file and returns the workspace identifier.
	 *
	 * @param workspaceUri - The URI of the workspace file to enter.
	 * @returns A promise that resolves to the enter workspace result containing
	 *          the workspace identifier, or `undefined` if the workspace cannot be entered.
	 */
	async enterWorkspace(workspaceUri: URI): Promise<IEnterWorkspaceResult | undefined> {
		return { workspace: await this.getWorkspaceIdentifier(workspaceUri) };
	}

	/**
	 * Creates a new untitled workspace file with the given folder configuration.
	 *
	 * Generates a unique filename using a timestamp-based random ID and writes
	 * the workspace definition (folders and optional remote authority) as a JSON
	 * file to the untitled workspaces home directory.
	 *
	 * @param folders - Optional array of workspace folder creation data to include
	 *                  in the new workspace.
	 * @param remoteAuthority - Optional remote authority to associate with the workspace.
	 * @returns A promise that resolves to the identifier of the newly created workspace.
	 */
	async createUntitledWorkspace(folders?: IWorkspaceFolderCreationData[], remoteAuthority?: string): Promise<IWorkspaceIdentifier> {
		const randomId = (Date.now() + Math.round(Math.random() * 1000)).toString();
		const newUntitledWorkspacePath = joinPath(this.environmentService.untitledWorkspacesHome, `Untitled-${randomId}.${WORKSPACE_EXTENSION}`);

		// Build array of workspace folders to store
		const storedWorkspaceFolder: IStoredWorkspaceFolder[] = [];
		if (folders) {
			for (const folder of folders) {
				storedWorkspaceFolder.push(getStoredWorkspaceFolder(folder.uri, true, folder.name, this.environmentService.untitledWorkspacesHome, this.uriIdentityService.extUri));
			}
		}

		// Store at untitled workspaces location
		const storedWorkspace: IStoredWorkspace = { folders: storedWorkspaceFolder, remoteAuthority };
		await this.fileService.writeFile(newUntitledWorkspacePath, VSBuffer.fromString(JSON.stringify(storedWorkspace, null, '\t')));

		return this.getWorkspaceIdentifier(newUntitledWorkspacePath);
	}

	/**
	 * Deletes an untitled workspace file from disk.
	 *
	 * Silently ignores "file not found" errors since the workspace may have
	 * already been deleted or never existed. All other errors are re-thrown.
	 *
	 * @param workspace - The identifier of the untitled workspace to delete.
	 * @throws {FileOperationError} When the deletion fails for reasons other than
	 *         the file not being found.
	 */
	async deleteUntitledWorkspace(workspace: IWorkspaceIdentifier): Promise<void> {
		try {
			await this.fileService.del(workspace.configPath);
		} catch (error) {
			if ((<FileOperationError>error).fileOperationResult !== FileOperationResult.FILE_NOT_FOUND) {
				throw error; // re-throw any other error than file not found which is OK
			}
		}
	}

	/**
	 * Resolves a workspace configuration URI to a stable workspace identifier.
	 *
	 * @param workspaceUri - The URI of the workspace configuration file.
	 * @returns A promise that resolves to the workspace identifier.
	 */
	async getWorkspaceIdentifier(workspaceUri: URI): Promise<IWorkspaceIdentifier> {
		return getWorkspaceIdentifier(workspaceUri);
	}

	//#endregion


	//#region Dirty Workspaces

	/**
	 * Returns workspaces that have unsaved changes (dirty state).
	 *
	 * Currently returns an empty array as dirty workspace detection
	 * has not yet been implemented for the Tauri platform.
	 *
	 * @returns A promise that resolves to an empty array.
	 */
	async getDirtyWorkspaces(): Promise<Array<IWorkspaceBackupInfo | IFolderBackupInfo>> {
		return []; // TODO(Phase N): Implement dirty workspace detection for Tauri
	}

	//#endregion
}

registerSingleton(IWorkspacesService, TauriWorkspacesService, InstantiationType.Delayed);
