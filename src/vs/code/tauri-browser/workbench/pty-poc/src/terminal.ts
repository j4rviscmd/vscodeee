/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0-4 PTY Host PoC — xterm.js ↔ Tauri PTY bridge.
 *
 * This module creates an xterm.js terminal and connects it to the Rust
 * PTY backend via Tauri's invoke/event system.
 *
 * Data flow:
 *   xterm.onData → invoke('write_terminal') → Rust → PTY stdin
 *   PTY stdout → Rust reader thread → emit('pty-output-{id}') → xterm.write()
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// CSS is bundled by esbuild
import '@xterm/xterm/css/xterm.css';

// Tauri API is available globally via withGlobalTauri in tauri.conf.json
declare const window: Window & {
	__TAURI__: {
		core: {
			invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
		};
		event: {
			listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
		};
	};
};

interface PtyTerminal {
	id: number;
	terminal: Terminal;
	fitAddon: FitAddon;
	unlisten: (() => void)[];
}

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const terminals: Map<number, PtyTerminal> = new Map();

/**
 * Create a new terminal instance and attach it to a DOM container.
 */
async function createTerminal(container: HTMLElement): Promise<PtyTerminal> {
	const terminal = new Terminal({
		cursorBlink: true,
		fontSize: 14,
		fontFamily: "Menlo, Monaco, 'Courier New', monospace",
		theme: {
			background: '#1e1e1e',
			foreground: '#d4d4d4',
			cursor: '#aeafad',
			selectionBackground: '#264f78',
		},
		convertEol: true,
		scrollback: 5000,
	});

	const fitAddon = new FitAddon();
	terminal.loadAddon(fitAddon);
	terminal.open(container);
	fitAddon.fit();

	// Detect shell — use SHELL env var or default to /bin/zsh on macOS
	const hostInfo = await invoke('get_native_host_info') as { homeDir: string; platform: string };
	const shell = hostInfo.platform === 'macos' ? '/bin/zsh' : '/bin/bash';
	const cwd = hostInfo.homeDir || '/tmp';

	// Spawn PTY
	const id = await invoke('create_terminal', {
		shell,
		cwd,
		cols: terminal.cols,
		rows: terminal.rows,
	}) as number;

	// Listen for PTY output
	const unlistenOutput = await listen(`pty-output-${id}`, (event) => {
		// Data comes as Vec<u8> from Rust, which Tauri serializes as number[]
		const data = event.payload as number[];
		const bytes = new Uint8Array(data);
		terminal.write(bytes);
	});

	// Listen for PTY exit
	const unlistenExit = await listen(`pty-exit-${id}`, (event) => {
		const payload = event.payload as { id: number; exitCode: number };
		terminal.write(`\r\n\x1b[90m[Process exited with code ${payload.exitCode}]\x1b[0m\r\n`);
	});

	// Connect terminal input → PTY
	terminal.onData((data) => {
		invoke('write_terminal', { id, data }).catch((e: Error) => {
			console.error(`[pty:${id}] write error:`, e);
		});
	});

	// Handle resize
	terminal.onResize(({ cols, rows }) => {
		invoke('resize_terminal', { id, cols, rows }).catch((e: Error) => {
			console.error(`[pty:${id}] resize error:`, e);
		});
	});

	// Handle window resize
	const onWindowResize = () => fitAddon.fit();
	window.addEventListener('resize', onWindowResize);

	const ptyTerminal: PtyTerminal = {
		id,
		terminal,
		fitAddon,
		unlisten: [
			unlistenOutput,
			unlistenExit,
			() => window.removeEventListener('resize', onWindowResize),
		],
	};

	terminals.set(id, ptyTerminal);
	return ptyTerminal;
}

/**
 * Close a terminal instance and clean up resources.
 */
async function closeTerminal(ptyTerminal: PtyTerminal): Promise<void> {
	for (const unlisten of ptyTerminal.unlisten) {
		unlisten();
	}
	terminals.delete(ptyTerminal.id);
	ptyTerminal.terminal.dispose();
	await invoke('close_terminal', { id: ptyTerminal.id });
}

// Export to global scope for index.html to use
(window as unknown as Record<string, unknown>).PtyPoc = {
	createTerminal,
	closeTerminal,
	terminals,
};
