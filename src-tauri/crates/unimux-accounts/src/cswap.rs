//! Read-only view of claude-swap's roster (port of src/main/accounts/cswap.ts): `sequence.json` holds e-mail, uuid and
//! organizationUuid per account, no tokens. cswap's files are never written, and of its credentials only the file names and
//! times are read (never their content). It only decides which saved accounts this app must not renew or swap in (R6, R7).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{Map, Value};
use unimux_core::js_json;

use crate::identity::{AccountIdentity, IdentityMatch, compare_identity, identity_fields_of};
use crate::js;

/// `CswapRoster`: `{ present: false }` without cswap; `accounts: None` for a roster that cannot be read (it holds everything).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CswapRoster {
    Absent,
    Present(Option<Vec<AccountIdentity>>),
}

impl CswapRoster {
    /// The conservative answer for anything unreadable.
    pub const UNREADABLE: CswapRoster = CswapRoster::Present(None);
}

/// The OS for the paths of other tools (`process.platform` where it matters).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// Where cswap keeps its roster (claude_swap/paths.py, get_backup_root).
pub fn cswap_roster_path(home: &Path, xdg_data_home: Option<&str>, os: Os) -> PathBuf {
    if os == Os::Linux {
        let mut xdg = xdg_data_home.map(|x| js::trim(x).to_string()).filter(|x| !x.is_empty());
        // cswap expands a leading `~` (os.path.expanduser) before the absolute-path check.
        if let Some(x) = &xdg
            && (x == "~" || x.starts_with("~/"))
        {
            xdg = Some(home.join(x.get(2..).unwrap_or("")).to_string_lossy().into_owned());
        }
        let base = match xdg {
            Some(x) if x.starts_with('/') => PathBuf::from(x).join("claude-swap"),
            _ => home.join(".local").join("share").join("claude-swap"),
        };
        return base.join("sequence.json");
    }
    home.join(".claude-swap-backup").join("sequence.json")
}

/// A real roster is a few KB; anything bigger is not read and counts as holding everything.
pub const CSWAP_ROSTER_MAX_BYTES: u64 = 1024 * 1024;

/// `readCswapRoster`.
pub fn read_cswap_roster(path: &Path) -> CswapRoster {
    let text = match fs::metadata(path) {
        Ok(info) if !info.is_file() || info.len() > CSWAP_ROSTER_MAX_BYTES => return CswapRoster::UNREADABLE,
        Ok(_) => match js::read_text(path) {
            Ok(t) => t,
            Err(e) => return absent_or_unreadable(&e),
        },
        Err(e) => return absent_or_unreadable(&e),
    };
    let Ok(data) = js_json::parse(&text) else { return CswapRoster::UNREADABLE };
    // `typeof data === 'object' && data !== null ? data.accounts : undefined` (an array has no `accounts`).
    let accounts = match &data {
        Value::Object(m) => m.get("accounts"),
        _ => None,
    };
    let Some(Value::Object(accounts)) = accounts else { return CswapRoster::UNREADABLE };
    CswapRoster::Present(Some(
        accounts
            .values()
            .filter_map(Value::as_object)
            .map(|a| {
                let mut m = Map::new();
                for (to, from) in [
                    ("email", "email"),
                    ("accountUuid", "uuid"),
                    ("organizationUuid", "organizationUuid"),
                    ("org", "organizationName"),
                ] {
                    if let Some(v) = a.get(from) {
                        m.insert(to.into(), v.clone());
                    }
                }
                identity_fields_of(&m)
            })
            .collect(),
    ))
}

fn absent_or_unreadable(e: &io::Error) -> CswapRoster {
    if crate::swapfs::is_missing(e) { CswapRoster::Absent } else { CswapRoster::UNREADABLE }
}

/// File timestamps may be coarse (2 s on FAT); a write this close before `since` still counts as after it.
const MTIME_SLACK_MS: f64 = 2_000.0;

/// The two file operations of [`cswap_wrote_since`] (`CswapFilesFs`).
pub trait CswapFilesFs {
    fn readdir(&self, path: &Path) -> io::Result<Vec<String>>;
    fn mtime_ms(&self, path: &Path) -> io::Result<f64>;
}

/// The real file system.
pub struct RealCswapFs;

impl CswapFilesFs for RealCswapFs {
    fn readdir(&self, path: &Path) -> io::Result<Vec<String>> {
        fs::read_dir(path)?.map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned())).collect()
    }
    fn mtime_ms(&self, path: &Path) -> io::Result<f64> {
        let t = fs::metadata(path)?.modified()?;
        Ok(t.duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0))
    }
}

/// Whether cswap may have saved this account's tokens at `since` or later. cswap keeps one credentials file per account in
/// `<backup root>/credentials` (`.creds-<n>-<email>.enc`, plus `.prev`) and rewrites it whenever it backs up or resyncs the
/// live login; the files are only listed and their times read, never opened. Anything unclear answers true (conservative):
/// an unreadable roster or folder, an account without an e-mail, or no file of that account. An account cswap does not
/// list was never saved by it.
pub fn cswap_wrote_since(
    roster_path: &Path,
    roster: &CswapRoster,
    identity: &AccountIdentity,
    since: f64,
    fs: &dyn CswapFilesFs,
) -> bool {
    let accounts = match roster {
        CswapRoster::Absent => return false,
        CswapRoster::Present(None) => return true,
        CswapRoster::Present(Some(a)) => a,
    };
    let listed: Vec<&AccountIdentity> =
        accounts.iter().filter(|entry| compare_identity(entry, identity) != IdentityMatch::Different).collect();
    if listed.is_empty() {
        return false;
    }
    let mut emails: Vec<String> = Vec::new();
    for i in std::iter::once(identity).chain(listed.iter().copied()) {
        if let Some(e) = i.email.as_deref().map(|e| js::trim(e).to_lowercase()).filter(|e| !e.is_empty())
            && !emails.contains(&e)
        {
            emails.push(e);
        }
    }
    if emails.is_empty() {
        return true;
    }
    let dir = roster_path.parent().unwrap_or(Path::new(".")).join("credentials");
    let Ok(names) = fs.readdir(&dir) else { return true };
    let mine: Vec<String> =
        names.into_iter().filter(|name| emails.iter().any(|email| name.to_lowercase().contains(&format!("-{email}")))).collect();
    if mine.is_empty() {
        return true;
    }
    for name in mine {
        match fs.mtime_ms(&dir.join(&name)) {
            Ok(m) if m >= since - MTIME_SLACK_MS => return true,
            Ok(_) => {}
            Err(_) => return true,
        }
    }
    false
}

/// cswap may hold a copy of this account's tokens. An unreadable roster holds everything (conservative).
pub fn cswap_holds(roster: &CswapRoster, identity: &AccountIdentity) -> bool {
    match roster {
        CswapRoster::Absent => false,
        CswapRoster::Present(None) => true,
        CswapRoster::Present(Some(a)) => a.iter().any(|entry| compare_identity(entry, identity) != IdentityMatch::Different),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(email: Option<&str>, uuid: Option<&str>) -> AccountIdentity {
        AccountIdentity { email: email.map(Into::into), account_uuid: uuid.map(Into::into), ..Default::default() }
    }

    fn cred_file(root: &Path, name: &str, at_ms: f64) {
        let dir = root.join(".claude-swap-backup").join("credentials");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, "encrypted").unwrap();
        let t = UNIX_EPOCH + std::time::Duration::from_millis(at_ms as u64);
        fs::File::options().write(true).open(&path).unwrap().set_modified(t).unwrap();
    }

    const NOW: f64 = 1_792_152_000_000.0; // 2026-10-16T12:00:00Z

    /// accounts-activate.test.ts "tells by the file times of that account whether cswap saved it since".
    #[test]
    fn tells_by_the_file_times_of_that_account_whether_cswap_saved_it_since() {
        let home = tempfile::tempdir().unwrap();
        let roster_path = cswap_roster_path(home.path(), None, Os::Windows);
        let listed = CswapRoster::Present(Some(vec![id(Some("X@x.com"), Some("uuid-X"))]));
        let x = id(Some("x@x.com"), Some("uuid-X"));
        cred_file(home.path(), ".creds-1-x@x.com.enc", NOW - 60_000.0);
        cred_file(home.path(), ".creds-2-other@x.com.enc", NOW + 60_000.0);
        assert!(!cswap_wrote_since(&roster_path, &listed, &x, NOW, &RealCswapFs));
        cred_file(home.path(), ".creds-1-x@x.com.enc.prev", NOW + 1_000.0);
        assert!(cswap_wrote_since(&roster_path, &listed, &x, NOW, &RealCswapFs));
    }

    /// accounts-activate.test.ts "answers yes whenever it cannot tell, and no for an account cswap does not list or without cswap".
    #[test]
    fn answers_yes_whenever_it_cannot_tell_and_no_for_an_unlisted_account_or_without_cswap() {
        let home = tempfile::tempdir().unwrap();
        let roster_path = cswap_roster_path(home.path(), None, Os::Windows);
        let listed = CswapRoster::Present(Some(vec![id(Some("X@x.com"), Some("uuid-X"))]));
        let x = id(Some("x@x.com"), Some("uuid-X"));
        assert!(cswap_wrote_since(&roster_path, &listed, &x, NOW, &RealCswapFs)); // no credentials folder
        cred_file(home.path(), ".creds-2-other@x.com.enc", NOW - 60_000.0);
        assert!(cswap_wrote_since(&roster_path, &listed, &x, NOW, &RealCswapFs)); // no file of that account
        assert!(cswap_wrote_since(&roster_path, &CswapRoster::UNREADABLE, &x, NOW, &RealCswapFs));
        let uuid_only = CswapRoster::Present(Some(vec![id(None, Some("uuid-X"))]));
        assert!(cswap_wrote_since(&roster_path, &uuid_only, &id(None, Some("uuid-X")), NOW, &RealCswapFs));
        let other = CswapRoster::Present(Some(vec![id(Some("o@x.com"), Some("uuid-O"))]));
        assert!(!cswap_wrote_since(&roster_path, &other, &x, NOW, &RealCswapFs));
        assert!(!cswap_wrote_since(&roster_path, &CswapRoster::Absent, &x, NOW, &RealCswapFs));
    }

    #[test]
    fn reads_the_roster_conservatively() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sequence.json");
        assert_eq!(read_cswap_roster(&path), CswapRoster::Absent);
        fs::write(&path, "{").unwrap();
        assert_eq!(read_cswap_roster(&path), CswapRoster::UNREADABLE);
        fs::write(&path, "[]").unwrap();
        assert_eq!(read_cswap_roster(&path), CswapRoster::UNREADABLE);
        fs::write(&path, r#"{"accounts":[]}"#).unwrap();
        assert_eq!(read_cswap_roster(&path), CswapRoster::UNREADABLE);
        fs::write(
            &path,
            r#"{"accounts":{"2":{"email":"b@x.com","uuid":"u-b","organizationName":" "},"1":{"email":"a@x.com","organizationUuid":"o"},"x":5}}"#,
        )
        .unwrap();
        let CswapRoster::Present(Some(a)) = read_cswap_roster(&path) else { panic!() };
        // Object.values: index keys first, ascending.
        assert_eq!(a[0].email.as_deref(), Some("a@x.com"));
        assert_eq!(a[0].organization_uuid.as_deref(), Some("o"));
        assert_eq!(a[1].account_uuid.as_deref(), Some("u-b"));
        assert_eq!(a[1].org, None);
        fs::write(&path, vec![b' '; (CSWAP_ROSTER_MAX_BYTES + 1) as usize]).unwrap();
        assert_eq!(read_cswap_roster(&path), CswapRoster::UNREADABLE);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(read_cswap_roster(&path), CswapRoster::UNREADABLE);
        let home = Path::new("/home/u");
        assert_eq!(
            cswap_roster_path(home, Some("~/data"), Os::Linux),
            home.join("data").join("claude-swap").join("sequence.json")
        );
        assert_eq!(cswap_roster_path(home, Some("rel"), Os::Linux), home.join(".local/share/claude-swap").join("sequence.json"));
        assert_eq!(cswap_roster_path(home, Some("/x"), Os::Linux), PathBuf::from("/x").join("claude-swap").join("sequence.json"));
    }

    #[test]
    fn holds_unless_proven_different() {
        let roster = CswapRoster::Present(Some(vec![id(Some("x@x.com"), None)]));
        assert!(cswap_holds(&roster, &id(Some("X@x.com"), Some("u"))));
        assert!(!cswap_holds(&roster, &id(Some("y@x.com"), None)));
        assert!(cswap_holds(&roster, &AccountIdentity::default())); // unknown is not different
        assert!(cswap_holds(&CswapRoster::UNREADABLE, &id(Some("y@x.com"), None)));
        assert!(!cswap_holds(&CswapRoster::Absent, &id(Some("x@x.com"), None)));
    }
}
