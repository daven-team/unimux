//! The DB vault against what the real 1.1.4 wrote (PLAN D1: "a 1.1.4 db/vault.json decrypts"): the SP2 fixture
//! (unimux-oscrypt/tests/fixtures/win-electron45, made by Electron 45.2.2 = unimux 1.1.4 on a throwaway profile) holds a
//! db/vault.json with one DB password, the `Local State` it belongs to and the unwrapped key (throwaway, so the AES layer
//! runs on every OS). The DPAPI path itself (the key unwrapped from `Local State`) works only for the Windows user who made
//! the fixture; for anyone else the password shows as locked, like in 1.1.4.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use unimux_db::vault::{DbVault, Password, SetPassword};
use unimux_oscrypt::{Cipher, Storage};
#[cfg(windows)]
use unimux_oscrypt::{Origin, SafeCipher, local_state};

const CONNECTION: &str = "2d855a7a-4192-4b5c-a5be-8551bacddb33";
const SECRET: &str = "db-pass Ünïcode 数据库";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../unimux-oscrypt/tests/fixtures/win-electron45")
}

fn fixture_key() -> Cipher {
    let hex = std::fs::read_to_string(fixture().join("key.hex")).unwrap();
    let hex = hex.trim();
    let key: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
    Cipher::with_gcm_key(key.try_into().unwrap())
}

/// A scratch data dir with the 1.1.4 db/vault.json.
fn data_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("db").join("vault.json");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::copy(fixture().join("electron/db/vault.json"), &file).unwrap();
    (dir, file)
}

#[test]
fn a_1_1_4_db_vault_decrypts_and_is_rewritten_byte_for_byte() {
    let (_dir, file) = data_dir();
    let original = std::fs::read(&file).unwrap();
    let vault = DbVault::new(&file, Arc::new(fixture_key()));
    let info = vault.info();
    assert_eq!(
        (info.storage, info.saved.clone(), info.locked.clone(), info.read_only),
        (Storage::Dpapi, vec![CONNECTION.to_string()], vec![], false)
    );
    match vault.password(CONNECTION) {
        Password::Ok(p) => assert_eq!(p.as_str(), SECRET),
        other => panic!("{other:?}"),
    }
    // Another password saved and removed again: the 1.1.4 entry is written back exactly as 1.1.4 wrote it.
    assert_eq!(vault.set_password("00000000-0000-4000-8000-000000000001", "x").unwrap(), SetPassword::Saved { ephemeral: false });
    assert_ne!(std::fs::read(&file).unwrap(), original);
    assert!(vault.clear_password("00000000-0000-4000-8000-000000000001").unwrap());
    assert_eq!(String::from_utf8(std::fs::read(&file).unwrap()).unwrap(), String::from_utf8(original).unwrap());
    // A password the Rust side seals reads back in 1.1.4's format (v10 + nonce + ciphertext + tag, base64).
    vault.set_password(CONNECTION, SECRET).unwrap();
    let again = DbVault::new(&file, Arc::new(fixture_key()));
    assert!(matches!(again.password(CONNECTION), Password::Ok(p) if p.as_str() == SECRET));
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let blob = unimux_oscrypt::node_base64::decode(v["passwords"][0]["secret"].as_str().unwrap());
    assert!(unimux_oscrypt::v10::has_prefix(&blob));
}

#[test]
fn with_another_key_the_1_1_4_password_shows_as_locked_and_the_file_stays() {
    let (_dir, file) = data_dir();
    let original = std::fs::read(&file).unwrap();
    let vault = DbVault::new(&file, Arc::new(Cipher::with_gcm_key([7; 32])));
    assert_eq!(vault.info().locked, vec![CONNECTION.to_string()]);
    assert_eq!(vault.password(CONNECTION), Password::Locked);
    assert_eq!(std::fs::read(&file).unwrap(), original);
}

/// The real key path: `Local State` of the fixture unwrapped with DPAPI. Only the Windows user who made the fixture gets the
/// key back; anyone else (CI) gets a new key (Origin::Replaced, like Chromium) and the old password stays locked.
#[cfg(windows)]
#[test]
fn the_fixture_local_state_opens_the_1_1_4_vault_for_its_windows_user() {
    let (dir, file) = data_dir();
    std::fs::copy(fixture().join("Local State"), local_state::path(dir.path())).unwrap();
    let cipher = Cipher::open(dir.path(), "unimux", false);
    let origin = cipher.origin().clone();
    let vault = DbVault::new(&file, Arc::new(cipher) as Arc<dyn SafeCipher>);
    match origin {
        Origin::Existing => {
            assert!(matches!(vault.password(CONNECTION), Password::Ok(p) if p.as_str() == SECRET));
            assert!(vault.info().locked.is_empty());
        }
        Origin::Replaced(reason) => {
            eprintln!("the fixture Local State belongs to another Windows user: {reason}");
            assert_eq!(vault.info().locked, vec![CONNECTION.to_string()]);
        }
        other => panic!("unexpected origin {other:?}"),
    }
}
