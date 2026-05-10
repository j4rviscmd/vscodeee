/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Barrier } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter } from '../../../../base/common/event.js';
import { IMarkdownString, MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import * as perf from '../../../../base/common/performance.js';
import { isCI } from '../../../../base/common/platform.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { isDefined } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import * as nls from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstallOperation } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ImplicitActivationEvents } from '../../../../platform/extensionManagement/common/implicitActivationEvents.js';
import { ExtensionIdentifier, ExtensionIdentifierMap, IExtension, IExtensionContributions, IExtensionDescription, IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { handleVetos } from '../../../../platform/lifecycle/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IRemoteAuthorityResolverService, RemoteAuthorityResolverError, RemoteAuthorityResolverErrorCode, ResolverResult, getRemoteAuthorityPrefix } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteExtensionsScannerService } from '../../../../platform/remote/common/remoteExtensionsScanner.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { IExtensionFeaturesRegistry, Extensions as ExtensionFeaturesExtensions, IExtensionFeatureMarkdownRenderer, IRenderedData, } from '../../extensionManagement/common/extensionFeatures.js';
import { IWorkbenchExtensionEnablementService, IWorkbenchExtensionManagementService } from '../../extensionManagement/common/extensionManagement.js';
import { ExtensionDescriptionRegistryLock, ExtensionDescriptionRegistrySnapshot, IActivationEventsReader, LockableExtensionDescriptionRegistry } from './extensionDescriptionRegistry.js';
import { parseExtensionDevOptions } from './extensionDevOptions.js';
import { ExtensionHostKind, ExtensionRunningPreference, IExtensionHostKindPicker } from './extensionHostKind.js';
import { ExtensionHostManager } from './extensionHostManager.js';
import { IExtensionHostManager } from './extensionHostManagers.js';
import { IResolveAuthorityErrorResult } from './extensionHostProxy.js';
import { IExtensionManifestPropertiesService } from './extensionManifestPropertiesService.js';
import { ExtensionRunningLocation, LocalProcessRunningLocation, LocalWebWorkerRunningLocation, RemoteRunningLocation } from './extensionRunningLocation.js';
import { ExtensionRunningLocationTracker, filterExtensionIdentifiers } from './extensionRunningLocationTracker.js';
import { ActivationKind, ActivationTimes, ExtensionActivationReason, ExtensionHostStartup, ExtensionPointContribution, IExtensionHost, IExtensionInspectInfo, IExtensionService, IExtensionsStatus, IInternalExtensionService, IMessage, IResponsiveStateChangeEvent, IWillActivateEvent, WillStopExtensionHostsEvent, toExtension, toExtensionDescription } from './extensions.js';
import { ExtensionsProposedApi } from './extensionsProposedApi.js';
import { ExtensionMessageCollector, ExtensionPoint, ExtensionsRegistry, IExtensionPoint, IExtensionPointUser } from './extensionsRegistry.js';
import { LazyCreateExtensionHostManager } from './lazyCreateExtensionHostManager.js';
import { ResponsiveState } from './rpcProtocol.js';
import { IExtensionActivationHost as IWorkspaceContainsActivationHost, checkActivateWorkspaceContainsExtension, checkGlobFileExists } from './workspaceContains.js';
import { ILifecycleService, WillShutdownJoinerOrder } from '../../lifecycle/common/lifecycle.js';
import { IExtensionHostExitInfo, IRemoteAgentService } from '../../remote/common/remoteAgentService.js';

const hasOwnProperty = Object.hasOwnProperty;
const NO_OP_VOID_PROMISE = Promise.resolve<void>(undefined);

/**
 * Base implementation of {@link IExtensionService} that manages the lifecycle of
 * extension hosts and the extensions running within them.
 *
 * Subclasses must provide platform-specific extension resolution
 * ({@link _resolveExtensions}), extension host exit handling
 * ({@link _onExtensionHostExit}), and remote authority resolution
 * ({@link _resolveAuthority}).
 *
 * The service is responsible for:
 * - Scanning and registering extensions (local and remote)
 * - Starting, stopping, and restarting extension hosts
 * - Activating extensions based on activation events
 * - Tracking extension status (activation times, errors, messages)
 * - Handling extension enablement/disablement changes at runtime
 * - Resolving remote authorities via resolver extensions (e.g. Remote-SSH)
 */
export abstract class AbstractExtensionService extends Disposable implements IExtensionService {

	public _serviceBrand: undefined;

	private readonly _hasLocalProcess: boolean;
	private readonly _allowRemoteExtensionsInLocalWebWorker: boolean;

	private readonly _onDidRegisterExtensions = this._register(new Emitter<void>());
	public readonly onDidRegisterExtensions = this._onDidRegisterExtensions.event;

	private readonly _onDidChangeExtensionsStatus = this._register(new Emitter<ExtensionIdentifier[]>());
	public readonly onDidChangeExtensionsStatus = this._onDidChangeExtensionsStatus.event;

	private readonly _onDidChangeExtensions = this._register(new Emitter<{ readonly added: ReadonlyArray<IExtensionDescription>; readonly removed: ReadonlyArray<IExtensionDescription> }>({ leakWarningThreshold: 400 }));
	public readonly onDidChangeExtensions = this._onDidChangeExtensions.event;

	private readonly _onWillActivateByEvent = this._register(new Emitter<IWillActivateEvent>());
	public readonly onWillActivateByEvent = this._onWillActivateByEvent.event;

	private readonly _onDidChangeResponsiveChange = this._register(new Emitter<IResponsiveStateChangeEvent>());
	public readonly onDidChangeResponsiveChange = this._onDidChangeResponsiveChange.event;

	private readonly _onWillStop = this._register(new Emitter<WillStopExtensionHostsEvent>());
	public readonly onWillStop = this._onWillStop.event;

	private readonly _activationEventReader = new ImplicitActivationAwareReader();
	private readonly _registry = new LockableExtensionDescriptionRegistry(this._activationEventReader);
	private readonly _installedExtensionsReady = new Barrier();
	private readonly _extensionStatus = new ExtensionIdentifierMap<ExtensionStatus>();
	protected readonly _allRequestedActivateEvents = new Set<string>();
	private readonly _pendingRemoteActivationEvents = new Set<string>();
	private readonly _runningLocations: ExtensionRunningLocationTracker;
	private readonly _remoteCrashTracker = new ExtensionHostCrashTracker();

	private _deltaExtensionsQueue: DeltaExtensionsQueueItem[] = [];
	private _inHandleDeltaExtensions = false;

	protected readonly _extensionHostManagers = this._register(new ExtensionHostCollection());

	private _resolveAuthorityAttempt: number = 0;

	/**
	 * Creates a new {@link AbstractExtensionService} instance.
	 *
	 * Sets up event listeners for extension enablement changes, profile changes,
	 * installation/uninstallation events, and lifecycle shutdown. Initializes the
	 * extension running location tracker and file-system activation bridge.
	 *
	 * @param options - Configuration controlling which extension host kinds are available.
	 * @param options.hasLocalProcess - Whether a local process extension host can be created.
	 * @param options.allowRemoteExtensionsInLocalWebWorker - Whether remote extensions are
	 *   allowed to run in the local web worker extension host.
	 */
	constructor(
		options: { hasLocalProcess: boolean; allowRemoteExtensionsInLocalWebWorker: boolean },
		private readonly _extensionsProposedApi: ExtensionsProposedApi,
		private readonly _extensionHostFactory: IExtensionHostFactory,
		private readonly _extensionHostKindPicker: IExtensionHostKindPicker,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@INotificationService protected readonly _notificationService: INotificationService,
		@IWorkbenchEnvironmentService protected readonly _environmentService: IWorkbenchEnvironmentService,
		@ITelemetryService protected readonly _telemetryService: ITelemetryService,
		@IWorkbenchExtensionEnablementService protected readonly _extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IFileService protected readonly _fileService: IFileService,
		@IProductService protected readonly _productService: IProductService,
		@IWorkbenchExtensionManagementService protected readonly _extensionManagementService: IWorkbenchExtensionManagementService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@IExtensionManifestPropertiesService private readonly _extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@ILogService protected readonly _logService: ILogService,
		@IRemoteAgentService protected readonly _remoteAgentService: IRemoteAgentService,
		@IRemoteExtensionsScannerService protected readonly _remoteExtensionsScannerService: IRemoteExtensionsScannerService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IRemoteAuthorityResolverService protected readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IDialogService private readonly _dialogService: IDialogService,
	) {
		super();

		this._hasLocalProcess = options.hasLocalProcess;
		this._allowRemoteExtensionsInLocalWebWorker = options.allowRemoteExtensionsInLocalWebWorker;

		// help the file service to activate providers by activating extensions by file system event
		this._register(this._fileService.onWillActivateFileSystemProvider(e => {
			if (e.scheme !== Schemas.vscodeRemote) {
				e.join(this.activateByEvent(`onFileSystem:${e.scheme}`));
			}
		}));

		this._runningLocations = new ExtensionRunningLocationTracker(
			this._registry,
			this._extensionHostKindPicker,
			this._environmentService,
			this._configurationService,
			this._logService,
			this._extensionManifestPropertiesService
		);

		this._register(this._extensionEnablementService.onEnablementChanged((extensions) => {
			const toAdd: IExtension[] = [];
			const toRemove: IExtension[] = [];
			for (const extension of extensions) {
				if (this._safeInvokeIsEnabled(extension)) {
					// an extension has been enabled
					toAdd.push(extension);
				} else {
					// an extension has been disabled
					toRemove.push(extension);
				}
			}
			if (isCI) {
				this._logService.info(`AbstractExtensionService.onEnablementChanged fired for ${extensions.map(e => e.identifier.id).join(', ')}`);
			}
			this._handleDeltaExtensions(new DeltaExtensionsQueueItem(toAdd, toRemove));
		}));

		this._register(this._extensionManagementService.onDidChangeProfile(({ added, removed }) => {
			if (added.length || removed.length) {
				if (isCI) {
					this._logService.info(`AbstractExtensionService.onDidChangeProfile fired`);
				}
				this._handleDeltaExtensions(new DeltaExtensionsQueueItem(added, removed));
			}
		}));

		this._register(this._extensionManagementService.onDidEnableExtensions(extensions => {
			if (extensions.length) {
				if (isCI) {
					this._logService.info(`AbstractExtensionService.onDidEnableExtensions fired`);
				}
				this._handleDeltaExtensions(new DeltaExtensionsQueueItem(extensions, []));
			}
		}));

		this._register(this._extensionManagementService.onDidInstallExtensions((result) => {
			const extensions: IExtension[] = [];
			const toRemove: string[] = [];
			for (const { local, operation } of result) {
				if (local && local.isValid && operation !== InstallOperation.Migrate && this._safeInvokeIsEnabled(local)) {
					extensions.push(local);
					if (operation === InstallOperation.Update) {
						toRemove.push(local.identifier.id);
					}
				}
			}
			if (extensions.length) {
				if (isCI) {
					this._logService.info(`AbstractExtensionService.onDidInstallExtensions fired for ${extensions.map(e => e.identifier.id).join(', ')}`);
				}
				this._handleDeltaExtensions(new DeltaExtensionsQueueItem(extensions, toRemove));
			}
		}));

		this._register(this._extensionManagementService.onDidUninstallExtension((event) => {
			if (!event.error) {
				// an extension has been uninstalled
				if (isCI) {
					this._logService.info(`AbstractExtensionService.onDidUninstallExtension fired for ${event.identifier.id}`);
				}
				this._handleDeltaExtensions(new DeltaExtensionsQueueItem([], [event.identifier.id]));
			}
		}));

		this._register(this._lifecycleService.onWillShutdown(event => {
			if (this._remoteAgentService.getConnection()) {
				event.join(async () => {
					// We need to disconnect the management connection before killing the local extension host.
					// Otherwise, the local extension host might terminate the underlying tunnel before the
					// management connection has a chance to send its disconnection message.
					try {
						await this._remoteAgentService.endConnection();
						await this._doStopExtensionHosts();
						this._remoteAgentService.getConnection()?.dispose();
					} catch {
						this._logService.warn('Error while disconnecting remote agent');
					}
				}, {
					id: 'join.disconnectRemote',
					label: nls.localize('disconnectRemote', "Disconnect Remote Agent"),
					order: WillShutdownJoinerOrder.Last // after others have joined that might depend on a remote connection
				});
			} else {
				event.join(this._doStopExtensionHosts(), {
					id: 'join.stopExtensionHosts',
					label: nls.localize('stopExtensionHosts', "Stopping Extension Hosts"),
				});
			}
		}));
	}

	/**
	 * Returns all extension host managers of the specified kind.
	 *
	 * @param kind - The extension host kind to filter by.
	 * @returns An array of matching extension host managers.
	 */
	protected _getExtensionHostManagers(kind: ExtensionHostKind): IExtensionHostManager[] {
		return this._extensionHostManagers.getByKind(kind);
	}

	//#region deltaExtensions

	/**
	 * Enqueues a delta extensions operation and processes the queue sequentially.
	 *
	 * If a delta operation is already in progress, the new item is queued and will
	 * be processed after the current operation completes. This prevents concurrent
	 * modifications to the extension registry.
	 *
	 * @param item - The delta extensions queue item containing extensions to add and remove.
	 */
	private async _handleDeltaExtensions(item: DeltaExtensionsQueueItem): Promise<void> {
		this._deltaExtensionsQueue.push(item);
		if (this._inHandleDeltaExtensions) {
			// Let the current item finish, the new one will be picked up
			return;
		}

		let lock: ExtensionDescriptionRegistryLock | null = null;
		try {
			this._inHandleDeltaExtensions = true;

			// wait for _initialize to finish before hanlding any delta extension events
			await this._installedExtensionsReady.wait();

			lock = await this._registry.acquireLock('handleDeltaExtensions');
			while (this._deltaExtensionsQueue.length > 0) {
				const item = this._deltaExtensionsQueue.shift()!;
				await this._deltaExtensions(lock, item.toAdd, item.toRemove);
			}
		} finally {
			this._inHandleDeltaExtensions = false;
			lock?.dispose();
		}
	}

	/**
	 * Processes a single delta extensions operation: removes qualifying extensions,
	 * adds qualifying extensions, updates the registry, extension points, and
	 * extension hosts, then activates newly added extensions if needed.
	 *
	 * Removal qualifiers: the extension must exist in the registry, match the same
	 * scheme, and not use non-dynamic extension points or be already activated.
	 *
	 * Addition qualifiers: the extension must be scannable, not already present
	 * (unless concurrently being removed), and have a valid extension host kind.
	 *
	 * @param lock - The registry lock acquired for this operation.
	 * @param _toAdd - Extensions to add (as {@link IExtension} objects).
	 * @param _toRemove - Extensions to remove (as identifier strings or {@link IExtension} objects).
	 */
	private async _deltaExtensions(lock: ExtensionDescriptionRegistryLock, _toAdd: IExtension[], _toRemove: string[] | IExtension[]): Promise<void> {
		if (isCI) {
			this._logService.info(`AbstractExtensionService._deltaExtensions: toAdd: [${_toAdd.map(e => e.identifier.id).join(',')}] toRemove: [${_toRemove.map(e => typeof e === 'string' ? e : e.identifier.id).join(',')}]`);
		}
		let toRemove: IExtensionDescription[] = [];
		for (let i = 0, len = _toRemove.length; i < len; i++) {
			const extensionOrId = _toRemove[i];
			const extensionId = (typeof extensionOrId === 'string' ? extensionOrId : extensionOrId.identifier.id);
			const extension = (typeof extensionOrId === 'string' ? null : extensionOrId);
			const extensionDescription = this._registry.getExtensionDescription(extensionId);
			if (!extensionDescription) {
				// ignore disabling/uninstalling an extension which is not running
				continue;
			}

			if (extension && extensionDescription.extensionLocation.scheme !== extension.location.scheme) {
				// this event is for a different extension than mine (maybe for the local extension, while I have the remote extension)
				continue;
			}

			if (!this.canRemoveExtension(extensionDescription)) {
				// uses non-dynamic extension point or is activated
				continue;
			}

			toRemove.push(extensionDescription);
		}

		const toAdd: IExtensionDescription[] = [];
		for (let i = 0, len = _toAdd.length; i < len; i++) {
			const extension = _toAdd[i];

			const extensionDescription = toExtensionDescription(extension, false);
			if (!extensionDescription) {
				// could not scan extension...
				continue;
			}

			if (!this._canAddExtension(extensionDescription, toRemove)) {
				continue;
			}

			toAdd.push(extensionDescription);
		}

		if (toAdd.length === 0 && toRemove.length === 0) {
			return;
		}

		// Update the local registry
		const result = this._registry.deltaExtensions(lock, toAdd, toRemove.map(e => e.identifier));
		this._onDidChangeExtensions.fire({ added: toAdd, removed: toRemove });

		toRemove = toRemove.concat(result.removedDueToLooping);
		if (result.removedDueToLooping.length > 0) {
			this._notificationService.notify({
				severity: Severity.Error,
				message: nls.localize('looping', "The following extensions contain dependency loops and have been disabled: {0}", result.removedDueToLooping.map(e => `'${e.identifier.value}'`).join(', '))
			});
		}

		// enable or disable proposed API per extension
		this._extensionsProposedApi.updateEnabledApiProposals(toAdd);

		// Update extension points
		this._doHandleExtensionPoints((<IExtensionDescription[]>[]).concat(toAdd).concat(toRemove), false);

		// Update the extension host
		await this._updateExtensionsOnExtHosts(result.versionId, toAdd, toRemove.map(e => e.identifier));

		for (let i = 0; i < toAdd.length; i++) {
			this._activateAddedExtensionIfNeeded(toAdd[i]);
		}
	}

	/**
	 * Updates the running location tracker and dispatches delta extension changes
	 * to all extension host managers in parallel.
	 *
	 * @param versionId - The new registry version ID after the delta.
	 * @param toAdd - Extensions that were added.
	 * @param toRemove - Extension identifiers that were removed.
	 */
	private async _updateExtensionsOnExtHosts(versionId: number, toAdd: IExtensionDescription[], toRemove: ExtensionIdentifier[]): Promise<void> {
		const removedRunningLocation = this._runningLocations.deltaExtensions(toAdd, toRemove);
		const promises = this._extensionHostManagers.map(
			extHostManager => this._updateExtensionsOnExtHost(extHostManager, versionId, toAdd, toRemove, removedRunningLocation)
		);
		await Promise.all(promises);
	}

	/**
	 * Sends a delta extensions request to a single extension host manager,
	 * filtered to only the extensions relevant to that host.
	 *
	 * @param extensionHostManager - The target extension host manager.
	 * @param versionId - The new registry version ID.
	 * @param toAdd - All extensions that were added.
	 * @param toRemove - All extension identifiers that were removed.
	 * @param removedRunningLocation - Map of removed extension identifiers to their
	 *   previous running locations (or null if they had none).
	 */
	private async _updateExtensionsOnExtHost(extensionHostManager: IExtensionHostManager, versionId: number, toAdd: IExtensionDescription[], toRemove: ExtensionIdentifier[], removedRunningLocation: ExtensionIdentifierMap<ExtensionRunningLocation | null>): Promise<void> {
		const myToAdd = this._runningLocations.filterByExtensionHostManager(toAdd, extensionHostManager);
		const myToRemove = filterExtensionIdentifiers(toRemove, removedRunningLocation, extRunningLocation => extensionHostManager.representsRunningLocation(extRunningLocation));
		const addActivationEvents = ImplicitActivationEvents.createActivationEventsMap(toAdd);
		if (isCI) {
			const printExtIds = (extensions: IExtensionDescription[]) => extensions.map(e => e.identifier.value).join(',');
			const printIds = (extensions: ExtensionIdentifier[]) => extensions.map(e => e.value).join(',');
			this._logService.info(`AbstractExtensionService: Calling deltaExtensions: toRemove: [${printIds(toRemove)}], toAdd: [${printExtIds(toAdd)}], myToRemove: [${printIds(myToRemove)}], myToAdd: [${printExtIds(myToAdd)}],`);
		}
		await extensionHostManager.deltaExtensions({ versionId, toRemove, toAdd, addActivationEvents, myToRemove, myToAdd: myToAdd.map(extension => extension.identifier) });
	}

	/**
	 * Checks whether the given extension can be added to the registry.
	 *
	 * @param extension - The extension description to check.
	 * @returns `true` if the extension is not already registered (or is being
	 *   removed concurrently) and a valid extension host kind is available.
	 */
	public canAddExtension(extension: IExtensionDescription): boolean {
		return this._canAddExtension(extension, []);
	}

	/**
	 * Internal check for whether an extension can be added.
	 *
	 * An extension can be added if it is not already in the registry (unless it is
	 * currently being removed) and the extension host kind picker returns a valid
	 * host kind for it.
	 *
	 * @param extension - The extension description to check.
	 * @param extensionsBeingRemoved - Extensions that are being removed in the same
	 *   delta operation, which allows re-adding the same extension.
	 * @returns `true` if the extension can be added.
	 */
	private _canAddExtension(extension: IExtensionDescription, extensionsBeingRemoved: IExtensionDescription[]): boolean {
		// (Also check for renamed extensions)
		const existing = this._registry.getExtensionDescriptionByIdOrUUID(extension.identifier, extension.id);
		if (existing) {
			// This extension is already known (most likely at a different version)
			// so it cannot be added again unless it is removed first
			const isBeingRemoved = extensionsBeingRemoved.some((extensionDescription) => ExtensionIdentifier.equals(extension.identifier, extensionDescription.identifier));
			if (!isBeingRemoved) {
				return false;
			}
		}

		const extensionKinds = this._runningLocations.readExtensionKinds(extension);
		const isRemote = extension.extensionLocation.scheme === Schemas.vscodeRemote;
		const extensionHostKind = this._extensionHostKindPicker.pickExtensionHostKind(extension.identifier, extensionKinds, !isRemote, isRemote, ExtensionRunningPreference.None);
		if (extensionHostKind === null) {
			return false;
		}

		return true;
	}

	/**
	 * Checks whether the given extension can be safely removed.
	 *
	 * An extension cannot be removed if it is unknown or if its activation has
	 * already started (to avoid destabilizing a running extension).
	 *
	 * @param extension - The extension description to check.
	 * @returns `true` if the extension is known and not yet activated.
	 */
	public canRemoveExtension(extension: IExtensionDescription): boolean {
		const extensionDescription = this._registry.getExtensionDescription(extension.identifier);
		if (!extensionDescription) {
			// Can't remove an extension that is unknown!
			return false;
		}

		if (this._extensionStatus.get(extensionDescription.identifier)?.activationStarted) {
			// Extension is running, cannot remove it safely
			return false;
		}

		return true;
	}

	/**
	 * Activates a newly added extension if its activation events have already been
	 * requested, if it has a wildcard activation event, if it listens for
	 * `onStartupFinished`, or if it matches a `workspaceContains` pattern.
	 *
	 * @param extensionDescription - The newly added extension to potentially activate.
	 */
	private async _activateAddedExtensionIfNeeded(extensionDescription: IExtensionDescription): Promise<void> {
		let shouldActivateReason: string | null = null;
		let hasWorkspaceContains = false;
		const activationEvents = this._activationEventReader.readActivationEvents(extensionDescription);
		for (const activationEvent of activationEvents) {
			if (this._allRequestedActivateEvents.has(activationEvent)) {
				// This activation event was fired before the extension was added
				shouldActivateReason = activationEvent;
				break;
			}

			if (activationEvent === '*') {
				shouldActivateReason = activationEvent;
				break;
			}

			if (/^workspaceContains/.test(activationEvent)) {
				hasWorkspaceContains = true;
			}

			if (activationEvent === 'onStartupFinished') {
				shouldActivateReason = activationEvent;
				break;
			}
		}

		if (!shouldActivateReason && hasWorkspaceContains) {
			const workspace = await this._contextService.getCompleteWorkspace();
			const forceUsingSearch = !!this._environmentService.remoteAuthority;
			const host: IWorkspaceContainsActivationHost = {
				logService: this._logService,
				folders: workspace.folders.map(folder => folder.uri),
				forceUsingSearch: forceUsingSearch,
				exists: (uri) => this._fileService.exists(uri),
				checkExists: (folders, includes, token) => this._instantiationService.invokeFunction((accessor) => checkGlobFileExists(accessor, folders, includes, token))
			};

			const result = await checkActivateWorkspaceContainsExtension(host, extensionDescription);
			if (result) {
				shouldActivateReason = result.activationEvent;
			}
		}

		if (shouldActivateReason) {
			await Promise.all(
				this._extensionHostManagers.map(extHostManager => extHostManager.activate(extensionDescription.identifier, { startup: false, extensionId: extensionDescription.identifier, activationEvent: shouldActivateReason }))
			);
		}
	}

	//#endregion

	private _initializePromise: Promise<void> | null = null;
	/**
	 * Ensures initialization runs exactly once by caching the promise.
	 *
	 * @returns The initialization promise, or the cached promise if initialization
	 *   has already been triggered.
	 */
	protected _initializeIfNeeded(): Promise<void> | null {
		if (!this._initializePromise) {
			this._initializePromise = this._initialize();
		}
		return this._initializePromise;
	}

	/**
	 * Initializes the extension service by starting extension hosts, resolving
	 * and processing extensions, starting on-demand hosts, releasing the
	 * initialization barrier, replaying deferred remote activation events, and
	 * running extension tests if in development mode.
	 */
	protected async _initialize(): Promise<void> {
		perf.mark('code/willLoadExtensions');
		this._startExtensionHostsIfNecessary(true, []);

		const lock = await this._registry.acquireLock('_initialize');
		try {
			await this._resolveAndProcessExtensions(lock);
			// Start extension hosts which are not automatically started
			this._startOnDemandExtensionHosts();
		} finally {
			lock.dispose();
		}

		this._releaseBarrier();
		perf.mark('code/didLoadExtensions');

		// Activate deferred remote events now that remote hosts are starting
		// This is done after the barrier is released to avoid blocking initialization
		this._activateDeferredRemoteEvents();

		await this._handleExtensionTests();
	}

	/**
	 * Replays activation events that were deferred during initialization because
	 * remote extension hosts were not yet ready.
	 *
	 * After remote hosts become ready, each deferred event is replayed on all
	 * remote extension host managers and then cleared from the pending set.
	 */
	private async _activateDeferredRemoteEvents(): Promise<void> {
		if (this._pendingRemoteActivationEvents.size === 0) {
			return;
		}

		const remoteExtensionHosts = this._getExtensionHostManagers(ExtensionHostKind.Remote);
		if (remoteExtensionHosts.length === 0) {
			this._pendingRemoteActivationEvents.clear();
			return;
		}

		// Wait for remote extension hosts to be ready
		await Promise.all(remoteExtensionHosts.map(extHost => extHost.ready()));

		// Replay deferred activation events on remote hosts
		for (const activationEvent of this._pendingRemoteActivationEvents) {
			const result = Promise.all(
				remoteExtensionHosts.map(extHostManager => extHostManager.activateByEvent(activationEvent, ActivationKind.Normal))
			).then(() => { });
			this._onWillActivateByEvent.fire({
				event: activationEvent,
				activation: result,
				activationKind: ActivationKind.Normal
			});
		}

		this._pendingRemoteActivationEvents.clear();
	}

	/**
	 * Resolves all extensions via the async iterable from {@link _resolveExtensions},
	 * categorizes them into resolver, local, and remote groups, initializes running
	 * locations, starts extension hosts, and registers all extensions in the registry.
	 *
	 * Resolver extensions are registered and their extension points handled first,
	 * followed by the remaining extensions. Extensions with dependency loops are
	 * detected and disabled with an error notification.
	 *
	 * @param lock - The registry lock acquired for this operation.
	 */
	private async _resolveAndProcessExtensions(lock: ExtensionDescriptionRegistryLock,): Promise<void> {
		let resolverExtensions: IExtensionDescription[] = [];
		let localExtensions: IExtensionDescription[] = [];
		let remoteExtensions: IExtensionDescription[] = [];

		for await (const extensions of this._resolveExtensions()) {
			if (extensions instanceof ResolverExtensions) {
				resolverExtensions = checkEnabledAndProposedAPI(this._logService, this._extensionEnablementService, this._extensionsProposedApi, extensions.extensions, false);
				this._registry.deltaExtensions(lock, resolverExtensions, []);
				this._doHandleExtensionPoints(resolverExtensions, true);
			}
			if (extensions instanceof LocalExtensions) {
				localExtensions = checkEnabledAndProposedAPI(this._logService, this._extensionEnablementService, this._extensionsProposedApi, extensions.extensions, false);
			}
			if (extensions instanceof RemoteExtensions) {
				remoteExtensions = checkEnabledAndProposedAPI(this._logService, this._extensionEnablementService, this._extensionsProposedApi, extensions.extensions, false);
			}
		}

		// `initializeRunningLocation` will look at the complete picture (e.g. an extension installed on both sides),
		// takes care of duplicates and picks a running location for each extension
		this._runningLocations.initializeRunningLocation(localExtensions, remoteExtensions);

		this._startExtensionHostsIfNecessary(true, []);

		// Some remote extensions could run locally in the web worker, so store them
		const remoteExtensionsThatNeedToRunLocally = (this._allowRemoteExtensionsInLocalWebWorker ? this._runningLocations.filterByExtensionHostKind(remoteExtensions, ExtensionHostKind.LocalWebWorker) : []);
		const localProcessExtensions = (this._hasLocalProcess ? this._runningLocations.filterByExtensionHostKind(localExtensions, ExtensionHostKind.LocalProcess) : []);
		const localWebWorkerExtensions = this._runningLocations.filterByExtensionHostKind(localExtensions, ExtensionHostKind.LocalWebWorker);
		remoteExtensions = this._runningLocations.filterByExtensionHostKind(remoteExtensions, ExtensionHostKind.Remote);

		// Add locally the remote extensions that need to run locally in the web worker
		for (const ext of remoteExtensionsThatNeedToRunLocally) {
			if (!includes(localWebWorkerExtensions, ext.identifier)) {
				localWebWorkerExtensions.push(ext);
			}
		}

		const allExtensions = remoteExtensions.concat(localProcessExtensions).concat(localWebWorkerExtensions);
		let toAdd = allExtensions;

		if (resolverExtensions.length) {
			// Add extensions that are not registered as resolvers but are in the final resolved set
			toAdd = allExtensions.filter(extension => !resolverExtensions.some(e => ExtensionIdentifier.equals(e.identifier, extension.identifier) && e.extensionLocation.toString() === extension.extensionLocation.toString()));
			// Remove extensions that are registered as resolvers but are not in the final resolved set
			if (allExtensions.length < toAdd.length + resolverExtensions.length) {
				const toRemove = resolverExtensions.filter(registered => !allExtensions.some(e => ExtensionIdentifier.equals(e.identifier, registered.identifier) && e.extensionLocation.toString() === registered.extensionLocation.toString()));
				if (toRemove.length) {
					this._registry.deltaExtensions(lock, [], toRemove.map(e => e.identifier));
					this._doHandleExtensionPoints(toRemove, true);
				}
			}
		}

		const result = this._registry.deltaExtensions(lock, toAdd, []);
		if (result.removedDueToLooping.length > 0) {
			this._notificationService.notify({
				severity: Severity.Error,
				message: nls.localize('looping', "The following extensions contain dependency loops and have been disabled: {0}", result.removedDueToLooping.map(e => `'${e.identifier.value}'`).join(', '))
			});
		}

		this._doHandleExtensionPoints(this._registry.getAllExtensionDescriptions(), false);
	}

	/**
	 * Runs the extension test runner if the environment is in extension development
	 * mode and a test location URI is configured.
	 *
	 * Finds the appropriate extension host for the test location, executes the test
	 * runner, and triggers the extension host exit callback with the resulting
	 * exit code.
	 */
	private async _handleExtensionTests(): Promise<void> {
		if (!this._environmentService.isExtensionDevelopment || !this._environmentService.extensionTestsLocationURI) {
			return;
		}

		const extensionHostManager = this.findTestExtensionHost(this._environmentService.extensionTestsLocationURI);
		if (!extensionHostManager) {
			const msg = nls.localize('extensionTestError', "No extension host found that can launch the test runner at {0}.", this._environmentService.extensionTestsLocationURI.toString());
			console.error(msg);
			this._notificationService.error(msg);
			return;
		}


		let exitCode: number;
		try {
			exitCode = await extensionHostManager.extensionTestsExecute();
			if (isCI) {
				this._logService.info(`Extension host test runner exit code: ${exitCode}`);
			}
		} catch (err) {
			if (isCI) {
				this._logService.error(`Extension host test runner error`, err);
			}
			console.error(err);
			exitCode = 1 /* ERROR */;
		}

		this._onExtensionHostExit(exitCode);
	}

	/**
	 * Finds the extension host manager that should run the test at the given location.
	 *
	 * If the test location is inside a registered extension, the extension's running
	 * location is used. Otherwise, remote-scheme tests use a remote running location
	 * and all other tests fall back to a local process running location.
	 *
	 * @param testLocation - The URI of the extension test entry point.
	 * @returns The matching extension host manager, or `null` if not found.
	 */
	private findTestExtensionHost(testLocation: URI): IExtensionHostManager | null {
		let runningLocation: ExtensionRunningLocation | null = null;

		for (const extension of this._registry.getAllExtensionDescriptions()) {
			if (isEqualOrParent(testLocation, extension.extensionLocation)) {
				runningLocation = this._runningLocations.getRunningLocation(extension.identifier);
				break;
			}
		}
		if (runningLocation === null) {
			// not sure if we should support that, but it was possible to have an test outside an extension

			if (testLocation.scheme === Schemas.vscodeRemote) {
				runningLocation = new RemoteRunningLocation();
			} else {
				// When a debugger attaches to the extension host, it will surface all console.log messages from the extension host,
				// but not necessarily from the window. So it would be best if any errors get printed to the console of the extension host.
				// That is why here we use the local process extension host even for non-file URIs
				runningLocation = new LocalProcessRunningLocation(0);
			}
		}
		if (runningLocation !== null) {
			return this._extensionHostManagers.getByRunningLocation(runningLocation);
		}
		return null;
	}

	/**
	 * Opens the installed-extensions-ready barrier, fires the extensions-registered
	 * event, and notifies status changes for all registered extensions.
	 */
	private _releaseBarrier(): void {
		this._installedExtensionsReady.open();
		this._onDidRegisterExtensions.fire(undefined);
		this._onDidChangeExtensionsStatus.fire(this._registry.getAllExtensionDescriptions().map(e => e.identifier));
	}

	//#region remote authority resolving

	/**
	 * Attempts to resolve a remote authority with automatic retries.
	 *
	 * Retries up to {@link MAX_ATTEMPTS} times on transient errors. Aborts
	 * immediately if the error indicates no resolver was found or the resolver
	 * explicitly requested no retry.
	 *
	 * @param remoteAuthority - The remote authority string to resolve.
	 * @returns The resolved authority result.
	 * @throws {Error} If resolution fails after all retry attempts or on
	 *   non-retryable errors.
	 */
	protected async _resolveAuthorityInitial(remoteAuthority: string): Promise<ResolverResult> {
		const MAX_ATTEMPTS = 5;

		for (let attempt = 1; ; attempt++) {
			try {
				return this._resolveAuthorityWithLogging(remoteAuthority);
			} catch (err) {
				if (RemoteAuthorityResolverError.isNoResolverFound(err)) {
					// There is no point in retrying if there is no resolver found
					throw err;
				}

				if (RemoteAuthorityResolverError.isNotAvailable(err)) {
					// The resolver is not available and asked us to not retry
					throw err;
				}

				if (attempt >= MAX_ATTEMPTS) {
					// Too many failed attempts, give up
					throw err;
				}
			}
		}
	}

	/**
	 * Re-resolves the current remote authority, typically after a connection loss.
	 *
	 * Clears the previously resolved authority, attempts resolution, and updates
	 * the resolver service with the new result or error.
	 */
	protected async _resolveAuthorityAgain(): Promise<void> {
		const remoteAuthority = this._environmentService.remoteAuthority;
		if (!remoteAuthority) {
			return;
		}

		this._remoteAuthorityResolverService._clearResolvedAuthority(remoteAuthority);
		try {
			const result = await this._resolveAuthorityWithLogging(remoteAuthority);
			this._remoteAuthorityResolverService._setResolvedAuthority(result.authority, result.options);
		} catch (err) {
			this._remoteAuthorityResolverService._setResolvedAuthorityError(remoteAuthority, err);
		}
	}

	/**
	 * Resolves a remote authority with performance marks and structured logging.
	 *
	 * Logs the authority prefix (not the full authority, to avoid leaking secrets),
	 * measures elapsed time, and records performance marks for success and failure.
	 *
	 * @param remoteAuthority - The remote authority string to resolve.
	 * @returns The resolved authority result.
	 * @throws Rethrows any error from the underlying {@link _resolveAuthority}.
	 */
	private async _resolveAuthorityWithLogging(remoteAuthority: string): Promise<ResolverResult> {
		const authorityPrefix = getRemoteAuthorityPrefix(remoteAuthority);
		const sw = StopWatch.create(false);
		this._logService.info(`Invoking resolveAuthority(${authorityPrefix})...`);
		try {
			perf.mark(`code/willResolveAuthority/${authorityPrefix}`);
			const result = await this._resolveAuthority(remoteAuthority);
			perf.mark(`code/didResolveAuthorityOK/${authorityPrefix}`);
			this._logService.info(`resolveAuthority(${authorityPrefix}) returned '${result.authority.connectTo}' after ${sw.elapsed()} ms`);
			return result;
		} catch (err) {
			perf.mark(`code/didResolveAuthorityError/${authorityPrefix}`);
			this._logService.error(`resolveAuthority(${authorityPrefix}) returned an error after ${sw.elapsed()} ms`, err);
			throw err;
		}
	}

	/**
	 * Delegates remote authority resolution to extension hosts of the specified kind.
	 *
	 * Sends the resolution request to all matching extension hosts and returns the
	 * first successful result. If all hosts fail, throws the most specific error
	 * (preferring non-`Unknown` error codes over `Unknown`).
	 *
	 * @param kind - The extension host kind to use for resolution.
	 * @param remoteAuthority - The remote authority string to resolve.
	 * @returns The resolved authority result from the first successful host.
	 * @throws {Error} If no extension hosts of the specified kind exist.
	 * @throws {RemoteAuthorityResolverError} If all hosts return errors.
	 */
	protected async _resolveAuthorityOnExtensionHosts(kind: ExtensionHostKind, remoteAuthority: string): Promise<ResolverResult> {

		const extensionHosts = this._getExtensionHostManagers(kind);
		if (extensionHosts.length === 0) {
			// no local process extension hosts
			throw new Error(`Cannot resolve authority`);
		}

		this._resolveAuthorityAttempt++;
		const results = await Promise.all(extensionHosts.map(extHost => extHost.resolveAuthority(remoteAuthority, this._resolveAuthorityAttempt)));

		let bestErrorResult: IResolveAuthorityErrorResult | null = null;
		for (const result of results) {
			if (result.type === 'ok') {
				return result.value;
			}
			if (!bestErrorResult) {
				bestErrorResult = result;
				continue;
			}
			const bestErrorIsUnknown = (bestErrorResult.error.code === RemoteAuthorityResolverErrorCode.Unknown);
			const errorIsUnknown = (result.error.code === RemoteAuthorityResolverErrorCode.Unknown);
			if (bestErrorIsUnknown && !errorIsUnknown) {
				bestErrorResult = result;
			}
		}

		// we can only reach this if there is an error
		throw new RemoteAuthorityResolverError(bestErrorResult!.error.message, bestErrorResult!.error.code, bestErrorResult!.error.detail);
	}

	//#endregion

	//#region Stopping / Starting / Restarting

	/**
	 * Stops all extension hosts, optionally with a confirmation dialog if
	 * extensions veto the shutdown.
	 *
	 * @param reason - A human-readable reason for stopping the extension hosts.
	 * @param auto - Whether this is an automatic (non-user-initiated) stop.
	 *   Automatic stops are skipped during extension development.
	 * @returns `true` if extension hosts were stopped or the caller should proceed
	 *   anyway after a veto, `false` if stopped by a veto without confirmation.
	 */
	public async stopExtensionHosts(reason: string, auto?: boolean): Promise<boolean> {
		await this._initializeIfNeeded();
		return this._doStopExtensionHostsWithVeto(reason, auto);
	}

	/**
	 * Stops all extension hosts in reverse creation order and clears runtime
	 * status for all previously activated extensions.
	 *
	 * Fires an extension status change event for any extensions that were
	 * activated before the stop.
	 */
	protected async _doStopExtensionHosts(): Promise<void> {
		const previouslyActivatedExtensionIds: ExtensionIdentifier[] = [];
		for (const extensionStatus of this._extensionStatus.values()) {
			if (extensionStatus.activationStarted) {
				previouslyActivatedExtensionIds.push(extensionStatus.id);
			}
		}

		await this._extensionHostManagers.stopAllInReverse();
		for (const extensionStatus of this._extensionStatus.values()) {
			extensionStatus.clearRuntimeStatus();
		}

		if (previouslyActivatedExtensionIds.length > 0) {
			this._onDidChangeExtensionsStatus.fire(previouslyActivatedExtensionIds);
		}
	}

	/**
	 * Attempts to stop extension hosts with veto support.
	 *
	 * Fires the `onWillStop` event to allow extensions to veto the shutdown.
	 * If a veto is received and this is not an automatic stop, a confirmation
	 * dialog is shown to the user asking whether to proceed anyway.
	 *
	 * @param reason - A human-readable reason for stopping.
	 * @param auto - Whether this is an automatic stop. Automatic stops during
	 *   extension development are silently skipped.
	 * @returns `true` if hosts were not stopped (vetoed) or the user should
	 *   proceed, `false` if the veto was accepted.
	 */
	private async _doStopExtensionHostsWithVeto(reason: string, auto: boolean = false): Promise<boolean> {
		if (auto && this._environmentService.isExtensionDevelopment) {
			return false;
		}

		const vetos: (boolean | Promise<boolean>)[] = [];
		const vetoReasons = new Set<string>();

		this._onWillStop.fire({
			reason,
			auto,
			veto(value, reason) {
				vetos.push(value);

				if (typeof value === 'boolean') {
					if (value === true) {
						vetoReasons.add(reason);
					}
				} else {
					value.then(value => {
						if (value) {
							vetoReasons.add(reason);
						}
					}).catch(error => {
						vetoReasons.add(nls.localize('extensionStopVetoError', "{0} (Error: {1})", reason, toErrorMessage(error)));
					});
				}
			}
		});

		const veto = await handleVetos(vetos, error => this._logService.error(error));
		if (!veto) {
			await this._doStopExtensionHosts();
		} else {
			if (!auto) {
				const vetoReasonsArray = Array.from(vetoReasons);

				this._logService.warn(`Extension host was not stopped because of veto (stop reason: ${reason}, veto reason: ${vetoReasonsArray.join(', ')})`);

				const { confirmed } = await this._dialogService.confirm({
					type: Severity.Warning,
					message: nls.localize('extensionStopVetoMessage', "Please confirm restart of extensions."),
					detail: vetoReasonsArray.length === 1 ?
						vetoReasonsArray[0] :
						vetoReasonsArray.join('\n -'),
					primaryButton: nls.localize('proceedAnyways', "Restart Anyway")
				});

				if (confirmed) {
					return true;
				}
			}

		}

		return !veto;
	}

	/**
	 * Creates and starts extension host managers for all running locations that
	 * do not already have a manager.
	 *
	 * Iterates through all local process affinities, local web worker affinities,
	 * and the remote running location, creating managers for any that are missing.
	 *
	 * @param isInitialStart - Whether this is the initial startup.
	 * @param initialActivationEvents - Activation events to pass to newly created
	 *   extension host managers.
	 */
	protected _startExtensionHostsIfNecessary(isInitialStart: boolean, initialActivationEvents: string[]): void {
		const locations: ExtensionRunningLocation[] = [];
		for (let affinity = 0; affinity <= this._runningLocations.maxLocalProcessAffinity; affinity++) {
			locations.push(new LocalProcessRunningLocation(affinity));
		}
		for (let affinity = 0; affinity <= this._runningLocations.maxLocalWebWorkerAffinity; affinity++) {
			locations.push(new LocalWebWorkerRunningLocation(affinity));
		}
		locations.push(new RemoteRunningLocation());
		for (const location of locations) {
			if (this._extensionHostManagers.getByRunningLocation(location)) {
				// already running
				continue;
			}
			const res = this._createExtensionHostManager(location, isInitialStart, initialActivationEvents);
			if (res) {
				const [extHostManager, disposableStore] = res;
				this._extensionHostManagers.add(extHostManager, disposableStore);
			}
		}
	}

	/**
	 * Creates an extension host manager for the given running location.
	 *
	 * Uses the extension host factory to create the host, wraps it in an
	 * {@link ExtensionHostManager} or {@link LazyCreateExtensionHostManager},
	 * and registers crash/exit and responsive-state listeners.
	 *
	 * @param runningLocation - The running location for the new extension host.
	 * @param isInitialStart - Whether this is the initial startup.
	 * @param initialActivationEvents - Activation events to pass to the manager.
	 * @returns A tuple of the manager and its disposable store, or `null` if
	 *   the factory did not create an extension host for this location.
	 */
	private _createExtensionHostManager(runningLocation: ExtensionRunningLocation, isInitialStart: boolean, initialActivationEvents: string[]): null | [IExtensionHostManager, DisposableStore] {
		const extensionHost = this._extensionHostFactory.createExtensionHost(this._runningLocations, runningLocation, isInitialStart);
		if (!extensionHost) {
			return null;
		}

		const processManager: IExtensionHostManager = this._doCreateExtensionHostManager(extensionHost, initialActivationEvents);
		const disposableStore = new DisposableStore();
		disposableStore.add(processManager.onDidExit(([code, signal]) => this._onExtensionHostCrashOrExit(processManager, code, signal)));
		disposableStore.add(processManager.onDidChangeResponsiveState((responsiveState) => {
			this._logService.info(`Extension host (${processManager.friendyName}) is ${responsiveState === ResponsiveState.Responsive ? 'responsive' : 'unresponsive'}.`);
			this._onDidChangeResponsiveChange.fire({
				extensionHostKind: processManager.kind,
				isResponsive: responsiveState === ResponsiveState.Responsive,
				getInspectListener: (tryEnableInspector: boolean) => {
					return processManager.getInspectPort(tryEnableInspector);
				}
			});
		}));
		return [processManager, disposableStore];
	}

	/**
	 * Creates the appropriate extension host manager based on the host's startup
	 * strategy.
	 *
	 * Uses {@link LazyCreateExtensionHostManager} for lazy-starting hosts and
	 * {@link ExtensionHostManager} for eager-starting hosts.
	 *
	 * @param extensionHost - The extension host to manage.
	 * @param initialActivationEvents - Activation events to pass to the manager.
	 * @returns The created extension host manager.
	 */
	protected _doCreateExtensionHostManager(extensionHost: IExtensionHost, initialActivationEvents: string[]): IExtensionHostManager {
		const internalExtensionService = this._acquireInternalAPI(extensionHost);
		if (extensionHost.startup === ExtensionHostStartup.LazyAutoStart) {
			return this._instantiationService.createInstance(LazyCreateExtensionHostManager, extensionHost, initialActivationEvents, internalExtensionService);
		}
		return this._instantiationService.createInstance(ExtensionHostManager, extensionHost, initialActivationEvents, internalExtensionService);
	}

	/**
	 * Dispatches an extension host termination event to the crash or exit handler.
	 *
	 * In extension development mode, termination is treated as a normal exit
	 * (e.g. the debugger disconnected). Otherwise, it is treated as a crash.
	 *
	 * @param extensionHost - The terminated extension host manager.
	 * @param code - The process exit code.
	 * @param signal - The termination signal, if any.
	 */
	private _onExtensionHostCrashOrExit(extensionHost: IExtensionHostManager, code: number, signal: string | null): void {

		// Unexpected termination
		const isExtensionDevHost = parseExtensionDevOptions(this._environmentService).isExtensionDevHost;
		if (!isExtensionDevHost) {
			this._onExtensionHostCrashed(extensionHost, code, signal);
			return;
		}

		this._onExtensionHostExit(code);
	}

	/**
	 * Handles an unexpected extension host crash.
	 *
	 * For local process extension hosts, stops all extension hosts. For remote
	 * extension hosts with a signal, delegates to the remote crash handler and
	 * stops only the crashed host.
	 *
	 * @param extensionHost - The crashed extension host manager.
	 * @param code - The process exit code.
	 * @param signal - The termination signal, if any.
	 */
	protected _onExtensionHostCrashed(extensionHost: IExtensionHostManager, code: number, signal: string | null): void {
		console.error(`Extension host (${extensionHost.friendyName}) terminated unexpectedly. Code: ${code}, Signal: ${signal}`);
		if (extensionHost.kind === ExtensionHostKind.LocalProcess) {
			this._doStopExtensionHosts();
		} else if (extensionHost.kind === ExtensionHostKind.Remote) {
			if (signal) {
				this._onRemoteExtensionHostCrashed(extensionHost, signal);
			}
			this._extensionHostManagers.stopOne(extensionHost);
		}
	}

	/**
	 * Retrieves exit information for a crashed remote extension host with a
	 * 2-second timeout.
	 *
	 * @param reconnectionToken - The reconnection token identifying the crashed host.
	 * @returns The exit info, or `null` if the remote agent does not have the info.
	 * @throws {Error} If the request times out after 2 seconds.
	 */
	private _getExtensionHostExitInfoWithTimeout(reconnectionToken: string): Promise<IExtensionHostExitInfo | null> {
		return new Promise((resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				reject(new Error('getExtensionHostExitInfo timed out'));
			}, 2000);
			this._remoteAgentService.getExtensionHostExitInfo(reconnectionToken).then(
				(r) => {
					clearTimeout(timeoutHandle);
					resolve(r);
				},
				reject
			);
		});
	}

	/**
	 * Handles a remote extension host crash with automatic restart logic.
	 *
	 * If the host has crashed fewer than 3 times in the last 5 minutes, it is
	 * automatically restarted with a transient notification. Otherwise, an error
	 * notification is shown with a manual restart action.
	 *
	 * @param extensionHost - The crashed remote extension host manager.
	 * @param reconnectionToken - The reconnection token for retrieving exit info.
	 */
	protected async _onRemoteExtensionHostCrashed(extensionHost: IExtensionHostManager, reconnectionToken: string): Promise<void> {
		try {
			const info = await this._getExtensionHostExitInfoWithTimeout(reconnectionToken);
			if (info) {
				this._logService.error(`Extension host (${extensionHost.friendyName}) terminated unexpectedly with code ${info.code}.`);
			}

			this._logExtensionHostCrash(extensionHost);
			this._remoteCrashTracker.registerCrash();

			if (this._remoteCrashTracker.shouldAutomaticallyRestart()) {
				this._logService.info(`Automatically restarting the remote extension host.`);
				this._notificationService.status(nls.localize('extensionService.autoRestart', "The remote extension host terminated unexpectedly. Restarting..."), { hideAfter: 5000 });
				this._startExtensionHostsIfNecessary(false, Array.from(this._allRequestedActivateEvents.keys()));
			} else {
				this._notificationService.prompt(Severity.Error, nls.localize('extensionService.crash', "Remote Extension host terminated unexpectedly 3 times within the last 5 minutes."),
					[{
						label: nls.localize('restart', "Restart Remote Extension Host"),
						run: () => {
							this._startExtensionHostsIfNecessary(false, Array.from(this._allRequestedActivateEvents.keys()));
						}
					}]
				);
			}
		} catch (err) {
			// maybe this wasn't an extension host crash and it was a permanent disconnection
		}
	}

	/**
	 * Logs details about a crashed extension host, including the list of
	 * extensions that were activated at the time of the crash.
	 *
	 * @param extensionHost - The crashed extension host manager.
	 */
	protected _logExtensionHostCrash(extensionHost: IExtensionHostManager): void {

		const activatedExtensions: ExtensionIdentifier[] = [];
		for (const extensionStatus of this._extensionStatus.values()) {
			if (extensionStatus.activationStarted && extensionHost.containsExtension(extensionStatus.id)) {
				activatedExtensions.push(extensionStatus.id);
			}
		}

		if (activatedExtensions.length > 0) {
			this._logService.error(`Extension host (${extensionHost.friendyName}) terminated unexpectedly. The following extensions were running: ${activatedExtensions.map(id => id.value).join(', ')}`);
		} else {
			this._logService.error(`Extension host (${extensionHost.friendyName}) terminated unexpectedly. No extensions were activated.`);
		}
	}

	/**
	 * Stops all extension hosts, optionally applies delta updates, then restarts
	 * all extension hosts and waits for local process hosts to become ready.
	 *
	 * @param updates - Optional delta updates to apply before restarting.
	 *   If provided, extensions are added/removed before hosts are started.
	 */
	public async startExtensionHosts(updates?: { toAdd: IExtension[]; toRemove: string[] }): Promise<void> {
		await this._doStopExtensionHosts();

		if (updates) {
			await this._handleDeltaExtensions(new DeltaExtensionsQueueItem(updates.toAdd, updates.toRemove));
		}

		const lock = await this._registry.acquireLock('startExtensionHosts');
		try {
			this._startExtensionHostsIfNecessary(false, Array.from(this._allRequestedActivateEvents.keys()));
			this._startOnDemandExtensionHosts();

			const localProcessExtensionHosts = this._getExtensionHostManagers(ExtensionHostKind.LocalProcess);
			await Promise.all(localProcessExtensionHosts.map(extHost => extHost.ready()));
		} finally {
			lock.dispose();
		}
	}

	/**
	 * Starts extension hosts that use on-demand (lazy) startup by delivering
	 * the current registry snapshot and the set of extensions assigned to each host.
	 */
	private _startOnDemandExtensionHosts(): void {
		const snapshot = this._registry.getSnapshot();
		for (const extHostManager of this._extensionHostManagers) {
			if (extHostManager.startup !== ExtensionHostStartup.EagerAutoStart) {
				const extensions = this._runningLocations.filterByExtensionHostManager(snapshot.extensions, extHostManager);
				extHostManager.start(snapshot.versionId, snapshot.extensions, extensions.map(extension => extension.identifier));
			}
		}
	}

	//#endregion

	//#region IExtensionService

	/**
	 * Activates extensions that listen for the given activation event.
	 *
	 * If extensions have not been scanned yet, the event is recorded and
	 * activation is deferred until initialization completes (unless the activation
	 * kind is {@link ActivationKind.Immediate}, in which case initialization is
	 * kicked off without awaiting).
	 *
	 * @param activationEvent - The activation event to dispatch.
	 * @param activationKind - The activation kind controlling urgency.
	 * @returns A promise that resolves when all relevant hosts have processed
	 *   the activation event.
	 */
	public activateByEvent(activationEvent: string, activationKind: ActivationKind = ActivationKind.Normal): Promise<void> {
		if (this._installedExtensionsReady.isOpen()) {
			// Extensions have been scanned and interpreted

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents.add(activationEvent);

			if (!this._registry.containsActivationEvent(activationEvent)) {
				// There is no extension that is interested in this activation event
				return NO_OP_VOID_PROMISE;
			}

			return this._activateByEvent(activationEvent, activationKind);
		} else {
			// Extensions have not been scanned yet.

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents.add(activationEvent);

			if (activationKind === ActivationKind.Immediate) {
				// Do not wait for the normal start-up of the extension host(s)

				// Note: some callers come in so early that the extension hosts have not even been created yet.
				// Therefore we kick off the extension host creation, but without awaiting it.
				// See https://github.com/microsoft/vscode/issues/260061
				void this._initializeIfNeeded();

				return this._activateByEvent(activationEvent, activationKind);
			}

			return this._installedExtensionsReady.wait().then(() => this._activateByEvent(activationEvent, activationKind));
		}
	}

	/**
	 * Dispatches an activation event to the appropriate extension host managers.
	 *
	 * For {@link ActivationKind.Immediate}, only local hosts and already-ready
	 * remote hosts are targeted; the event is also deferred for remote hosts that
	 * are not yet ready. For normal activation, all hosts are targeted.
	 *
	 * @param activationEvent - The activation event to dispatch.
	 * @param activationKind - The activation kind controlling which hosts receive
	 *   the event immediately.
	 * @returns A promise that resolves when all targeted hosts have processed
	 *   the activation event.
	 */
	private _activateByEvent(activationEvent: string, activationKind: ActivationKind): Promise<void> {
		let managers: IExtensionHostManager[];
		if (activationKind === ActivationKind.Immediate) {
			// For immediate activation, only activate on local extension hosts
			// and on remote extension hosts that are already ready.
			// Defer activation for remote hosts that are not yet ready to avoid
			// blocking (e.g. during remote authority resolution).
			managers = this._extensionHostManagers.filter(
				extHostManager => extHostManager.kind === ExtensionHostKind.LocalProcess
					|| extHostManager.kind === ExtensionHostKind.LocalWebWorker
					|| extHostManager.isReady
			);
			this._pendingRemoteActivationEvents.add(activationEvent);
		} else {
			managers = [...this._extensionHostManagers];
		}

		const result = Promise.all(
			managers.map(extHostManager => extHostManager.activateByEvent(activationEvent, activationKind))
		).then(() => { });
		this._onWillActivateByEvent.fire({
			event: activationEvent,
			activation: result,
			activationKind
		});
		return result;
	}

	/**
	 * Activates an extension by its identifier on all extension host managers.
	 *
	 * @param extensionId - The identifier of the extension to activate.
	 * @param reason - The reason for activation.
	 * @throws {Error} If no extension host manager recognizes the extension.
	 */
	public activateById(extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<void> {
		return this._activateById(extensionId, reason);
	}

	/**
	 * Checks whether an activation event has been fully processed by all
	 * extension host managers.
	 *
	 * @param activationEvent - The activation event to check.
	 * @returns `true` if extensions have not been scanned yet, if no extension
	 *   listens for the event, or if all hosts have finished processing it.
	 */
	public activationEventIsDone(activationEvent: string): boolean {
		if (!this._installedExtensionsReady.isOpen()) {
			return false;
		}
		if (!this._registry.containsActivationEvent(activationEvent)) {
			// There is no extension that is interested in this activation event
			return true;
		}
		return this._extensionHostManagers.every(manager => manager.activationEventIsDone(activationEvent));
	}

	/**
	 * Returns a promise that resolves when all installed extensions have been
	 * scanned and registered.
	 *
	 * @returns A promise that resolves to `true` once the extensions barrier
	 *   is open.
	 */
	public whenInstalledExtensionsRegistered(): Promise<boolean> {
		return this._installedExtensionsReady.wait();
	}

	/**
	 * Returns all registered extension descriptions.
	 *
	 * @returns An array of all extension descriptions in the registry.
	 */
	get extensions(): IExtensionDescription[] {
		return this._registry.getAllExtensionDescriptions();
	}

	/**
	 * Returns a snapshot of the extension description registry once extensions
	 * are fully registered.
	 *
	 * @returns A promise that resolves to the registry snapshot.
	 */
	protected _getExtensionRegistrySnapshotWhenReady(): Promise<ExtensionDescriptionRegistrySnapshot> {
		return this._installedExtensionsReady.wait().then(() => this._registry.getSnapshot());
	}

	/**
	 * Retrieves an extension description by its identifier string.
	 *
	 * @param id - The extension identifier string (e.g. `publisher.extensionName`).
	 * @returns A promise that resolves to the extension description, or `undefined`
	 *   if no matching extension is found.
	 */
	public getExtension(id: string): Promise<IExtensionDescription | undefined> {
		return this._installedExtensionsReady.wait().then(() => {
			return this._registry.getExtensionDescription(id);
		});
	}

	/**
	 * Reads all contributions to a given extension point from registered extensions.
	 *
	 * @typeParam T - The contribution type of the extension point.
	 * @param extPoint - The extension point to read contributions for.
	 * @returns A promise that resolves to an array of contributions from all
	 *   extensions that declare a contribution to this extension point.
	 */
	public readExtensionPointContributions<T extends IExtensionContributions[keyof IExtensionContributions]>(extPoint: IExtensionPoint<T>): Promise<ExtensionPointContribution<T>[]> {
		return this._installedExtensionsReady.wait().then(() => {
			const availableExtensions = this._registry.getAllExtensionDescriptions();

			const result: ExtensionPointContribution<T>[] = [];
			for (const desc of availableExtensions) {
				if (desc.contributes && hasOwnProperty.call(desc.contributes, extPoint.name)) {
					result.push(new ExtensionPointContribution<T>(desc, desc.contributes[extPoint.name as keyof typeof desc.contributes] as T));
				}
			}

			return result;
		});
	}

	/**
	 * Returns the current status of all registered extensions.
	 *
	 * @returns A map from extension identifier values to their status objects,
	 *   including messages, activation state, activation times, runtime errors,
	 *   and running location.
	 */
	public getExtensionsStatus(): { [id: string]: IExtensionsStatus } {
		const result: { [id: string]: IExtensionsStatus } = Object.create(null);
		if (this._registry) {
			const extensions = this._registry.getAllExtensionDescriptions();
			for (const extension of extensions) {
				const extensionStatus = this._extensionStatus.get(extension.identifier);
				result[extension.identifier.value] = {
					id: extension.identifier,
					messages: extensionStatus?.messages ?? [],
					activationStarted: extensionStatus?.activationStarted ?? false,
					activationTimes: extensionStatus?.activationTimes ?? undefined,
					runtimeErrors: extensionStatus?.runtimeErrors ?? [],
					runningLocation: this._runningLocations.getRunningLocation(extension.identifier),
				};
			}
		}
		return result;
	}

	/**
	 * Returns the debug/inspect ports for all extension hosts of the given kind.
	 *
	 * @param extensionHostKind - The extension host kind to query.
	 * @param tryEnableInspector - Whether to attempt enabling the inspector
	 *   on hosts that do not already have it active.
	 * @returns An array of inspect info objects with port and debug label details.
	 */
	public async getInspectPorts(extensionHostKind: ExtensionHostKind, tryEnableInspector: boolean): Promise<IExtensionInspectInfo[]> {
		const result = await Promise.all(
			this._getExtensionHostManagers(extensionHostKind).map(async extHost => {
				let portInfo = await extHost.getInspectPort(tryEnableInspector);
				if (portInfo !== undefined) {
					portInfo = { ...portInfo, devtoolsLabel: extHost.friendyName };
				}
				return portInfo;
			})
		);
		// remove 0s:
		return result.filter(isDefined);
	}

	/**
	 * Sets environment variables on all extension hosts for remote extension
	 * debugging scenarios.
	 *
	 * @param env - A map of environment variable names to their values (or `null`
	 *   to unset a variable).
	 */
	public async setRemoteEnvironment(env: { [key: string]: string | null }): Promise<void> {
		await this._extensionHostManagers
			.map(manager => manager.setRemoteEnvironment(env));
	}

	//#endregion

	// --- impl

	/**
	 * Safely checks whether an extension is enabled, catching any errors from
	 * the enablement service.
	 *
	 * @param extension - The extension to check.
	 * @returns `true` if the extension is enabled, `false` if disabled or if
	 *   the enablement check throws an error.
	 */
	private _safeInvokeIsEnabled(extension: IExtension): boolean {
		try {
			return this._extensionEnablementService.isEnabled(extension);
		} catch (err) {
			return false;
		}
	}

	/**
	 * Processes extension points affected by a set of extensions.
	 *
	 * Collects all extension point names contributed by the affected extensions,
	 * then calls {@link AbstractExtensionService._handleExtensionPoint} for each
	 * matching registered extension point. Records performance marks for
	 * diagnostic purposes.
	 *
	 * @param affectedExtensions - The extensions whose extension points should
	 *   be processed.
	 * @param onlyResolverExtensionPoints - If `true`, only extension points that
	 *   can handle resolver extensions are processed.
	 */
	private _doHandleExtensionPoints(affectedExtensions: IExtensionDescription[], onlyResolverExtensionPoints: boolean): void {
		const affectedExtensionPoints: { [extPointName: string]: boolean } = Object.create(null);
		for (const extensionDescription of affectedExtensions) {
			if (extensionDescription.contributes) {
				for (const extPointName in extensionDescription.contributes) {
					if (hasOwnProperty.call(extensionDescription.contributes, extPointName)) {
						affectedExtensionPoints[extPointName] = true;
					}
				}
			}
		}

		const messageHandler = (msg: IMessage) => this._handleExtensionPointMessage(msg);
		const availableExtensions = this._registry.getAllExtensionDescriptions();
		const extensionPoints = ExtensionsRegistry.getExtensionPoints();
		perf.mark(onlyResolverExtensionPoints ? 'code/willHandleResolverExtensionPoints' : 'code/willHandleExtensionPoints');
		for (const extensionPoint of extensionPoints) {
			if (affectedExtensionPoints[extensionPoint.name] && (!onlyResolverExtensionPoints || extensionPoint.canHandleResolver)) {
				perf.mark(`code/willHandleExtensionPoint/${extensionPoint.name}`);
				AbstractExtensionService._handleExtensionPoint(extensionPoint, availableExtensions, messageHandler);
				perf.mark(`code/didHandleExtensionPoint/${extensionPoint.name}`);
			}
		}
		perf.mark(onlyResolverExtensionPoints ? 'code/didHandleResolverExtensionPoints' : 'code/didHandleExtensionPoints');
	}

	/**
	 * Returns the {@link ExtensionStatus} for the given extension, creating one
	 * if it does not already exist.
	 *
	 * @param extensionId - The extension identifier.
	 * @returns The existing or newly created extension status.
	 */
	private _getOrCreateExtensionStatus(extensionId: ExtensionIdentifier): ExtensionStatus {
		if (!this._extensionStatus.has(extensionId)) {
			this._extensionStatus.set(extensionId, new ExtensionStatus(extensionId));
		}
		return this._extensionStatus.get(extensionId)!;
	}

	/**
	 * Handles a validation message from an extension point.
	 *
	 * Adds the message to the extension's status, logs it at the appropriate
	 * severity level, shows a notification for extensions under development,
	 * and reports the message via telemetry in production builds.
	 *
	 * @param msg - The extension point validation message.
	 */
	private _handleExtensionPointMessage(msg: IMessage) {
		const extensionStatus = this._getOrCreateExtensionStatus(msg.extensionId);
		extensionStatus.addMessage(msg);

		const extension = this._registry.getExtensionDescription(msg.extensionId);
		const strMsg = `[${msg.extensionId.value}]: ${msg.message}`;

		if (msg.type === Severity.Error) {
			if (extension && extension.isUnderDevelopment) {
				// This message is about the extension currently being developed
				this._notificationService.notify({ severity: Severity.Error, message: strMsg });
			}
			this._logService.error(strMsg);
		} else if (msg.type === Severity.Warning) {
			if (extension && extension.isUnderDevelopment) {
				// This message is about the extension currently being developed
				this._notificationService.notify({ severity: Severity.Warning, message: strMsg });
			}
			this._logService.warn(strMsg);
		} else {
			this._logService.info(strMsg);
		}

		if (msg.extensionId && this._environmentService.isBuilt && !this._environmentService.isExtensionDevelopment) {
			const { type, extensionId, extensionPointId, message } = msg;
			type ExtensionsMessageClassification = {
				owner: 'alexdima';
				comment: 'A validation message for an extension';
				type: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Severity of problem.' };
				extensionId: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the extension that has a problem.' };
				extensionPointId: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The extension point that has a problem.' };
				message: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The message of the problem.' };
			};
			type ExtensionsMessageEvent = {
				type: Severity;
				extensionId: string;
				extensionPointId: string;
				message: string;
			};
			this._telemetryService.publicLog2<ExtensionsMessageEvent, ExtensionsMessageClassification>('extensionsMessage', {
				type, extensionId: extensionId.value, extensionPointId, message
			});
		}
	}

	/**
	 * Collects all user contributions to an extension point from the available
	 * extensions and passes them to the extension point for validation and
	 * registration.
	 *
	 * @typeParam T - The contribution type of the extension point.
	 * @param extensionPoint - The extension point to process.
	 * @param availableExtensions - All registered extension descriptions.
	 * @param messageHandler - Callback for validation messages emitted during
	 *   contribution processing.
	 */
	private static _handleExtensionPoint<T extends IExtensionContributions[keyof IExtensionContributions]>(extensionPoint: ExtensionPoint<T>, availableExtensions: IExtensionDescription[], messageHandler: (msg: IMessage) => void): void {
		const users: IExtensionPointUser<T>[] = [];
		for (const desc of availableExtensions) {
			if (desc.contributes && hasOwnProperty.call(desc.contributes, extensionPoint.name)) {
				users.push({
					description: desc,
					value: desc.contributes[extensionPoint.name as keyof typeof desc.contributes] as T,
					collector: new ExtensionMessageCollector(messageHandler, desc, extensionPoint.name)
				});
			}
		}
		extensionPoint.acceptUsers(users);
	}

	//#region Called by extension host

	/**
	 * Creates an internal extension service API object for an extension host.
	 *
	 * This API is passed to extension host managers so they can invoke
	 * activation, report activation results, and report runtime errors back
	 * to the extension service.
	 *
	 * @param extensionHost - The extension host that will use this internal API.
	 * @returns The internal extension service interface.
	 */
	private _acquireInternalAPI(extensionHost: IExtensionHost): IInternalExtensionService {
		return {
			_activateById: (extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<void> => {
				return this._activateById(extensionId, reason);
			},
			_onWillActivateExtension: (extensionId: ExtensionIdentifier): void => {
				return this._onWillActivateExtension(extensionId, extensionHost.runningLocation);
			},
			_onDidActivateExtension: (extensionId: ExtensionIdentifier, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, activationReason: ExtensionActivationReason): void => {
				return this._onDidActivateExtension(extensionId, codeLoadingTime, activateCallTime, activateResolvedTime, activationReason);
			},
			_onDidActivateExtensionError: (extensionId: ExtensionIdentifier, error: Error): void => {
				return this._onDidActivateExtensionError(extensionId, error);
			},
			_onExtensionRuntimeError: (extensionId: ExtensionIdentifier, err: Error): void => {
				return this._onExtensionRuntimeError(extensionId, err);
			}
		};
	}

	/**
	 * Activates an extension by its identifier on all extension host managers.
	 *
	 * @param extensionId - The identifier of the extension to activate.
	 * @param reason - The reason for activation.
	 * @throws {Error} If no extension host manager reports successful activation.
	 */
	public async _activateById(extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<void> {
		const results = await Promise.all(
			this._extensionHostManagers.map(manager => manager.activate(extensionId, reason))
		);
		const activated = results.some(e => e);
		if (!activated) {
			throw new Error(`Unknown extension ${extensionId.value}`);
		}
	}

	/**
	 * Called when an extension host is about to activate an extension.
	 *
	 * Updates the running location for the extension and marks its activation
	 * as started in the status tracker.
	 *
	 * @param extensionId - The identifier of the extension being activated.
	 * @param runningLocation - The running location where the extension is
	 *   being activated.
	 */
	private _onWillActivateExtension(extensionId: ExtensionIdentifier, runningLocation: ExtensionRunningLocation): void {
		this._runningLocations.set(extensionId, runningLocation);
		const extensionStatus = this._getOrCreateExtensionStatus(extensionId);
		extensionStatus.onWillActivate();
	}

	/**
	 * Called when an extension has been successfully activated.
	 *
	 * Records the activation times and fires a status change event.
	 *
	 * @param extensionId - The identifier of the activated extension.
	 * @param codeLoadingTime - Time in milliseconds spent loading the extension code.
	 * @param activateCallTime - Time in milliseconds spent in the `activate` function call.
	 * @param activateResolvedTime - Time in milliseconds for the `activate` promise to resolve.
	 * @param activationReason - The reason the extension was activated.
	 */
	private _onDidActivateExtension(extensionId: ExtensionIdentifier, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, activationReason: ExtensionActivationReason): void {
		const extensionStatus = this._getOrCreateExtensionStatus(extensionId);
		extensionStatus.setActivationTimes(new ActivationTimes(codeLoadingTime, activateCallTime, activateResolvedTime, activationReason));
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	/**
	 * Reports an extension activation error via telemetry.
	 *
	 * @param extensionId - The identifier of the extension that failed to activate.
	 * @param error - The activation error.
	 */
	private _onDidActivateExtensionError(extensionId: ExtensionIdentifier, error: Error): void {
		type ExtensionActivationErrorClassification = {
			owner: 'alexdima';
			comment: 'An extension failed to activate';
			extensionId: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The identifier of the extension.' };
			error: { classification: 'CallstackOrException'; purpose: 'PerformanceAndHealth'; comment: 'The error message.' };
		};
		type ExtensionActivationErrorEvent = {
			extensionId: string;
			error: string;
		};
		this._telemetryService.publicLog2<ExtensionActivationErrorEvent, ExtensionActivationErrorClassification>('extensionActivationError', {
			extensionId: extensionId.value,
			error: error.message
		});
	}

	/**
	 * Records a runtime error from an extension and fires a status change event.
	 *
	 * @param extensionId - The identifier of the extension that threw the error.
	 * @param err - The runtime error.
	 */
	private _onExtensionRuntimeError(extensionId: ExtensionIdentifier, err: Error): void {
		const extensionStatus = this._getOrCreateExtensionStatus(extensionId);
		extensionStatus.addRuntimeError(err);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	//#endregion

	/**
	 * Resolves extensions by yielding {@link ResolvedExtensions} events through
	 * an async iterable. Subclasses must implement this to provide platform-specific
	 * extension scanning and remote authority resolution.
	 */
	protected abstract _resolveExtensions(): AsyncIterable<ResolvedExtensions>;

	/**
	 * Called when an extension host exits (as opposed to crashing).
	 * Subclasses must implement this to handle clean shutdown scenarios.
	 *
	 * @param code - The process exit code.
	 */
	protected abstract _onExtensionHostExit(code: number): Promise<void>;

	/**
	 * Resolves a remote authority string to connection metadata.
	 * Subclasses must implement this to delegate resolution to the appropriate
	 * extension host kind.
	 *
	 * @param remoteAuthority - The remote authority string to resolve.
	 * @returns The resolved authority result.
	 */
	protected abstract _resolveAuthority(remoteAuthority: string): Promise<ResolverResult>;
}

/**
 * Manages a collection of extension host managers with lifecycle support
 * for adding, stopping, and querying by kind or running location.
 */
class ExtensionHostCollection extends Disposable {

	private _extensionHostManagers: ExtensionHostManagerData[] = [];

	/**
	 * Disconnects and disposes all extension host managers.
	 */
	public override dispose() {
		for (let i = this._extensionHostManagers.length - 1; i >= 0; i--) {
			const manager = this._extensionHostManagers[i];
			manager.extensionHost.disconnect();
			manager.dispose();
		}
		this._extensionHostManagers = [];
		super.dispose();
	}

	/**
	 * Adds an extension host manager to the collection.
	 *
	 * @param extensionHostManager - The extension host manager to add.
	 * @param disposableStore - A disposable store containing listeners associated
	 *   with the manager that should be disposed when the manager is removed.
	 */
	public add(extensionHostManager: IExtensionHostManager, disposableStore: DisposableStore): void {
		this._extensionHostManagers.push(new ExtensionHostManagerData(extensionHostManager, disposableStore));
	}

	/**
	 * Stops all extension host managers in reverse creation order.
	 *
	 * Disconnection happens in reverse order because the local extension host
	 * may be sustaining a connection to the remote extension host.
	 */
	public async stopAllInReverse(): Promise<void> {
		// See https://github.com/microsoft/vscode/issues/152204
		// Dispose extension hosts in reverse creation order because the local extension host
		// might be critical in sustaining a connection to the remote extension host
		for (let i = this._extensionHostManagers.length - 1; i >= 0; i--) {
			const manager = this._extensionHostManagers[i];
			await manager.extensionHost.disconnect();
			manager.dispose();
		}
		this._extensionHostManagers = [];
	}

	/**
	 * Stops and removes a single extension host manager from the collection.
	 *
	 * @param extensionHostManager - The extension host manager to stop.
	 */
	public async stopOne(extensionHostManager: IExtensionHostManager): Promise<void> {
		const index = this._extensionHostManagers.findIndex(el => el.extensionHost === extensionHostManager);
		if (index >= 0) {
			this._extensionHostManagers.splice(index, 1);
			await extensionHostManager.disconnect();
			extensionHostManager.dispose();
		}
	}

	/**
	 * Returns all extension host managers of the specified kind.
	 *
	 * @param kind - The extension host kind to filter by.
	 * @returns An array of matching extension host managers.
	 */
	public getByKind(kind: ExtensionHostKind): IExtensionHostManager[] {
		return this.filter(el => el.kind === kind);
	}

	/**
	 * Returns the extension host manager that represents the given running location.
	 *
	 * @param runningLocation - The running location to search for.
	 * @returns The matching extension host manager, or `null` if not found.
	 */
	public getByRunningLocation(runningLocation: ExtensionRunningLocation): IExtensionHostManager | null {
		for (const el of this._extensionHostManagers) {
			if (el.extensionHost.representsRunningLocation(runningLocation)) {
				return el.extensionHost;
			}
		}
		return null;
	}

	/** Iterates over all extension host managers in the collection. */
	*[Symbol.iterator]() {
		for (const extensionHostManager of this._extensionHostManagers) {
			yield extensionHostManager.extensionHost;
		}
	}

	/**
	 * Maps all extension host managers through a callback function.
	 *
	 * @param callback - The mapping function.
	 * @returns An array of mapped results.
	 */
	public map<T>(callback: (extHostManager: IExtensionHostManager) => T): T[] {
		return this._extensionHostManagers.map(el => callback(el.extensionHost));
	}

	/**
	 * Tests whether all extension host managers pass the provided predicate.
	 *
	 * @param callback - The predicate function.
	 * @returns `true` if all managers pass the predicate.
	 */
	public every(callback: (extHostManager: IExtensionHostManager) => unknown): boolean {
		return this._extensionHostManagers.every(el => callback(el.extensionHost));
	}

	/**
	 * Filters extension host managers by the provided predicate.
	 *
	 * @param callback - The predicate function.
	 * @returns An array of managers that pass the predicate.
	 */
	public filter(callback: (extHostManager: IExtensionHostManager) => unknown): IExtensionHostManager[] {
		return this._extensionHostManagers.filter(el => callback(el.extensionHost)).map(el => el.extensionHost);
	}
}

/**
 * Internal data wrapper pairing an extension host manager with its
 * associated disposable store (event listeners, etc.).
 */
class ExtensionHostManagerData {
	constructor(
		public readonly extensionHost: IExtensionHostManager,
		public readonly disposableStore: DisposableStore
	) { }

	public dispose(): void {
		this.disposableStore.dispose();
		this.extensionHost.dispose();
	}
}

/**
 * Wrapper for resolver extension descriptions yielded during extension resolution.
 *
 * Resolver extensions handle `onResolveRemoteAuthority:*` activation events
 * and are registered before other extensions so their extension points are
 * available early.
 */
export class ResolverExtensions {
	constructor(
		public readonly extensions: IExtensionDescription[],
	) { }
}

/**
 * Wrapper for local extension descriptions yielded during extension resolution.
 */
export class LocalExtensions {
	constructor(
		public readonly extensions: IExtensionDescription[],
	) { }
}

/**
 * Wrapper for remote extension descriptions yielded during extension resolution.
 */
export class RemoteExtensions {
	constructor(
		public readonly extensions: IExtensionDescription[],
	) { }
}

/** Discriminated union of extension groups yielded during extension resolution. */
export type ResolvedExtensions = ResolverExtensions | LocalExtensions | RemoteExtensions;

/**
 * Factory interface for creating extension hosts.
 *
 * Implementations are platform-specific and determine how extension hosts
 * are spawned and communicate with the main process.
 */
export interface IExtensionHostFactory {
	createExtensionHost(runningLocations: ExtensionRunningLocationTracker, runningLocation: ExtensionRunningLocation, isInitialStart: boolean): IExtensionHost | null;
}

/**
 * Queued item representing a batch of extensions to add and remove.
 * Used by the delta extensions queue to serialize extension changes.
 */
class DeltaExtensionsQueueItem {
	constructor(
		public readonly toAdd: IExtension[],
		public readonly toRemove: string[] | IExtension[]
	) { }
}

/**
 * Checks whether an extension is a resolver extension.
 *
 * Resolver extensions declare activation events matching `onResolveRemoteAuthority:`
 * and are used to resolve remote connections (e.g. Remote-SSH).
 *
 * @param extension - The extension description to check.
 * @returns `true` if the extension has at least one resolver activation event.
 */
export function isResolverExtension(extension: IExtensionDescription): boolean {
	return !!extension.activationEvents?.some(activationEvent => activationEvent.startsWith('onResolveRemoteAuthority:'));
}

/**
 * Updates proposed API proposals and returns only enabled extensions.
 *
 * @param logService - The log service for diagnostic output.
 * @param extensionEnablementService - The service for checking extension enablement.
 * @param extensionsProposedApi - The service for managing proposed API proposals.
 * @param extensions - The extensions to be checked.
 * @param ignoreWorkspaceTrust - Do not take workspace trust into account.
 * @returns The subset of extensions that are enabled.
 */
export function checkEnabledAndProposedAPI(logService: ILogService, extensionEnablementService: IWorkbenchExtensionEnablementService, extensionsProposedApi: ExtensionsProposedApi, extensions: IExtensionDescription[], ignoreWorkspaceTrust: boolean): IExtensionDescription[] {
	// enable or disable proposed API per extension
	extensionsProposedApi.updateEnabledApiProposals(extensions);

	// keep only enabled extensions
	return filterEnabledExtensions(logService, extensionEnablementService, extensions, ignoreWorkspaceTrust);
}

/**
 * Returns the subset of extensions that are enabled.
 *
 * Extensions under development are always included. Other extensions are
 * checked against the enablement service.
 *
 * @param logService - The log service for diagnostic output.
 * @param extensionEnablementService - The service for checking extension enablement.
 * @param extensions - The extensions to filter.
 * @param ignoreWorkspaceTrust - Do not take workspace trust into account.
 * @returns The subset of extensions that are enabled.
 */
export function filterEnabledExtensions(logService: ILogService, extensionEnablementService: IWorkbenchExtensionEnablementService, extensions: IExtensionDescription[], ignoreWorkspaceTrust: boolean): IExtensionDescription[] {
	const enabledExtensions: IExtensionDescription[] = [], extensionsToCheck: IExtensionDescription[] = [], mappedExtensions: IExtension[] = [];
	for (const extension of extensions) {
		if (extension.isUnderDevelopment) {
			// Never disable extensions under development
			enabledExtensions.push(extension);
		} else {
			extensionsToCheck.push(extension);
			mappedExtensions.push(toExtension(extension));
		}
	}

	const enablementStates = extensionEnablementService.getEnablementStates(mappedExtensions, ignoreWorkspaceTrust ? { trusted: true } : undefined);
	for (let index = 0; index < enablementStates.length; index++) {
		if (extensionEnablementService.isEnabledEnablementState(enablementStates[index])) {
			enabledExtensions.push(extensionsToCheck[index]);
		} else {
			if (isCI) {
				logService.info(`filterEnabledExtensions: extension '${extensionsToCheck[index].identifier.value}' is disabled`);
			}
		}
	}

	return enabledExtensions;
}

/**
 * Checks whether a single extension is enabled.
 *
 * @param logService - The log service for diagnostic output.
 * @param extensionEnablementService - The service for checking extension enablement.
 * @param extension - The extension to check.
 * @param ignoreWorkspaceTrust - Do not take workspace trust into account.
 * @returns `true` if the extension is enabled.
 */
export function extensionIsEnabled(logService: ILogService, extensionEnablementService: IWorkbenchExtensionEnablementService, extension: IExtensionDescription, ignoreWorkspaceTrust: boolean): boolean {
	return filterEnabledExtensions(logService, extensionEnablementService, [extension], ignoreWorkspaceTrust).includes(extension);
}

/**
 * Checks whether an extension with the given identifier exists in the array.
 *
 * @param extensions - The array of extension descriptions to search.
 * @param identifier - The extension identifier to look for.
 * @returns `true` if a matching extension is found.
 */
function includes(extensions: IExtensionDescription[], identifier: ExtensionIdentifier): boolean {
	for (const extension of extensions) {
		if (ExtensionIdentifier.equals(extension.identifier, identifier)) {
			return true;
		}
	}
	return false;
}

/**
 * Tracks the runtime status of a single extension, including activation state,
 * activation times, validation messages, and runtime errors.
 */
export class ExtensionStatus {

	private readonly _messages: IMessage[] = [];
	public get messages(): IMessage[] {
		return this._messages;
	}

	private _activationTimes: ActivationTimes | null = null;
	public get activationTimes(): ActivationTimes | null {
		return this._activationTimes;
	}

	private _runtimeErrors: Error[] = [];
	public get runtimeErrors(): Error[] {
		return this._runtimeErrors;
	}

	private _activationStarted: boolean = false;
	public get activationStarted(): boolean {
		return this._activationStarted;
	}

	constructor(
		public readonly id: ExtensionIdentifier,
	) { }

	/**
	 * Clears all runtime status: resets activation state, times, and errors.
	 * Called when extension hosts are stopped.
	 */
	public clearRuntimeStatus(): void {
		this._activationStarted = false;
		this._activationTimes = null;
		this._runtimeErrors = [];
	}

	/**
	 * Adds a validation message (e.g. from extension point processing).
	 *
	 * @param msg - The validation message to add.
	 */
	public addMessage(msg: IMessage): void {
		this._messages.push(msg);
	}

	/**
	 * Sets the activation times for this extension.
	 *
	 * @param activationTimes - The recorded activation times.
	 */
	public setActivationTimes(activationTimes: ActivationTimes) {
		this._activationTimes = activationTimes;
	}

	/**
	 * Records a runtime error thrown by the extension.
	 *
	 * @param err - The runtime error.
	 */
	public addRuntimeError(err: Error): void {
		this._runtimeErrors.push(err);
	}

	/**
	 * Marks the extension as having started activation.
	 * Called before the extension's `activate` function is invoked.
	 */
	public onWillActivate() {
		this._activationStarted = true;
	}
}

/** Records the timestamp of a single extension host crash event. */
interface IExtensionHostCrashInfo {
	timestamp: number;
}

/**
 * Tracks remote extension host crash history to determine whether automatic
 * restart should be attempted.
 *
 * Maintains a sliding window of crash timestamps and allows automatic restart
 * only if fewer than 3 crashes have occurred within the last 5 minutes.
 */
export class ExtensionHostCrashTracker {

	private static _TIME_LIMIT = 5 * 60 * 1000; // 5 minutes
	private static _CRASH_LIMIT = 3;

	private readonly _recentCrashes: IExtensionHostCrashInfo[] = [];

	private _removeOldCrashes(): void {
		const limit = Date.now() - ExtensionHostCrashTracker._TIME_LIMIT;
		while (this._recentCrashes.length > 0 && this._recentCrashes[0].timestamp < limit) {
			this._recentCrashes.shift();
		}
	}

	/**
	 * Records a crash event at the current time after purging expired entries.
	 */
	public registerCrash(): void {
		this._removeOldCrashes();
		this._recentCrashes.push({ timestamp: Date.now() });
	}

	/**
	 * Determines whether the remote extension host should be automatically
	 * restarted after a crash.
	 *
	 * @returns `true` if fewer than 3 crashes have occurred in the last 5 minutes.
	 */
	public shouldAutomaticallyRestart(): boolean {
		this._removeOldCrashes();
		return (this._recentCrashes.length < ExtensionHostCrashTracker._CRASH_LIMIT);
	}
}

/**
 * Activation event reader that includes implicit activation events derived from
 * an extension's declared contributions (e.g. `onCommand`, `onLanguage`,
 * `onFileSystem`).
 *
 * This can run correctly only on the renderer process because that is the only place
 * where all extension points and all implicit activation events generators are known.
 */
export class ImplicitActivationAwareReader implements IActivationEventsReader {
	/**
	 * Reads all activation events for an extension, including both explicitly
	 * declared events and implicitly derived events from contributions.
	 *
	 * @param extensionDescription - The extension description to read events for.
	 * @returns An array of activation event strings.
	 */
	public readActivationEvents(extensionDescription: IExtensionDescription): string[] {
		return ImplicitActivationEvents.readActivationEvents(extensionDescription);
	}
}

/**
 * Renders activation events as a markdown list for the extension features UI.
 */
class ActivationFeatureMarkdowneRenderer extends Disposable implements IExtensionFeatureMarkdownRenderer {

	readonly type = 'markdown';

	/**
	 * Checks whether the extension has activation events to render.
	 *
	 * @param manifest - The extension manifest to check.
	 * @returns `true` if the manifest declares activation events.
	 */
	shouldRender(manifest: IExtensionManifest): boolean {
		return !!manifest.activationEvents;
	}

	/**
	 * Renders the extension's activation events as a markdown bullet list.
	 *
	 * @param manifest - The extension manifest containing activation events.
	 * @returns Rendered markdown data containing a list of activation events.
	 */
	render(manifest: IExtensionManifest): IRenderedData<IMarkdownString> {
		const activationEvents = manifest.activationEvents || [];
		const data = new MarkdownString();
		if (activationEvents.length) {
			for (const activationEvent of activationEvents) {
				data.appendMarkdown(`- \`${activationEvent}\`\n`);
			}
		}
		return {
			data,
			dispose: () => { }
		};
	}
}

Registry.as<IExtensionFeaturesRegistry>(ExtensionFeaturesExtensions.ExtensionFeaturesRegistry).registerExtensionFeature({
	id: 'activationEvents',
	label: nls.localize('activation', "Activation Events"),
	access: {
		canToggle: false
	},
	renderer: new SyncDescriptor(ActivationFeatureMarkdowneRenderer),
});
