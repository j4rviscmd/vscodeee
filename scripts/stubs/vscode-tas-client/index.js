/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op stub for vscode-tas-client.
// This project does not use Microsoft's experimentation service.
// See: https://github.com/j4rviscmd/vscodeee/issues/296

"use strict";

const { getExperimentationService, getExperimentationServiceAsync } = require('./vscode-tas-client/VSCodeTasClient');
const { TargetPopulation } = require('./vscode-tas-client/VSCodeFilterProvider');

module.exports.getExperimentationService = getExperimentationService;
module.exports.getExperimentationServiceAsync = getExperimentationServiceAsync;
module.exports.TargetPopulation = TargetPopulation;
