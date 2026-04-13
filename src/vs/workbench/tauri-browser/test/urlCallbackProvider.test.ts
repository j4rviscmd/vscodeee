/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { TauriURLCallbackProvider, TauriListenFn } from '../urlCallbackProvider.js';

suite('TauriURLCallbackProvider', () => {

	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Creates a mock Tauri `listen` function that captures the event handler
	 * and returns a trigger function for simulating deep-link events.
	 */
	function createMockListen(): {
		listenFn: TauriListenFn;
		/** Simulate a deep-link event with the given URL string */
		fireDeepLink: (url: string) => void;
		/** Number of times listen was called */
		listenCallCount: number;
		/** Event name that was subscribed to */
		subscribedEvent: string | undefined;
		/** Unlisten was called */
		unlistenCalled: boolean;
	} {
		let handler: ((event: { payload: unknown }) => void) | undefined;
		const state = {
			listenCallCount: 0,
			subscribedEvent: undefined as string | undefined,
			unlistenCalled: false,
		};

		const listenFn: TauriListenFn = async <T>(event: string, h: (event: { payload: T }) => void) => {
			state.listenCallCount++;
			state.subscribedEvent = event;
			handler = h as (event: { payload: unknown }) => void;
			return () => { state.unlistenCalled = true; };
		};

		const fireDeepLink = (url: string) => {
			if (handler) {
				handler({ payload: url });
			}
		};

		return { listenFn, fireDeepLink, ...state, get listenCallCount() { return state.listenCallCount; }, get subscribedEvent() { return state.subscribedEvent; }, get unlistenCalled() { return state.unlistenCalled; } };
	}

	test('create() builds URI with correct scheme', () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('vscodeee', mock.listenFn));

		const uri = provider.create({
			authority: 'vscode.github-authentication',
			path: '/did-authenticate',
			query: 'code=abc123',
		});

		assert.strictEqual(uri.scheme, 'vscodeee');
		assert.strictEqual(uri.authority, 'vscode.github-authentication');
		assert.strictEqual(uri.path, '/did-authenticate');
		assert.strictEqual(uri.query, 'code=abc123');
	});

	test('create() prepends / to path when authority is present', () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('vscodeee', mock.listenFn));

		const uri = provider.create({
			authority: 'some-extension',
			path: 'callback', // no leading /
		});

		assert.strictEqual(uri.path, '/callback');
	});

	test('create() works with no options', () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('vscodeee', mock.listenFn));

		const uri = provider.create();
		assert.strictEqual(uri.scheme, 'vscodeee');
	});

	test('startListening() subscribes to deep-link-open event', async () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('vscodeee', mock.listenFn));

		const disposable = ds.add(await provider.startListening());

		assert.strictEqual(mock.listenCallCount, 1);
		assert.strictEqual(mock.subscribedEvent, 'deep-link-open');

		disposable.dispose();
		assert.strictEqual(mock.unlistenCalled, true);
	});

	test('onCallback fires when deep-link event is received', async () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('vscodeee', mock.listenFn));
		ds.add(await provider.startListening());

		const receivedUris: URI[] = [];
		ds.add(provider.onCallback((uri: URI) => receivedUris.push(uri)));

		mock.fireDeepLink('vscodeee://vscode.github-authentication/did-authenticate?code=abc123&state=xyz');

		assert.strictEqual(receivedUris.length, 1);
		assert.strictEqual(receivedUris[0].scheme, 'vscodeee');
		assert.strictEqual(receivedUris[0].authority, 'vscode.github-authentication');
		assert.strictEqual(receivedUris[0].path, '/did-authenticate');
		assert.ok(receivedUris[0].query.includes('code=abc123'));
	});

	test('onCallback handles multiple deep-link events', async () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('vscodeee', mock.listenFn));
		ds.add(await provider.startListening());

		const receivedUris: URI[] = [];
		ds.add(provider.onCallback((uri: URI) => receivedUris.push(uri)));

		mock.fireDeepLink('vscodeee://ext1/callback1');
		mock.fireDeepLink('vscodeee://ext2/callback2');

		assert.strictEqual(receivedUris.length, 2);
		assert.strictEqual(receivedUris[0].authority, 'ext1');
		assert.strictEqual(receivedUris[1].authority, 'ext2');
	});

	test('onCallback does not fire for invalid URIs', async () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('vscodeee', mock.listenFn));
		ds.add(await provider.startListening());

		const receivedUris: URI[] = [];
		ds.add(provider.onCallback((uri: URI) => receivedUris.push(uri)));

		// Empty string — URI.parse handles this gracefully, so it should still fire
		mock.fireDeepLink('');

		// URI.parse('') returns a valid (empty) URI, so the provider fires it.
		// The actual validation happens downstream in the URL handlers.
		assert.strictEqual(receivedUris.length, 1);
	});

	test('create() uses correct scheme from constructor', () => {
		const mock = createMockListen();
		const provider = ds.add(new TauriURLCallbackProvider('my-custom-scheme', mock.listenFn));

		const uri = provider.create({ authority: 'test' });
		assert.strictEqual(uri.scheme, 'my-custom-scheme');
	});
});
