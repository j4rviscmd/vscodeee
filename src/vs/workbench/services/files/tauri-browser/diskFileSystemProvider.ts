/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isLinux } from '../../../../base/common/platform.js';
import {
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	createFileSystemProviderError,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithFileFolderCopyCapability,
	IFileWriteOptions,
	IStat,
	IFileChange,
} from '../../../../platform/files/common/files.js';
import { AbstractDiskFileSystemProvider } from '../../../../platform/files/common/diskFileSystemProvider.js';
import { AbstractNonRecursiveWatcherClient, AbstractUniversalWatcherClient, ILogMessage } from '../../../../platform/files/common/watcher.js';
import { TauriUniversalWatcherClient } from './watcherClient.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { invoke } from '../../../../platform/tauri/common/tauriApi.js';
import { Emitter, Event } from '../../../../base/common/event.js';

interface RustStatResult {
	readonly type: number;
	readonly mtime: number;
	readonly ctime: number;
	readonly size: number;
	readonly permissions: number | null;
}

interface RustDirEntry {
	readonly name: string;
	readonly type: number;
}

/**
 * File system provider that delegates to Rust Tauri commands for real disk I/O.
 *
 * Extends `AbstractDiskFileSystemProvider` with `forceUniversal: true` to route
 * all watch requests through a single universal watcher backed by the Rust
 * `notify` crate.
 *
 * Implements `IFileSystemProviderWithFileReadWriteCapability` (whole-file read/write)
 * and `IFileSystemProviderWithFileFolderCopyCapability` (native copy).
 *
 * File content is transferred as base64 strings over `invoke()`. This is
 * acceptable for Phase 2A (settings, source files). For large binary files,
 * a streaming/chunked approach will be added in a future phase.
 */
export class TauriDiskFileSystemProvider extends AbstractDiskFileSystemProvider implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithFileFolderCopyCapability {

	private readonly _onDidChangeCapabilities = this._register(new Emitter<void>());
	readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event;

	constructor(logService: ILogService) {
		super(logService, { watcher: { forceUniversal: true } });
	}

	get capabilities(): FileSystemProviderCapabilities {
		let caps =
			FileSystemProviderCapabilities.FileReadWrite |
			FileSystemProviderCapabilities.FileFolderCopy |
			FileSystemProviderCapabilities.Trash |
			FileSystemProviderCapabilities.FileAppend;
		if (isLinux) {
			caps |= FileSystemProviderCapabilities.PathCaseSensitive;
		}
		return caps;
	}

	// --- watcher factory methods ---

	protected createUniversalWatcher(
		onChange: (changes: IFileChange[]) => void,
		onLogMessage: (msg: ILogMessage) => void,
		verboseLogging: boolean
	): AbstractUniversalWatcherClient {
		return new TauriUniversalWatcherClient(onChange, onLogMessage, verboseLogging);
	}

	protected createNonRecursiveWatcher(
		_onChange: (changes: IFileChange[]) => void,
		_onLogMessage: (msg: ILogMessage) => void,
		_verboseLogging: boolean
	): AbstractNonRecursiveWatcherClient {
		// forceUniversal is true, so this method should never be called.
		// All watches are routed through the universal watcher.
		throw new Error('Non-recursive watcher is not used when forceUniversal is true');
	}

	// --- stat ---

	async stat(resource: URI): Promise<IStat> {
		const result = await this.invokeFs<RustStatResult>('fs_stat', { path: resource.fsPath });
		return {
			type: result.type,
			mtime: result.mtime,
			ctime: result.ctime,
			size: result.size,
			permissions: result.permissions ?? undefined,
		};
	}

	// --- readdir ---

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const entries = await this.invokeFs<RustDirEntry[]>('fs_read_dir', { path: resource.fsPath });
		return entries.map(e => [e.name, e.type]);
	}

	// --- readFile ---

	async readFile(resource: URI): Promise<Uint8Array> {
		const base64 = await this.invokeFs<string>('fs_read_file', { path: resource.fsPath });
		return this.base64ToUint8Array(base64);
	}

	// --- writeFile ---

	async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		const base64 = this.uint8ArrayToBase64(content);
		await this.invokeFs<void>('fs_write_file', {
			path: resource.fsPath,
			content: base64,
			create: opts.create,
			overwrite: opts.overwrite,
			append: opts.append ?? false,
		});
	}

	// --- mkdir ---

	async mkdir(resource: URI): Promise<void> {
		await this.invokeFs<void>('fs_mkdir', { path: resource.fsPath, recursive: true });
	}

	// --- delete ---

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		if (opts.useTrash) {
			await invoke<void>('move_item_to_trash', { path: resource.fsPath });
		} else {
			await this.invokeFs<void>('fs_delete', {
				path: resource.fsPath,
				recursive: opts.recursive,
			});
		}
	}

	// --- rename ---

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		await this.invokeFs<void>('fs_rename', {
			from: from.fsPath,
			to: to.fsPath,
			overwrite: opts.overwrite,
		});
	}

	// --- copy ---

	async copy(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		await this.invokeFs<void>('fs_copy', {
			from: from.fsPath,
			to: to.fsPath,
			overwrite: opts.overwrite,
		});
	}

	// --- helpers ---

	/**
	 * Invoke a Rust filesystem command, mapping Rust error strings to
	 * `FileSystemProviderError` instances.
	 */
	private async invokeFs<T>(command: string, args: Record<string, unknown>): Promise<T> {
		try {
			return await invoke<T>(command, args);
		} catch (err) {
			throw this.toFileSystemProviderError(err);
		}
	}

	private toFileSystemProviderError(err: unknown): Error {
		const message = String(err);
		const code = this.parseErrorCode(message);
		return createFileSystemProviderError(message, code);
	}

	private parseErrorCode(message: string): FileSystemProviderErrorCode {
		if (message.includes('EntryNotFound')) {
			return FileSystemProviderErrorCode.FileNotFound;
		}
		if (message.includes('EntryExists')) {
			return FileSystemProviderErrorCode.FileExists;
		}
		if (message.includes('EntryNotADirectory')) {
			return FileSystemProviderErrorCode.FileNotADirectory;
		}
		if (message.includes('EntryIsADirectory')) {
			return FileSystemProviderErrorCode.FileIsADirectory;
		}
		if (message.includes('NoPermissions')) {
			return FileSystemProviderErrorCode.NoPermissions;
		}
		return FileSystemProviderErrorCode.Unknown;
	}

	private base64ToUint8Array(base64: string): Uint8Array {
		const binaryString = atob(base64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	}

	private uint8ArrayToBase64(bytes: Uint8Array): string {
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}
}
