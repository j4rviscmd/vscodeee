/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// No-op stub for @vscode/extension-telemetry (browser entry point)
// See: dist/node/node/telemetryReporter.js for the full implementation notes.

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

module.exports = TelemetryReporter;
module.exports.default = TelemetryReporter;
module.exports.TelemetryReporter = TelemetryReporter;
