/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tauri endpoint telemetry service — no-op stub with console warnings.
 *
 * VS Code's desktop (Electron) version supports custom endpoint telemetry
 * that sends data to non-Microsoft telemetry endpoints. This is managed
 * through the Shared Process. In the Tauri migration, this infrastructure
 * is not available.
 *
 * This stub logs a warning when methods are invoked, helping developers
 * identify code paths that still reference custom endpoint telemetry.
 */

import { ICustomEndpointTelemetryService, ITelemetryEndpoint, ITelemetryData } from '../../../../platform/telemetry/common/telemetry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

export class TauriEndpointTelemetryService implements ICustomEndpointTelemetryService {

	declare readonly _serviceBrand: undefined;

	private loggedWarning = false;

	publicLog(_endpoint: ITelemetryEndpoint, eventName: string, _data?: ITelemetryData): void {
		this.warnOnce(eventName);
	}

	publicLogError(_endpoint: ITelemetryEndpoint, errorEventName: string, _data?: ITelemetryData): void {
		this.warnOnce(errorEventName);
	}

	private warnOnce(eventName: string): void {
		if (!this.loggedWarning) {
			this.loggedWarning = true;
			console.warn(
				`[TauriEndpointTelemetryService] Custom endpoint telemetry is not available ` +
				`(Shared Process removed). Event "${eventName}" was discarded.`
			);
		}
	}
}

registerSingleton(ICustomEndpointTelemetryService, TauriEndpointTelemetryService, InstantiationType.Delayed);
