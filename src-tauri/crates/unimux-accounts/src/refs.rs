//! The Claude cards of the limits panel, one per account (port of src/main/accounts/refs.ts; `renewRule` is in
//! [`crate::rules`]). The live login is read through Claude Code's files and never renewed here; a saved account is renewed
//! only when its token family lives nowhere else (R6).

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::cswap::CswapRoster;
use crate::identity::{Custody, custody_of, identity_key};
use crate::rules::{RenewRule, renew_rule};
use crate::store::{AccountNotice, LiveIdentity, ManagedAccount, NoticeKind};

/// `AccountRef` of src/shared/usage.ts (the fields the Claude cards use; Codex refs are built by the usage service). Key
/// order as 1.1.4 builds them: `id, provider, configDir?, key?, active?, renew?, deadTokens?`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRef {
    pub id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renew: Option<RenewRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dead_tokens: Option<String>,
}

/// `SetAsideAccount`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAsideAccount {
    pub record_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub restoring: bool,
}

/// `accountsPanelInfo(...)`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelInfo {
    pub set_aside: Vec<SetAsideAccount>,
    pub duplicate_copies: Vec<String>,
}

/// What the limits panel tells about records that have no card: set-aside cards (quarantined without a holder, or parked
/// while their restore is retried) and the copies whose holder still exists (only those may be deleted as "a copy").
pub fn accounts_panel_info(records: &[ManagedAccount], parked_ids: &[String]) -> PanelInfo {
    let parked: HashSet<&str> = parked_ids.iter().map(String::as_str).collect();
    let ids: HashSet<&str> = records.iter().map(|r| r.id.as_str()).collect();
    let quarantined = |r: &ManagedAccount| custody_of(r.custody) == Custody::Quarantined;
    let is_copy = |r: &ManagedAccount| {
        quarantined(r) && r.duplicate_of.as_deref().is_some_and(|d| !d.is_empty() && ids.contains(d) && d != r.id)
    };
    PanelInfo {
        set_aside: records
            .iter()
            .filter(|r| if parked.contains(r.id.as_str()) { true } else { quarantined(r) && !is_copy(r) })
            .map(|r| SetAsideAccount {
                record_id: r.id.clone(),
                email: r.identity.email.clone().filter(|e| !e.is_empty()),
                restoring: parked.contains(r.id.as_str()),
            })
            .collect(),
        duplicate_copies: records
            .iter()
            .filter(|r| is_copy(r) && !parked.contains(r.id.as_str()))
            .map(|r| r.id.clone())
            .collect(),
    }
}

/// The notices the limits panel shows: an outside switch (`switchedOut`, 0.9.1 to 1.0.9) is no banner since 1.0.10, and
/// "Added X" (`adopted`) none since 1.1.2.
pub fn panel_notices(notices: &[AccountNotice]) -> Vec<AccountNotice> {
    notices.iter().filter(|n| !matches!(n.kind, NoticeKind::SwitchedOut | NoticeKind::Adopted)).cloned().collect()
}

/// `RefsInput`.
pub struct RefsInput<'a> {
    pub records: &'a [ManagedAccount],
    pub dir_of: &'a dyn Fn(&str) -> Option<PathBuf>,
    pub live: Option<&'a LiveIdentity>,
    pub cswap: &'a CswapRoster,
    /// macOS keeps Claude logins in the Keychain: saved profiles cannot be read there.
    pub darwin: bool,
}

/// `claudeRefs`: the live login first (one record), then every other visible record. Codex is added by the caller.
pub fn claude_refs(input: &RefsInput<'_>) -> Vec<AccountRef> {
    let visible: Vec<&ManagedAccount> = input.records.iter().filter(|r| custody_of(r.custody) != Custody::Quarantined).collect();
    let active_id = input.live.and_then(|l| l.record_id.as_deref()).filter(|id| !id.is_empty());
    let active = active_id.and_then(|id| visible.iter().copied().find(|r| r.id == id));
    let mut refs = Vec::new();
    match active {
        Some(a) => refs.push(AccountRef {
            id: format!("claude:{}", a.id),
            provider: "claude".into(),
            key: Some(identity_key(&a.identity).unwrap_or_else(|| format!("claude:{}", a.id))),
            active: Some(true),
            ..Default::default()
        }),
        None => refs.push(AccountRef {
            id: "claude:main".into(),
            provider: "claude".into(),
            key: input.live.map(|l| identity_key(&l.identity).unwrap_or_else(|| "claude:main".into())),
            active: input.live.map(|_| true),
            ..Default::default()
        }),
    }
    if input.darwin {
        return refs;
    }
    for record in visible {
        if active.is_some_and(|a| a.id == record.id) {
            continue;
        }
        refs.push(AccountRef {
            id: format!("claude:{}", record.id),
            provider: "claude".into(),
            config_dir: (input.dir_of)(&record.id),
            key: Some(identity_key(&record.identity).unwrap_or_else(|| format!("claude:{}", record.id))),
            active: None,
            renew: Some(renew_rule(record, input.live, input.cswap)),
            dead_tokens: record.dead_tokens.clone().filter(|d| !d.is_empty()),
        });
    }
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{AccountIdentity, TokenFamily};

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const C: &str = "33333333-3333-4333-8333-333333333333";

    fn rec(id: &str, email: &str, custody: Custody, family: TokenFamily) -> ManagedAccount {
        ManagedAccount {
            id: id.into(),
            added_at: 1.0,
            identity: AccountIdentity {
                email: Some(email.into()),
                account_uuid: Some(format!("u-{email}")),
                ..Default::default()
            },
            custody: Some(custody),
            family: Some(family),
            ..Default::default()
        }
    }

    fn dir_of(id: &str) -> Option<PathBuf> {
        Some(PathBuf::from(format!("/p/{id}")))
    }

    /// accounts-refs "lists the live record first with its identity key, then the others, never quarantined ones" and
    /// "keeps a signed-out placeholder when nobody is signed in, and no profiles on macOS".
    #[test]
    fn lists_the_live_record_first_then_the_others_never_quarantined_ones() {
        let mut q = rec(C, "a@x.com", Custody::Quarantined, TokenFamily::Live);
        q.duplicate_of = Some(A.into());
        let mut b = rec(B, "b@x.com", Custody::App, TokenFamily::Own);
        b.dead_tokens = Some("ab".repeat(32));
        let records = vec![rec(A, "a@x.com", Custody::Live, TokenFamily::Live), b, q];
        let live = LiveIdentity { identity: records[0].identity.clone(), record_id: Some(A.into()) };
        let refs = claude_refs(&RefsInput {
            records: &records,
            dir_of: &dir_of,
            live: Some(&live),
            cswap: &CswapRoster::Absent,
            darwin: false,
        });
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].id, format!("claude:{A}"));
        assert_eq!(refs[0].active, Some(true));
        assert_eq!(refs[0].key, identity_key(&records[0].identity));
        assert_eq!(refs[1].renew, Some(RenewRule::Allowed));
        assert_eq!(refs[1].dead_tokens.as_deref(), Some("ab".repeat(32).as_str()));
        assert_eq!(refs[1].config_dir, dir_of(B));
        let json = serde_json::to_string(&refs[1]).unwrap();
        assert!(json.starts_with(&format!(r#"{{"id":"claude:{B}","provider":"claude","configDir":"#)), "{json}");

        let none =
            claude_refs(&RefsInput { records: &records, dir_of: &dir_of, live: None, cswap: &CswapRoster::Absent, darwin: true });
        assert_eq!(none, vec![AccountRef { id: "claude:main".into(), provider: "claude".into(), ..Default::default() }]);
        assert_eq!(serde_json::to_string(&none[0]).unwrap(), r#"{"id":"claude:main","provider":"claude"}"#);
    }

    /// accounts-refs "lists set-aside cards (no holder, or parked) and the copies whose holder exists" and "a set-aside card
    /// signed in again (custody app) leaves the set-aside list".
    #[test]
    fn lists_set_aside_cards_and_the_copies_whose_holder_exists() {
        let mut copy = rec(B, "a@x.com", Custody::Quarantined, TokenFamily::Live);
        copy.duplicate_of = Some(A.into());
        let mut orphan = rec(C, "c@x.com", Custody::Quarantined, TokenFamily::Live);
        orphan.duplicate_of = Some("44444444-4444-4444-8444-444444444444".into());
        let records = vec![rec(A, "a@x.com", Custody::Live, TokenFamily::Live), copy, orphan];
        let info = accounts_panel_info(&records, &[]);
        assert_eq!(info.duplicate_copies, vec![B.to_string()]);
        assert_eq!(
            info.set_aside,
            vec![SetAsideAccount { record_id: C.into(), email: Some("c@x.com".into()), restoring: false }]
        );
        let parked = accounts_panel_info(&records, &[B.to_string()]);
        assert!(parked.duplicate_copies.is_empty());
        assert_eq!(
            parked.set_aside.iter().map(|s| (s.record_id.as_str(), s.restoring)).collect::<Vec<_>>(),
            [(B, true), (C, false)]
        );
        let mut again = records.clone();
        again[2].custody = Some(Custody::App);
        assert!(accounts_panel_info(&again, &[]).set_aside.is_empty());
    }

    /// accounts-dead-login "hides switch-out banners stored by older versions and "added" banners (1.1.2)".
    #[test]
    fn hides_switch_out_and_added_banners() {
        let notice = |id: &str, kind| AccountNotice { id: id.into(), kind, at: 1.0, email: None, record_id: None, count: None };
        let all = [
            notice("1", NoticeKind::SwitchedOut),
            notice("2", NoticeKind::LoggedOut),
            notice("3", NoticeKind::Adopted),
            notice("4", NoticeKind::Quarantined),
            notice("5", NoticeKind::Migrated),
        ];
        assert_eq!(panel_notices(&all).iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["2", "4", "5"]);
    }
}
