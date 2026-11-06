//! macOS: the OSCrypt password in the login Keychain, through the SecItem API like Chromium 156's KeychainPassword
//! (crypto/apple/keychain_v2). Names and steps as in Electron 45.2.2 (shell/browser/electron_browser_main_parts.cc sets service
//! `<app name> Safe Storage` and account `<app name>`; Electron's patch
//! feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch appends ` Key` for non-MAS builds):
//!
//! 1. generic password service `unimux Safe Storage`, account `unimux Key`: found -> use it;
//! 2. not found: the legacy account `unimux`: found -> copy it to `unimux Key`, delete the legacy item, use it;
//! 3. neither: store base64 of 16 random bytes as `unimux Key` (Chromium's AddRandomPasswordToKeychain) and use it;
//! 4. any other Keychain error: no password (safeStorage unavailable).
//!
//! The password bytes (the base64 text) feed PBKDF2 directly. NOT run on a real Mac yet (SP2 Mac half): compiled and clippy
//! clean for aarch64-apple-darwin only.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};
use zeroize::Zeroizing;

/// errSecItemNotFound.
const ITEM_NOT_FOUND: i32 = -25300;

pub fn service_name(app_name: &str) -> String {
    format!("{app_name} Safe Storage")
}

pub fn account_name(app_name: &str) -> String {
    format!("{app_name} Key")
}

/// How the password was obtained (for `Origin` in startup.log).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Found {
    /// Step 1: the `<app> Key` item.
    Existing,
    /// Step 2: the legacy `<app>` item (copied to `<app> Key`).
    Migrated,
    /// Step 3: a new random password was stored.
    Created,
}

/// The password bytes and how they were found, or None when the Keychain refused (locked, denied, no default keychain).
pub fn password(app_name: &str) -> Option<(Zeroizing<Vec<u8>>, Found)> {
    let (service, account) = (service_name(app_name), account_name(app_name));
    match get_generic_password(&service, &account) {
        Ok(found) => return Some((Zeroizing::new(found), Found::Existing)),
        Err(e) if e.code() == ITEM_NOT_FOUND => {}
        Err(_) => return None,
    }
    match get_generic_password(&service, app_name) {
        Ok(legacy) => {
            let legacy = Zeroizing::new(legacy);
            if set_generic_password(&service, &account, &legacy).is_ok() {
                let _ = delete_generic_password(&service, app_name);
            }
            return Some((legacy, Found::Migrated));
        }
        Err(e) if e.code() == ITEM_NOT_FOUND => {}
        Err(_) => return None,
    }
    let mut random = Zeroizing::new([0u8; 16]);
    getrandom::fill(random.as_mut()).ok()?;
    let created = Zeroizing::new(STANDARD.encode(random.as_ref()).into_bytes());
    set_generic_password(&service, &account, &created).ok()?;
    Some((created, Found::Created))
}
