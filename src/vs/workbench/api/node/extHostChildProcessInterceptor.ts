/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import nodeModule from 'node:module';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IExtHostChildProcessRegistry, IChildProcessInfo } from '../common/extHostChildProcessRegistry.js';

const nodeRequire = nodeModule.createRequire(import.meta.url);

/**
 * Intercepts `child_process.fork()` calls made by extensions to:
 *
 * 1. Inject `--no-experimental-require-module` into child process `execArgv`.
 *    In the Tauri migration, the Extension Host sidecar runs with this flag,
 *    but `vscode-languageclient` explicitly sets `execArgv: []` when forking
 *    Language Server child processes (line 406 of main.js). Without this flag,
 *    Node.js 22+ enables `require(esm)` by default, which uses `Atomics.wait()`
 *    and can cause deadlocks or crashes in child processes.
 *
 * 2. Capture stderr from child processes and route to ILogService for debugging.
 *    Language Server crashes are otherwise silent because the VS Code Output Channel
 *    forwarding may not work in the Tauri dev environment.
 *
 * 3. Track child process lifecycle (spawn/exit) for monitoring and diagnostics.
 *
 * TODO(Phase 5-D): Consider extending to also intercept `child_process.spawn()`
 * for Language Servers that use `TransportKind.stdio` with a custom runtime.
 */
export class ExtHostChildProcessInterceptor extends Disposable implements IExtHostChildProcessRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly _activeProcesses = new Map<number, IChildProcessInfo>();
	private readonly _onDidSpawnProcess = new Emitter<IChildProcessInfo>();
	private readonly _onDidExitProcess = new Emitter<{ info: IChildProcessInfo; code: number | null; signal: string | null }>();

	readonly activeProcesses: ReadonlyMap<number, IChildProcessInfo> = this._activeProcesses;
	readonly onDidSpawnProcess: Event<IChildProcessInfo> = this._onDidSpawnProcess.event;
	readonly onDidExitProcess: Event<{ info: IChildProcessInfo; code: number | null; signal: string | null }> = this._onDidExitProcess.event;

	private _installed = false;

	/**
	 * @param _logService - Logger used for trace/warn/error messages related
	 *   to child process lifecycle events.
	 */
	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Install the child_process.fork() interceptor. Must be called before
	 * extensions are activated (in _beforeAlmostReadyToRunExtensions).
	 */
	install(): void {
		if (this._installed) {
			return;
		}
		this._installed = true;

		const childProcessModule = nodeRequire('child_process') as typeof cp;

		// cp.fork is overloaded: fork(path, opts?) and fork(path, args?, opts?).
		// We normalize the arguments before passing to the original.
		type ForkSignature = (modulePath: string | URL, args?: readonly string[], options?: cp.ForkOptions) => cp.ChildProcess;
		const originalFork = childProcessModule.fork;
		const interceptor = this;

		(childProcessModule.fork as ForkSignature) = function fork(modulePath: string | URL, args?: readonly string[], options?: cp.ForkOptions): cp.ChildProcess {
			const forkArgs = args ?? [];
			const modifiedOptions: cp.ForkOptions = { ...options };

			// Ensure execArgv includes --no-experimental-require-module.
			// vscode-languageclient explicitly sets execArgv: [], which means
			// the parent's --no-experimental-require-module is NOT inherited.
			// In Node.js 22+, require(esm) is enabled by default and uses
			// Atomics.wait() which can deadlock or crash child processes.
			const execArgv = modifiedOptions.execArgv ? [...modifiedOptions.execArgv] : [];
			if (!execArgv.includes('--no-experimental-require-module')) {
				execArgv.push('--no-experimental-require-module');
			}
			modifiedOptions.execArgv = execArgv;

			const child = (originalFork as ForkSignature)(modulePath, forkArgs, modifiedOptions);
			interceptor._trackChild(child, String(modulePath), forkArgs);
			return child;
		};

		this._store.add(toDisposable(() => {
			(childProcessModule.fork as ForkSignature) = originalFork as ForkSignature;
		}));

		this._logService.trace('[ExtHostChildProcess] Interceptor installed');
	}

	/**
	 * Registers a child process for lifecycle tracking.
	 *
	 * Creates an {@link IChildProcessInfo} record, adds it to
	 * {@link activeProcesses}, and attaches `stderr`, `exit`, and `error`
	 * listeners that log through {@link ILogService}.
	 *
	 * Handles the async nature of `child.pid` assignment: if the PID is
	 * already available (synchronous spawn), the process is registered
	 * immediately; otherwise registration is deferred to the `'spawn'` event.
	 *
	 * @param child - The `ChildProcess` returned by `cp.fork()`.
	 * @param modulePath - The module path string used to spawn the process.
	 * @param args - Command-line arguments forwarded to the child process.
	 */
	private _trackChild(child: cp.ChildProcess, modulePath: string, args: readonly string[]): void {
		// pid may be undefined if spawn fails synchronously; wait for 'spawn' event
		const register = (pid: number) => {
			const info: IChildProcessInfo = {
				pid,
				module: modulePath,
				args: [...args],
				spawnTime: Date.now(),
				exitCode: null,
				exitSignal: null,
			};
			this._activeProcesses.set(pid, info);
			this._onDidSpawnProcess.fire(info);
			this._logService.trace(`[ExtHostChildProcess] Spawned pid=${pid} module=${modulePath}`);

			// Capture stderr for debugging Language Server crashes.
			// In Tauri dev mode, the VS Code Output Channel forwarding may not
			// surface these errors, so we log them directly via ILogService.
			if (child.stderr) {
				child.stderr.on('data', (chunk: Buffer) => {
					const text = chunk.toString().trimEnd();
					if (text) {
						this._logService.warn(`[ExtHostChildProcess] stderr pid=${pid}: ${text}`);
					}
				});
			}

			child.on('exit', (code, signal) => {
				info.exitCode = code;
				info.exitSignal = signal;
				this._activeProcesses.delete(pid);
				this._onDidExitProcess.fire({ info, code, signal });
				if (code !== 0 && code !== null) {
					this._logService.warn(`[ExtHostChildProcess] Exited pid=${pid} code=${code} signal=${signal}`);
				} else {
					this._logService.trace(`[ExtHostChildProcess] Exited pid=${pid} code=${code} signal=${signal}`);
				}
			});

			child.on('error', (err) => {
				this._logService.error(`[ExtHostChildProcess] Error pid=${pid}: ${err.message}`);
			});
		};

		if (child.pid !== undefined) {
			register(child.pid);
		} else {
			child.on('spawn', () => {
				if (child.pid !== undefined) {
					register(child.pid);
				}
			});
		}
	}

	/** Disposes the emitter instances and the base {@link Disposable} store (restores original `cp.fork`). */
	override dispose(): void {
		super.dispose();
		this._onDidSpawnProcess.dispose();
		this._onDidExitProcess.dispose();
	}
}
