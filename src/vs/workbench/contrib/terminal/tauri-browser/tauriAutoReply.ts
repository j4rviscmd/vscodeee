/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TauriAutoReply — manages auto-reply patterns for terminal output.
 *
 * This TypeScript-side class installs/removes patterns via the Rust
 * `AutoReplyInterceptor`. The actual pattern matching happens in the
 * Rust reader thread for low latency.
 */

import { ITerminalLogService } from '../../../../platform/terminal/common/terminal.js';
import { tauriInvoke } from './tauriIpc.js';

/**
 * Manages auto-reply patterns for all terminal instances.
 *
 * Patterns are stored in the Rust `AutoReplyInterceptor` and applied
 * to all PTY instances automatically by the reader thread.
 */
export class TauriAutoReply {
  constructor(
    private readonly _logService: ITerminalLogService,
  ) { }

  /**
	 * Install an auto-reply pattern.
	 * When terminal output contains `matchStr`, `reply` will be sent back.
	 */
  async install(matchStr: string, reply: string): Promise<void> {
    try {
      await tauriInvoke('install_auto_reply', { matchStr, reply });
      this._logService.trace('TauriAutoReply#install', { matchStr, reply });
    } catch (e) {
      this._logService.error('TauriAutoReply#install failed', e instanceof Error ? e.message : String(e));
    }
  }

  /**
	 * Remove all auto-reply patterns.
	 */
  async uninstallAll(): Promise<void> {
    try {
      await tauriInvoke('uninstall_all_auto_replies');
      this._logService.trace('TauriAutoReply#uninstallAll');
    } catch (e) {
      this._logService.error('TauriAutoReply#uninstallAll failed', e instanceof Error ? e.message : String(e));
    }
  }
}
