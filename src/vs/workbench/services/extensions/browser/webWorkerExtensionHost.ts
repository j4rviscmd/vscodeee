/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { parentOriginHash } from '../../../../base/browser/iframe.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Barrier } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { canceled, onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { AppResourcePath, COI, FileAccess } from '../../../../base/common/network.js';
import * as platform from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';
import { getNLSLanguage, getNLSMessages } from '../../../../nls.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService, ILoggerService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { isLoggingOnly } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IDefaultLogLevelsService } from '../../log/common/defaultLogLevels.js';
import { ExtensionHostExitCode, IExtensionHostInitData, MessageType, UIKind, createMessageOfType, isMessageOfType } from '../common/extensionHostProtocol.js';
import { LocalWebWorkerRunningLocation } from '../common/extensionRunningLocation.js';
import { ExtensionHostExtensions, ExtensionHostStartup, IExtensionHost } from '../common/extensions.js';

/**
 * Initialization data specific to the web worker extension host.
 *
 * Contains the set of extensions that should be loaded into the
 * web worker-based extension host process.
 */
export interface IWebWorkerExtensionHostInitData {
	readonly extensions: ExtensionHostExtensions;
}

/**
 * Provides initialization data for the web worker extension host.
 *
 * Implementations are responsible for asynchronously resolving the
 * set of extensions and other configuration needed before the
 * extension host can start.
 */
export interface IWebWorkerExtensionHostDataProvider {
	getInitData(): Promise<IWebWorkerExtensionHostInitData>;
}

/**
 * Extension host implementation that runs extensions inside a Web Worker
 * loaded within a sandboxed iframe.
 *
 * The extension host communicates with the main workbench via a `MessagePort`
 * transferred through `postMessage`. A three-way handshake (Ready -> Init -> Initialized)
 * is performed before the extension host becomes operational.
 *
 * On Tauri, `parentOrigin` is explicitly passed to the iframe because the main
 * window (`tauri://localhost`) and the iframe (`vscode-file://vscode-app`) have
 * different origins, requiring cross-origin message validation.
 */
export class WebWorkerExtensionHost extends Disposable implements IExtensionHost {

	/** Always `null` — web worker extension hosts do not have an OS-level process ID. */
	public readonly pid = null;

	/** Always `null` — web worker extension hosts are local, not remote. */
	public readonly remoteAuthority = null;

	/** The resolved set of extensions loaded into this extension host, or `null` before initialization. */
	public extensions: ExtensionHostExtensions | null = null;

	private readonly _onDidExit = this._register(new Emitter<[number, string | null]>());
	/** Fires when the extension host exits unexpectedly, providing the exit code and optional error message. */
	public readonly onExit: Event<[number, string | null]> = this._onDidExit.event;

	private _isTerminating: boolean;
	private _protocolPromise: Promise<IMessagePassingProtocol> | null;
	private _protocol: IMessagePassingProtocol | null;

	/** File system URI where extension host log files are written. */
	private readonly _extensionHostLogsLocation: URI;

	constructor(
		public readonly runningLocation: LocalWebWorkerRunningLocation,
		public readonly startup: ExtensionHostStartup,
		private readonly _initDataProvider: IWebWorkerExtensionHostDataProvider,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@ILabelService private readonly _labelService: ILabelService,
		@ILogService private readonly _logService: ILogService,
		@ILoggerService private readonly _loggerService: ILoggerService,
		@IBrowserWorkbenchEnvironmentService private readonly _environmentService: IBrowserWorkbenchEnvironmentService,
		@IUserDataProfilesService private readonly _userDataProfilesService: IUserDataProfilesService,
		@IProductService private readonly _productService: IProductService,
		@ILayoutService private readonly _layoutService: ILayoutService,
		@IStorageService private readonly _storageService: IStorageService,
		@IWebWorkerService private readonly _webWorkerService: IWebWorkerService,
		@IDefaultLogLevelsService private readonly _defaultLogLevelsService: IDefaultLogLevelsService,
	) {
		super();
		this._isTerminating = false;
		this._protocolPromise = null;
		this._protocol = null;
		this._extensionHostLogsLocation = joinPath(this._environmentService.extHostLogsPath, 'webWorker');
	}

	/**
	 * Build the source URL for the extension host iframe.
	 *
	 * Handles several concerns:
	 * - Sets `debugged` query param when both extension host and renderer debugging are enabled.
	 * - Appends Cross-Origin Isolation (COI) search params.
	 * - On Tauri, passes `parentOrigin` explicitly to enable cross-origin message validation.
	 * - On web, computes a stable origin UUID (persisted in workspace storage) and builds
	 *   a `parentOriginHash` subdomain URL for iframe origin isolation.
	 *
	 * @returns The fully qualified iframe source URL with all required query parameters.
	 */
	private async _getWebWorkerExtensionHostIframeSrc(): Promise<string> {
		const suffixSearchParams = new URLSearchParams();
		if (this._environmentService.debugExtensionHost && this._environmentService.debugRenderer) {
			suffixSearchParams.set('debugged', '1');
		}
		COI.addSearchParam(suffixSearchParams, true, true);

		// TODO(Phase 1): In Tauri, the main window (tauri://localhost) and the iframe
		// (vscode-file://vscode-app) have different origins. The iframe's origin check
		// rejects parent messages unless parentOrigin is passed explicitly.
		if (platform.isTauri) {
			suffixSearchParams.set('parentOrigin', mainWindow.origin);
		}

		const suffix = `?${suffixSearchParams.toString()}`;

		const iframeModulePath: AppResourcePath = `vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html`;
		if (platform.isWeb) {
			const webEndpointUrlTemplate = this._productService.webEndpointUrlTemplate;
			const commit = this._productService.commit;
			const quality = this._productService.quality;
			if (webEndpointUrlTemplate && commit && quality) {
				// Try to keep the web worker extension host iframe origin stable by storing it in workspace storage
				const key = 'webWorkerExtensionHostIframeStableOriginUUID';
				let stableOriginUUID = this._storageService.get(key, StorageScope.WORKSPACE);
				if (typeof stableOriginUUID === 'undefined') {
					stableOriginUUID = generateUuid();
					this._storageService.store(key, stableOriginUUID, StorageScope.WORKSPACE, StorageTarget.MACHINE);
				}
				const hash = await parentOriginHash(mainWindow.origin, stableOriginUUID);
				const baseUrl = (
					webEndpointUrlTemplate
						.replace('{{uuid}}', `v--${hash}`) // using `v--` as a marker to require `parentOrigin`/`salt` verification
						.replace('{{commit}}', commit)
						.replace('{{quality}}', quality)
				);

				const res = new URL(`${baseUrl}/out/${iframeModulePath}${suffix}`);
				res.searchParams.set('parentOrigin', mainWindow.origin);
				res.searchParams.set('salt', stableOriginUUID);
				return res.toString();
			}

			console.warn(`The web worker extension host is started in a same-origin iframe!`);
		}

		const relativeExtensionHostIframeSrc = this._webWorkerService.getWorkerUrl(new WebWorkerDescriptor({
			esmModuleLocation: FileAccess.asBrowserUri(iframeModulePath),
			esmModuleLocationBundler: new URL(`../worker/webWorkerExtensionHostIframe.html`, import.meta.url),
			label: 'webWorkerExtensionHostIframe'
		}));

		return `${relativeExtensionHostIframeSrc}${suffix}`;
	}

	/**
	 * Start the web worker extension host.
	 *
	 * Creates the extension host iframe, waits for the `MessagePort` handshake,
	 * and performs the three-way protocol initialization. The resulting
	 * `IMessagePassingProtocol` is cached so subsequent calls return the same
	 * instance.
	 *
	 * @returns A promise that resolves with the message-passing protocol once
	 *   the extension host is fully initialized and ready to receive messages.
	 */
	public async start(): Promise<IMessagePassingProtocol> {
		if (!this._protocolPromise) {
			this._protocolPromise = this._startInsideIframe();
			this._protocolPromise.then(protocol => this._protocol = protocol);
		}
		return this._protocolPromise;
	}

	/**
	 * Create the sandboxed iframe, set up message listeners for the extension host
	 * bootstrap handshake, and establish the `MessagePort` communication channel.
	 *
	 * The flow is:
	 * 1. Create an iframe pointing to `webWorkerExtensionHostIframe.html`.
	 * 2. Listen for the `vscode.bootstrap.nls` message from the iframe, then reply
	 *    with the worker URL, file root, and NLS data.
	 * 3. Receive a `MessagePort` from the iframe and use it for direct communication.
	 * 4. Forward `vscode.init` message ports (extension API channels) to the iframe.
	 *
	 * @returns A promise resolving to the `IMessagePassingProtocol` backed by the `MessagePort`.
	 * @throws If the iframe fails to start within 60 seconds or sends an error message.
	 */
	private async _startInsideIframe(): Promise<IMessagePassingProtocol> {
		const webWorkerExtensionHostIframeSrc = await this._getWebWorkerExtensionHostIframeSrc();
		const emitter = this._register(new Emitter<VSBuffer>());

		const iframe = document.createElement('iframe');
		iframe.setAttribute('class', 'web-worker-ext-host-iframe');
		iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
		iframe.setAttribute('allow', 'usb; serial; hid; cross-origin-isolated; local-network-access;');
		iframe.setAttribute('aria-hidden', 'true');
		iframe.style.display = 'none';

		const vscodeWebWorkerExtHostId = generateUuid();
		iframe.setAttribute('src', `${webWorkerExtensionHostIframeSrc}&vscodeWebWorkerExtHostId=${vscodeWebWorkerExtHostId}`);

		const barrier = new Barrier();
		let port!: MessagePort;
		let barrierError: Error | null = null;
		let barrierHasError = false;
		let startTimeout: Timeout | undefined = undefined;

		const rejectBarrier = (exitCode: number, error: Error) => {
			barrierError = error;
			barrierHasError = true;
			onUnexpectedError(barrierError);
			clearTimeout(startTimeout);
			this._onDidExit.fire([ExtensionHostExitCode.UnexpectedError, barrierError.message]);
			barrier.open();
		};

		const resolveBarrier = (messagePort: MessagePort) => {
			port = messagePort;
			clearTimeout(startTimeout);
			barrier.open();
		};

		startTimeout = setTimeout(() => {
			console.warn(`The Web Worker Extension Host did not start in 60s, that might be a problem.`);
		}, 60000);

		this._register(dom.addDisposableListener(mainWindow, 'message', (event) => {
			if (event.source !== iframe.contentWindow) {
				return;
			}
			if (event.data.vscodeWebWorkerExtHostId !== vscodeWebWorkerExtHostId) {
				return;
			}
			if (event.data.error) {
				const { name, message, stack } = event.data.error;
				const err = new Error();
				err.message = message;
				err.name = name;
				err.stack = stack;
				return rejectBarrier(ExtensionHostExitCode.UnexpectedError, err);
			}
			if (event.data.type === 'vscode.bootstrap.nls') {
				iframe.contentWindow!.postMessage({
					type: event.data.type,
					data: {
						workerUrl: this._webWorkerService.getWorkerUrl(extensionHostWorkerMainDescriptor),
						fileRoot: globalThis._VSCODE_FILE_ROOT,
						nls: {
							messages: getNLSMessages(),
							language: getNLSLanguage()
						}
					}
				}, '*');
				return;
			}
			const { data } = event.data;
			if (barrier.isOpen() || !(data instanceof MessagePort)) {
				console.warn('UNEXPECTED message', event);
				const err = new Error('UNEXPECTED message');
				return rejectBarrier(ExtensionHostExitCode.UnexpectedError, err);
			}
			resolveBarrier(data);
		}));

		this._layoutService.mainContainer.appendChild(iframe);
		this._register(toDisposable(() => iframe.remove()));

		// await MessagePort and use it to directly communicate
		// with the worker extension host
		await barrier.wait();

		if (barrierHasError) {
			throw barrierError;
		}

		// Send over message ports for extension API
		const messagePorts = this._environmentService.options?.messagePorts ?? new Map();
		iframe.contentWindow!.postMessage({ type: 'vscode.init', data: messagePorts }, '*', [...messagePorts.values()]);

		port.onmessage = (event) => {
			const { data } = event;
			if (!(data instanceof ArrayBuffer)) {
				console.warn('UNKNOWN data received', data);
				this._onDidExit.fire([77, 'UNKNOWN data received']);
				return;
			}
			emitter.fire(VSBuffer.wrap(new Uint8Array(data, 0, data.byteLength)));
		};

		const protocol: IMessagePassingProtocol = {
			onMessage: emitter.event,
			send: vsbuf => {
				const data = vsbuf.buffer.buffer.slice(vsbuf.buffer.byteOffset, vsbuf.buffer.byteOffset + vsbuf.buffer.byteLength);
				port.postMessage(data, [data]);
			}
		};

		return this._performHandshake(protocol);
	}

	/**
	 * Perform the three-way handshake with the extension host worker.
	 *
	 * Protocol sequence:
	 * 1. Wait for `MessageType.Ready` from the extension host.
	 * 2. Send the serialized `IExtensionHostInitData`.
	 * 3. Wait for `MessageType.Initialized` confirmation.
	 *
	 * If the host is terminating at any checkpoint, the handshake is aborted
	 * with a `canceled()` error.
	 *
	 * @param protocol - The message-passing protocol connected to the extension host.
	 * @returns The same protocol instance, now fully initialized.
	 */
	private async _performHandshake(protocol: IMessagePassingProtocol): Promise<IMessagePassingProtocol> {
		// extension host handshake happens below
		// (1) <== wait for: Ready
		// (2) ==> send: init data
		// (3) <== wait for: Initialized

		await Event.toPromise(Event.filter(protocol.onMessage, msg => isMessageOfType(msg, MessageType.Ready)));
		if (this._isTerminating) {
			throw canceled();
		}
		protocol.send(VSBuffer.fromString(JSON.stringify(await this._createExtHostInitData())));
		if (this._isTerminating) {
			throw canceled();
		}
		await Event.toPromise(Event.filter(protocol.onMessage, msg => isMessageOfType(msg, MessageType.Initialized)));
		if (this._isTerminating) {
			throw canceled();
		}

		return protocol;
	}

	/**
	 * Dispose the extension host by sending a `Terminate` message and
	 * cleaning up the iframe and all associated event listeners.
	 *
	 * If the host is already terminating, this is a no-op.
	 */
	public override dispose(): void {
		if (this._isTerminating) {
			return;
		}
		this._isTerminating = true;
		this._protocol?.send(createMessageOfType(MessageType.Terminate));
		super.dispose();
	}

	/**
	 * Web worker extension hosts do not support the debug inspector protocol.
	 *
	 * @returns Always `undefined`.
	 */
	getInspectPort(): undefined {
		return undefined;
	}

	/**
	 * Web worker extension hosts do not support enabling a debug inspector port.
	 *
	 * @returns A promise resolving to `false`, indicating the inspect port was not enabled.
	 */
	enableInspectPort(): Promise<boolean> {
		return Promise.resolve(false);
	}

	/**
	 * Build the `IExtensionHostInitData` payload sent to the extension host during handshake.
	 *
	 * Aggregates product metadata, workspace configuration, NLS base URL,
	 * telemetry identifiers, logger registrations, and extension snapshots
	 * into a single initialization object.
	 *
	 * @returns A fully populated `IExtensionHostInitData` for the extension host.
	 */
	private async _createExtHostInitData(): Promise<IExtensionHostInitData> {
		const initData = await this._initDataProvider.getInitData();
		this.extensions = initData.extensions;
		const workspace = this._contextService.getWorkspace();
		const nlsBaseUrl = this._productService.extensionsGallery?.nlsBaseUrl;
		let nlsUrlWithDetails: URI | undefined = undefined;
		// Only use the nlsBaseUrl if we are using a language other than the default, English.
		if (nlsBaseUrl && this._productService.commit && !platform.Language.isDefaultVariant()) {
			nlsUrlWithDetails = URI.joinPath(URI.parse(nlsBaseUrl), this._productService.commit, this._productService.version, platform.Language.value());
		}
		return {
			commit: this._productService.commit,
			version: this._productService.version,
			quality: this._productService.quality,
			date: this._productService.date,
			parentPid: 0,
			environment: {
				isExtensionDevelopmentDebug: this._environmentService.debugRenderer,
				appName: this._productService.nameLong,
				appHost: this._productService.embedderIdentifier ?? (platform.isWeb ? 'web' : 'desktop'),
				appUriScheme: this._productService.urlProtocol,
				appLanguage: platform.language,
				isExtensionTelemetryLoggingOnly: isLoggingOnly(this._productService, this._environmentService),
				isPortable: false,
				extensionDevelopmentLocationURI: this._environmentService.extensionDevelopmentLocationURI,
				extensionTestsLocationURI: this._environmentService.extensionTestsLocationURI,
				globalStorageHome: this._userDataProfilesService.defaultProfile.globalStorageHome,
				workspaceStorageHome: this._environmentService.workspaceStorageHome,
				extensionLogLevel: this._defaultLogLevelsService.defaultLogLevels.extensions,
				isSessionsWindow: this._environmentService.isSessionsWindow
			},
			workspace: this._contextService.getWorkbenchState() === WorkbenchState.EMPTY ? undefined : {
				configuration: workspace.configuration || undefined,
				id: workspace.id,
				name: this._labelService.getWorkspaceLabel(workspace),
				transient: workspace.transient
			},
			consoleForward: {
				includeStack: false,
				logNative: this._environmentService.debugRenderer
			},
			extensions: this.extensions.toSnapshot(),
			nlsBaseUrl: nlsUrlWithDetails,
			telemetryInfo: {
				sessionId: this._telemetryService.sessionId,
				machineId: this._telemetryService.machineId,
				sqmId: this._telemetryService.sqmId,
				devDeviceId: this._telemetryService.devDeviceId ?? this._telemetryService.machineId,
				firstSessionDate: this._telemetryService.firstSessionDate,
				msftInternal: this._telemetryService.msftInternal
			},
			remoteExtensionTips: this._productService.remoteExtensionTips,
			virtualWorkspaceExtensionTips: this._productService.virtualWorkspaceExtensionTips,
			logLevel: this._logService.getLevel(),
			loggers: [...this._loggerService.getRegisteredLoggers()],
			logsLocation: this._extensionHostLogsLocation,
			autoStart: (this.startup === ExtensionHostStartup.EagerAutoStart || this.startup === ExtensionHostStartup.LazyAutoStart),
			remote: {
				authority: this._environmentService.remoteAuthority,
				connectionData: null,
				isRemote: false
			},
			uiKind: platform.isWeb ? UIKind.Web : UIKind.Desktop
		};
	}
}

/**
 * Descriptor for the main extension host worker script.
 *
 * Provides both browser and bundler-resolved URLs for the worker entry point
 * (`extensionHostWorkerMain.js` / `.ts`). Used by the iframe to create the
 * Web Worker via a `Blob` URL that injects NLS data before importing the module.
 */
const extensionHostWorkerMainDescriptor = new WebWorkerDescriptor({
	label: 'extensionHostWorkerMain',
	esmModuleLocation: () => FileAccess.asBrowserUri('vs/workbench/api/worker/extensionHostWorkerMain.js'),
	esmModuleLocationBundler: () => new URL('../../../api/worker/extensionHostWorkerMain.ts?esm', import.meta.url),
});
