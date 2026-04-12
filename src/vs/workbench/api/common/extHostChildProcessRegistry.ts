/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../base/common/event.js';

/**
 * Service identifier for the child process registry.
 *
 * Provides lifecycle tracking and event emission for child processes
 * spawned by extensions via `child_process.fork()`. Used by the
 * {@link ExtHostChildProcessInterceptor} implementation.
 */
export const IExtHostChildProcessRegistry = createDecorator<IExtHostChildProcessRegistry>('IExtHostChildProcessRegistry');

/**
 * Snapshot of metadata for a child process spawned by an extension via
 * `child_process.fork()`. Returned by {@link IExtHostChildProcessRegistry}
 * events and stored in the active process map.
 */
export interface IChildProcessInfo {
	/** Operating system process identifier assigned at spawn time. */
	readonly pid: number;
	/** Module path (or URL string) that was passed to `cp.fork()`. */
	readonly module: string;
	/** Command-line arguments forwarded to the child process. */
	readonly args: readonly string[];
	/** Unix timestamp (ms) when the process was spawned. */
	readonly spawnTime: number;
	/** Exit code of the process, or `null` if it has not exited or was terminated by a signal. */
	exitCode: number | null;
	/** Signal that terminated the process (e.g. `'SIGTERM'`), or `null` if it exited normally. */
	exitSignal: string | null;
}

/**
 * Registry that tracks child processes spawned by extensions and provides
 * lifecycle events for debugging and monitoring.
 *
 * In the Tauri migration, this is critical because the Extension Host sidecar
 * runs with `--no-experimental-require-module` but child processes (Language Servers)
 * spawned via `cp.fork()` do NOT inherit this flag unless explicitly injected.
 */
export interface IExtHostChildProcessRegistry {
	readonly _serviceBrand: undefined;

	/** Currently active (running) child processes, keyed by PID. Entries are removed on exit. */
	readonly activeProcesses: ReadonlyMap<number, IChildProcessInfo>;

	/** Fired immediately after a child process is successfully spawned. */
	readonly onDidSpawnProcess: Event<IChildProcessInfo>;

	/** Fired when a child process exits, regardless of exit code. */
	readonly onDidExitProcess: Event<{ info: IChildProcessInfo; code: number | null; signal: string | null }>;
}
