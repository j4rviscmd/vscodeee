/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//! Encryption commands — master-key approach for secret storage.
//!
//! Instead of storing each secret as an individual OS credential store entry
//! (which triggers per-item Keychain ACL dialogs on macOS), this module stores
//! a single **master encryption key** in the OS credential store and encrypts
//! all secrets with AES-256-GCM before persisting them to SQLite via
//! VS Code's `BaseSecretStorageService`.
//!
//! ## Architecture
//!
//! ```text
//! TypeScript (BaseSecretStorageService)
//!   ├─ TauriEncryptionService.encrypt(value)
//!   │   └─ invoke('encryption_encrypt') → this module → AES-256-GCM
//!   ├─ TauriEncryptionService.decrypt(value)
//!   │   └─ invoke('encryption_decrypt') → this module → AES-256-GCM
//!   └─ IStorageService → SQLite (encrypted blobs)
//!
//! Rust side:
//!   encryption_get_key() → keyring crate → OS credential store (1 item)
//!   encryption_encrypt() → get cached key → AES-256-GCM → base64
//!   encryption_decrypt() → base64 → get cached key → AES-256-GCM
//!
//! ## Master key caching
//!
//! The master key is read from the OS credential store on first access and
//! cached in memory via `Mutex<Option<Vec<u8>>>`. Subsequent encrypt/decrypt operations
//! use the cached key without hitting the Keychain, matching the behavior
//! of Electron's safeStorage (which also caches the Chromium os_crypt key
//! after first access).
//! ```
//!
//! ## macOS ACL behavior
//!
//! Only the master key is stored in the Keychain. On macOS debug builds,
//! the master key is stored with a permissive ("any application") ACL so that
//! different worktree binaries can access it without triggering password dialogs.
//! Release builds use the default ACL (application-specific).

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use std::sync::Mutex;

/// Keyring service name for the master encryption key.
/// Only one Keychain/credential store entry is created with this service name.
const MASTER_KEY_SERVICE: &str = "vscodeee.encryption.master";

/// Keyring account name for the master encryption key.
const MASTER_KEY_ACCOUNT: &str = "master-key";

/// AES-256-GCM key length in bytes.
const KEY_LEN: usize = 32;

/// AES-GCM nonce length in bytes.
const NONCE_LEN: usize = 12;

/// AES-GCM authentication tag length in bytes.
const GCM_TAG_LEN: usize = 16;

/// In-memory cache of the master encryption key.
///
/// Initialized once on first access from the OS credential store, then
/// reused for all subsequent encrypt/decrypt operations without hitting
/// the Keychain again. Mirrors Electron safeStorage's internal caching
/// of the Chromium `os_crypt` key.
static MASTER_KEY_CACHE: Mutex<Option<Vec<u8>>> = Mutex::new(None);

/// Base64 encoding config used for all encryption/decryption operations.
fn base64_engine() -> base64::engine::GeneralPurpose {
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::general_purpose::NO_PAD,
    )
}

// ── Master key management ───────────────────────────────────────────────────

/// Retrieve the master encryption key, using the in-memory cache if available.
///
/// On first call, reads the key from the OS credential store (or generates
/// a new one if none exists) and caches it. Subsequent calls return the
/// cached key immediately without Keychain access.
fn get_master_key() -> Result<Vec<u8>, String> {
    let mut cache = MASTER_KEY_CACHE.lock().unwrap();
    if let Some(key) = cache.as_ref() {
        return Ok(key.clone());
    }

    // Slow path: load from credential store and cache.
    let key = load_or_create_master_key()?;
    log::info!(target: "vscodeee::encryption", "get_master_key: cached master key in memory");
    *cache = Some(key.clone());
    Ok(key)
}

/// Load the master key from the OS credential store or create a new one.
///
/// If no key exists, a new 256-bit random key is generated and stored.
/// On macOS debug builds, the key is stored with a permissive ACL.
fn load_or_create_master_key() -> Result<Vec<u8>, String> {
    // Try to read existing key from the credential store.
    let entry = keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT)
        .map_err(|e| format!("Failed to create keyring entry for master key: {e}"))?;

    match entry.get_password() {
        Ok(key_b64) => {
            let key_bytes = base64_engine()
                .decode(&key_b64)
                .map_err(|e| format!("Failed to decode master key: {e}"))?;

            if key_bytes.len() != KEY_LEN {
                log::warn!(
                    target: "vscodeee::encryption",
                    "get_or_create_master_key: existing key has wrong length ({}), regenerating",
                    key_bytes.len()
                );
                // Delete the corrupted key before regenerating to avoid
                // ERR_SEC_DUPLICATE_ITEM on platforms that don't upsert.
                let _ = entry.delete_credential();
                // Fall through to generate a new key.
            } else {
                log::trace!(target: "vscodeee::encryption", "get_or_create_master_key: loaded existing key");
                return Ok(key_bytes);
            }
        }
        Err(keyring::Error::NoEntry) => {
            log::info!(target: "vscodeee::encryption", "get_or_create_master_key: no existing key, generating new one");
        }
        Err(e) => {
            // On macOS debug builds, the existing key might have a restricted ACL
            // that blocks the current binary. Try to delete it and regenerate.
            log::warn!(
                target: "vscodeee::encryption",
                "get_or_create_master_key: failed to read existing key: {e}, attempting regeneration"
            );

            // Try macOS-specific permissive approach first.
            #[cfg(all(target_os = "macos", debug_assertions))]
            {
                if let Ok(Some(key_str)) = macos_permissive::read_master_key_skip_ui() {
                    if let Ok(key_bytes) = base64_engine().decode(&key_str) {
                        if key_bytes.len() == KEY_LEN {
                            log::info!(target: "vscodeee::encryption", "get_or_create_master_key: read key via permissive path, re-saving with any-app ACL");
                            // Re-save with permissive ACL for future access.
                            macos_permissive::set_master_key_any_app(&key_str)?;
                            return Ok(key_bytes);
                        }
                    }
                }
            }

            // Delete the corrupted/inaccessible entry and regenerate.
            let _ = entry.delete_credential();
        }
    }

    // Generate a new 256-bit key.
    let mut key_bytes = vec![0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key_bytes);
    let key_b64 = base64_engine().encode(&key_bytes);

    // Store using platform-appropriate method.
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        macos_permissive::set_master_key_any_app(&key_b64)?;
    }

    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
        entry
            .set_password(&key_b64)
            .map_err(|e| format!("Failed to store master key: {e}"))?;
    }

    log::info!(target: "vscodeee::encryption", "get_or_create_master_key: generated and stored new master key");
    Ok(key_bytes)
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Check whether the encryption service is available.
///
/// Returns `true` if the OS credential store is accessible and a master
/// key can be obtained or created.
#[tauri::command]
pub fn encryption_is_available() -> bool {
    // Try to create a keyring entry — if this fails, encryption is unavailable.
    keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT).is_ok()
}

/// Encrypt a plaintext string using AES-256-GCM with the master key.
///
/// The output format is: `base64(nonce || ciphertext || tag)`.
#[tauri::command]
pub fn encryption_encrypt(value: String) -> Result<String, String> {
    let key_bytes = get_master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to create AES cipher: {e}"))?;

    // Generate a random 96-bit nonce.
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    // Encrypt with AES-256-GCM. The tag is appended automatically.
    let ciphertext = cipher
        .encrypt(&nonce, value.as_bytes())
        .map_err(|e| format!("AES-GCM encryption failed: {e}"))?;

    // Prepend nonce to ciphertext+tag and base64-encode.
    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&ciphertext);

    Ok(base64_engine().encode(&combined))
}

/// Decrypt a ciphertext string using AES-256-GCM with the master key.
///
/// Expects the input format: `base64(nonce || ciphertext || tag)`.
#[tauri::command]
pub fn encryption_decrypt(value: String) -> Result<String, String> {
    let key_bytes = get_master_key()?;

    let combined = base64_engine()
        .decode(&value)
        .map_err(|e| format!("Failed to decode encrypted value: {e}"))?;

    if combined.len() < NONCE_LEN + GCM_TAG_LEN {
        return Err("Encrypted value too short".to_string());
    }

    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to create AES cipher: {e}"))?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("AES-GCM decryption failed: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("Decrypted value is not valid UTF-8: {e}"))
}

// ── macOS debug-only: permissive ACL for master key ─────────────────────────
//
// Only the master key needs a permissive ACL. All other secrets are encrypted
// and stored in SQLite, so they never touch the Keychain.

#[cfg(all(target_os = "macos", debug_assertions))]
mod macos_permissive {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFTypeRef, OSStatus};
    use core_foundation_sys::dictionary::{
        kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryAddValue,
        CFDictionaryCreateMutable, CFDictionaryRef, CFMutableDictionaryRef,
    };
    use security_framework_sys::item::{
        kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecMatchLimit,
        kSecReturnData, kSecValueData,
    };
    use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};
    use std::ffi::c_void;
    use std::ptr;

    use super::{MASTER_KEY_ACCOUNT, MASTER_KEY_SERVICE};

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;

    extern "C" {
        static kSecAttrAccess: core_foundation_sys::string::CFStringRef;
        static kSecMatchLimitOne: core_foundation_sys::string::CFStringRef;
        static kSecUseAuthenticationUI: core_foundation_sys::string::CFStringRef;
        static kSecUseAuthenticationUISkip: core_foundation_sys::string::CFStringRef;

        fn SecAccessCreate(
            descriptor: core_foundation_sys::string::CFStringRef,
            trusted_list: core_foundation_sys::array::CFArrayRef,
            access_ref: *mut security_framework_sys::base::SecAccessRef,
        ) -> OSStatus;

        fn SecAccessCopyACLList(
            access_ref: security_framework_sys::base::SecAccessRef,
            acl_list: *mut core_foundation_sys::array::CFArrayRef,
        ) -> OSStatus;

        fn SecACLSetContents(
            acl: *const c_void,
            application_list: core_foundation_sys::array::CFArrayRef,
            description: core_foundation_sys::string::CFStringRef,
            prompt_selector: u16,
        ) -> OSStatus;

        fn SecACLCopyContents(
            acl: *const c_void,
            application_list: *mut core_foundation_sys::array::CFArrayRef,
            description: *mut core_foundation_sys::string::CFStringRef,
            prompt_selector: *mut u16,
        ) -> OSStatus;
    }

    unsafe fn create_mutable_dict() -> CFMutableDictionaryRef {
        CFDictionaryCreateMutable(
            kCFAllocatorDefault,
            0,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    }

    /// Build a query dictionary matching a generic-password item by service and account.
    unsafe fn create_query_dict(
        cf_service: &CFString,
        cf_account: &CFString,
    ) -> CFMutableDictionaryRef {
        let query = create_mutable_dict();
        CFDictionaryAddValue(
            query,
            kSecClass as *const c_void,
            kSecClassGenericPassword as *const c_void,
        );
        CFDictionaryAddValue(
            query,
            kSecAttrService as *const c_void,
            cf_service.as_concrete_TypeRef() as *const c_void,
        );
        CFDictionaryAddValue(
            query,
            kSecAttrAccount as *const c_void,
            cf_account.as_concrete_TypeRef() as *const c_void,
        );
        query
    }

    /// Read the master key from Keychain using `kSecUseAuthenticationUISkip`.
    ///
    /// Returns `Ok(None)` if the item does not exist or is inaccessible due to ACL.
    pub(super) fn read_master_key_skip_ui() -> Result<Option<String>, String> {
        unsafe {
            let cf_service = CFString::new(MASTER_KEY_SERVICE);
            let cf_account = CFString::new(MASTER_KEY_ACCOUNT);

            let query = create_query_dict(&cf_service, &cf_account);
            CFDictionaryAddValue(
                query,
                kSecReturnData as *const c_void,
                core_foundation_sys::number::kCFBooleanTrue as *const c_void,
            );
            CFDictionaryAddValue(
                query,
                kSecMatchLimit as *const c_void,
                kSecMatchLimitOne as *const c_void,
            );
            CFDictionaryAddValue(
                query,
                kSecUseAuthenticationUI as *const c_void,
                kSecUseAuthenticationUISkip as *const c_void,
            );

            let mut result: CFTypeRef = ptr::null();
            let status = SecItemCopyMatching(query as CFDictionaryRef, &mut result);
            CFRelease(query as CFTypeRef);

            if status == ERR_SEC_ITEM_NOT_FOUND {
                return Ok(None);
            }

            if status == ERR_SEC_AUTH_FAILED {
                log::warn!(target: "vscodeee::encryption", "read_master_key_skip_ui: auth failed, ACL restricts binary");
                // Delete the stale item so we can regenerate.
                delete_keychain_item_skip_ui(&cf_service, &cf_account);
                return Ok(None);
            }

            if status != 0 {
                return Err(format!("SecItemCopyMatching failed with status {status}"));
            }

            if result.is_null() {
                return Ok(None);
            }

            let data_ref = result as core_foundation_sys::data::CFDataRef;
            let len = core_foundation_sys::data::CFDataGetLength(data_ref) as usize;
            let data_ptr = core_foundation_sys::data::CFDataGetBytePtr(data_ref);
            let bytes = std::slice::from_raw_parts(data_ptr, len);
            let password = String::from_utf8_lossy(bytes).into_owned();
            CFRelease(result);

            Ok(Some(password))
        }
    }

    /// Store the master key in Keychain with an "any application" ACL.
    pub(super) fn set_master_key_any_app(key_b64: &str) -> Result<(), String> {
        unsafe {
            // Create SecAccess with default ACL, then patch to "any app".
            let descriptor = CFString::new(MASTER_KEY_SERVICE);
            let mut access_ref: security_framework_sys::base::SecAccessRef = ptr::null_mut();
            let status = SecAccessCreate(
                descriptor.as_concrete_TypeRef(),
                ptr::null(),
                &mut access_ref,
            );
            if status != 0 {
                return Err(format!("SecAccessCreate failed with status {status}"));
            }

            // Patch all ACL entries to "any application".
            let mut acl_list: core_foundation_sys::array::CFArrayRef = ptr::null();
            let status = SecAccessCopyACLList(access_ref, &mut acl_list);
            if status != 0 {
                CFRelease(access_ref as CFTypeRef);
                return Err(format!("SecAccessCopyACLList failed with status {status}"));
            }

            let acl_count = core_foundation_sys::array::CFArrayGetCount(acl_list);
            for i in 0..acl_count {
                let acl = core_foundation_sys::array::CFArrayGetValueAtIndex(acl_list, i);

                let mut app_list: core_foundation_sys::array::CFArrayRef = ptr::null();
                let mut desc: core_foundation_sys::string::CFStringRef = ptr::null();
                let mut prompt: u16 = 0;
                let copy_status = SecACLCopyContents(acl, &mut app_list, &mut desc, &mut prompt);
                if copy_status != 0 {
                    continue;
                }

                SecACLSetContents(acl, ptr::null(), desc, prompt);

                if !app_list.is_null() {
                    CFRelease(app_list as CFTypeRef);
                }
                if !desc.is_null() {
                    CFRelease(desc as CFTypeRef);
                }
            }
            CFRelease(acl_list as CFTypeRef);

            // Prepare values.
            let cf_service = CFString::new(MASTER_KEY_SERVICE);
            let cf_account = CFString::new(MASTER_KEY_ACCOUNT);
            let cf_password = core_foundation::data::CFData::from_buffer(key_b64.as_bytes());

            let build_add_dict = || -> CFMutableDictionaryRef {
                let dict = create_query_dict(&cf_service, &cf_account);
                CFDictionaryAddValue(
                    dict,
                    kSecValueData as *const c_void,
                    cf_password.as_concrete_TypeRef() as *const c_void,
                );
                CFDictionaryAddValue(
                    dict,
                    kSecAttrAccess as *const c_void,
                    access_ref as *const c_void,
                );
                dict
            };

            // Delete existing, then add new.
            delete_keychain_item_skip_ui(&cf_service, &cf_account);

            let add_dict = build_add_dict();
            let mut status = SecItemAdd(add_dict as CFDictionaryRef, ptr::null_mut());
            CFRelease(add_dict as CFTypeRef);

            // Fallback: if skip-UI delete failed due to ACL, try normal delete.
            if status == ERR_SEC_DUPLICATE_ITEM {
                log::info!(target: "vscodeee::encryption", "set_master_key_any_app: duplicate item, falling back to normal delete");
                let del_dict = create_query_dict(&cf_service, &cf_account);
                let del_status = SecItemDelete(del_dict as CFDictionaryRef);
                CFRelease(del_dict as CFTypeRef);

                if del_status == 0 || del_status == ERR_SEC_ITEM_NOT_FOUND {
                    let retry_dict = build_add_dict();
                    status = SecItemAdd(retry_dict as CFDictionaryRef, ptr::null_mut());
                    CFRelease(retry_dict as CFTypeRef);
                } else {
                    CFRelease(access_ref as CFTypeRef);
                    return Err(format!("Fallback delete failed with status {del_status}"));
                }
            }

            CFRelease(access_ref as CFTypeRef);

            if status != 0 {
                return Err(format!("SecItemAdd failed with status {status}"));
            }

            log::info!(target: "vscodeee::encryption", "set_master_key_any_app: stored master key with permissive ACL");
            Ok(())
        }
    }

    /// Delete a Keychain item suppressing authentication UI.
    unsafe fn delete_keychain_item_skip_ui(cf_service: &CFString, cf_account: &CFString) {
        let query = create_query_dict(cf_service, cf_account);
        CFDictionaryAddValue(
            query,
            kSecUseAuthenticationUI as *const c_void,
            kSecUseAuthenticationUISkip as *const c_void,
        );

        let status = SecItemDelete(query as CFDictionaryRef);
        CFRelease(query as CFTypeRef);

        if status != 0 && status != ERR_SEC_ITEM_NOT_FOUND && status != ERR_SEC_AUTH_FAILED {
            log::warn!(target: "vscodeee::encryption", "delete_keychain_item_skip_ui: unexpected status {status}");
        }
    }
}
