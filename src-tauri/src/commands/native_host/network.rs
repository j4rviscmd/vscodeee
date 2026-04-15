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

/// Credentials returned from the OS credential store.
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

// ─── Credential store commands ──────────────────────────────────────────

/// Look up stored credentials from the OS credential store for a given auth challenge.
///
/// Uses the `keyring` crate to access:
/// - macOS: Keychain Access
/// - Windows: Credential Manager
/// - Linux: Secret Service (GNOME Keyring / KDE Wallet)
///
/// The credential service name is constructed as:
/// `vscodeee.auth.{scheme}.{host}:{port}`
///
/// Returns `None` if no matching credential is found.
#[tauri::command]
pub fn lookup_authorization(auth_info: AuthInfo) -> Result<Option<Credentials>, NativeHostError> {
    let service = format!(
        "vscodeee.auth.{}.{}:{}",
        auth_info.scheme, auth_info.host, auth_info.port
    );

    log::debug!(
        target: "vscodeee",
        "lookup_authorization: service={}, realm={}, attempt={}",
        service,
        auth_info.realm,
        auth_info.attempt
    );

    // On macOS debug builds, use the permissive Keychain path that suppresses
    // password dialogs when the ACL restricts the calling binary.
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        match crate::commands::secret_storage::macos_permissive_get_password(
            &service,
            &auth_info.realm,
        ) {
            Ok(Some(password)) => {
                log::debug!(
                    target: "vscodeee",
                    "lookup_authorization: found credential for {service} (permissive path)"
                );
                Ok(Some(Credentials {
                    username: auth_info.realm.clone(),
                    password,
                }))
            }
            Ok(None) => {
                log::debug!(
                    target: "vscodeee",
                    "lookup_authorization: no credential for {service} (permissive path)"
                );
                Ok(None)
            }
            Err(e) => {
                log::warn!(
                    target: "vscodeee",
                    "lookup_authorization: permissive path error for {service}: {e}"
                );
                Ok(None)
            }
        }
    }

    // On release builds (and non-macOS), use the default keyring behavior.
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
        match keyring::Entry::new(&service, &auth_info.realm) {
            Ok(entry) => match entry.get_password() {
                Ok(password) => {
                    log::debug!(target: "vscodeee", "lookup_authorization: found credential for {service}");
                    Ok(Some(Credentials {
                        username: auth_info.realm.clone(),
                        password,
                    }))
                }
                Err(keyring::Error::NoEntry) => {
                    log::debug!(target: "vscodeee", "lookup_authorization: no credential for {service}");
                    Ok(None)
                }
                Err(e) => {
                    log::warn!(target: "vscodeee", "lookup_authorization: keyring error for {service}: {e}");
                    Ok(None)
                }
            },
            Err(e) => {
                log::warn!(target: "vscodeee", "lookup_authorization: failed to create keyring entry for {service}: {e}");
                Ok(None)
            }
        }
    }
}
