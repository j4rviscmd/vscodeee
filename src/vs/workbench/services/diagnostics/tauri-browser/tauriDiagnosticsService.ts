/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri diagnostics service — no-op stub with toast notifications.
 *
 * VS Code's desktop (Electron) version provides diagnostics via the Shared Process
 * for crash dump collection and system information gathering. Since Tauri does not
 * have a Shared Process, this stub returns empty/default values and shows a toast
 * error when `reportWorkspaceStats` is called.
 *
 * **Why stub instead of NullDiagnosticsService:**
 * The base `NullDiagnosticsService` silently returns empty data. This Tauri-specific
 * version adds visibility by showing a toast when `reportWorkspaceStats` is called,
 * helping developers identify code paths that still reference Shared Process diagnostics.
 */

import { IDiagnosticsService, IMainProcessDiagnostics, IRemoteDiagnosticInfo, IRemoteDiagnosticError, PerformanceInfo, SystemInfo, IWorkspaceInformation } from '../../../../platform/diagnostics/common/diagnostics.js';
import { IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

export class TauriDiagnosticsService implements IDiagnosticsService {

	declare readonly _serviceBrand: undefined;

	async getPerformanceInfo(_mainProcessInfo: IMainProcessDiagnostics, _remoteInfo: (IRemoteDiagnosticInfo | IRemoteDiagnosticError)[]): Promise<PerformanceInfo> {
		return {};
	}

	async getSystemInfo(_mainProcessInfo: IMainProcessDiagnostics, _remoteInfo: (IRemoteDiagnosticInfo | IRemoteDiagnosticError)[]): Promise<SystemInfo> {
		return {
			processArgs: '',
			gpuStatus: '',
			screenReader: 'no',
			remoteData: [],
			os: 'Tauri',
			memory: 'n/a',
			vmHint: '',
		};
	}

	async getDiagnostics(_mainProcessInfo: IMainProcessDiagnostics, _remoteInfo: (IRemoteDiagnosticInfo | IRemoteDiagnosticError)[]): Promise<string> {
		return 'Tauri VS Codeee — diagnostics not available (Shared Process removed).';
	}

	async getWorkspaceFileExtensions(_workspace: IWorkspace): Promise<{ extensions: string[] }> {
		return { extensions: [] };
	}

	async reportWorkspaceStats(_workspace: IWorkspaceInformation): Promise<void> {
		// Shared Process diagnostics are not available in Tauri.
		// Show toast to inform developers this is not implemented.
		try {
			const { invoke } = await import('../../../../platform/tauri/common/tauriApi.js');
			await invoke('show_toast', {
				title: 'Diagnostics Unavailable',
				body: 'reportWorkspaceStats is not available: Shared Process has been removed in the Tauri migration.',
				kind: 'error',
			});
		} catch {
			// Toast not available — silent fallback
		}
	}
}

registerSingleton(IDiagnosticsService, TauriDiagnosticsService, InstantiationType.Delayed);
