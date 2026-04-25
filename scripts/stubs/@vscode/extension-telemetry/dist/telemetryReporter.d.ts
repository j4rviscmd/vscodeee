/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op stub type definitions for @vscode/extension-telemetry

export interface TelemetryEventProperties {
	readonly [key: string]: string | import('vscode').TelemetryTrustedValue<string> | undefined;
}

export interface TelemetryEventMeasurements {
	readonly [key: string]: number | undefined;
}

export interface ReplacementOption {
	lookup: RegExp;
	replacementString?: string;
}

export class TelemetryReporter {
	constructor(connectionString: string, replacementOptions?: ReplacementOption[]);
	telemetryLevel: 'all' | 'error' | 'crash' | 'off';
	onDidChangeTelemetryLevel: import('vscode').Event<'all' | 'error' | 'crash' | 'off'>;
	sendTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
	sendRawTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
	sendDangerousTelemetryEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
	sendTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
	sendDangerousTelemetryErrorEvent(eventName: string, properties?: TelemetryEventProperties, measurements?: TelemetryEventMeasurements): void;
	dispose(): Promise<any>;
}

export default TelemetryReporter;
