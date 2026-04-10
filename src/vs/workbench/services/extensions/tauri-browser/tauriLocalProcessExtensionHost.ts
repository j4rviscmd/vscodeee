/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as platform from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';
import { PersistentProtocol } from '../../../../base/parts/ipc/common/ipc.net.js';
import { ILogService, ILoggerService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { isLoggingOnly } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { IDefaultLogLevelsService } from '../../log/common/defaultLogLevels.js';
import { IExtensionHostInitData, MessageType, UIKind, isMessageOfType } from '../common/extensionHostProtocol.js';
import { LocalProcessRunningLocation } from '../common/extensionRunningLocation.js';
import { ExtensionHostExtensions, ExtensionHostStartup, IExtensionHost, IExtensionInspectInfo } from '../common/extensions.js';
import { connectToExtHostRelay } from './tauriExtHostSocket.js';
import { invoke } from '../../../../platform/tauri/common/tauriApi.js';

/**
 * Result returned from the Rust `spawn_exthost_with_relay` command.
 */
interface IExtHostSpawnResult {
	readonly wsPort: number;
	readonly extHostPid: number;
	readonly pipePath: string;
}

/**
 * Data provider for the Tauri local process extension host.
 * Supplies the set of extensions to load during initialization.
 */
export interface ITauriLocalProcessExtensionHostDataProvider {
	/** Resolve the extensions to run in this extension host instance. */
	getInitData(): Promise<{ extensions: ExtensionHostExtensions }>;
}

/**
 * IExtensionHost implementation for the Tauri local process extension host.
 *
 * Communication flow:
 *   TS (WebView) → invoke('spawn_exthost_with_relay') → Rust spawns Node.js + WS relay
 *   TS → WebSocket ws://127.0.0.1:{port} → Rust relay → Unix pipe → Node.js ExtHost
 *   PersistentProtocol manages the full VS Code extension host protocol over this socket.
 */
export class TauriLocalProcessExtensionHost extends Disposable implements IExtensionHost {

	public pid: number | null = null;
	public readonly remoteAuthority = null;
	public readonly startup = ExtensionHostStartup.EagerAutoStart;
	public extensions: ExtensionHostExtensions | null = null;

	private readonly _onExit = this._register(new Emitter<[number, string | null]>());
	public readonly onExit: Event<[number, string | null]> = this._onExit.event;

	private _protocol: PersistentProtocol | null = null;
	private readonly _extensionHostLogsLocation: URI;

	constructor(
		public readonly runningLocation: LocalProcessRunningLocation,
		private readonly _initDataProvider: ITauriLocalProcessExtensionHostDataProvider,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@ILoggerService private readonly _loggerService: ILoggerService,
		@ILabelService private readonly _labelService: ILabelService,
		@IProductService private readonly _productService: IProductService,
		@IUserDataProfilesService private readonly _userDataProfilesService: IUserDataProfilesService,
		@IDefaultLogLevelsService private readonly _defaultLogLevelsService: IDefaultLogLevelsService,
	) {
		super();
		this._extensionHostLogsLocation = joinPath(this._environmentService.extHostLogsPath, 'localProcess');
	}

	/**
	 * Start the extension host process and establish a protocol connection.
	 *
	 * Performs the following steps:
	 * 1. Invokes the Rust `spawn_exthost_with_relay` command to spawn Node.js
	 *    and start the WebSocket relay
	 * 2. Connects a WebSocket to the relay at `ws://127.0.0.1:{port}`
	 * 3. Wraps the socket in a {@link PersistentProtocol}
	 * 4. Performs the VS Code extension host handshake:
	 *    - Waits for the `Ready` message from the ExtHost
	 *    - Sends `IExtensionHostInitData` as JSON
	 *    - Waits for the `Initialized` message
	 *
	 * @returns The connected message passing protocol for RPC communication.
	 * @throws If the handshake does not complete within 60 seconds.
	 */
	public async start(): Promise<IMessagePassingProtocol> {
		// 1) Ask Rust to spawn Node.js ExtHost + WS relay
		this._logService.info('[TauriExtHost] Spawning extension host with WS relay...');
		const result = await invoke<IExtHostSpawnResult>('spawn_exthost_with_relay');
		this.pid = result.extHostPid;
		this._logService.info(`[TauriExtHost] ExtHost PID=${result.extHostPid}, WS port=${result.wsPort}, pipe=${result.pipePath}`);

		// 2) Connect WebSocket to the relay
		this._logService.info('[TauriExtHost] Connecting WS to relay...');
		const socket = await connectToExtHostRelay(result.wsPort);
		this._register(socket);
		this._logService.info('[TauriExtHost] WS connected to relay');

		// 3) Wrap in PersistentProtocol (byte-transparent relay — no WebSocket frames on the pipe side)
		const protocol = new PersistentProtocol({ socket, initialChunk: null });
		this._register(protocol);
		this._protocol = protocol;
		this._logService.info('[TauriExtHost] PersistentProtocol created, starting handshake...');

		// Monitor disconnection
		protocol.onDidDispose(() => {
			this._logService.info('[TauriExtHost] Protocol disposed');
			this._onExit.fire([0, null]);
		});
		protocol.onSocketClose((e) => {
			this._logService.info('[TauriExtHost] Socket closed', e);
			this._onExit.fire([0, null]);
		});

		// 4) Perform handshake: wait Ready → send InitData → wait Initialized
		return new Promise<IMessagePassingProtocol>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this._logService.error('[TauriExtHost] Handshake timeout — ExtHost did not send Ready within 60s');
				disposable.dispose();
				reject(new Error('The Tauri local extension host took longer than 60s to send its ready message.'));
			}, 60 * 1000);

			const disposable = protocol.onMessage(msg => {
				this._logService.info(`[TauriExtHost] Handshake message received, length=${msg.byteLength}, first bytes=[${Array.from(msg.slice(0, Math.min(16, msg.byteLength)).buffer).join(',')}]`);

				if (isMessageOfType(msg, MessageType.Ready)) {
					this._logService.info('[TauriExtHost] Received Ready — sending init data...');
					// Extension Host is ready — send initialization data
					this._createExtHostInitData().then(data => {
						const json = JSON.stringify(data);
						this._logService.info(`[TauriExtHost] Sending init data (${json.length} chars)`);
						protocol.send(VSBuffer.fromString(json));
					}).catch(err => {
						clearTimeout(timeout);
						disposable.dispose();
						reject(err);
					});
					return;
				}

				if (isMessageOfType(msg, MessageType.Initialized)) {
					// Extension Host is initialized — handshake complete
					this._logService.info('[TauriExtHost] Received Initialized — handshake complete!');
					clearTimeout(timeout);
					disposable.dispose();

					// Add post-handshake monitoring on the protocol
					let postHandshakeMsgCount = 0;
					let lastMsgTime = Date.now();
					const monitorDisposable = protocol.onMessage(postMsg => {
						postHandshakeMsgCount++;
						const now = Date.now();
						const gap = now - lastMsgTime;
						lastMsgTime = now;
						if (postHandshakeMsgCount <= 50 || postHandshakeMsgCount % 100 === 0) {
							this._logService.info(`[TauriExtHost] Post-handshake onMessage #${postHandshakeMsgCount}: ${postMsg.byteLength} bytes, gap=${gap}ms, first8=[${Array.from(postMsg.slice(0, Math.min(8, postMsg.byteLength)).buffer).join(',')}]`);
						}
					});
					this._register(monitorDisposable);

					resolve(protocol);
					return;
				}

				this._logService.warn(`[TauriExtHost] Unexpected message during handshake, length=${msg.byteLength}`);
			});
		});
	}

	public getInspectPort(): IExtensionInspectInfo | undefined {
		return undefined;
	}

	public enableInspectPort(): Promise<boolean> {
		return Promise.resolve(false);
	}

	/**
	 * Send a disconnect notification to the extension host and close the protocol.
	 */
	public async disconnect(): Promise<void> {
		if (this._protocol) {
			this._protocol.send(VSBuffer.fromString(JSON.stringify({ type: 'VSCODE_EXTHOST_DISCONNECT' })));
			this._protocol.sendDisconnect();
		}
	}

	/**
	 * Send a termination message to the extension host and dispose all resources.
	 */
	public override dispose(): void {
		if (this._protocol) {
			this._protocol.send(VSBuffer.fromString(JSON.stringify({ type: '__$terminate' })));
		}
		super.dispose();
	}

	/**
	 * Build the {@link IExtensionHostInitData} payload sent to the Node.js
	 * Extension Host during the handshake.
	 *
	 * Key differences from the Electron implementation:
	 * - `parentPid` is set to `0` — the ExtHost monitors this PID and
	 *   self-terminates if the parent dies; `0` prevents premature exit
	 * - `uiKind` is `Desktop` — Tauri is a desktop application
	 * - `appHost` is `'desktop'` — distinguishes from browser-based hosts
	 * - `remote.isRemote` is `false` — the ExtHost runs locally
	 */
	private async _createExtHostInitData(): Promise<IExtensionHostInitData> {
		const initData = await this._initDataProvider.getInitData();
		this.extensions = initData.extensions;
		const workspace = this._contextService.getWorkspace();
		const nlsBaseUrl = this._productService.extensionsGallery?.nlsBaseUrl;
		let nlsUrlWithDetails: URI | undefined = undefined;
		if (nlsBaseUrl && this._productService.commit && !platform.Language.isDefaultVariant()) {
			nlsUrlWithDetails = URI.joinPath(URI.parse(nlsBaseUrl), this._productService.commit, this._productService.version, platform.Language.value());
		}
		return {
			commit: this._productService.commit,
			version: this._productService.version,
			quality: this._productService.quality,
			date: this._productService.date,
			parentPid: 0, // Tauri has no equivalent to process.pid — the Rust sidecar monitors ExtHost lifecycle instead
			environment: {
				isExtensionDevelopmentDebug: this._environmentService.debugRenderer,
				appName: this._productService.nameLong,
				appHost: 'desktop', // Tauri is a desktop app, not a web app
				appUriScheme: this._productService.urlProtocol,
				appLanguage: platform.language,
				isExtensionTelemetryLoggingOnly: isLoggingOnly(this._productService, this._environmentService),
				isPortable: false,
				extensionDevelopmentLocationURI: this._environmentService.extensionDevelopmentLocationURI,
				extensionTestsLocationURI: this._environmentService.extensionTestsLocationURI,
				globalStorageHome: this._userDataProfilesService.defaultProfile.globalStorageHome,
				workspaceStorageHome: this._environmentService.workspaceStorageHome,
				extensionLogLevel: this._defaultLogLevelsService.defaultLogLevels.extensions,
				isSessionsWindow: this._environmentService.isSessionsWindow,
			},
			workspace: this._contextService.getWorkbenchState() === WorkbenchState.EMPTY ? undefined : {
				configuration: workspace.configuration || undefined,
				id: workspace.id,
				name: this._labelService.getWorkspaceLabel(workspace),
				transient: workspace.transient,
			},
			consoleForward: {
				includeStack: false,
				logNative: this._environmentService.debugRenderer,
			},
			extensions: this.extensions.toSnapshot(),
			// TODO(debug): zero-extensions test (uncomment below, comment above)
			// extensions: { versionId: 0, allExtensions: [], activationEvents: {}, myExtensions: [] },
			nlsBaseUrl: nlsUrlWithDetails,
			telemetryInfo: {
				sessionId: this._telemetryService.sessionId,
				machineId: this._telemetryService.machineId,
				sqmId: this._telemetryService.sqmId,
				devDeviceId: this._telemetryService.devDeviceId ?? this._telemetryService.machineId,
				firstSessionDate: this._telemetryService.firstSessionDate,
				msftInternal: this._telemetryService.msftInternal,
			},
			remoteExtensionTips: this._productService.remoteExtensionTips,
			virtualWorkspaceExtensionTips: this._productService.virtualWorkspaceExtensionTips,
			logLevel: this._logService.getLevel(),
			loggers: [...this._loggerService.getRegisteredLoggers()],
			logsLocation: this._extensionHostLogsLocation,
			autoStart: true,
			remote: {
				authority: this._environmentService.remoteAuthority,
				connectionData: null,
				isRemote: false,
			},
			uiKind: UIKind.Desktop, // MUST be Desktop — Tauri is a desktop app
		};
	}
}
