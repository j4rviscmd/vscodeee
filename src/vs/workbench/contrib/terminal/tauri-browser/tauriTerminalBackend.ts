/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TauriTerminalBackend — ITerminalBackend implementation for Tauri.
 *
 * Bridges VS Code's terminal infrastructure with the Rust PTY backend
 * via Tauri IPC. Registered as a terminal backend via the
 * TerminalBackendRegistry.
 *
 * ## Architecture
 *
 * ```
 * VS Code Terminal UI (xterm.js)
 *   ↕ ITerminalBackend (TauriTerminalBackend)
 *   ↕ ITerminalChildProcess (TauriPty)
 * Tauri IPC
 *   ↕
 * Rust PTY Manager (portable-pty)
 * ```
 */

import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { OperatingSystem, type IProcessEnvironment } from '../../../../base/common/platform.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ITerminalBackend, ITerminalBackendRegistry, ITerminalChildProcess, ITerminalLogService, ITerminalProcessOptions, ITerminalProfile, ITerminalsLayoutInfo, ITerminalsLayoutInfoById, ProcessPropertyType, TerminalExtensions, TerminalIcon, TitleEventSource, type IPtyHostLatencyMeasurement, type IProcessPropertyMap, type IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { BaseTerminalBackend } from '../browser/baseTerminalBackend.js';
import { TauriPty } from './tauriPty.js';
import { TauriPtyHostController } from './tauriPtyHostController.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { IHistoryService } from '../../../services/history/common/history.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstanceService } from '../browser/terminal.js';
import { PerformanceMark } from '../../../../base/common/performance.js';

// Tauri IPC helper
function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	const w = globalThis as unknown as {
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T>;
		};
	};
	if (w.__TAURI_INTERNALS__?.invoke) {
		return w.__TAURI_INTERNALS__.invoke(cmd, args);
	}
	throw new Error('Tauri IPC not available');
}

/**
 * Registers the TauriTerminalBackend when running in a Tauri environment.
 */
export class TauriTerminalBackendContribution implements IWorkbenchContribution {
	static readonly ID = 'tauriTerminalBackend';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService
	) {
		// Only register when Tauri IPC is available
		const w = globalThis as unknown as {
			__TAURI_INTERNALS__?: unknown;
		};
		if (!w.__TAURI_INTERNALS__) {
			return;
		}

		const backend = instantiationService.createInstance(TauriTerminalBackend);
		Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
		terminalInstanceService.didRegisterBackend(backend);
	}
}

// Counter for assigning unique terminal child process IDs
let nextTerminalId = 1;

class TauriTerminalBackend extends BaseTerminalBackend implements ITerminalBackend {
	readonly remoteAuthority: string | undefined = undefined; // Local terminal — no remote authority

	private readonly _whenConnected = new DeferredPromise<void>();
	get whenReady(): Promise<void> { return this._whenConnected.p; }
	setReady(): void { this._whenConnected.complete(); }

	private readonly _onDidRequestDetach = this._register(new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>());
	readonly onDidRequestDetach = this._onDidRequestDetach.event;

	private readonly _tauriPtyHostController: TauriPtyHostController;

	constructor(
		@ITerminalLogService logService: ITerminalLogService,
		@IHistoryService historyService: IHistoryService,
		@IConfigurationResolverService configurationResolverService: IConfigurationResolverService,
		@IStatusbarService statusBarService: IStatusbarService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		const ptyHostController = new TauriPtyHostController();
		super(ptyHostController, logService, historyService, configurationResolverService, statusBarService, workspaceContextService);
		this._tauriPtyHostController = ptyHostController;

		// Signal that the backend is connected
		this._onPtyHostConnected.fire();
	}

	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		_unicodeVersion: '6' | '11',
		_env: IProcessEnvironment,
		_options: ITerminalProcessOptions,
		_shouldPersist: boolean
	): Promise<ITerminalChildProcess> {
		const id = nextTerminalId++;

		// Determine the shell executable
		let shell = shellLaunchConfig.executable;
		if (!shell) {
			shell = await this.getDefaultSystemShell();
		}

		// Determine the working directory
		const resolvedCwd = typeof shellLaunchConfig.cwd === 'string'
			? shellLaunchConfig.cwd
			: shellLaunchConfig.cwd?.fsPath ?? cwd;

		this._logService.trace('TauriTerminalBackend#createProcess', { id, shell, cwd: resolvedCwd, cols, rows });

		const pty = new TauriPty(id, shell, resolvedCwd, cols, rows, this._logService);
		return pty;
	}

	async attachToProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
		// TODO: Implement process attachment for persistence
		this._logService.trace('TauriTerminalBackend#attachToProcess (not implemented)', { id: _id });
		return undefined;
	}

	async attachToRevivedProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
		// TODO: Implement process revival for persistence
		this._logService.trace('TauriTerminalBackend#attachToRevivedProcess (not implemented)', { id: _id });
		return undefined;
	}

	async listProcesses(): Promise<IProcessDetails[]> {
		// TODO: Implement via Rust command to list running PTY instances
		return [];
	}

	async getLatency(): Promise<IPtyHostLatencyMeasurement[]> {
		// Tauri IPC latency is negligible (in-process)
		return [{ label: 'tauri-ipc', latency: 0 }];
	}

	async getDefaultSystemShell(_osOverride?: OperatingSystem): Promise<string> {
		try {
			const shell = await tauriInvoke<string>('get_default_shell');
			return shell;
		} catch {
			// Fallback: try to determine from platform
			return '/bin/zsh'; // macOS default
		}
	}

	async getProfiles(_profiles: unknown, _defaultProfile: unknown, _includeDetectedProfiles?: boolean): Promise<ITerminalProfile[]> {
		// TODO: Detect available shells via Rust
		// For now, return a basic profile based on the default shell
		try {
			const defaultShell = await this.getDefaultSystemShell();
			const shellName = defaultShell.split('/').pop() ?? 'shell';
			return [{
				profileName: shellName,
				path: defaultShell,
				isDefault: true,
			}];
		} catch {
			return [];
		}
	}

	async getWslPath(original: string, _direction: 'unix-to-win' | 'win-to-unix'): Promise<string> {
		// WSL is not applicable in Tauri
		return original;
	}

	async getEnvironment(): Promise<IProcessEnvironment> {
		try {
			return await tauriInvoke<IProcessEnvironment>('get_environment');
		} catch {
			return {};
		}
	}

	async getShellEnvironment(): Promise<IProcessEnvironment | undefined> {
		return this.getEnvironment();
	}

	async setTerminalLayoutInfo(_layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {
		// TODO: Implement layout persistence
	}

	async updateTitle(_id: number, _title: string, _titleSource: TitleEventSource): Promise<void> {
		// TODO: Implement title tracking
	}

	async updateIcon(_id: number, _userInitiated: boolean, _icon: TerminalIcon, _color?: string): Promise<void> {
		// TODO: Implement icon tracking
	}

	async setNextCommandId(_id: number, _commandLine: string, _commandId: string): Promise<void> {
		// TODO: Implement for shell integration
	}

	async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		// TODO: Implement layout restoration
		return undefined;
	}

	async getPerformanceMarks(): Promise<PerformanceMark[]> {
		return [];
	}

	async reduceConnectionGraceTime(): Promise<void> {
		// No-op — no reconnection in current implementation
	}

	async requestDetachInstance(_workspaceId: string, _instanceId: number): Promise<IProcessDetails | undefined> {
		// TODO: Implement for persistence
		return undefined;
	}

	async acceptDetachInstanceReply(_requestId: number, _persistentProcessId?: number): Promise<void> {
		// TODO: Implement for persistence
	}

	async persistTerminalState(): Promise<void> {
		// TODO: Implement terminal state persistence
	}

	async installAutoReply(_match: string, _reply: string): Promise<void> {
		// TODO: Implement auto-reply
	}

	async uninstallAllAutoReplies(): Promise<void> {
		// TODO: Implement auto-reply removal
	}

	async updateProperty<T extends ProcessPropertyType>(_id: number, _property: T, _value: IProcessPropertyMap[T]): Promise<void> {
		// TODO: Implement property updates
	}

	override dispose(): void {
		this._tauriPtyHostController.dispose();
		super.dispose();
	}
}

// Register the TauriTerminalBackendContribution as a workbench contribution
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
registerWorkbenchContribution2(TauriTerminalBackendContribution.ID, TauriTerminalBackendContribution, WorkbenchPhase.AfterRestored);
