//! Ports of test/accounts-store.test.ts.

use super::*;
use serde_json::json;

const ID: &str = "123e4567-e89b-42d3-a456-426614174000";
const OTHER: &str = "223e4567-e89b-42d3-a456-426614174000";
const BAD_IDS: [&str; 9] = [
    "",
    "../x",
    "a/b",
    "not-a-uuid",
    "..",
    "00000000-0000-0000-0000-00000000000G",
    "../../00000000-0000-0000-0000-000000000000",
    "123E4567-E89B-42D3-A456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000\n",
];

struct Fixture {
    _base: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let base = tempfile::tempdir().unwrap();
    let path = base.path().to_path_buf();
    Fixture { root: path.join("accounts"), base: path, _base: base }
}

fn acc(v: Value) -> Value {
    v
}

fn listed(store: &AccountsStore) -> Value {
    Value::Array(store.list().iter().map(ManagedAccount::to_value).collect())
}

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> =
        fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    out.sort();
    out
}

#[test]
fn is_account_id_accepts_uuids_only() {
    assert!(is_account_id(ID));
    for bad in BAD_IDS {
        assert!(!is_account_id(bad), "{bad:?}");
    }
    assert!(!is_account_id_value(Some(&json!(5))));
    assert!(!is_account_id_value(None));
}

#[test]
fn prepare_creates_the_directory_but_does_not_list_it() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (id, dir) = store.prepare().unwrap();
    assert!(is_account_id(&id));
    assert_eq!(dir, f.root.join("claude").join(&id));
    assert!(dir.is_dir());
    assert!(store.list().is_empty());
}

#[test]
fn commit_lists_the_account_and_persists_across_instances_in_insertion_order() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let a = store.prepare().unwrap().0;
    let b = store.prepare().unwrap().0;
    store.commit_value(&acc(json!({"id": b, "email": "b@x.com", "addedAt": 2}))).unwrap();
    store.commit_value(&acc(json!({"id": a, "email": "a@x.com", "org": "Org", "addedAt": 1}))).unwrap();
    let again = AccountsStore::new(&f.root).list();
    assert_eq!(again.iter().map(|x| x.id.clone()).collect::<Vec<_>>(), [b, a.clone()]);
    assert_eq!(again[1].to_value(), json!({"id": a, "addedAt": 1, "email": "a@x.com", "org": "Org"}));
}

/// test/main-perf.test.ts: the cached accounts.json.
#[test]
fn reads_the_file_again_only_when_it_changed_and_own_writes_are_seen_at_once() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    assert!(store.list().is_empty());
    store.commit_value(&json!({"id": ID, "addedAt": 1, "email": "a@b.c"})).unwrap();
    assert_eq!(listed(&store), json!([{"id": ID, "addedAt": 1, "email": "a@b.c"}]));
    // A copy: changing what a caller got never changes the store.
    let mut copy = store.list();
    copy[0].identity.email = Some("changed@x.y".into());
    assert_eq!(store.get(ID).unwrap().identity.email.as_deref(), Some("a@b.c"));
    // A change made outside (another size) is read.
    let outside = json!({"version": 2, "claude": [{"id": ID, "addedAt": 1, "email": "other@example.com"}]});
    fs::write(f.root.join("accounts.json"), outside.to_string()).unwrap();
    assert_eq!(store.get(ID).unwrap().identity.email.as_deref(), Some("other@example.com"));
}

#[test]
fn commit_of_an_existing_id_replaces_it() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (id, _) = store.prepare().unwrap();
    store.commit_value(&json!({"id": id, "email": "old@x.com", "addedAt": 1})).unwrap();
    store.commit_value(&json!({"id": id, "email": "new@x.com", "addedAt": 3})).unwrap();
    assert_eq!(listed(&store), json!([{"id": id, "addedAt": 3, "email": "new@x.com"}]));
}

#[test]
fn drops_over_long_email_and_org_on_commit_and_update_like_list_does() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (id, _) = store.prepare().unwrap();
    store.commit_value(&json!({"id": id, "email": "x".repeat(121), "org": "Org", "addedAt": 1})).unwrap();
    assert_eq!(listed(&store), json!([{"id": id, "addedAt": 1, "org": "Org"}]));
    store.update(&id, Some(Some(&"y".repeat(200))), Some(Some(&"o".repeat(121)))).unwrap();
    assert_eq!(listed(&store), json!([{"id": id, "addedAt": 1}]));
    store.update(&id, Some(Some("ok@x.com")), None).unwrap();
    assert_eq!(listed(&store), json!([{"id": id, "addedAt": 1, "email": "ok@x.com"}]));
}

#[test]
fn keeps_a_corrupt_accounts_json_as_a_timestamped_backup_and_starts_empty_never_over_an_earlier_backup() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    fs::create_dir_all(&f.root).unwrap();
    fs::write(f.root.join("accounts.json"), "{not json").unwrap();
    let (id, _) = store.prepare().unwrap();
    store.commit_value(&json!({"id": id, "addedAt": 1})).unwrap();
    assert!(!store.read_only());
    assert_eq!(listed(&store), json!([{"id": id, "addedAt": 1}]));
    // A different size, so the stat stamp changes even within one timer tick.
    fs::write(f.root.join("accounts.json"), "{broken again").unwrap();
    assert!(store.list().is_empty());
    let backups: Vec<String> = names(&f.root).into_iter().filter(|n| n.starts_with("accounts.json.bak-")).collect();
    assert_eq!(backups.len(), 2, "{backups:?}");
    let mut texts: Vec<String> = backups.iter().map(|n| fs::read_to_string(f.root.join(n)).unwrap()).collect();
    texts.sort();
    assert_eq!(texts, ["{broken again", "{not json"]);
    assert!(!f.root.join("accounts.json.bak").exists());
}

#[test]
fn removes_the_temp_file_when_the_write_cannot_be_completed() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (id, _) = store.prepare().unwrap();
    fs::create_dir(f.root.join("accounts.json")).unwrap();
    assert!(store.read_only());
    assert!(store.commit_value(&json!({"id": id, "addedAt": 1})).is_err());
    assert!(names(&f.root).iter().all(|n| !n.ends_with(".tmp")));
}

#[test]
fn removes_the_temp_file_when_the_rename_fails() {
    // The rename itself fails (a directory where accounts.json should go appears after the read): no temp file is left.
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    store.commit_value(&json!({"id": ID, "addedAt": 1})).unwrap();
    let file = StoreFile::empty(false);
    fs::remove_file(f.root.join("accounts.json")).unwrap();
    fs::create_dir(f.root.join("accounts.json")).unwrap();
    fs::write(f.root.join("accounts.json").join("x"), "x").unwrap();
    assert!(store.write(&file).is_err());
    assert!(names(&f.root).iter().all(|n| !n.ends_with(".tmp")));
}

#[test]
fn tolerates_missing_and_corrupt_files() {
    let f = fixture();
    assert!(AccountsStore::new(&f.root).list().is_empty());
    fs::create_dir_all(&f.root).unwrap();
    for text in ["{not json", "[1,2]", r#"{"claude":"x"}"#] {
        fs::write(f.root.join("accounts.json"), text).unwrap();
        assert!(AccountsStore::new(&f.root).list().is_empty(), "{text}");
    }
}

#[test]
fn drops_entries_with_bad_ids_or_shapes() {
    let f = fixture();
    fs::create_dir_all(&f.root).unwrap();
    let text = json!({"claude": [
        {"id": "../x", "addedAt": 1},
        {"id": ID, "addedAt": "x"},
        null, 7,
        {"id": ID, "addedAt": 5, "email": "ok@x.com", "org": 3},
        {"id": OTHER, "addedAt": 6, "email": "e".repeat(121)},
    ]});
    fs::write(f.root.join("accounts.json"), text.to_string()).unwrap();
    assert_eq!(
        listed(&AccountsStore::new(&f.root)),
        json!([{"id": ID, "addedAt": 5, "email": "ok@x.com"}, {"id": OTHER, "addedAt": 6}])
    );
}

#[test]
fn update_changes_email_and_org() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (id, _) = store.prepare().unwrap();
    store.commit_value(&json!({"id": id, "addedAt": 1})).unwrap();
    store.update(&id, Some(Some("u@x.com")), Some(Some("O"))).unwrap();
    assert_eq!(listed(&AccountsStore::new(&f.root)), json!([{"id": id, "addedAt": 1, "email": "u@x.com", "org": "O"}]));
    store.update(ID, Some(Some("z")), None).unwrap();
    store.update("../x", Some(Some("z")), None).unwrap();
    assert_eq!(store.list().len(), 1);
}

#[test]
fn remove_deletes_the_record_and_directory_also_for_an_uncommitted_id() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (a, a_dir) = store.prepare().unwrap();
    store.commit_value(&json!({"id": a, "addedAt": 1})).unwrap();
    let (b, b_dir) = store.prepare().unwrap();
    store.remove(&a).unwrap();
    store.remove(&b).unwrap();
    assert!(store.list().is_empty());
    assert!(!a_dir.exists());
    assert!(!b_dir.exists());
}

#[test]
fn rejects_invalid_ids_and_never_touches_anything_outside_the_root() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    store.prepare().unwrap();
    let sibling = f.base.join("keep.txt");
    fs::write(&sibling, "x").unwrap();
    fs::create_dir_all(f.root.join("claude").join("x")).unwrap();
    for bad in BAD_IDS {
        assert!(matches!(store.dir_of(bad), Err(StoreError::InvalidId)), "{bad:?}");
        assert_eq!(StoreError::InvalidId.to_string(), "invalid account id");
        store.remove(bad).unwrap();
    }
    assert!(sibling.exists());
    assert!(f.root.join("claude").join("x").exists());
    assert!(f.base.exists());
}

#[test]
fn writes_atomically_and_leaves_no_temp_files() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (id, _) = store.prepare().unwrap();
    store.commit_value(&json!({"id": id, "addedAt": 1})).unwrap();
    store.update(&id, Some(Some("a@x.com")), None).unwrap();
    let all = names(&f.root);
    assert!(all.iter().all(|n| !n.ends_with(".tmp")));
    assert!(all.contains(&"accounts.json".to_string()));
}

#[test]
fn update_keeps_the_key_order_of_the_stored_entry() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    store.commit_value(&json!({"id": ID, "email": "a@x.com", "org": "Org", "addedAt": 5})).unwrap();
    let keys = || -> Vec<String> {
        let v: Value = js_json::parse(&fs::read_to_string(f.root.join("accounts.json")).unwrap()).unwrap();
        v["claude"][0].as_object().unwrap().keys().cloned().collect()
    };
    let before = keys();
    store.update(ID, Some(Some("b@x.com")), Some(Some("Other"))).unwrap();
    assert_eq!(keys(), before);
    store.update(ID, None, Some(None)).unwrap();
    assert_eq!(store.list()[0].to_value(), json!({"id": ID, "addedAt": 5, "email": "b@x.com"}));
}

#[test]
fn v2_keeps_identity_custody_family_and_duplicate_of_and_drops_bad_values() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    store
        .commit_value(&json!({"id": ID, "addedAt": 1, "email": "a@x.com", "accountUuid": "u1", "organizationUuid": "o1", "custody": "live", "family": "own"}))
        .unwrap();
    store.commit_value(&json!({"id": OTHER, "addedAt": 2, "custody": "weird", "family": "x", "duplicateOf": "../x"})).unwrap();
    assert_eq!(
        listed(&store),
        json!([
            {"id": ID, "addedAt": 1, "email": "a@x.com", "accountUuid": "u1", "organizationUuid": "o1", "custody": "live", "family": "own"},
            {"id": OTHER, "addedAt": 2},
        ])
    );
    store.set_custody(OTHER, Custody::Quarantined, Some(ID)).unwrap();
    store.set_family(OTHER, TokenFamily::Live).unwrap();
    let identity = AccountIdentity { email: Some("b@x.com".into()), account_uuid: Some("u2".into()), ..Default::default() };
    store.update_identity(OTHER, &identity, false).unwrap();
    assert_eq!(
        store.get(OTHER).unwrap().to_value(),
        json!({"id": OTHER, "addedAt": 2, "email": "b@x.com", "accountUuid": "u2", "custody": "quarantined", "family": "live", "duplicateOf": ID})
    );
}

#[test]
fn v2_update_identity_with_replace_takes_exactly_the_given_identity() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    store
        .commit_value(&json!({"id": ID, "addedAt": 1, "email": "a@x.com", "org": "Acme", "accountUuid": "u1", "organizationUuid": "o1", "custody": "live"}))
        .unwrap();
    let identity = AccountIdentity { email: Some("b@x.com".into()), account_uuid: Some("u2".into()), ..Default::default() };
    store.update_identity(ID, &identity, true).unwrap();
    assert_eq!(
        store.get(ID).unwrap().to_value(),
        json!({"id": ID, "addedAt": 1, "email": "b@x.com", "accountUuid": "u2", "custody": "live"})
    );
}

#[test]
fn v2_opens_a_file_it_cannot_read_safely_read_only_and_never_writes_over_it() {
    let cases = [
        ("wrong shape", json!({"claude": "x"}).to_string()),
        ("not an object", "[1,2]".to_string()),
        ("bad version", json!({"version": "2", "claude": []}).to_string()),
        ("bad notices", json!({"version": 2, "claude": [], "notices": {}}).to_string()),
        ("newer version", json!({"version": 3, "claude": [{"id": ID, "addedAt": 1, "email": "a@x.com"}]}).to_string()),
        // Not in the TS table, same rule: a live identity that is not an object, a fractional or zero version.
        ("bad live", json!({"version": 2, "claude": [], "live": 5}).to_string()),
        ("fractional version", json!({"version": 1.5, "claude": []}).to_string()),
        ("zero version", json!({"version": 0, "claude": []}).to_string()),
        ("null", "null".to_string()),
    ];
    for (name, text) in cases {
        let f = fixture();
        fs::create_dir_all(f.root.join("claude").join(ID)).unwrap();
        fs::write(f.root.join("accounts.json"), &text).unwrap();
        let store = AccountsStore::new(&f.root);
        assert!(store.read_only(), "{name}");
        assert!(matches!(store.mark_migrated(), Err(StoreError::ReadOnly)), "{name}");
        assert!(matches!(store.commit_value(&json!({"id": OTHER, "addedAt": 2})), Err(StoreError::ReadOnly)), "{name}");
        let notice = NewNotice { kind: NoticeKind::Migrated, at: 1.0, email: None, record_id: None, count: None };
        assert!(matches!(store.add_notice(&notice), Err(StoreError::ReadOnly)), "{name}");
        assert!(matches!(store.set_live(None), Err(StoreError::ReadOnly)), "{name}");
        assert!(matches!(store.remove(ID), Err(StoreError::ReadOnly)), "{name}");
        assert!(store.dir_of(ID).unwrap().exists(), "{name}");
        assert_eq!(fs::read_to_string(f.root.join("accounts.json")).unwrap(), text, "{name}");
        assert_eq!(names(&f.root), ["accounts.json", "claude"], "{name}");
        assert_eq!(StoreError::ReadOnly.to_string(), "accounts.json cannot be read safely; not writing over it");
    }
}

#[test]
fn v2_lists_the_records_of_a_newer_file_without_changing_it() {
    let f = fixture();
    fs::create_dir_all(&f.root).unwrap();
    fs::write(
        f.root.join("accounts.json"),
        json!({"version": 3, "claude": [{"id": ID, "addedAt": 1, "email": "a@x.com"}]}).to_string(),
    )
    .unwrap();
    assert_eq!(listed(&AccountsStore::new(&f.root)), json!([{"id": ID, "addedAt": 1, "email": "a@x.com"}]));
}

#[test]
fn v2_reports_version_1_for_a_0_9_0_file_and_2_after_the_migration_mark() {
    let f = fixture();
    fs::create_dir_all(&f.root).unwrap();
    fs::write(f.root.join("accounts.json"), json!({"claude": [{"id": ID, "addedAt": 1, "email": "a@x.com"}]}).to_string())
        .unwrap();
    let store = AccountsStore::new(&f.root);
    assert_eq!(store.version(), 1.0);
    store.mark_migrated().unwrap();
    assert_eq!(store.version(), 2.0);
    assert_eq!(listed(&store), json!([{"id": ID, "addedAt": 1, "email": "a@x.com"}]));
}

#[test]
fn v2_keeps_the_live_identity_and_the_notices_across_record_writes_at_most_20_notices() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let live = LiveIdentity {
        identity: AccountIdentity { email: Some("a@x.com".into()), account_uuid: Some("u1".into()), ..Default::default() },
        record_id: Some(ID.into()),
    };
    store.set_live(Some(&live)).unwrap();
    for i in 0..25 {
        let n = NewNotice {
            kind: NoticeKind::SwitchedOut,
            at: f64::from(i),
            email: Some(format!("n{i}@x.com")),
            record_id: None,
            count: None,
        };
        store.add_notice(&n).unwrap();
    }
    store.commit_value(&json!({"id": ID, "addedAt": 1})).unwrap();
    assert_eq!(store.live(), Some(live));
    let notices = store.notices();
    assert_eq!(notices.len(), 20);
    assert_eq!(notices[0].email.as_deref(), Some("n5@x.com"));
    store.dismiss_notice(&notices[0].id).unwrap();
    assert_eq!(store.notices().len(), 19);
    store.set_live(None).unwrap();
    assert_eq!(store.live(), None);
}

#[test]
fn v2_remove_drops_the_notices_and_the_live_record_id_that_point_to_the_record() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let (id, _) = store.prepare().unwrap();
    store.commit_value(&json!({"id": id, "addedAt": 1})).unwrap();
    let live = LiveIdentity {
        identity: AccountIdentity { email: Some("a@x.com".into()), ..Default::default() },
        record_id: Some(id.clone()),
    };
    store.set_live(Some(&live)).unwrap();
    store
        .add_notice(&NewNotice { kind: NoticeKind::Quarantined, at: 1.0, email: None, record_id: Some(id.clone()), count: None })
        .unwrap();
    store.remove(&id).unwrap();
    assert!(store.notices().is_empty());
    assert_eq!(store.live().unwrap().to_value(), json!({"email": "a@x.com"}));
}

#[test]
fn v2_removing_the_record_a_copy_was_set_aside_for_releases_the_copy() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    let holder = store.prepare().unwrap().0;
    let copy = store.prepare().unwrap().0;
    let other = store.prepare().unwrap().0;
    store.commit_value(&json!({"id": holder, "addedAt": 1, "email": "a@x.com"})).unwrap();
    store
        .commit_value(&json!({"id": copy, "addedAt": 2, "email": "a@x.com", "custody": "quarantined", "duplicateOf": holder}))
        .unwrap();
    store
        .commit_value(&json!({"id": other, "addedAt": 3, "email": "b@x.com", "custody": "quarantined", "duplicateOf": copy}))
        .unwrap();
    let notice = |kind| NewNotice { kind, at: 1.0, email: Some("a@x.com".into()), record_id: Some(copy.clone()), count: None };
    store.add_notice(&notice(NoticeKind::Quarantined)).unwrap();
    store.add_notice(&notice(NoticeKind::SwitchedOut)).unwrap();
    store.remove(&holder).unwrap();
    let kept = store.get(&copy).unwrap();
    assert_eq!(kept.custody, Some(Custody::Quarantined));
    assert_eq!(kept.duplicate_of, None);
    assert_eq!(store.notices().iter().map(|n| n.kind).collect::<Vec<_>>(), [NoticeKind::SwitchedOut]);
    assert_eq!(store.get(&other).unwrap().duplicate_of.as_deref(), Some(copy.as_str()));
    assert!(store.dir_of(&copy).unwrap().exists());
}

// ── beyond the TS cases: the byte format and the no-write rules ─────────────

#[test]
fn writes_the_1_1_4_format_byte_for_byte() {
    let f = fixture();
    let store = AccountsStore::with_ids(&f.root, Box::new(|| "00000000-0000-4000-8000-000000000001".into()));
    store
        .commit_value(&json!({
            "appSwap": {"own": true, "from": "a".repeat(64), "at": 1.5}, "deadTokens": "b".repeat(64), "id": ID, "addedAt": 1_762_430_400_000u64,
            "family": "own", "custody": "live", "organizationUuid": "o1", "accountUuid": "u1", "org": "Ącme \"x\"", "email": "a@x.com"
        }))
        .unwrap();
    store.add_notice(&NewNotice { kind: NoticeKind::Adopted, at: 2.0, email: None, record_id: None, count: Some(3.0) }).unwrap();
    let expected = format!(
        "{{\n  \"version\": 1,\n  \"claude\": [\n    {{\n      \"id\": \"{ID}\",\n      \"addedAt\": 1762430400000,\n      \"email\": \"a@x.com\",\n      \"org\": \"Ącme \\\"x\\\"\",\n      \"accountUuid\": \"u1\",\n      \"organizationUuid\": \"o1\",\n      \"custody\": \"live\",\n      \"family\": \"own\",\n      \"deadTokens\": \"{b}\",\n      \"appSwap\": {{\n        \"at\": 1.5,\n        \"from\": \"{a}\",\n        \"own\": true\n      }}\n    }}\n  ],\n  \"notices\": [\n    {{\n      \"id\": \"00000000-0000-4000-8000-000000000001\",\n      \"kind\": \"adopted\",\n      \"at\": 2,\n      \"count\": 3\n    }}\n  ]\n}}",
        a = "a".repeat(64),
        b = "b".repeat(64)
    );
    assert_eq!(fs::read_to_string(f.root.join("accounts.json")).unwrap(), expected);
}

#[test]
fn setters_that_change_nothing_do_not_write() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    store.commit_value(&json!({"id": ID, "addedAt": 1})).unwrap();
    fs::remove_file(f.root.join("accounts.json")).unwrap();
    store.set_held_tokens(ID, None).unwrap();
    store.set_dead_tokens(ID, None).unwrap();
    store.set_app_swap(ID, None).unwrap();
    store.remove(OTHER).unwrap();
    assert!(!f.root.join("accounts.json").exists());
    // A patch of an unknown record still writes (as 1.1.4 does).
    store.set_family(OTHER, TokenFamily::Own).unwrap();
    assert_eq!(fs::read_to_string(f.root.join("accounts.json")).unwrap(), "{\n  \"version\": 1,\n  \"claude\": []\n}");
}

#[test]
fn an_unreadable_directory_in_place_of_the_file_is_read_only_and_kept() {
    let f = fixture();
    fs::create_dir_all(f.root.join("accounts.json")).unwrap();
    let store = AccountsStore::new(&f.root);
    assert!(store.read_only());
    assert!(store.list().is_empty());
    assert!(f.root.join("accounts.json").is_dir());
}

#[test]
fn reads_again_after_an_outside_change() {
    let f = fixture();
    let store = AccountsStore::new(&f.root);
    store.commit_value(&json!({"id": ID, "addedAt": 1})).unwrap();
    assert_eq!(store.list().len(), 1);
    fs::write(
        f.root.join("accounts.json"),
        json!({"claude": [{"id": ID, "addedAt": 1}, {"id": OTHER, "addedAt": 2}]}).to_string(),
    )
    .unwrap();
    assert_eq!(store.list().len(), 2);
}
