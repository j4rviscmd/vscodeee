/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Network commands — port scanning, proxy resolution, certificates.

use super::error::NativeHostError;

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
    let stride = if stride == 0 { 1 } else { stride };
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
