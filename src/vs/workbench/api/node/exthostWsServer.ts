/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ISocket, SocketCloseEvent, SocketCloseEventType, SocketDiagnostics, SocketDiagnosticsEventType } from '../../../base/parts/ipc/common/ipc.net.js';

/**
 * Minimal interface for Bun's `ServerWebSocket` — only the methods
 * we actually use. Declared locally to avoid `@typescript-eslint/no-explicit-any`.
 */
interface IBunServerWebSocket {
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(code?: number, reason?: string): void;
	_vscode_onData?: (data: Uint8Array) => void;
	_vscode_onClose?: (code: number, reason: string) => void;
}

/** Minimal interface for Bun's `Server` in the `websocket` handlers. */
interface IBunWebSocketServer {
	stop(): void;
	upgrade(req: Request): void;
	readonly port: number;
}

/**
 * ISocket implementation that wraps a Bun ServerWebSocket for the
 * Extension Host direct WebSocket connection.
 *
 * Bun's ServerWebSocket differs from browser WebSocket — the `message`
 * callback is set at `Bun.serve()` time, not via addEventListener.
 * This class bridges that by storing the data listener registered by
 * PersistentProtocol's `onData()` call.
 */
export class BunWsSocket implements ISocket {

	private readonly _ws: IBunServerWebSocket;
	public readonly debugLabel: string;
	private _dataListener: ((data: VSBuffer) => void) | null = null;
	private _closeListener: ((e: SocketCloseEvent) => void) | null = null;

	constructor(ws: IBunServerWebSocket, debugLabel: string) {
		this._ws = ws;
		this.debugLabel = debugLabel;
		// Wire message handler — delegates to whatever onData registers
		this._ws._vscode_onData = (data: Uint8Array) => {
			if (this._dataListener) {
				this._dataListener(VSBuffer.wrap(data));
			}
		};
		this._ws._vscode_onClose = (code: number, reason: string) => {
			if (this._closeListener) {
				this._closeListener({
					type: SocketCloseEventType.WebSocketCloseEvent,
					code,
					reason,
					wasClean: code !== 1006,
					event: undefined,
				});
			}
		};
	}

	public dispose(): void {
		try { this._ws.close(); } catch { /* already closed */ }
	}

	public onData(listener: (e: VSBuffer) => void): IDisposable {
		this._dataListener = listener;
		return toDisposable(() => { this._dataListener = null; });
	}

	public onClose(listener: (e: SocketCloseEvent) => void): IDisposable {
		this._closeListener = listener;
		return toDisposable(() => { this._closeListener = null; });
	}

	public onEnd(_listener: () => void): IDisposable {
		// WebSocket close covers end semantics
		return { dispose() { } };
	}

	public write(buffer: VSBuffer): void {
		this._ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
	}

	public end(): void {
		try { this._ws.close(); } catch { /* already closed */ }
	}

	public drain(): Promise<void> {
		return Promise.resolve();
	}

	public traceSocketEvent(type: SocketDiagnosticsEventType, data?: VSBuffer | Uint8Array | ArrayBuffer | ArrayBufferView | unknown): void {
		SocketDiagnostics.traceSocketEvent(this._ws, this.debugLabel, type, data);
	}
}

/**
 * Check if the Extension Host should start in WebSocket server mode.
 * When `VSCODEEE_EXTHOST_WS_PORT` is set (by the Rust sidecar), the
 * ExtHost starts a Bun.serve() WS server instead of connecting to an IPC pipe.
 */
export function isWsServerMode(): boolean {
	return typeof process.env.VSCODEEE_EXTHOST_WS_PORT === 'string'
		&& process.env.VSCODEEE_EXTHOST_WS_PORT!.length > 0;
}

/**
 * Start a Bun WebSocket server for direct Extension Host IPC.
 *
 * Binds to `127.0.0.1:0` (OS-assigned port), writes the port to stdout
 * as `EXTHOST_WS_PORT:<port>` for the Rust parent to read, and returns
 * a Promise that resolves with an ISocket when the WebView connects.
 */
export function startWsServer(): Promise<ISocket> {
	return new Promise<ISocket>((resolve, reject) => {
		const timeout = setTimeout(() => {
			server.stop();
			reject(new Error('Timeout waiting for WebView WebSocket connection (60s)'));
		}, 60 * 1000);

		// @ts-expect-error — Bun global
		const server: IBunWebSocketServer = Bun.serve({
			hostname: '127.0.1',
			port: 0,
			fetch(req: Request, srv: IBunWebSocketServer) {
				if (req.headers.get('upgrade') !== 'websocket') {
					return new Response(null, { status: 503 });
				}
				srv.upgrade(req);
				return undefined;
			},
			websocket: {
				open(ws: IBunServerWebSocket) {
					clearTimeout(timeout);
					const socket = new BunWsSocket(ws, 'exthost-ws-server');
					resolve(socket);
				},
				message(ws: IBunServerWebSocket, message: Uint8Array) {
					// Delegate to the BunWsSocket data listener
					if (message instanceof Uint8Array) {
						if (ws._vscode_onData) {
							ws._vscode_onData(message);
						}
					}
				},
				close(ws: IBunServerWebSocket, code: number, reason: string) {
					if (ws._vscode_onClose) {
						ws._vscode_onClose(code, reason);
					}
				},
			},
		});

		// Report port to stdout so Rust can read it
		const port = server.port;
		process.stdout.write(`EXTHOST_WS_PORT:${port}\n`);
	});
}
