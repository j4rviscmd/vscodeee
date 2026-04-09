/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IEntryPoint } from './lib/bundle.ts';

/**
 * Creates an entry point descriptor for a module by name.
 *
 * @param name - The module name (e.g. `'vs/editor/common/services/editorWebWorkerMain'`).
 * @returns An `IEntryPoint` object with the given name.
 */
function createModuleDescription(name: string): IEntryPoint {
	return {
		name
	};
}

/** Entry point for the editor web worker. */
export const workerEditor = createModuleDescription('vs/editor/common/services/editorWebWorkerMain');
/** Entry point for the extension host worker. */
export const workerExtensionHost = createModuleDescription('vs/workbench/api/worker/extensionHostWorkerMain');
/** Entry point for the notebook web worker. */
export const workerNotebook = createModuleDescription('vs/workbench/contrib/notebook/common/services/notebookWebWorkerMain');
/** Entry point for the language detection web worker. */
export const workerLanguageDetection = createModuleDescription('vs/workbench/services/languageDetection/browser/languageDetectionWebWorkerMain');
/** Entry point for the local file search worker. */
export const workerLocalFileSearch = createModuleDescription('vs/workbench/services/search/worker/localFileSearchMain');
/** Entry point for the output link computer worker. */
export const workerOutputLinks = createModuleDescription('vs/workbench/contrib/output/common/outputLinkComputerMain');
/** Entry point for the background tokenization worker. */
export const workerBackgroundTokenization = createModuleDescription('vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain');

/**
 * Desktop workbench entry points including debug telemetry, file watcher,
 * terminal pty host, agent host, extension host process, and desktop main modules.
 */
export const workbenchDesktop = [
	createModuleDescription('vs/workbench/contrib/debug/node/telemetryApp'),
	createModuleDescription('vs/platform/files/node/watcher/watcherMain'),
	createModuleDescription('vs/platform/terminal/node/ptyHostMain'),
	createModuleDescription('vs/platform/agentHost/node/agentHostMain'),
	createModuleDescription('vs/workbench/api/node/extensionHostProcess'),
	createModuleDescription('vs/workbench/workbench.desktop.main'),
	createModuleDescription('vs/sessions/sessions.desktop.main')
];

/** Entry point for the web workbench. */
export const workbenchWeb = createModuleDescription('vs/workbench/workbench.web.main.internal');

/**
 * Keyboard layout contribution entry points for Linux, macOS, and Windows.
 */
export const keyboardMaps = [
	createModuleDescription('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.linux'),
	createModuleDescription('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.darwin'),
	createModuleDescription('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.win')
];

/**
 * Desktop CLI entry point for the main process.
 */
export const code = [
	// 'vs/code/electron-main/main' is not included here because it comes in via ./src/main.js
	// 'vs/code/node/cli' is not included here because it comes in via ./src/cli.js
	createModuleDescription('vs/code/node/cliProcessMain'),
];

/** Entry point for the web-based code workbench. */
export const codeWeb = createModuleDescription('vs/code/browser/workbench/workbench');

/**
 * Server entry points including extension host, file watcher,
 * terminal pty host, and agent host.
 */
export const codeServer = [
	// 'vs/server/node/server.main' is not included here because it gets inlined via ./src/server-main.js
	// 'vs/server/node/server.cli' is not included here because it gets inlined via ./src/server-cli.js
	createModuleDescription('vs/workbench/api/node/extensionHostProcess'),
	createModuleDescription('vs/platform/files/node/watcher/watcherMain'),
	createModuleDescription('vs/platform/terminal/node/ptyHostMain'),
	createModuleDescription('vs/platform/agentHost/node/agentHostMain')
];

/**
 * Factory function to create an entry point descriptor. Exported for
 * use by external build scripts that need to define additional entry points.
 */
export const entrypoint = createModuleDescription;

/**
 * Aggregation of all build entry points used by the build system.
 */
const buildfile = {
	workerEditor,
	workerExtensionHost,
	workerNotebook,
	workerLanguageDetection,
	workerLocalFileSearch,
	workerOutputLinks,
	workerBackgroundTokenization,
	workbenchDesktop,
	workbenchWeb,
	keyboardMaps,
	code,
	codeWeb,
	codeServer,
	entrypoint: createModuleDescription
};

export default buildfile;
