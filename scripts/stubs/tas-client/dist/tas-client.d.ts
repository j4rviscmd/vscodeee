/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op type declarations for tas-client stub.

export interface IExperimentationFilterProvider {
	getFilters(): Map<string, any>;
	getFilterValue(filter: string): string;
}

export interface IExperimentationService {
	readonly initializePromise: Promise<void>;
	readonly initialFetch: Promise<void>;
	isFlightEnabled(flight: string): boolean;
	isCachedFlightEnabled(flight: string): Promise<boolean>;
	isFlightEnabledAsync(flight: string): Promise<boolean>;
	getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined;
	getTreatmentVariableAsync<T extends boolean | number | string>(configId: string, name: string, checkCache?: boolean): Promise<T | undefined>;
}

export interface IExperimentationTelemetry {
	setSharedProperty(name: string, value: string): void;
	postEvent(eventName: string, props: Map<string, string>): void;
}

export interface IKeyValueStorage {
	getValue<T>(key: string, defaultValue?: T): Promise<T | undefined>;
	setValue<T>(key: string, value: T): Promise<void>;
}

export interface ExperimentationServiceConfig {
	filterProviders?: IExperimentationFilterProvider[];
	telemetry?: IExperimentationTelemetry;
	storageKey?: string;
	keyValueStorage?: IKeyValueStorage;
	featuresTelemetryPropertyName?: string;
	assignmentContextTelemetryPropertyName?: string;
	telemetryEventName?: string;
	endpoint?: string;
	refetchInterval?: number;
}

export declare class ExperimentationService implements IExperimentationService {
	constructor(config: ExperimentationServiceConfig);
	readonly initializePromise: Promise<void>;
	readonly initialFetch: Promise<void>;
	isFlightEnabled(flight: string): boolean;
	isCachedFlightEnabled(flight: string): Promise<boolean>;
	isFlightEnabledAsync(flight: string): Promise<boolean>;
	getTreatmentVariable<T extends boolean | number | string>(configId: string, name: string): T | undefined;
	getTreatmentVariableAsync<T extends boolean | number | string>(configId: string, name: string, checkCache?: boolean): Promise<T | undefined>;
}
