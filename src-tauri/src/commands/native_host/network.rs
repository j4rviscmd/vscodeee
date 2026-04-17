/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Network commands — port scanning, proxy resolution, certificates, credential lookup.

use serde::{Deserialize, Serialize};

use super::error::NativeHostError;

// ─── Types ──────────────────────────────────────────────────────────────

/// Authentication challenge information, mirroring VS Code's `AuthInfo`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthInfo {
    pub is_proxy: bool,
    pub scheme: String,
    pub host: String,
    pub port: u32,
    pub realm: String,
    pub attempt: u32,
}

/// Credentials returned from the credential store.
#[derive(Debug, Serialize, Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

// ─── Existing commands (moved from native_host.rs) ──────────────────────

/// Check if a given port is free for binding.
#[tauri::command]
pub fn is_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Find a free port starting from `start_port`.
#[tauri::command]
pub fn find_free_port(
    start_port: u16,
    give_up_after: u16,
    _timeout: u64,
    stride: u16,
) -> Result<u16, NativeHostError> {
    let stride = stride.max(1);
    let mut port = start_port;
    let end = start_port.saturating_add(give_up_after);
    while port < end {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
        port = port.saturating_add(stride);
    }
    Err(NativeHostError::Other(format!(
        "Could not find a free port in range {start_port}..{end}"
    )))
}

// ─── New commands ───────────────────────────────────────────────────────

/// Resolve a proxy URL for the given target URL.
///
/// Returns `None` (direct connection) — proxy resolution would require
/// platform-specific APIs (CFNetworkCopySystemProxySettings on macOS,
/// WinHttpGetProxyForUrl on Windows). Extensions typically handle
/// their own proxy configuration via settings.
#[tauri::command]
pub fn resolve_proxy(_url: String) -> Option<String> {
    None
}

/// Load system SSL/TLS certificates.
///
/// Returns an empty list — VS Code extensions and the built-in
/// HTTP client handle certificate loading independently.
/// A full implementation would use `rustls-native-certs`.
#[tauri::command]
pub fn load_certificates() -> Vec<String> {
    Vec::new()
}

// ─── Credential store commands ──────────────────────────────────────────

/// Look up stored credentials for a given auth challenge.
///
/// Proxy authentication credentials are now managed through TypeScript's
/// `ISecretStorageService` (encrypted with the master key and stored in SQLite)
/// rather than directly in the OS credential store. This command always
/// returns `None` and will be removed in a future cleanup.
///
// TODO(Phase 2): Remove this command once proxy auth is fully routed through
// ISecretStorageService on the TypeScript side.
#[tauri::command]
pub fn lookup_authorization(_auth_info: AuthInfo) -> Result<Option<Credentials>, NativeHostError> {
    // Proxy credentials are now managed by TypeScript's ISecretStorageService
    // via the master encryption key. No longer reading from Keychain here.
    Ok(None)
}
