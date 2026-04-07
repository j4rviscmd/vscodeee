/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Minimal `IExtensionHostInitData` JSON builder for the PoC handshake.
//!
//! Only fields accessed before `Initialized` is sent are critical
//! (see `extensionHostProcess.ts:336-387`):
//! - `commit` — omitted to skip version check
//! - `parentPid: 0` — disables parent PID monitoring
//!
//! All other fields are stubs to prevent immediate crashes after the handshake.
//!
//! # TODO: Production (Phase 1-2)
//!
//! Replace this with a proper `IExtensionHostInitData` builder that:
//! - Populates real extension scan results (`allExtensions`, `myExtensions`)
//! - Provides actual workspace info
//! - Includes real telemetry session IDs
//! - Reads product.json for version/quality info
//! - Sets correct `parentPid` for process monitoring

/// Build the minimal `IExtensionHostInitData` JSON for the handshake PoC.
///
/// This JSON is sent as the InitData message during the
/// Ready→InitData→Initialized handshake sequence.
pub fn build_minimal_init_data() -> String {
    serde_json::json!({
        "version": "1.115.0",
        "quality": "stable",
        "parentPid": 0,
        "environment": {
            "isExtensionDevelopmentDebug": false,
            "appName": "VS Codee",
            "appHost": "tauri",
            "appLanguage": "en",
            "isExtensionTelemetryLoggingOnly": false,
            "appUriScheme": "vscodee",
            "globalStorageHome": {
                "scheme": "file",
                "path": "/tmp/vscodee-poc/globalStorage"
            },
            "workspaceStorageHome": {
                "scheme": "file",
                "path": "/tmp/vscodee-poc/workspaceStorage"
            }
        },
        "workspace": serde_json::Value::Null,
        "extensions": {
            "versionId": 0,
            "allExtensions": [],
            "activationEvents": {},
            "myExtensions": []
        },
        "telemetryInfo": {
            "sessionId": "00000000-0000-0000-0000-000000000000",
            "machineId": "00000000-0000-0000-0000-000000000000",
            "sqmId": "00000000-0000-0000-0000-000000000000",
            "devDeviceId": "00000000-0000-0000-0000-000000000000",
            "firstSessionDate": "2024-01-01T00:00:00.000Z"
        },
        "logLevel": 1,
        "loggers": [],
        "logsLocation": {
            "scheme": "file",
            "path": "/tmp/vscodee-poc/logs"
        },
        "autoStart": false,
        "remote": {
            "isRemote": false,
            "authority": serde_json::Value::Null,
            "connectionData": serde_json::Value::Null
        },
        "consoleForward": {
            "includeStack": false,
            "logNative": false
        },
        "uiKind": 1
    })
    .to_string()
}
