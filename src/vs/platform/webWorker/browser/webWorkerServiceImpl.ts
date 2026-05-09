/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createTrustedTypesPolicy } from '../../../base/browser/trustedTypes.js';
import { coalesce } from '../../../base/common/arrays.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { COI } from '../../../base/common/network.js';
import { IWebWorker, IWebWorkerClient, Message, WebWorkerClient } from '../../../base/common/worker/webWorker.js';
import { getNLSLanguage, getNLSMessages } from '../../../nls.js';
import { WebWorkerDescriptor } from './webWorkerDescriptor.js';
import { IWebWorkerService } from './webWorkerService.js';

/**
 * Default implementation of {@link IWebWorkerService} that creates Web Workers
 * with NLS injection, Trusted Types policy, and Cross-Origin Isolation (COI) support.
 *
 * Each worker is bootstrapped via a `Blob` URL that injects `_VSCODE_NLS_MESSAGES`,
 * `_VSCODE_NLS_LANGUAGE`, `_VSCODE_FILE_ROOT`, `_VSCODE_FILE_SERVER_URL`, and
 * `__TAURI_INTERNALS__` globals before dynamically importing the actual worker script.
 * This ensures workers have access to the same configuration as the main thread.
 */
export class WebWorkerService implements IWebWorkerService {
	private static _workerIdPool: number = 0;
	declare readonly _serviceBrand: undefined;

	/**
	 * Create a new web worker client wrapping the given worker descriptor.
	 *
	 * If the descriptor is already a `Worker` instance or a promise resolving to one,
	 * it is used directly. Otherwise, a new worker is created via `_createWorker`.
	 *
	 * @typeParam T - The shape of the worker's public API.
	 * @param workerDescriptor - A `WebWorkerDescriptor`, an existing `Worker`, or a promise of one.
	 * @returns A `WebWorkerClient` that proxies calls to the worker.
	 */
	createWorkerClient<T extends object>(workerDescriptor: WebWorkerDescriptor | Worker | Promise<Worker>): IWebWorkerClient<T> {
		let worker: Worker | Promise<Worker>;
		const id = ++WebWorkerService._workerIdPool;
		if (workerDescriptor instanceof Worker || isPromiseLike<Worker>(workerDescriptor)) {
			worker = Promise.resolve(workerDescriptor);
		} else {
			worker = this._createWorker(workerDescriptor);
		}

		return new WebWorkerClient<T>(new WebWorker(worker, id));
	}

	/**
	 * Create a new Web Worker from a descriptor.
	 *
	 * Resolves the worker script URL, wraps it in a bootstrap `Blob` that injects
	 * NLS and Tauri globals, and waits for the worker to signal readiness via
	 * a `vscode-worker-ready` postMessage.
	 *
	 * @param descriptor - The descriptor containing the worker module location.
	 * @returns A promise resolving to the created `Worker` once it is ready.
	 */
	protected _createWorker(descriptor: WebWorkerDescriptor): Promise<Worker> {
		const workerRunnerUrl = this.getWorkerUrl(descriptor);

		const workerUrlWithNls = getWorkerBootstrapUrl(descriptor.label, workerRunnerUrl, this._getWorkerLoadingFailedErrorMessage(descriptor));
		const worker = new Worker(ttPolicy ? ttPolicy.createScriptURL(workerUrlWithNls) as unknown as string : workerUrlWithNls, { name: descriptor.label, type: 'module' });
		return whenESMWorkerReady(worker);
	}

	/**
	 * Returns an optional error message to display when a worker fails to load.
	 *
	 * Subclasses can override this to provide context-specific error messages.
	 * The default implementation returns `undefined` (no custom message).
	 */
	protected _getWorkerLoadingFailedErrorMessage(_descriptor: WebWorkerDescriptor): string | undefined {
		return undefined;
	}

	/**
	 * Resolve the browser URL for a worker descriptor's ESM module location.
	 *
	 * @param descriptor - The descriptor containing the ESM module location (URL string, URI, or function).
	 * @returns The fully resolved URL string for the worker module.
	 * @throws If `esmModuleLocation` is not set on the descriptor.
	 */
	getWorkerUrl(descriptor: WebWorkerDescriptor): string {
		if (!descriptor.esmModuleLocation) {
			throw new Error('Missing esmModuleLocation in WebWorkerDescriptor');
		}
		const uri = typeof descriptor.esmModuleLocation === 'function' ? descriptor.esmModuleLocation() : descriptor.esmModuleLocation;
		const urlStr = uri.toString(true);
		return urlStr;
	}
}

const ttPolicy = ((): ReturnType<typeof createTrustedTypesPolicy> => {
	type WorkerGlobalWithPolicy = typeof globalThis & {
		workerttPolicy?: ReturnType<typeof createTrustedTypesPolicy>;
	};

	// Reuse the trusted types policy defined from worker bootstrap
	// when available.
	// Refs https://github.com/microsoft/vscode/issues/222193
	const workerGlobalThis = globalThis as WorkerGlobalWithPolicy;
	if (typeof self === 'object' && self.constructor && self.constructor.name === 'DedicatedWorkerGlobalScope' && workerGlobalThis.workerttPolicy !== undefined) {
		return workerGlobalThis.workerttPolicy;
	} else {
		return createTrustedTypesPolicy('defaultWorkerFactory', { createScriptURL: value => value });
	}
})();

/**
 * Create a Web Worker from a Blob URL.
 *
 * Validates that the URL is a `blob:` scheme and applies the Trusted Types
 * policy if available.
 *
 * @param blobUrl - The Blob URL to load as a worker script.
 * @param options - Optional `WorkerOptions` passed to the `Worker` constructor.
 * @returns A new `Worker` instance.
 * @throws {URIError} If the provided URL is not a Blob URL.
 */
export function createBlobWorker(blobUrl: string, options?: WorkerOptions): Worker {
	if (!blobUrl.startsWith('blob:')) {
		throw new URIError('Not a blob-url: ' + blobUrl);
	}
	return new Worker(ttPolicy ? ttPolicy.createScriptURL(blobUrl) as unknown as string : blobUrl, { ...options, type: 'module' });
}

/**
 * Build a bootstrap Blob URL for a Web Worker.
 *
 * Creates a `Blob` script that:
 * 1. Injects NLS messages and language into `globalThis`.
 * 2. Sets `_VSCODE_FILE_ROOT` for `vscode-file://` URI resolution.
 * 3. Propagates `__TAURI_INTERNALS__` for Tauri platform detection.
 * 4. Propagates `_VSCODE_FILE_SERVER_URL` for Windows WebView2 compatibility.
 * 5. Creates a Trusted Types policy for the worker context.
 * 6. Dynamically imports the actual worker script.
 * 7. Posts a `vscode-worker-ready` message to signal completion.
 *
 * Cross-origin worker scripts are loaded as-is without COI parameter injection.
 *
 * @param label - A descriptive label for the worker (used in comments and error messages).
 * @param workerScriptUrl - The URL of the worker script to import.
 * @param workerLoadingFailedErrorMessage - Optional error message to show on import failure.
 * @returns A Blob URL string for the bootstrap script.
 */
function getWorkerBootstrapUrl(label: string, workerScriptUrl: string, workerLoadingFailedErrorMessage: string | undefined): string {
	if (/^((http:)|(https:)|(file:))/.test(workerScriptUrl) && workerScriptUrl.substring(0, globalThis.origin.length) !== globalThis.origin) {
		// this is the cross-origin case
		// i.e. the webpage is running at a different origin than where the scripts are loaded from
	} else {
		const start = workerScriptUrl.lastIndexOf('?');
		const end = workerScriptUrl.lastIndexOf('#', start);
		const params = start > 0
			? new URLSearchParams(workerScriptUrl.substring(start + 1, ~end ? end : undefined))
			: new URLSearchParams();

		COI.addSearchParam(params, true, true);
		const search = params.toString();
		if (!search) {
			workerScriptUrl = `${workerScriptUrl}#${label}`;
		} else {
			workerScriptUrl = `${workerScriptUrl}?${params.toString()}#${label}`;
		}
	}

	// In below blob code, we are using JSON.stringify to ensure the passed
	// in values are not breaking our script. The values may contain string
	// terminating characters (such as ' or ").
	const blob = new Blob([coalesce([
		`/*${label}*/`,
		`globalThis._VSCODE_NLS_MESSAGES = ${JSON.stringify(getNLSMessages())};`,
		`globalThis._VSCODE_NLS_LANGUAGE = ${JSON.stringify(getNLSLanguage())};`,
		`globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(globalThis._VSCODE_FILE_ROOT)};`,
		// Propagate __TAURI_INTERNALS__ marker to the worker so that
		// platform.isTauri is correctly detected. This enables
		// FileAccess.uriToBrowserUri() to convert file:// URIs to
		// vscode-file:// which is required by Tauri's CSP.
		typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
			? `globalThis.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__ || {};`
			: '',
		// On Windows, WebView2 blocks fetch()/import() for custom URI schemes.
		// Propagate the file server URL so workers can route requests through HTTP.
		typeof (globalThis as Record<string, unknown>)._VSCODE_FILE_SERVER_URL === 'string'
			? `globalThis._VSCODE_FILE_SERVER_URL = ${JSON.stringify((globalThis as Record<string, unknown>)._VSCODE_FILE_SERVER_URL)};`
			: '',
		`const ttPolicy = globalThis.trustedTypes?.createPolicy('defaultWorkerFactory', { createScriptURL: value => value });`,
		`globalThis.workerttPolicy = ttPolicy;`,

		workerLoadingFailedErrorMessage ? 'try {' : '',
		`await import(ttPolicy?.createScriptURL(${JSON.stringify(workerScriptUrl)}) ?? ${JSON.stringify(workerScriptUrl)});`,
		workerLoadingFailedErrorMessage ? `} catch (err) { console.error(${JSON.stringify(workerLoadingFailedErrorMessage)}, err); throw err; }` : '',

		`globalThis.postMessage({ type: 'vscode-worker-ready' });`,
		`/*${label}*/`
	]).join('')], { type: 'application/javascript' });
	return URL.createObjectURL(blob);
}

/**
 * Wait for a Web Worker to signal that it has finished loading.
 *
 * Listens for a single `vscode-worker-ready` message from the worker,
 * then resolves with the worker instance. Rejects on worker error.
 *
 * @param worker - The Web Worker to wait for.
 * @returns A promise resolving to the same `Worker` once it is ready.
 */
function whenESMWorkerReady(worker: Worker): Promise<Worker> {
	return new Promise<Worker>((resolve, reject) => {
		worker.onmessage = function (e) {
			if (e.data.type === 'vscode-worker-ready') {
				worker.onmessage = null;
				resolve(worker);
			}
		};
		worker.onerror = reject;
	});
}

/**
 * Type guard that checks whether a value implements the `PromiseLike` interface.
 *
 * @typeParam T - The type the promise resolves to.
 * @param obj - The value to check.
 * @returns `true` if the value has a callable `then` method.
 */
function isPromiseLike<T>(obj: unknown): obj is PromiseLike<T> {
	return !!obj && typeof (obj as PromiseLike<T>).then === 'function';
}

/**
 * Wrapper around a Web Worker that implements the {@link IWebWorker} interface.
 *
 * Provides typed message passing via `onMessage` / `postMessage` and automatic
 * cleanup on disposal (terminates the worker and removes all event listeners).
 */
export class WebWorker extends Disposable implements IWebWorker {
	private readonly id: number;
	private worker: Promise<Worker> | null;

	private readonly _onMessage = this._register(new Emitter<Message>());
	public readonly onMessage = this._onMessage.event;

	private readonly _onError = this._register(new Emitter<MessageEvent | ErrorEvent>());
	public readonly onError = this._onError.event;

	/**
	 * @param worker - A promise resolving to the underlying `Worker` instance.
	 * @param id - Unique numeric identifier for this worker.
	 */
	constructor(worker: Promise<Worker>, id: number) {
		super();
		this.id = id;
		this.worker = worker;
		this.postMessage('-please-ignore-', []); // TODO: Eliminate this extra message
		const errorHandler = (ev: ErrorEvent) => {
			this._onError.fire(ev);
		};
		this.worker.then((w) => {
			w.onmessage = (ev) => {
				this._onMessage.fire(ev.data);
			};
			w.onmessageerror = (ev) => {
				this._onError.fire(ev);
			};
			if (typeof w.addEventListener === 'function') {
				w.addEventListener('error', errorHandler);
			}
		});
		this._register(toDisposable(() => {
			this.worker?.then(w => {
				w.onmessage = null;
				w.onmessageerror = null;
				w.removeEventListener('error', errorHandler);
				w.terminate();
			});
			this.worker = null;
		}));
	}

	/** Returns the unique numeric identifier for this worker. */
	public getId(): number {
		return this.id;
	}

	/**
	 * Send a message to the worker, optionally transferring ownership of `Transferable` objects.
	 *
	 * @param message - The data to send.
	 * @param transfer - An array of `Transferable` objects (e.g., `ArrayBuffer`, `MessagePort`) to transfer.
	 */
	public postMessage(message: unknown, transfer: Transferable[]): void {
		this.worker?.then(w => {
			try {
				w.postMessage(message, transfer);
			} catch (err) {
				onUnexpectedError(err);
				onUnexpectedError(new Error(`FAILED to post message to worker`, { cause: err }));
			}
		});
	}
}
