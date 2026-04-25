/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op type declarations for vscode-tas-client stub.

export { IKeyValueStorage, IExperimentationService, IExperimentationTelemetry, IExperimentationFilterProvider } from 'tas-client';

export declare function getExperimentationService(
	extensionName: string,
	extensionVersion: string,
	targetPopulation: TargetPopulation,
	telemetry: IExperimentationTelemetry,
	memento: any,
	...filterProviders: IExperimentationFilterProvider[]
): IExperimentationService;

export declare function getExperimentationServiceAsync(
	extensionName: string,
	extensionVersion: string,
	targetPopulation: TargetPopulation,
	telemetry: IExperimentationTelemetry,
	memento: any,
	...filterProviders: IExperimentationFilterProvider[]
): Promise<IExperimentationService>;

export declare enum TargetPopulation {
	Team = 'team',
	Internal = 'internal',
	Insiders = 'insider',
	Public = 'public',
}

import type { IExperimentationTelemetry, IExperimentationFilterProvider, IExperimentationService } from 'tas-client';
