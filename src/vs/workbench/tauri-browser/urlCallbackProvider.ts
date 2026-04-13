/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * URL callback provider for Tauri — listens for deep-link URLs forwarded
 * from the Rust backend via the `deep-link-open` Tauri event and converts
 * them into VS Code URI handler callbacks.
 *
 * This bridges the Tauri deep-link plugin with VS Code's `IURLService`,
 * enabling OAuth callback flows (e.g., `vscodeee://vscode.github-authentication/did-authenticate?code=xxx`).
 */

import { Emitter, Event } from '../../base/common/event.js';
import { URI, UriComponents } from '../../base/common/uri.js';
import { IURLCallbackProvider } from '../services/url/browser/urlService.js';

/**
 * Function type for listening to Tauri events.
 * Abstracted to allow dependency injection for testing.
 */
export type TauriListenFn = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

export class TauriURLCallbackProvider implements IURLCallbackProvider {

	private readonly _onCallback = new Emitter<URI>();
	readonly onCallback: Event<URI> = this._onCallback.event;

	constructor(
		private readonly urlProtocol: string,
		private readonly listenFn: TauriListenFn
	) { }

	/**
	 * Start listening for `deep-link-open` events from the Tauri backend.
	 * Returns a dispose function to stop listening.
	 */
	async startListening(): Promise<{ dispose(): void }> {
		const unlisten = await this.listenFn<string>('deep-link-open', (event) => {
			try {
				const uri = URI.parse(event.payload);
				this._onCallback.fire(uri);
			} catch (err) {
				console.error('[TauriURLCallbackProvider] Failed to parse deep-link URL:', event.payload, err);
			}
		});
		return { dispose: unlisten };
	}

	create(options?: Partial<UriComponents>): URI {
		// Build a URI with the product's custom scheme (vscodeee://).
		// This is used by extensions to generate callback URLs.
		let { authority, path, query, fragment } = options ?? {};
		if (authority && path && path.indexOf('/') !== 0) {
			path = `/${path}`;
		}
		return URI.from({ scheme: this.urlProtocol, authority, path, query, fragment });
	}

	dispose(): void {
		this._onCallback.dispose();
	}
}
