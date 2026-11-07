//! Ports of test/accounts-migrate.test.ts.

use super::*;
use crate::identity::identity_from_oauth_account;
use serde_json::{Value, json};
use std::path::PathBuf;

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const C: &str = "33333333-3333-4333-8333-333333333333";

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    store: AccountsStore,
}

impl Fx {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join("accounts")).unwrap();
        let store = AccountsStore::new(root.join("accounts"));
        Self { _tmp: tmp, root, store }
    }
    fn file(&self) -> PathBuf {
        self.root.join("accounts").join("accounts.json")
    }
    /// A 0.9.0 record (version-less accounts.json) with a fake login in its profile dir.
    fn legacy(&self, id: &str, added_at: f64, label: &str, file: Option<(&str, Option<&str>, Option<&str>)>, expires_at: f64) {
        let mut listed: Vec<Value> = self
            .store
            .list()
            .iter()
            .map(|r| json!({ "id": r.id, "addedAt": crate::js::num(r.added_at), "email": r.identity.email }))
            .collect();
        listed.push(json!({ "id": id, "addedAt": crate::js::num(added_at), "email": label }));
        std::fs::write(self.file(), json!({ "claude": listed }).to_string()).unwrap();
        let dir = self.store.dir_of(id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".credentials.json"),
            json!({ "claudeAiOauth": { "accessToken": format!("fake-access-{id}"), "refreshToken": format!("fake-refresh-{id}"), "expiresAt": crate::js::num(expires_at) } }).to_string(),
        )
        .unwrap();
        if let Some((email, uuid, org)) = file {
            let mut account = serde_json::Map::new();
            account.insert("emailAddress".into(), email.into());
            if let Some(u) = uuid {
                account.insert("accountUuid".into(), u.into());
            }
            if let Some(o) = org {
                account.insert("organizationUuid".into(), o.into());
            }
            std::fs::write(dir.join(".claude.json"), json!({ "oauthAccount": account }).to_string()).unwrap();
        }
    }
    fn run(&self, live: Option<AccountIdentity>) -> MigrationReport {
        let read_profile = |dir: &Path| -> Result<AccountIdentity, ()> {
            let text = std::fs::read_to_string(dir.join(".claude.json")).map_err(|_| ())?;
            let v: Value = serde_json::from_str(&text).map_err(|_| ())?;
            Ok(identity_from_oauth_account(v.get("oauthAccount")))
        };
        let read_live = || Ok(live.clone());
        let read_expiry = |dir: &Path| Ok(crate::live::profile_expiry(dir));
        migrate_accounts(&MigrationDeps {
            store: &self.store,
            read_profile_identity: &read_profile,
            read_live_identity: &read_live,
            read_expiry: &read_expiry,
            now: &|| 5.0,
        })
        .unwrap()
    }
}

fn id(email: &str, uuid: &str) -> AccountIdentity {
    AccountIdentity { email: Some(email.into()), account_uuid: Some(uuid.into()), ..Default::default() }
}

#[test]
fn backfills_uuids_from_the_profile_and_runs_only_once() {
    let fx = Fx::new();
    fx.legacy(A, 1.0, "a@x.com", Some(("a@x.com", Some("ua"), Some("oa"))), 1000.0);
    let report = fx.run(None);
    assert_eq!((report.migrated, report.filled, report.quarantined.len()), (true, 1, 0));
    let r = fx.store.get(A).unwrap();
    assert_eq!(
        (r.identity.email.as_deref(), r.identity.account_uuid.as_deref(), r.identity.organization_uuid.as_deref()),
        (Some("a@x.com"), Some("ua"), Some("oa"))
    );
    assert_eq!(fx.store.version(), 2.0);
    assert!(!fx.run(None).migrated);
}

#[test]
fn sets_duplicates_of_the_live_account_aside_keeping_the_oldest_record_deleting_nothing() {
    let fx = Fx::new();
    fx.legacy(A, 1.0, "a@x.com", Some(("a@x.com", Some("ua"), None)), 1000.0);
    fx.legacy(B, 2.0, "a@x.com", Some(("a@x.com", Some("ua"), None)), 1000.0);
    fx.legacy(C, 3.0, "c@x.com", Some(("c@x.com", Some("uc"), None)), 1000.0);
    let report = fx.run(Some(id("a@x.com", "ua")));
    assert_eq!(report.quarantined, [(B.to_string(), A.to_string())]);
    let b = fx.store.get(B).unwrap();
    assert_eq!((b.custody, b.duplicate_of.as_deref()), (Some(Custody::Quarantined), Some(A)));
    assert_eq!(fx.store.get(A).unwrap().custody, None);
    for i in [A, B, C] {
        assert!(fx.store.dir_of(i).unwrap().exists());
    }
    let mut kinds: Vec<&str> = fx.store.notices().iter().map(|n| n.kind.as_str()).collect();
    kinds.sort();
    assert_eq!(kinds, ["migrated", "quarantined"]);
}

#[test]
fn keeps_the_freshest_login_of_duplicates_that_are_not_live() {
    let fx = Fx::new();
    fx.legacy(A, 1.0, "a@x.com", Some(("a@x.com", Some("ua"), None)), 100.0);
    fx.legacy(B, 2.0, "a@x.com", Some(("a@x.com", Some("ua"), None)), 900.0);
    assert_eq!(fx.run(Some(id("z@x.com", "uz"))).quarantined, [(A.to_string(), B.to_string())]);
}

#[test]
fn trusts_the_profile_file_over_a_rewritten_label_and_drops_its_stale_organisation() {
    let fx = Fx::new();
    fx.legacy(A, 1.0, "support@guybot.xyz", Some(("app@x.com", Some("uapp"), None)), 1000.0);
    fx.store.update(A, None, Some(Some("Guybot"))).unwrap();
    fx.run(None);
    let r = fx.store.get(A).unwrap();
    assert_eq!(r.identity, id("app@x.com", "uapp"));
    assert_eq!(
        serde_json::to_value(&r).unwrap(),
        json!({ "id": A, "addedAt": 1.0, "email": "app@x.com", "accountUuid": "uapp" })
    );
}

#[test]
fn never_marks_or_writes_over_an_accounts_json_it_cannot_read_safely() {
    let fx = Fx::new();
    fx.legacy(A, 1.0, "a@x.com", Some(("a@x.com", Some("ua"), None)), 1000.0);
    let original = r#"{"claude":{"broken":true}}"#;
    std::fs::write(fx.file(), original).unwrap();
    assert_eq!(fx.run(None), MigrationReport::default());
    assert_eq!(std::fs::read_to_string(fx.file()).unwrap(), original);
    std::fs::remove_file(fx.file()).unwrap();
    std::fs::create_dir(fx.file()).unwrap();
    assert!(!fx.run(None).migrated);
    assert_eq!(std::fs::read_dir(fx.file()).unwrap().count(), 0);
    std::fs::remove_dir(fx.file()).unwrap();
    fx.legacy(A, 1.0, "a@x.com", Some(("a@x.com", Some("ua"), None)), 1000.0);
    assert!(fx.run(None).migrated);
    assert_eq!(fx.store.get(A).unwrap().identity.account_uuid.as_deref(), Some("ua"));
}

#[test]
fn moves_an_unparsable_accounts_json_to_a_timestamped_backup_then_starts_an_empty_v2_list() {
    let fx = Fx::new();
    std::fs::write(fx.file(), "{not json").unwrap();
    assert!(fx.run(None).migrated);
    let backups: Vec<String> = std::fs::read_dir(fx.root.join("accounts"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("accounts.json.bak-"))
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(fx.root.join("accounts").join(&backups[0])).unwrap(), "{not json");
    assert_eq!(fx.store.version(), 2.0);
    assert!(fx.store.list().is_empty());
}
