/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ISocket, SocketCloseEvent, SocketCloseEventType, SocketDiagnostics, SocketDiagnosticsEventType } from '../../../../base/parts/ipc/common/ipc.net.js';

/**
 * An ISocket implementation that wraps a browser WebSocket connected to the
 * Tauri Rust WS relay. The relay forwards bytes transparently between this
 * WebSocket and the Extension Host Node.js process via a Unix pipe.
 *
 * Pattern follows BrowserSocket in browserSocketFactory.ts.
 */
export class TauriExtHostSocket implements ISocket {

	private readonly _socket: WebSocket;
	public readonly debugLabel: string;

	constructor(socket: WebSocket, debugLabel: string) {
		this._socket = socket;
		this.debugLabel = debugLabel;
	}

	public dispose(): void {
		this._socket.close();
	}

	/**
	 * Register a listener for incoming binary data from the WebSocket.
	 * Only `ArrayBuffer` messages are forwarded; text frames are ignored.
	 */
	public onData(listener: (e: VSBuffer) => void): IDisposable {
		let msgCount = 0;
		let lastTime = Date.now();
		const handler = (event: MessageEvent) => {
			if (event.data instanceof ArrayBuffer) {
				msgCount++;
				const bytes = new Uint8Array(event.data);
				const now = Date.now();
				const gap = now - lastTime;
				lastTime = now;
				if (msgCount <= 50 || msgCount % 100 === 0) {
					console.log(`[TauriExtHostSocket] onData #${msgCount}: ${bytes.byteLength} bytes, gap=${gap}ms, first4=[${Array.from(bytes.slice(0, 4)).join(',')}]`);
				}
				listener(VSBuffer.wrap(bytes));
			}
		};
		this._socket.addEventListener('message', handler);
		return toDisposable(() => this._socket.removeEventListener('message', handler));
	}

	/**
	 * Register a listener for the WebSocket close event, mapping it
	 * to a {@link SocketCloseEvent} with the appropriate close code and reason.
	 */
	public onClose(listener: (e: SocketCloseEvent) => void): IDisposable {
		const handler = (event: CloseEvent) => {
			console.warn(`[TauriExtHostSocket] WebSocket CLOSED: code=${event.code}, reason="${event.reason}", wasClean=${event.wasClean}`);
			listener({
				type: SocketCloseEventType.WebSocketCloseEvent,
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
				event: event
			});
		};
		this._socket.addEventListener('close', handler);
		return toDisposable(() => this._socket.removeEventListener('close', handler));
	}

	/**
	 * No-op: WebSocket does not have a separate 'end' event — the close
	 * event covers both half-close and full-close semantics.
	 */
	public onEnd(_listener: () => void): IDisposable {
		// WebSocket doesn't have a separate 'end' event — close covers it
		return { dispose() { } };
	}

	/**
	 * Send binary data over the WebSocket to the Rust WS relay.
	 */
	public write(buffer: VSBuffer): void {
		console.log(`[TauriExtHostSocket] write: ${buffer.byteLength} bytes, first4=[${Array.from(buffer.slice(0, 4).buffer).join(',')}]`);
		this._socket.send(buffer.buffer as Uint8Array<ArrayBuffer>);
	}

	public end(): void {
		this._socket.close();
	}

	/**
	 * Immediately resolves since WebSocket has built-in buffering.
	 */
	public drain(): Promise<void> {
		return Promise.resolve();
	}

	public traceSocketEvent(type: SocketDiagnosticsEventType, data?: VSBuffer | Uint8Array | ArrayBuffer | ArrayBufferView | any): void {
		SocketDiagnostics.traceSocketEvent(this._socket, this.debugLabel, type, data);
	}
}

/**
 * Creates a connected TauriExtHostSocket by opening a WebSocket to the
 * Rust WS relay at `ws://127.0.0.1:{port}`.
 */
export function connectToExtHostRelay(port: number): Promise<TauriExtHostSocket> {
	return new Promise<TauriExtHostSocket>((resolve, reject) => {
		const url = `ws://127.0.0.1:${port}`;
		const ws = new WebSocket(url);
		ws.binaryType = 'arraybuffer';

		const onOpen = () => {
			cleanup();
			resolve(new TauriExtHostSocket(ws, `exthost-relay:${port}`));
		};

		const onError = (e: Event) => {
			cleanup();
			ws.close();
			reject(new Error(`Failed to connect to ExtHost WS relay at ${url}`));
		};

		const cleanup = () => {
			ws.removeEventListener('open', onOpen);
			ws.removeEventListener('error', onError);
		};

		ws.addEventListener('open', onOpen);
		ws.addEventListener('error', onError);
	});
}
