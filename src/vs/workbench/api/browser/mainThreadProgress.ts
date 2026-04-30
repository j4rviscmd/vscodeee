/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProgress, IProgressService, IProgressStep, ProgressLocation, IProgressOptions, IProgressNotificationOptions } from '../../../platform/progress/common/progress.js';
import { MainThreadProgressShape, MainContext, ExtHostProgressShape, ExtHostContext } from '../common/extHost.protocol.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { localize } from '../../../nls.js';
import { onUnexpectedExternalError } from '../../../base/common/errors.js';
import { toAction } from '../../../base/common/actions.js';
import { NotificationPriority } from '../../../platform/notification/common/notification.js';

/**
 * Main-thread side of the progress API bridge.
 *
 * Receives progress operations from the extension host (via `$startProgress`,
 * `$progressReport`, `$progressEnd`) and forwards them to the
 * {@link IProgressService}. For notification-based progress, a "Manage Extension"
 * secondary action is automatically attached so users can navigate to the
 * contributing extension.
 */
@extHostNamedCustomer(MainContext.MainThreadProgress)
export class MainThreadProgress implements MainThreadProgressShape {

	/** Extension identifiers whose progress notifications should be promoted to {@link NotificationPriority.URGENT}. */
	private static readonly URGENT_PROGRESS_SOURCES = [
		'vscode.github-authentication',
	];

	private readonly _progressService: IProgressService;
	private _progress = new Map<number, { resolve: () => void; progress: IProgress<IProgressStep> }>();
	private readonly _proxy: ExtHostProgressShape;

	constructor(
		extHostContext: IExtHostContext,
		@IProgressService progressService: IProgressService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostProgress);
		this._progressService = progressService;
	}

	/**
	 * Disposes this main-thread progress instance.
	 *
	 * Resolves every in-flight progress promise so that the extension host
	 * is not left waiting, then clears the internal handle map.
	 */
	dispose(): void {
		this._progress.forEach(handle => handle.resolve());
		this._progress.clear();
	}

	/**
	 * Start a progress operation on behalf of an extension.
	 *
	 * When the progress location is {@link ProgressLocation.Notification} and an
	 * {@link extensionId} is provided, the options are augmented with:
	 * - An elevated {@link NotificationPriority} if the extension is listed in
	 *   {@link URGENT_PROGRESS_SOURCES}.
	 * - A "Manage Extension" secondary action that opens the extension management
	 *   view for the contributing extension.
	 *
	 * @param handle - Opaque identifier that the extension host uses to correlate
	 *   subsequent `$progressReport` and `$progressEnd` calls.
	 * @param options - Progress options (location, title, cancellable, etc.).
	 * @param extensionId - The identifier of the extension that initiated the progress.
	 */
	async $startProgress(handle: number, options: IProgressOptions, extensionId?: string): Promise<void> {
		this._logService.info(`[MainThreadProgress] $startProgress(handle=${handle}, title=${options.title}, extensionId=${extensionId})`);
		const task = this._createTask(handle);

		if (options.location === ProgressLocation.Notification && extensionId) {
			const sourceIsUrgent = MainThreadProgress.URGENT_PROGRESS_SOURCES.includes(extensionId);
			const notificationOptions: IProgressNotificationOptions = {
				...options,
				priority: sourceIsUrgent ? NotificationPriority.URGENT : NotificationPriority.DEFAULT,
				location: ProgressLocation.Notification,
				secondaryActions: [toAction({
					id: extensionId,
					label: localize('manageExtension', "Manage Extension"),
					run: () => this._commandService.executeCommand('_extensions.manage', extensionId)
				})]
			};

			options = notificationOptions;
		}

		try {
			this._progressService.withProgress(options, task, () => this._proxy.$acceptProgressCanceled(handle));
		} catch (err) {
			// the withProgress-method will throw synchronously when invoked with bad options
			// which is then an enternal/extension error
			onUnexpectedExternalError(err);
		}
	}

	/**
	 * Report an incremental progress update for an in-flight progress operation.
	 *
	 * If the {@link handle} does not match any active progress, the call is silently ignored.
	 *
	 * @param handle - The progress handle originally passed to {@link $startProgress}.
	 * @param message - The progress step containing an optional message and/or increment value.
	 */
	$progressReport(handle: number, message: IProgressStep): void {
		this._logService.trace(`[MainThreadProgress] $progressReport(handle=${handle}, message=${message.message}, increment=${message.increment})`);
		const entry = this._progress.get(handle);
		if (entry) {
			entry.progress.report(message);
		}
	}

	/**
	 * End a progress operation and release its associated resources.
	 *
	 * Resolves the progress promise (which signals completion to the
	 * {@link IProgressService}) and removes the handle from the internal map.
	 * If the {@link handle} is not found, the call is silently ignored.
	 *
	 * @param handle - The progress handle originally passed to {@link $startProgress}.
	 */
	$progressEnd(handle: number): void {
		const entry = this._progress.get(handle);
		if (entry) {
			entry.resolve();
			this._progress.delete(handle);
		}
	}

	private _createTask(handle: number) {
		return (progress: IProgress<IProgressStep>) => {
			return new Promise<void>(resolve => {
				this._progress.set(handle, { resolve, progress });
			});
		};
	}
}
