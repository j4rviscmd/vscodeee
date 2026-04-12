/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TauriPty — ITerminalChildProcess implementation backed by Rust PTY via Tauri IPC.
 *
 * Each TauriPty instance corresponds to a single Rust PTY instance managed by
 * PtyManager on the Rust side. Communication happens through:
 *   - invoke('create_terminal') → spawn a new PTY
 *   - invoke('write_terminal')  → send input to PTY stdin
 *   - invoke('resize_terminal') → resize PTY dimensions
 *   - invoke('close_terminal')  → close and cleanup PTY
 *   - listen('pty-output-{id}') → receive PTY stdout data
 *   - listen('pty-exit-{id}')   → receive PTY exit notification
 *
 * ## Flow Control
 *
 * Implements VS Code's flow control mechanism via acknowledgeDataEvent().
 * When unacknowledged characters exceed HighWatermarkChars, output is buffered
 * until the client catches up to LowWatermarkChars.
 */

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FlowControlConstants, ProcessPropertyType, type IProcessDataEvent, type IProcessProperty, type IProcessPropertyMap, type IProcessReadyEvent, type ITerminalChildProcess, type ITerminalLaunchError, type ITerminalLaunchResult } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalLogService } from '../../../../platform/terminal/common/terminal.js';

// Tauri IPC types
declare function __TAURI_INVOKE__(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/naming-convention
declare function __TAURI_INTERNALS__listenEvent(event: string, handler: (event: { payload: unknown }) => void): Promise<() => void>;

/**
 * Helper to call Tauri invoke. Falls back to window.__TAURI_INTERNALS__.invoke
 * which is the standard Tauri v2 WebView API.
 */
function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	// Tauri v2 exposes invoke via window.__TAURI_INTERNALS__
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
 * Helper to listen to Tauri events. Returns an unlisten function.
 */
function tauriListen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
	const w = globalThis as unknown as {
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: Record<string, unknown>) => Promise<number>;
		};
	};
	if (w.__TAURI_INTERNALS__?.invoke) {
		// Tauri v2 event listening via plugin:event
		// Use the core event system
		const eventId = w.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
			event,
			target: { kind: 'Any' },
			handler: (window as unknown as { __TAURI_INTERNALS__: { transformCallback: (cb: (event: { payload: unknown }) => void) => number } }).__TAURI_INTERNALS__.transformCallback(
				(ev: { payload: unknown }) => handler(ev.payload)
			),
		});
		return eventId.then(id => {
			return () => {
				w.__TAURI_INTERNALS__?.invoke('plugin:event|unlisten', { event, eventId: id });
			};
		});
	}
	throw new Error('Tauri event system not available');
}

export class TauriPty extends Disposable implements ITerminalChildProcess {
	// The Rust PTY id, assigned after start()
	private _ptyId: number = 0;
	id: number;
	shouldPersist: boolean = false;

	// Flow control state
	private _unacknowledgedCharCount = 0;
	private _isPaused = false;
	private _pendingData: string[] = [];

	// Event unlisten functions
	private _unlistenOutput: (() => void) | undefined;
	private _unlistenExit: (() => void) | undefined;

	// Process properties
	private readonly _properties: IProcessPropertyMap = {
		cwd: '',
		initialCwd: '',
		fixedDimensions: { cols: undefined, rows: undefined },
		title: '',
		shellType: undefined,
		hasChildProcesses: true,
		resolvedShellLaunchConfig: {},
		overrideDimensions: undefined,
		failedShellIntegrationActivation: false,
		usedShellIntegrationInjection: undefined,
		shellIntegrationInjectionFailureReason: undefined,
	};

	// Dimensions tracking
	private _lastDimensions: { cols: number; rows: number } = { cols: -1, rows: -1 };

	// Events
	private readonly _onProcessData = this._register(new Emitter<IProcessDataEvent | string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;
	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	readonly onProcessExit = this._onProcessExit.event;

	constructor(
		id: number,
		private readonly _shell: string,
		private readonly _cwd: string,
		private readonly _cols: number,
		private readonly _rows: number,
		private readonly _logService: ITerminalLogService,
	) {
		super();
		this.id = id;
		this._properties.initialCwd = _cwd;
		this._properties.cwd = _cwd;
		this._lastDimensions = { cols: _cols, rows: _rows };
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		try {
			this._logService.trace('TauriPty#start', { id: this.id, shell: this._shell, cwd: this._cwd });

			// Spawn the PTY via Rust
			this._ptyId = await tauriInvoke<number>('create_terminal', {
				shell: this._shell,
				cwd: this._cwd,
				cols: this._cols,
				rows: this._rows,
			});

			this._logService.trace('TauriPty#start result', { id: this.id, ptyId: this._ptyId });

			// Listen for output data from the Rust PTY
			this._unlistenOutput = await tauriListen(`pty-output-${this._ptyId}`, (payload: unknown) => {
				// Payload is Vec<u8> from Rust, arrives as number[] in JS
				const data = payload instanceof Uint8Array
					? new TextDecoder().decode(payload)
					: typeof payload === 'string'
						? payload
						: Array.isArray(payload)
							? new TextDecoder().decode(new Uint8Array(payload as number[]))
							: String(payload);

				this._handleOutput(data);
			});

			// Listen for exit event
			this._unlistenExit = await tauriListen(`pty-exit-${this._ptyId}`, (payload: unknown) => {
				const exitData = payload as { id: number; exitCode: number } | undefined;
				const exitCode = exitData?.exitCode ?? undefined;
				this._logService.trace('TauriPty#exit', { id: this.id, ptyId: this._ptyId, exitCode });
				this._onProcessExit.fire(exitCode);
			});

			// Fire process ready event
			// TODO: Get actual PID from Rust if needed
			this._onProcessReady.fire({
				pid: this._ptyId, // Use pty ID as pseudo-PID
				cwd: this._cwd,
				requiresWindowsMode: false,
			});

			return undefined; // Success
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this._logService.error('TauriPty#start failed', message);
			return { message };
		}
	}

	/**
	 * Handle output data with flow control.
	 */
	private _handleOutput(data: string): void {
		if (this._isPaused) {
			this._pendingData.push(data);
			return;
		}

		this._unacknowledgedCharCount += data.length;
		this._onProcessData.fire(data);

		// Check if we need to pause
		if (this._unacknowledgedCharCount > FlowControlConstants.HighWatermarkChars) {
			this._isPaused = true;
			this._logService.trace('TauriPty#flowControl paused', {
				id: this.id,
				unacknowledgedChars: this._unacknowledgedCharCount,
			});
		}
	}

	acknowledgeDataEvent(charCount: number): void {
		this._unacknowledgedCharCount = Math.max(this._unacknowledgedCharCount - charCount, 0);

		// Resume if we've dropped below the low watermark
		if (this._isPaused && this._unacknowledgedCharCount < FlowControlConstants.LowWatermarkChars) {
			this._isPaused = false;
			this._logService.trace('TauriPty#flowControl resumed', {
				id: this.id,
				unacknowledgedChars: this._unacknowledgedCharCount,
			});

			// Flush any buffered data
			const pending = this._pendingData.splice(0);
			for (const data of pending) {
				this._handleOutput(data);
			}
		}
	}

	input(data: string): void {
		if (this._ptyId === 0) {
			return; // Not started yet
		}
		tauriInvoke('write_terminal', { id: this._ptyId, data }).catch(err => {
			this._logService.error('TauriPty#input failed', err instanceof Error ? err.message : String(err));
		});
	}

	resize(cols: number, rows: number): void {
		if (this._ptyId === 0) {
			return; // Not started yet
		}
		if (this._lastDimensions.cols === cols && this._lastDimensions.rows === rows) {
			return; // No change
		}
		this._lastDimensions = { cols, rows };
		tauriInvoke('resize_terminal', { id: this._ptyId, cols, rows }).catch(err => {
			this._logService.error('TauriPty#resize failed', err instanceof Error ? err.message : String(err));
		});
	}

	shutdown(immediate: boolean): void {
		if (this._ptyId === 0) {
			return;
		}
		this._logService.trace('TauriPty#shutdown', { id: this.id, ptyId: this._ptyId, immediate });
		tauriInvoke('close_terminal', { id: this._ptyId }).catch(err => {
			this._logService.error('TauriPty#shutdown failed', err instanceof Error ? err.message : String(err));
		});
	}

	sendSignal(_signal: string): void {
		// TODO: Implement signal sending via Rust
		// For now, this is a no-op. Signals would require a new Tauri command.
		this._logService.trace('TauriPty#sendSignal (not implemented)', { signal: _signal });
	}

	async processBinary(_data: string): Promise<void> {
		// Binary data processing — not typically used in basic scenarios
	}

	async clearBuffer(): Promise<void> {
		// TODO: Could be implemented by sending clear escape sequence
	}

	async setUnicodeVersion(_version: '6' | '11'): Promise<void> {
		// No-op — unicode version handling is done client-side by xterm.js
	}

	async getInitialCwd(): Promise<string> {
		return this._properties.initialCwd;
	}

	async getCwd(): Promise<string> {
		return this._properties.cwd || this._properties.initialCwd;
	}

	async refreshProperty<T extends ProcessPropertyType>(_property: T): Promise<IProcessPropertyMap[T]> {
		return this._properties[_property];
	}

	async updateProperty<T extends ProcessPropertyType>(property: T, value: IProcessPropertyMap[T]): Promise<void> {
		(this._properties as Record<string, unknown>)[property] = value;
		this._onDidChangeProperty.fire({ type: property, value });
	}

	override dispose(): void {
		// Unlisten from Tauri events
		this._unlistenOutput?.();
		this._unlistenExit?.();

		// Close the PTY if still running
		if (this._ptyId !== 0) {
			tauriInvoke('close_terminal', { id: this._ptyId }).catch(() => { /* ignore errors during dispose */ });
			this._ptyId = 0;
		}

		super.dispose();
	}
}
