/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TauriTerminalStateService — wraps Rust-side terminal state persistence commands.
 *
 * Provides a clean TypeScript interface for saving and loading terminal
 * buffer state and layout info via Tauri IPC to the Rust file-based store.
 */

import { ITerminalLogService } from '../../../../platform/terminal/common/terminal.js';
import { tauriInvoke } from './tauriIpc.js';

/**
 * Extracts a readable error message from an unknown thrown value.
 */
function toErrorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Service for persisting terminal state across window reloads.
 *
 * Delegates to the Rust `TerminalStateStore` via Tauri commands for
 * file-based storage in `app_data_dir/terminal/`.
 */
export class TauriTerminalStateService {
	constructor(
		private readonly _workspaceId: string,
		private readonly _logService: ITerminalLogService,
	) { }

	/**
	 * Save terminal buffer state.
	 * The data should be a JSON string in ICrossVersionSerializedTerminalState format.
	 */
	async saveBufferState(data: string): Promise<void> {
		try {
			await tauriInvoke('persist_terminal_state', {
				workspaceId: this._workspaceId,
				data,
			});
		} catch (e) {
			this._logService.error('TauriTerminalStateService#saveBufferState failed', toErrorMessage(e));
		}
	}

	/**
	 * Load terminal buffer state.
	 * Returns the JSON string or undefined if no state exists.
	 */
	async loadBufferState(): Promise<string | undefined> {
		try {
			return await tauriInvoke<string | null>('load_terminal_state', {
				workspaceId: this._workspaceId,
			}) ?? undefined;
		} catch (e) {
			this._logService.error('TauriTerminalStateService#loadBufferState failed', toErrorMessage(e));
			return undefined;
		}
	}

	/**
	 * Save terminal layout info.
	 */
	async saveLayoutInfo(data: string): Promise<void> {
		try {
			await tauriInvoke('persist_terminal_layout', {
				workspaceId: this._workspaceId,
				data,
			});
		} catch (e) {
			this._logService.error('TauriTerminalStateService#saveLayoutInfo failed', toErrorMessage(e));
		}
	}

	/**
	 * Load terminal layout info.
	 * Returns the JSON string or undefined if no state exists.
	 */
	async loadLayoutInfo(): Promise<string | undefined> {
		try {
			return await tauriInvoke<string | null>('load_terminal_layout', {
				workspaceId: this._workspaceId,
			}) ?? undefined;
		} catch (e) {
			this._logService.error('TauriTerminalStateService#loadLayoutInfo failed', toErrorMessage(e));
			return undefined;
		}
	}
}
