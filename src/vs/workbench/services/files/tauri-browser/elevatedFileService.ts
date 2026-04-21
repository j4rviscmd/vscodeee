/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer, VSBufferReadable, VSBufferReadableStream } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStatWithMetadata, IWriteFileOptions } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IElevatedFileService } from '../common/elevatedFileService.js';

/**
 * Tauri implementation of {@link IElevatedFileService}.
 *
 * Writes files that require elevated (admin/root) privileges by first saving
 * the content to a temporary location under the current user-profile cache
 * directory, then instructing the Rust backend to move the temp file to the
 * target path with elevated permissions.
 *
 * Only `file`-scheme resources are supported.
 */
export class TauriElevatedFileService implements IElevatedFileService {

  declare readonly _serviceBrand: undefined;

  /**
	 * @param nativeHostService - Tauri native host for invoking the elevated write command.
	 * @param fileService - Standard file service used for temp-file I/O.
	 * @param userDataProfileService - Provides the cache directory used for temp files.
	 * @param logService - Logger for tracing elevated write operations.
	 */
  constructor(
    @INativeHostService private readonly nativeHostService: INativeHostService,
    @IFileService private readonly fileService: IFileService,
    @IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
    @ILogService private readonly logService: ILogService,
  ) { }

  /** @inheritDoc IElevatedFileService.isSupported */
  isSupported(resource: URI): boolean {
    return resource.scheme === Schemas.file;
  }

  /**
	 * Writes `value` to `resource` with elevated privileges.
	 *
	 * The implementation uses a two-phase strategy:
	 * 1. Writes the content to a temporary file under the user-profile cache home.
	 * 2. Delegates to the Rust backend ({@link INativeHostService.writeElevated})
	 *    to move the temp file to the final destination with admin rights.
	 *
	 * The temporary file is cleaned up in a `finally` block (best-effort).
	 * After the move, the target file's metadata is resolved and returned.
	 *
	 * @inheritDoc IElevatedFileService.writeFileElevated
	 */
  async writeFileElevated(resource: URI, value: VSBuffer | VSBufferReadable | VSBufferReadableStream, options?: IWriteFileOptions): Promise<IFileStatWithMetadata> {
    this.logService.trace('TauriElevatedFileService#writeFileElevated', resource.fsPath);

    // Write to a temp location first via the normal file service
    const tempPath = URI.joinPath(this.userDataProfileService.currentProfile.cacheHome, `elevated-${Date.now()}.tmp`);
    await this.fileService.writeFile(tempPath, value);

    try {
      // Move to target with elevated privileges via Rust backend
      await this.nativeHostService.writeElevated(tempPath, resource, { unlock: options?.unlock });
    } finally {
      // Clean up temp file
      try {
        await this.fileService.del(tempPath);
      } catch {
        // best effort
      }
    }

    return await this.fileService.resolve(resource, { resolveMetadata: true }) as IFileStatWithMetadata;
  }
}

registerSingleton(IElevatedFileService, TauriElevatedFileService, InstantiationType.Delayed);
