/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNumber, isObject } from '../../../../base/common/types.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ISerializedTerminalEditorInput, ITerminalEditorService, ITerminalEditorSnapshot, ITerminalInstance, type IDeserializedTerminalEditorInput } from './terminal.js';
import { TerminalEditorInput } from './terminalEditorInput.js';

/** Serialized format for fresh-restore mode (no process reattachment). */
interface IFreshSerializedTerminalEditorInput extends ISerializedTerminalEditorInput {
	freshRestore: true;
}

export class TerminalInputSerializer implements IEditorSerializer {
	constructor(
		@ITerminalEditorService private readonly _terminalEditorService: ITerminalEditorService
	) { }

	public canSerialize(editorInput: TerminalEditorInput): editorInput is TerminalEditorInput & { readonly terminalInstance: ITerminalInstance } {
		// Prefer cached snapshot (available after onWillShutdown begins)
		const snapshot = editorInput.serializedSnapshot;
		if (snapshot) {
			// Reattach path: process persistence is supported
			if (isNumber(snapshot.persistentProcessId) && snapshot.shouldPersist) {
				return true;
			}
			// Fresh-restore path: tab restoration without process reattachment.
			// Exclude transient, hidden, and feature terminals.
			if (!snapshot.isFeatureTerminal && !snapshot.hideFromUser) {
				return true;
			}
			return false;
		}

		// Live instance path (e.g. window reload without full shutdown)
		const instance = editorInput.terminalInstance;
		if (!instance) {
			return false;
		}
		if (isNumber(instance.persistentProcessId) && instance.shouldPersist) {
			return true;
		}
		return !instance.shellLaunchConfig.isTransient &&
			!instance.shellLaunchConfig.hideFromUser &&
			!instance.shellLaunchConfig.isFeatureTerminal;
	}

	public serialize(editorInput: TerminalEditorInput): string | undefined {
		if (!this.canSerialize(editorInput)) {
			return;
		}

		// Use cached snapshot when available (post-shutdown)
		const snapshot = editorInput.serializedSnapshot;
		if (snapshot) {
			return JSON.stringify(this._snapshotToJson(snapshot));
		}

		// Serialize from live instance
		const instance = editorInput.terminalInstance;
		if (instance) {
			return JSON.stringify(this._instanceToJson(instance));
		}

		return undefined;
	}

	public deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		const parsed = JSON.parse(serializedEditorInput) as unknown;
		if (!isObject(parsed)) {
			throw new Error(`Could not revive terminal editor input, ${parsed}`);
		}

		// Fresh-restore format: tab is restored with a new shell process
		if ('freshRestore' in parsed && (parsed as IFreshSerializedTerminalEditorInput).freshRestore === true) {
			const fresh = parsed as IFreshSerializedTerminalEditorInput;
			return this._terminalEditorService.reviveFreshInput({
				title: fresh.title,
				titleSource: fresh.titleSource,
				cwd: fresh.cwd,
				icon: fresh.icon,
				color: fresh.color,
				hasChildProcesses: fresh.hasChildProcesses,
				isFeatureTerminal: fresh.isFeatureTerminal,
				hideFromUser: fresh.hideFromUser,
				reconnectionProperties: fresh.reconnectionProperties,
				shellIntegrationNonce: fresh.shellIntegrationNonce,
			});
		}

		// Legacy reattach format
		if (!isDeserializedTerminalEditorInput(parsed)) {
			throw new Error(`Could not revive terminal editor input, ${serializedEditorInput}`);
		}
		return this._terminalEditorService.reviveInput(parsed);
	}

	private _instanceToJson(instance: ITerminalInstance): IFreshSerializedTerminalEditorInput | ISerializedTerminalEditorInput {
		const canReattach = isNumber(instance.persistentProcessId) && instance.shouldPersist;
		return {
			id: instance.persistentProcessId!,
			pid: instance.processId || 0,
			title: instance.title,
			titleSource: instance.titleSource,
			cwd: '',
			icon: instance.icon,
			color: instance.color,
			hasChildProcesses: instance.hasChildProcesses,
			isFeatureTerminal: instance.shellLaunchConfig.isFeatureTerminal,
			hideFromUser: instance.shellLaunchConfig.hideFromUser,
			reconnectionProperties: instance.shellLaunchConfig.reconnectionProperties,
			shellIntegrationNonce: instance.shellIntegrationNonce,
			...(!canReattach ? { freshRestore: true as const } : {}),
		};
	}

	private _snapshotToJson(snapshot: ITerminalEditorSnapshot): IFreshSerializedTerminalEditorInput | ISerializedTerminalEditorInput {
		const canReattach = isNumber(snapshot.persistentProcessId) && snapshot.shouldPersist;
		if (canReattach) {
			return {
				id: snapshot.persistentProcessId!,
				pid: snapshot.processId || 0,
				title: snapshot.title,
				titleSource: snapshot.titleSource,
				cwd: '',
				icon: snapshot.icon,
				color: snapshot.color,
				hasChildProcesses: snapshot.hasChildProcesses,
				isFeatureTerminal: snapshot.isFeatureTerminal,
				hideFromUser: snapshot.hideFromUser,
				reconnectionProperties: snapshot.reconnectionProperties,
				shellIntegrationNonce: snapshot.shellIntegrationNonce,
			};
		}
		return {
			id: 0,
			pid: 0,
			title: snapshot.title,
			titleSource: snapshot.titleSource,
			cwd: snapshot.cwd,
			icon: snapshot.icon,
			color: snapshot.color,
			hasChildProcesses: snapshot.hasChildProcesses,
			isFeatureTerminal: snapshot.isFeatureTerminal,
			hideFromUser: snapshot.hideFromUser,
			reconnectionProperties: snapshot.reconnectionProperties,
			shellIntegrationNonce: snapshot.shellIntegrationNonce,
			freshRestore: true,
		};
	}
}

function isDeserializedTerminalEditorInput(obj: unknown): obj is IDeserializedTerminalEditorInput {
	return isObject(obj) && 'id' in obj && 'pid' in obj;
}
