/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isLinux } from '../../../../base/common/platform.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { newWriteableStream, ReadableStreamEvents } from '../../../../base/common/stream.js';
import {
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileType,
  createFileSystemProviderError,
  IFileDeleteOptions,
  IFileOverwriteOptions,
  IFileSystemProviderWithFileReadWriteCapability,
  IFileSystemProviderWithOpenReadWriteCloseCapability,
  IFileSystemProviderWithFileReadStreamCapability,
  IFileSystemProviderWithFileFolderCopyCapability,
  IFileSystemProviderWithFileAtomicReadCapability,
  IFileSystemProviderWithFileAtomicWriteCapability,
  IFileSystemProviderWithFileAtomicDeleteCapability,
  IFileWriteOptions,
  IFileReadStreamOptions,
  IFileOpenOptions,
  IStat,
  IFileChange,
  isFileOpenForWriteOptions,
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
 * Tracks an open file handle for the open/read/write/close API.
 *
 * For Phase 2A the entire file content is buffered in-memory on `open()` and
 * flushed back on `close()` when opened for writing. This is sufficient for
 * settings, profiles, and other small user-data files. A streaming approach
 * via chunked Rust commands should be added in a future phase.
 */
interface OpenFileHandle {
  readonly resource: URI;
  readonly isWrite: boolean;
  readonly isAppend: boolean;
  data: Uint8Array;
  pos: number;
  dirty: boolean;
}

/**
 * File system provider that delegates to Rust Tauri commands for real disk I/O.
 *
 * Extends `AbstractDiskFileSystemProvider` with `forceUniversal: true` to route
 * all watch requests through a single universal watcher backed by the Rust
 * `notify` crate.
 *
 * Implements `IFileSystemProviderWithFileReadWriteCapability` (whole-file read/write),
 * `IFileSystemProviderWithOpenReadWriteCloseCapability` (fd-based read/write),
 * `IFileSystemProviderWithFileReadStreamCapability` (streaming read),
 * `IFileSystemProviderWithFileFolderCopyCapability` (native copy),
 * and atomic read/write/delete capabilities.
 *
 * File content is transferred as base64 strings over `invoke()`. This is
 * acceptable for Phase 2A (settings, source files). For large binary files,
 * a streaming/chunked approach will be added in a future phase.
 */
export class TauriDiskFileSystemProvider extends AbstractDiskFileSystemProvider implements
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithOpenReadWriteCloseCapability,
	IFileSystemProviderWithFileReadStreamCapability,
	IFileSystemProviderWithFileFolderCopyCapability,
	IFileSystemProviderWithFileAtomicReadCapability,
	IFileSystemProviderWithFileAtomicWriteCapability,
	IFileSystemProviderWithFileAtomicDeleteCapability {

  private readonly _onDidChangeCapabilities = this._register(new Emitter<void>());
  readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event;

  // TODO(Phase 3): Replace in-memory fd map with Rust-side fd management for
  // better large-file support and reduced IPC overhead.
  private nextFd = 1;
  private readonly openFiles = new Map<number, OpenFileHandle>();

  constructor(logService: ILogService) {
    super(logService, { watcher: { forceUniversal: true } });
  }

  get capabilities(): FileSystemProviderCapabilities {
    let caps =
			FileSystemProviderCapabilities.FileReadWrite |
			FileSystemProviderCapabilities.FileOpenReadWriteClose |
			FileSystemProviderCapabilities.FileReadStream |
			FileSystemProviderCapabilities.FileFolderCopy |
			FileSystemProviderCapabilities.Trash |
			FileSystemProviderCapabilities.FileAppend |
			FileSystemProviderCapabilities.FileAtomicRead |
			FileSystemProviderCapabilities.FileAtomicWrite |
			FileSystemProviderCapabilities.FileAtomicDelete;
    if (isLinux) {
      caps |= FileSystemProviderCapabilities.PathCaseSensitive;
    }
    return caps;
  }

  // --- watcher factory methods ---

  protected createUniversalWatcher(
    onChange: (changes: IFileChange[]) => void,
    onLogMessage: (msg: ILogMessage) => void,
    verboseLogging: boolean,
  ): AbstractUniversalWatcherClient {
    return new TauriUniversalWatcherClient(onChange, onLogMessage, verboseLogging);
  }

  protected createNonRecursiveWatcher(
    _onChange: (changes: IFileChange[]) => void,
    _onLogMessage: (msg: ILogMessage) => void,
    _verboseLogging: boolean,
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

  // --- open / read / write / close (fd-based) ---

  /**
	 * Opens a file and returns a file descriptor (fd). The entire file content is
	 * loaded into memory. For write mode, changes are flushed on `close()`.
	 */
  async open(resource: URI, opts: IFileOpenOptions): Promise<number> {
    const isWrite = isFileOpenForWriteOptions(opts);
    const isAppend = isWrite && (opts.append ?? false);

    let data: Uint8Array;
    if (isWrite && !isAppend) {
      // Write (truncate): start with empty buffer
      data = new Uint8Array(0);
    } else {
      try {
        data = await this.readFile(resource);
      } catch {
        if (isWrite) {
          // File does not exist yet; create with empty buffer
          data = new Uint8Array(0);
        } else {
          throw createFileSystemProviderError(
            `File not found: ${resource.fsPath}`,
            FileSystemProviderErrorCode.FileNotFound,
          );
        }
      }
    }

    const fd = this.nextFd++;
    this.openFiles.set(fd, {
      resource,
      isWrite,
      isAppend,
      data,
      pos: isAppend ? data.length : 0,
      dirty: false,
    });
    return fd;
  }

  /**
	 * Reads bytes from an open file descriptor into the provided buffer.
	 */
  async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
    const handle = this.openFiles.get(fd);
    if (!handle) {
      throw createFileSystemProviderError(
        `Invalid file descriptor: ${fd}`,
        FileSystemProviderErrorCode.Unavailable,
      );
    }

    const available = handle.data.length - pos;
    if (available <= 0) {
      return 0;
    }

    const bytesToRead = Math.min(length, available);
    data.set(handle.data.subarray(pos, pos + bytesToRead), offset);
    return bytesToRead;
  }

  /**
	 * Writes bytes from the provided buffer into the open file descriptor.
	 */
  async write(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
    const handle = this.openFiles.get(fd);
    if (!handle) {
      throw createFileSystemProviderError(
        `Invalid file descriptor: ${fd}`,
        FileSystemProviderErrorCode.Unavailable,
      );
    }

    const chunk = data.subarray(offset, offset + length);

    if (handle.isAppend) {
      // Append: always add to end
      const newData = new Uint8Array(handle.data.length + chunk.length);
      newData.set(handle.data);
      newData.set(chunk, handle.data.length);
      handle.data = newData;
    } else {
      // Random write: ensure buffer is large enough
      const requiredLength = pos + chunk.length;
      if (requiredLength > handle.data.length) {
        const newData = new Uint8Array(requiredLength);
        newData.set(handle.data);
        handle.data = newData;
      }
      handle.data.set(chunk, pos);
    }

    handle.dirty = true;
    return chunk.length;
  }

  /**
	 * Closes the file descriptor. Always flushes write-mode handles to
	 * ensure the file content on disk matches the handle buffer, including
	 * empty content (file truncation).
	 */
  async close(fd: number): Promise<void> {
    const handle = this.openFiles.get(fd);
    if (!handle) {
      throw createFileSystemProviderError(
        `Invalid file descriptor: ${fd}`,
        FileSystemProviderErrorCode.Unavailable,
      );
    }

    try {
      if (handle.isWrite) {
        await this.writeFile(handle.resource, handle.data, {
          create: true,
          overwrite: true,
          unlock: false,
          atomic: false,
        });
      }
    } finally {
      this.openFiles.delete(fd);
    }
  }

  // --- readFileStream ---

  /**
	 * Creates a readable stream from the file content. Reads the entire file
	 * and pushes it as a single chunk (or sliced by position/length options).
	 *
	 * TODO(Phase 3): Implement Rust-side chunked streaming for large files.
	 */
  readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
    const stream = newWriteableStream<Uint8Array>(data => {
      // Reducer: concatenate Uint8Array chunks
      const totalLength = data.reduce((sum, chunk) => sum + chunk.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of data) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    });

    // Read asynchronously and push to stream
    (async () => {
      try {
        if (token.isCancellationRequested) {
          stream.end();
          return;
        }

        const data = await this.readFile(resource);
        if (token.isCancellationRequested) {
          stream.end();
          return;
        }

        // Apply position and length options
        const start = opts.position ?? 0;
        const end = opts.length !== undefined ? start + opts.length : data.length;
        const slice = data.subarray(start, Math.min(end, data.length));

        stream.write(slice);
        stream.end();
      } catch (err) {
        stream.error(this.toFileSystemProviderError(err));
        stream.end();
      }
    })();

    return stream;
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
