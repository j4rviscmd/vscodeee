/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Secret storage commands — OS Keychain backend for ISecretStorageProvider.
//!
//! Uses the `keyring` crate to access platform-native credential stores:
//! - macOS: Keychain Access
//! - Windows: Credential Manager
//! - Linux: Secret Service (GNOME Keyring / KDE Wallet)
//!
//! The service name is fixed to `vscodeee.secrets` to namespace all secrets
//! under a single application entry.

/// The keyring service name used for all secret storage entries.
/// Each secret is stored as a separate entry with this service name
/// and the secret key as the "account" (username) field.
const SERVICE_NAME: &str = "vscodeee.secrets";

/// Retrieve a secret value from the OS credential store.
///
/// # Arguments
/// * `key` - The secret key to look up.
///
/// # Returns
/// The secret value as a string, or `None` if no entry exists.
#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    log::trace!(target: "vscodeee::secrets", "secret_get: key={key}");

    match keyring::Entry::new(SERVICE_NAME, &key) {
        Ok(entry) => match entry.get_password() {
            Ok(password) => {
                log::trace!(target: "vscodeee::secrets", "secret_get: found value for key={key}");
                Ok(Some(password))
            }
            Err(keyring::Error::NoEntry) => {
                log::trace!(target: "vscodeee::secrets", "secret_get: no entry for key={key}");
                Ok(None)
            }
            Err(e) => {
                log::warn!(target: "vscodeee::secrets", "secret_get: keyring error for key={key}: {e}");
                Err(format!("Failed to get secret for key '{key}': {e}"))
            }
        },
        Err(e) => {
            log::warn!(target: "vscodeee::secrets", "secret_get: failed to create entry for key={key}: {e}");
            Err(format!(
                "Failed to create keyring entry for key '{key}': {e}"
            ))
        }
    }
}

/// Store a secret value in the OS credential store.
///
/// # Arguments
/// * `key` - The secret key.
/// * `value` - The secret value to store.
#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    log::trace!(target: "vscodeee::secrets", "secret_set: key={key}");

    let entry = keyring::Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Failed to create keyring entry for key '{key}': {e}"))?;

    entry
        .set_password(&value)
        .map_err(|e| format!("Failed to set secret for key '{key}': {e}"))?;

    log::trace!(target: "vscodeee::secrets", "secret_set: stored value for key={key}");
    Ok(())
}

/// Delete a secret from the OS credential store.
///
/// # Arguments
/// * `key` - The secret key to delete.
///
/// Silently succeeds if no entry exists for the given key.
#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    log::trace!(target: "vscodeee::secrets", "secret_delete: key={key}");

    let entry = keyring::Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Failed to create keyring entry for key '{key}': {e}"))?;

    match entry.delete_credential() {
        Ok(()) => {
            log::trace!(target: "vscodeee::secrets", "secret_delete: deleted key={key}");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => {
            log::trace!(target: "vscodeee::secrets", "secret_delete: no entry for key={key} (noop)");
            Ok(())
        }
        Err(e) => {
            log::warn!(target: "vscodeee::secrets", "secret_delete: keyring error for key={key}: {e}");
            Err(format!("Failed to delete secret for key '{key}': {e}"))
        }
    }
}
