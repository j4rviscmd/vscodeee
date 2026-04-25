/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op TelemetryDisabledExperimentationService.
// Mirrors the real vscode-tas-client implementation for telemetry-disabled mode.

"use strict";

class TelemetryDisabledExperimentationService {
	constructor() {
		this.initializePromise = Promise.resolve();
		this.initialFetch = Promise.resolve();
	}

	isFlightEnabled(_flight) {
		return false;
	}

	isCachedFlightEnabled(_flight) {
		return Promise.resolve(false);
	}

	isFlightEnabledAsync(_flight) {
		return Promise.resolve(false);
	}

	getTreatmentVariable(_configId, _name) {
		return undefined;
	}

	getTreatmentVariableAsync(_configId, _name) {
		return Promise.resolve(undefined);
	}
}

module.exports = TelemetryDisabledExperimentationService;
module.exports.default = TelemetryDisabledExperimentationService;
