/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op VSCodeTasClient stub.
// Always returns TelemetryDisabledExperimentationService regardless of telemetry settings.

"use strict";

const TelemetryDisabledExperimentationService = require('./TelemetryDisabledExperimentationService');

/**
 * No-op getExperimentationService — always returns a disabled experimentation service.
 * @returns {TelemetryDisabledExperimentationService}
 */
function getExperimentationService(_extensionName, _extensionVersion, _targetPopulation, _telemetry, _memento) {
	return new TelemetryDisabledExperimentationService();
}

/**
 * No-op getExperimentationServiceAsync — always returns a disabled experimentation service.
 * @returns {Promise<TelemetryDisabledExperimentationService>}
 */
async function getExperimentationServiceAsync(_extensionName, _extensionVersion, _targetPopulation, _telemetry, _memento) {
	return new TelemetryDisabledExperimentationService();
}

module.exports.getExperimentationService = getExperimentationService;
module.exports.getExperimentationServiceAsync = getExperimentationServiceAsync;
