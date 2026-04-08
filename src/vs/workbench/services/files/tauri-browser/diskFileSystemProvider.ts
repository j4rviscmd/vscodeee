/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { isLinux } from '../../../../base/common/platform.js';
import {
	FileChangeType,
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	createFileSystemProviderError,
	IFileChange,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithFileFolderCopyCapability,
	IFileWriteOptions,
	IStat,
	IWatchOptions,
} from '../../../../platform/files/common/files.js';
import { invoke } from '../../../../platform/tauri/common/tauriApi.js';

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
 * Implements `IFileSystemProviderWithFileReadWriteCapability` (whole-file read/write)
 * and `IFileSystemProviderWithFileFolderCopyCapability` (native copy).
 *
 * File content is transferred as base64 strings over `invoke()`. This is
 * acceptable for Phase 2A (settings, source files). For large binary files,
 * a streaming/chunked approach will be added in Phase 2B.
 */
export class TauriDiskFileSystemProvider extends Disposable implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithFileFolderCopyCapability {

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event;

	private readonly _onDidChangeCapabilities = this._register(new Emitter<void>());
	readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event;

	get capabilities(): FileSystemProviderCapabilities {
		let caps =
			FileSystemProviderCapabilities.FileReadWrite |
			FileSystemProviderCapabilities.FileFolderCopy;
		if (isLinux) {
			caps |= FileSystemProviderCapabilities.PathCaseSensitive;
		}
		return caps;
	}

	// --- watch (no-op for Phase 2A; Phase 2B adds Rust `notify` crate) ---

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None;
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
		});

		this._onDidChangeFile.fire([{
			resource,
			type: FileChangeType.UPDATED,
		}]);
	}

	// --- mkdir ---

	async mkdir(resource: URI): Promise<void> {
		await this.invokeFs<void>('fs_mkdir', { path: resource.fsPath, recursive: true });

		this._onDidChangeFile.fire([{
			resource,
			type: FileChangeType.ADDED,
		}]);
	}

	// --- delete ---

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		await this.invokeFs<void>('fs_delete', {
			path: resource.fsPath,
			recursive: opts.recursive,
		});

		this._onDidChangeFile.fire([{
			resource,
			type: FileChangeType.DELETED,
		}]);
	}

	// --- rename ---

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		await this.invokeFs<void>('fs_rename', {
			from: from.fsPath,
			to: to.fsPath,
			overwrite: opts.overwrite,
		});

		this._onDidChangeFile.fire([
			{ resource: from, type: FileChangeType.DELETED },
			{ resource: to, type: FileChangeType.ADDED },
		]);
	}

	// --- copy ---

	async copy(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		await this.invokeFs<void>('fs_copy', {
			from: from.fsPath,
			to: to.fsPath,
			overwrite: opts.overwrite,
		});

		this._onDidChangeFile.fire([{
			resource: to,
			type: FileChangeType.ADDED,
		}]);
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
