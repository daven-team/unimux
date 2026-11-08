//! Case-by-case ports of the remaining cases of test/accounts-reconcile.test.ts (the fixture of the parent module).

use super::*;
use crate::cswap::CswapRoster;
use crate::identity::{LiveIdentityUnknown, read_live_claude_identity};
use crate::rules::{RenewRule, gate_family_refresh, renew_rule};

/// "sets a second live record of the live account aside without a switchedOut notice"
#[test]
fn ts_a_second_live_record_is_set_aside_with_a_quarantined_notice_only() {
    let fx = Fx::new();
    let p = fx.add(a(), Some(Custody::Live));
    let copy = fx.add(a(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(p.clone()) })).unwrap();
    fx.set_live(Some(a()));
    reconcile_live(&deps!(fx, None), false).unwrap();
    let c = fx.store.get(&copy).unwrap();
    assert_eq!((c.custody, c.duplicate_of.as_deref()), (Some(Custody::Quarantined), Some(p.as_str())));
    assert_eq!(fx.kinds(), [NoticeKind::Quarantined]);
}

/// "renews a profile exactly when renewRule allows it, never a quarantined record or a dir no record names"
#[test]
fn ts_the_refresh_gate_renews_exactly_what_the_renew_rule_allows() {
    let fx = Fx::new();
    let own = fx.add(a(), None);
    fx.store.set_family(&own, TokenFamily::Own).unwrap();
    let legacy = fx.add(ident("b@x.com", None), None); // 0.9.0 record: the family defaults to live
    let copy = fx.add(ident("c@x.com", None), Some(Custody::Live));
    fx.store.set_family(&copy, TokenFamily::Own).unwrap();
    let foreign = fx.add(ident("d@x.com", None), None);
    fx.store.set_family(&foreign, TokenFamily::Own).unwrap();
    fx.store.set_custody(&foreign, Custody::Foreign, None).unwrap();
    let parked = fx.add(ident("e@x.com", None), None);
    fx.store.set_family(&parked, TokenFamily::Own).unwrap();
    fx.store.set_custody(&parked, Custody::Quarantined, Some(&own)).unwrap();
    // Same identity as the live login, but a family of its own (P and main, investigation test 5).
    let twin = fx.add(g(), None);
    fx.store.set_family(&twin, TokenFamily::Own).unwrap();
    fx.store.set_live(Some(&LiveIdentity { identity: g(), record_id: Some(copy.clone()) })).unwrap();
    let renewed = |roster: &CswapRoster| {
        let mut out = Vec::new();
        for id in [&own, &legacy, &copy, &foreign, &parked, &twin] {
            let dir = fx.store.dir_of(id).unwrap();
            let result = gate_family_refresh(&fx.store, roster, &dir, |_| "renewed", "blocked");
            let record = fx.store.get(id).unwrap();
            // The gate and the card never disagree: both come from renew_rule.
            if record.custody != Some(Custody::Quarantined) {
                assert_eq!(
                    result == "renewed",
                    renew_rule(&record, fx.store.live().as_ref(), roster) == RenewRule::Allowed,
                    "{id}"
                );
            }
            if result == "renewed" {
                out.push(id.clone());
            }
        }
        out
    };
    assert_eq!(renewed(&CswapRoster::Absent), [own.clone(), legacy.clone()]);
    let roster = CswapRoster::Present(Some(vec![ident("b@x.com", None), a()]));
    assert_eq!(renewed(&roster), std::slice::from_ref(&own));
    assert_eq!(renewed(&CswapRoster::UNREADABLE), std::slice::from_ref(&own));
    assert_eq!(
        gate_family_refresh(&fx.store, &CswapRoster::Absent, &fx.root.join("elsewhere"), |_| "renewed", "blocked"),
        "blocked"
    );
}

/// "resolves at once when the backup is already current"
#[test]
fn ts_a_current_backup_resolves_the_main_relogin_at_once() {
    let fx = Fx::new();
    fx.add(a(), Some(Custody::Live));
    fx.set_live(Some(a()));
    let calls = Cell::new(0);
    let resync = |_: &str, _: &AccountIdentity| {
        calls.set(calls.get() + 1);
        Ok(ResyncResult::Unchanged)
    };
    backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &opts()).unwrap();
    assert_eq!(calls.get(), 1);
}

/// "skips the outgoing resync while a swap holds the slot, a journal is pending, or nothing is live"
#[test]
fn ts_the_outgoing_resync_is_skipped_while_a_swap_holds_the_slot_a_journal_is_pending_or_nothing_is_live() {
    let fx = Fx::new();
    let gid = fx.add(g(), Some(Custody::Live));
    let calls = Cell::new(0);
    let resync = |_: &str, _: &AccountIdentity| {
        calls.set(calls.get() + 1);
        Ok(ResyncResult::Copied)
    };
    assert_eq!(resync_outgoing_when_idle(&fx.slot, &|| false, None, &deps!(fx, Some(&resync))).unwrap(), None);
    fx.store.set_live(Some(&LiveIdentity { identity: g(), record_id: Some(gid) })).unwrap();
    assert_eq!(resync_outgoing_when_idle(&fx.slot, &|| false, Some(&|| Ok(true)), &deps!(fx, Some(&resync))).unwrap(), None);
    {
        let _held = fx.slot.try_claim().unwrap();
        assert_eq!(resync_outgoing_when_idle(&fx.slot, &|| false, None, &deps!(fx, Some(&resync))).unwrap(), None);
    }
    assert_eq!(calls.get(), 0);
    assert_eq!(resync_outgoing_when_idle(&fx.slot, &|| false, None, &deps!(fx, None)).unwrap(), None);
    assert_eq!(
        resync_outgoing_when_idle(&fx.slot, &|| false, None, &deps!(fx, Some(&resync))).unwrap(),
        Some(ResyncResult::Copied)
    );
}

/// "readLiveClaudeIdentity: missing file or no account is signed out, a corrupt or unreadable file is unknown (I2)"
#[test]
fn ts_the_live_identity_is_signed_out_or_unknown() {
    let fx = Fx::new();
    let file = fx.home.join(".claude.json");
    assert_eq!(read_live_claude_identity(None, &fx.home), Ok(None));
    std::fs::write(&file, r#"{"projects":{}}"#).unwrap();
    assert_eq!(read_live_claude_identity(None, &fx.home), Ok(None));
    std::fs::write(&file, r#"{"oauthAccount": {"emailAddress": "a@x.com", "accou"#).unwrap();
    assert_eq!(read_live_claude_identity(None, &fx.home), Err(LiveIdentityUnknown));
    std::fs::write(&file, "").unwrap();
    assert_eq!(read_live_claude_identity(None, &fx.home), Err(LiveIdentityUnknown));
    let mut busy = |_: &std::path::Path| Err(std::io::Error::from(std::io::ErrorKind::ResourceBusy));
    assert_eq!(crate::identity::read_live_claude_identity_with(None, &fx.home, &mut busy), Err(LiveIdentityUnknown));
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap(); // a directory where the file should be: it exists but cannot be read
    assert_eq!(read_live_claude_identity(None, &fx.home), Err(LiveIdentityUnknown));
    std::fs::remove_dir(&file).unwrap();
    std::fs::write(&file, r#"{"oauthAccount":{"emailAddress":"a@x.com","accountUuid":"ua"}}"#).unwrap();
    assert_eq!(read_live_claude_identity(None, &fx.home), Ok(Some(a())));
}

/// "a ${kind} live config changes no role, adds no notice and keeps the live record (I2)", "a ${kind} live config refuses the
/// main re-login with unread instead of starting it without a backup (I2)" (corrupt and unreadable)
#[test]
fn ts_a_corrupt_or_unreadable_live_config_changes_nothing_and_refuses_the_main_relogin() {
    for kind in ["corrupt", "unreadable"] {
        let fx = Fx::new();
        let aid = fx.add(a(), Some(Custody::Live));
        let live = LiveIdentity { identity: a(), record_id: Some(aid.clone()) };
        fx.store.set_live(Some(&live)).unwrap();
        let file = fx.home.join(".claude.json");
        if kind == "corrupt" {
            std::fs::write(&file, r#"{"oauthAccount": {"emailAd"#).unwrap();
        } else {
            std::fs::create_dir(&file).unwrap();
        }
        let calls = Cell::new(0);
        let resync = |_: &str, _: &AccountIdentity| {
            calls.set(calls.get() + 1);
            Ok(ResyncResult::Copied)
        };
        let read = || read_live_claude_identity(None, &fx.home).map_err(|_| ());
        let deps = ReconcileDeps {
            store: &fx.store,
            read_live_identity: &read,
            resync: Some(&resync),
            cswap_wrote_since: None,
            saved_copy_dead: None,
            now: &|| 10.0,
        };
        assert_eq!(
            reconcile_live(&deps, false).unwrap(),
            ReconcileResult { active_id: Some(aid.clone()), changed: false },
            "{kind}"
        );
        assert_eq!(fx.custody(&aid), Some(Custody::Live));
        assert!(fx.store.notices().is_empty());
        assert_eq!(fx.store.live(), Some(live.clone()));
        assert_eq!((fx.store.list().len(), calls.get()), (1, 0));
        assert_eq!(backup_live_before_login(&fx.slot, &|| false, None, &deps, &opts()).unwrap_err().reason, "unread");
        assert_eq!(fx.store.live(), Some(live));
        // The outgoing backup during a main login keeps running (the live record was not dropped).
        assert_eq!(resync_outgoing_when_idle(&fx.slot, &|| false, None, &deps).unwrap(), Some(ResyncResult::Copied));
    }
}
