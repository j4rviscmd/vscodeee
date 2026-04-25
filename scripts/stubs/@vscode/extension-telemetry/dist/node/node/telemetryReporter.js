/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op stub for @vscode/extension-telemetry
// This stub replaces the real telemetry package in production builds to eliminate
// ~80MB of transitive dependencies (@microsoft/applicationinsights-*, @nevware21/*)
// while keeping all extension activation paths functional.
//
// See: https://github.com/j4rviscmd/vscodeee/issues/274

'use strict';

const noopEvent = Object.freeze({ dispose() { } });

class TelemetryReporter {
	constructor(_connectionString, _replacementOptions) {
		this.telemetryLevel = 'off';
		this.onDidChangeTelemetryLevel = noopEvent;
	}

	sendTelemetryEvent(_eventName, _properties, _measurements) { }
	sendRawTelemetryEvent(_eventName, _properties, _measurements) { }
	sendDangerousTelemetryEvent(_eventName, _properties, _measurements) { }
	sendTelemetryErrorEvent(_eventName, _properties, _measurements) { }
	sendDangerousTelemetryErrorEvent(_eventName, _properties, _measurements) { }

	dispose() {
		return Promise.resolve();
	}
}

// Support both default and named exports:
// - v0.9.x: import TelemetryReporter from '@vscode/extension-telemetry'
// - v1.0.x: import { TelemetryReporter } from '@vscode/extension-telemetry'
module.exports = TelemetryReporter;
module.exports.default = TelemetryReporter;
module.exports.TelemetryReporter = TelemetryReporter;
