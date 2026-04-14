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
//!
//! ## macOS ACL behavior (debug vs release)
//!
//! On macOS, Keychain items have an Access Control List (ACL) that specifies
//! which applications are allowed to read the item without prompting the user.
//! By default, only the binary that created the item is added to the ACL.
//!
//! In debug builds (e.g., `cargo tauri dev`), each git worktree produces a
//! binary at a different path, causing macOS to prompt for a password every
//! time a new worktree accesses the same secret. To avoid this friction
//! during development, debug builds store Keychain items with an
//! "any application" ACL (no application restriction).
//!
//! Release builds retain the default behavior — only the signed application
//! binary is granted access, preserving security for end users.

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
///
/// On macOS debug builds, after successfully reading a Keychain item,
/// the ACL is automatically patched to "any application" if it currently
/// restricts access to specific binaries. This ensures that subsequent
/// reads from different worktree binaries will not trigger a password prompt.
#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    log::trace!(target: "vscodeee::secrets", "secret_get: key={key}");

    // On macOS debug builds, use the permissive ACL path: read the password
    // and then patch the ACL to "any application" so future reads from
    // different worktree binaries won't trigger a password dialog.
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        return match macos_permissive::get_password_and_patch_acl(SERVICE_NAME, &key) {
            Ok(Some(password)) => {
                log::trace!(target: "vscodeee::secrets", "secret_get: found value for key={key} (permissive path)");
                Ok(Some(password))
            }
            Ok(None) => {
                log::trace!(target: "vscodeee::secrets", "secret_get: no entry for key={key}");
                Ok(None)
            }
            Err(e) => {
                log::warn!(target: "vscodeee::secrets", "secret_get: permissive path error for key={key}: {e}");
                Err(e)
            }
        };
    }

    // On release builds (and non-macOS), use the default keyring behavior.
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
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
}

/// Store a secret value in the OS credential store.
///
/// # Arguments
/// * `key` - The secret key.
/// * `value` - The secret value to store.
///
/// On macOS debug builds, the Keychain item is stored with an "any application"
/// ACL to avoid password prompts across different worktree binaries.
/// On release builds, the default (application-specific) ACL is used.
#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    log::trace!(target: "vscodeee::secrets", "secret_set: key={key}");

    // On macOS debug builds, use the permissive ACL path to avoid password
    // prompts when multiple worktree binaries access the same Keychain item.
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        log::info!(target: "vscodeee::secrets", "secret_set: using permissive ACL path for key={key}");
        macos_permissive::set_password_any_app(SERVICE_NAME, &key, &value)?;
        log::info!(target: "vscodeee::secrets", "secret_set: stored value for key={key} (permissive ACL)");
        return Ok(());
    }

    // On release builds (and non-macOS), use the default keyring behavior.
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    {
        let entry = keyring::Entry::new(SERVICE_NAME, &key)
            .map_err(|e| format!("Failed to create keyring entry for key '{key}': {e}"))?;

        entry
            .set_password(&value)
            .map_err(|e| format!("Failed to set secret for key '{key}': {e}"))?;

        log::trace!(target: "vscodeee::secrets", "secret_set: stored value for key={key}");
        Ok(())
    }
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

// ── macOS debug-only: permissive ACL implementation ──────────────────────────
//
// Uses the macOS Security Framework C API directly to create Keychain items
// with an "any application" ACL. This avoids the password prompt that occurs
// when different binaries (from different worktrees) access the same item.
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

    // FFI declarations for macOS Security Framework APIs not exposed
    // by the `security-framework-sys` crate.
    extern "C" {
        // kSecAttrAccess: CFStringRef key for setting the access object on a
        // legacy Keychain item (macOS only, not available on iOS).
        static kSecAttrAccess: core_foundation_sys::string::CFStringRef;

        // kSecMatchLimitOne: CFStringRef value for kSecMatchLimit that limits
        // SecItemCopyMatching to return at most one item.
        static kSecMatchLimitOne: core_foundation_sys::string::CFStringRef;

        // SecAccessCreate: Creates a new access object.
        // trustedList=NULL → only calling app; empty CFArray → empty list.
        // We use NULL here and then patch ACL entries afterwards.
        fn SecAccessCreate(
            descriptor: core_foundation_sys::string::CFStringRef,
            trusted_list: core_foundation_sys::array::CFArrayRef,
            access_ref: *mut security_framework_sys::base::SecAccessRef,
        ) -> OSStatus;

        // SecAccessCopyACLList: Get all ACL entries from a SecAccess object.
        fn SecAccessCopyACLList(
            access_ref: security_framework_sys::base::SecAccessRef,
            acl_list: *mut core_foundation_sys::array::CFArrayRef,
        ) -> OSStatus;

        // SecACLSetContents: Set the application list for an ACL entry.
        // applicationList=NULL means "any application" (no restriction).
        fn SecACLSetContents(
            acl: *const c_void,                                       // SecACLRef
            application_list: core_foundation_sys::array::CFArrayRef, // NULL = any app
            description: core_foundation_sys::string::CFStringRef,
            prompt_selector: u16, // SecKeychainPromptSelector
        ) -> OSStatus;

        // SecACLCopyContents: Read the current contents of an ACL entry.
        fn SecACLCopyContents(
            acl: *const c_void, // SecACLRef
            application_list: *mut core_foundation_sys::array::CFArrayRef,
            description: *mut core_foundation_sys::string::CFStringRef,
            prompt_selector: *mut u16, // SecKeychainPromptSelector
        ) -> OSStatus;
    }

    /// Create a new mutable CFDictionary. Caller must CFRelease when done.
    unsafe fn create_mutable_dict() -> CFMutableDictionaryRef {
        CFDictionaryCreateMutable(
            kCFAllocatorDefault,
            0,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    }

    /// Store a generic password in the macOS Keychain with an "any application" ACL.
    ///
    /// This function:
    /// 1. Creates a `SecAccess` object (default ACL).
    /// 2. Iterates all ACL entries and sets each one's application list to NULL
    ///    (= `applications: <null>` = any application can access without prompting).
    /// 3. Deletes any existing item with the same service/account.
    /// 4. Creates a new Keychain item with the fully permissive ACL.
    ///
    /// ## Key insight
    /// - `SecACLSetContents(acl, NULL, ...)` → `applications: <null>` (any app, no prompt)
    /// - `SecACLSetContents(acl, empty_array, ...)` → `applications (0)` (no app allowed!)
    /// - `SecAccessCreate(desc, NULL, ...)` → default ACL with calling app only
    pub(super) fn set_password_any_app(
        service: &str,
        account: &str,
        password: &str,
    ) -> Result<(), String> {
        unsafe {
            // Step 1: Create a SecAccess with default ACL (we'll patch it below).
            let descriptor = CFString::new(service);
            let mut access_ref: security_framework_sys::base::SecAccessRef = ptr::null_mut();
            let status = SecAccessCreate(
                descriptor.as_concrete_TypeRef(),
                ptr::null(), // default: calling app only (we'll override below)
                &mut access_ref,
            );
            if status != 0 {
                return Err(format!(
                    "SecAccessCreate failed with status {status} for key '{account}'"
                ));
            }

            // Step 2: Get all ACL entries and set each one to "any application".
            let mut acl_list: core_foundation_sys::array::CFArrayRef = ptr::null();
            let status = SecAccessCopyACLList(access_ref, &mut acl_list);
            if status != 0 {
                CFRelease(access_ref as CFTypeRef);
                return Err(format!(
                    "SecAccessCopyACLList failed with status {status} for key '{account}'"
                ));
            }

            let acl_count = core_foundation_sys::array::CFArrayGetCount(acl_list);
            log::info!(
                target: "vscodeee::secrets",
                "set_password_any_app: patching {acl_count} ACL entries for key={account}"
            );

            for i in 0..acl_count {
                let acl = core_foundation_sys::array::CFArrayGetValueAtIndex(acl_list, i);

                // Read current contents to preserve description and prompt selector.
                let mut app_list: core_foundation_sys::array::CFArrayRef = ptr::null();
                let mut desc: core_foundation_sys::string::CFStringRef = ptr::null();
                let mut prompt: u16 = 0;
                let status = SecACLCopyContents(acl, &mut app_list, &mut desc, &mut prompt);
                if status != 0 {
                    log::warn!(
                        target: "vscodeee::secrets",
                        "set_password_any_app: SecACLCopyContents failed for ACL {i}: status={status}"
                    );
                    continue;
                }

                // Set application list to NULL = any application (no restriction).
                let status = SecACLSetContents(
                    acl,
                    ptr::null(), // NULL = applications: <null> = any app
                    desc,
                    prompt,
                );

                // Clean up the copies.
                if !app_list.is_null() {
                    CFRelease(app_list as CFTypeRef);
                }
                if !desc.is_null() {
                    CFRelease(desc as CFTypeRef);
                }

                if status != 0 {
                    log::warn!(
                        target: "vscodeee::secrets",
                        "set_password_any_app: SecACLSetContents failed for ACL {i}: status={status}"
                    );
                }
            }

            CFRelease(acl_list as CFTypeRef);

            // Prepare CFString values (these are auto-released via Drop).
            let cf_service = CFString::new(service);
            let cf_account = CFString::new(account);
            let cf_password = core_foundation::data::CFData::from_buffer(password.as_bytes());

            // Step 3: Delete existing item if present (ignore errors).
            let delete_dict = create_mutable_dict();
            CFDictionaryAddValue(
                delete_dict,
                kSecClass as *const c_void,
                kSecClassGenericPassword as *const c_void,
            );
            CFDictionaryAddValue(
                delete_dict,
                kSecAttrService as *const c_void,
                cf_service.as_concrete_TypeRef() as *const c_void,
            );
            CFDictionaryAddValue(
                delete_dict,
                kSecAttrAccount as *const c_void,
                cf_account.as_concrete_TypeRef() as *const c_void,
            );
            let _ = SecItemDelete(delete_dict as CFDictionaryRef);
            CFRelease(delete_dict as CFTypeRef);

            // Step 4: Add new item with the fully permissive ACL.
            let add_dict = create_mutable_dict();
            CFDictionaryAddValue(
                add_dict,
                kSecClass as *const c_void,
                kSecClassGenericPassword as *const c_void,
            );
            CFDictionaryAddValue(
                add_dict,
                kSecAttrService as *const c_void,
                cf_service.as_concrete_TypeRef() as *const c_void,
            );
            CFDictionaryAddValue(
                add_dict,
                kSecAttrAccount as *const c_void,
                cf_account.as_concrete_TypeRef() as *const c_void,
            );
            CFDictionaryAddValue(
                add_dict,
                kSecValueData as *const c_void,
                cf_password.as_concrete_TypeRef() as *const c_void,
            );
            CFDictionaryAddValue(
                add_dict,
                kSecAttrAccess as *const c_void,
                access_ref as *const c_void,
            );

            let status = SecItemAdd(add_dict as CFDictionaryRef, ptr::null_mut());

            // Clean up.
            CFRelease(add_dict as CFTypeRef);
            CFRelease(access_ref as CFTypeRef);

            if status != 0 {
                return Err(format!(
                    "SecItemAdd failed with status {status} for key '{account}'"
                ));
            }

            log::info!(
                target: "vscodeee::secrets",
                "set_password_any_app: stored with fully permissive ACL for key={account}"
            );

            Ok(())
        }
    }

    /// Read a generic password from the macOS Keychain and, if the item's ACL
    /// restricts access to specific binaries, re-save it with an "any application"
    /// ACL so that future reads from any worktree binary succeed without prompting.
    ///
    /// ## Behavior
    /// 1. Use `SecItemCopyMatching` to read the password value.
    /// 2. If the item does not exist, return `Ok(None)`.
    /// 3. If the read succeeds, re-save the same value via `set_password_any_app`
    ///    which deletes + re-creates the item with a fully permissive ACL.
    ///    This is idempotent — if the ACL is already permissive, the re-save
    ///    simply overwrites with the same value and ACL.
    ///
    /// ## Important
    /// The first call from a new binary **may still trigger a password dialog**
    /// if the existing item has a binary-restricted ACL and the user allowed
    /// access. After that, the ACL is patched and subsequent calls won't prompt.
    pub(super) fn get_password_and_patch_acl(
        service: &str,
        account: &str,
    ) -> Result<Option<String>, String> {
        unsafe {
            let cf_service = CFString::new(service);
            let cf_account = CFString::new(account);

            // Build the query dictionary for SecItemCopyMatching.
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

            let mut result: CFTypeRef = ptr::null();
            let status = SecItemCopyMatching(query as CFDictionaryRef, &mut result);
            CFRelease(query as CFTypeRef);

            // errSecItemNotFound = -25300
            if status == -25300 {
                return Ok(None);
            }

            if status != 0 {
                return Err(format!(
                    "Failed to get secret for key '{account}': Platform secure storage failure (status {status})"
                ));
            }

            if result.is_null() {
                return Ok(None);
            }

            // Convert CFData → String.
            let data_ref = result as core_foundation_sys::data::CFDataRef;
            let len = core_foundation_sys::data::CFDataGetLength(data_ref) as usize;
            let ptr = core_foundation_sys::data::CFDataGetBytePtr(data_ref);
            let bytes = std::slice::from_raw_parts(ptr, len);
            let password = String::from_utf8_lossy(bytes).into_owned();
            CFRelease(result);

            // Re-save with permissive ACL to patch any binary-restricted ACL.
            // This is idempotent — overwrites with same value + any-app ACL.
            log::info!(
                target: "vscodeee::secrets",
                "get_password_and_patch_acl: re-saving with permissive ACL for key={account}"
            );
            if let Err(e) = set_password_any_app(service, account, &password) {
                // Log the error but still return the password — the read succeeded.
                log::warn!(
                    target: "vscodeee::secrets",
                    "get_password_and_patch_acl: failed to patch ACL for key={account}: {e}"
                );
            }

            Ok(Some(password))
        }
    }
}
