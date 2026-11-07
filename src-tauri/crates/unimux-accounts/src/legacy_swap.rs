//! The 0.9.0 exchange and its recovery (port of the rest of src/main/accounts/swap.ts).
//!
//! Making a managed account the MAIN one was an EXCHANGE of two login blobs: the target's `claudeAiOauth` + `oauthAccount`
//! move to the machine's own Claude config, the old main login moves into the target's profile directory. 0.9.1 replaced it
//! with [`crate::activate`]; the exchange is no longer wired, but [`recover_interrupted_swap`] must still repair its
//! version-1 journals (`swap-journal.json` with `version: 1`) and the tests build those states with [`swap_main_account`].
//!
//! A token's lineage follows its POSITION, never stale bytes: every step works on the CURRENT content of the shared files
//! (read again right before each write, guarded by an unchanged-since-read check before every rename attempt), and a
//! rollback is a reverse exchange of the current blobs. The recovery decides once from the phase and from which login
//! (A = old main, X = the target's) each file's refresh token belongs to; when that is not provable it modifies no
//! credential file and reports `manual`.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};
use unimux_core::js_json;

use crate::activate::{ActivateDeps, JOURNAL};
use crate::identity::is_account_id;
use crate::js;
use crate::refresh::RefreshOutcome;
use crate::results::{Recovery, SwapError, SwapResult};
use crate::swapfs::{
    Snap, SwapFs, SwapPaths, WriteError, atomic_write, env_get, oauth_of, read_snap, str_of, stringify, stringify2, swap_paths,
    unchanged, valid_oauth, with_key,
};

const MAX_TRIES: usize = 3;
const EXPIRY_MARGIN_MS: f64 = 60_000.0;
/// How long Claude Code gets to write its own refresh result before we trust what we wrote.
const SETTLE: Duration = Duration::from_millis(1500);
const MAIN_CREDS: &str = "main-credentials.json";
const MAIN_JSON: &str = "main-claude.json";
const TARGET_CREDS: &str = "target-credentials.json";
const TARGET_JSON: &str = "target-claude.json";
const BACKUPS: [&str; 4] = [MAIN_CREDS, MAIN_JSON, TARGET_CREDS, TARGET_JSON];

/// `/\.[0-9a-f-]{36}\.tmp$/`.
pub(crate) fn is_uuid_tmp(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tmp") else { return false };
    let b = stem.as_bytes();
    b.len() > 36
        && b[b.len() - 37] == b'.'
        && b[b.len() - 36..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c) || *c == b'-')
}

/// `/^\.(credentials|claude)\.json\.[0-9a-f-]{36}\.tmp$/`: our own leftover temp files in the config dirs.
fn is_own_temp(name: &str) -> bool {
    [".credentials.json.", ".claude.json."].iter().any(|prefix| {
        name.strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(".tmp"))
            .is_some_and(|id| id.len() == 36 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-'))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    BackedUp,
    TargetWritten,
    MainCredsWritten,
    MainJsonWritten,
    RollingBack,
    Verified,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::BackedUp => "backed-up",
            Phase::TargetWritten => "target-written",
            Phase::MainCredsWritten => "main-creds-written",
            Phase::MainJsonWritten => "main-json-written",
            Phase::RollingBack => "rolling-back",
            Phase::Verified => "verified",
        }
    }
}

/// The swap-internal reasons to stop (`Fail`, `Changed`, `Unprovable`, any other throw).
enum Stop {
    Fail(SwapError),
    Changed,
    /// Main credentials no longer hold what we wrote: whose lineage they are cannot be proven.
    Unprovable,
    Other,
}

impl From<io::Error> for Stop {
    fn from(_: io::Error) -> Self {
        Stop::Other
    }
}
impl From<WriteError> for Stop {
    fn from(e: WriteError) -> Self {
        match e {
            WriteError::Changed => Stop::Changed,
            WriteError::Io(_) => Stop::Other,
        }
    }
}
impl From<crate::store::StoreError> for Stop {
    fn from(_: crate::store::StoreError) -> Self {
        Stop::Other
    }
}

type Rec = Map<String, Value>;

/// The 0.9.0 identity: uuid, lowercase e-mail and organisation.
#[derive(Debug, Clone)]
struct Identity {
    uuid: Option<String>,
    email: String,
    org: Option<String>,
}

fn identity_of(account: Option<&Value>, fallback: Option<(Option<&str>, Option<&str>)>) -> Option<Identity> {
    let empty = Map::new();
    let a = js::record(account).unwrap_or(&empty);
    let (fb_email, fb_org) = fallback.unwrap_or((None, None));
    let email = str_of(a.get("emailAddress")).or(fb_email.filter(|e| !e.is_empty()))?;
    let email_absent = a.get("emailAddress").is_none() || str_of(a.get("emailAddress")).is_none();
    let org = str_of(a.get("organizationName")).or(if email_absent { fb_org.filter(|o| !o.is_empty()) } else { None });
    Some(Identity {
        uuid: str_of(a.get("accountUuid")).map(str::to_string),
        email: email.to_lowercase(),
        org: org.map(str::to_lowercase),
    })
}

/// Conservative: an unknown organisation or a missing uuid never makes two logins look different.
fn same_identity(a: &Identity, b: &Identity) -> bool {
    if let (Some(x), Some(y)) = (&a.uuid, &b.uuid) {
        return x == y;
    }
    if a.email != b.email {
        return false;
    }
    a.org.is_none() || b.org.is_none() || a.org == b.org
}

fn oauth(data: &Rec) -> Option<&Rec> {
    oauth_of(data)
}

/// `hasPendingSwap`: true while an earlier swap left a journal or backups behind (they are the only proof of whose login is
/// whose).
pub fn has_pending_swap(fs: &dyn SwapFs, backup_dir: &Path) -> io::Result<bool> {
    Ok(!fs.readdir(backup_dir)?.is_empty())
}

/// `clearPendingSwap`: deletes the journal and backups for good (the user confirmed). Refused while a swap runs.
pub fn clear_pending_swap(deps: &ActivateDeps) -> bool {
    let Some(_slot) = deps.slot.try_claim() else { return false };
    let fs = &*deps.fs;
    let run = || -> io::Result<bool> {
        let names = fs.readdir(&deps.backup_dir)?;
        for name in names.iter().filter(|n| *n == JOURNAL).chain(names.iter().filter(|n| *n != JOURNAL)) {
            fs.rm(&deps.backup_dir.join(name))?;
        }
        let _ = fs.rmdir(&deps.backup_dir);
        let empty = fs.readdir(&deps.backup_dir)?.is_empty();
        if empty {
            deps.slot.set_unresolved(false);
        }
        Ok(empty)
    };
    run().unwrap_or(false)
}

/// The 0.9.0 exchange (`swapMainAccount`; deprecated, no longer wired). Never exposes a token.
pub fn swap_main_account(deps: &ActivateDeps, account_id: &str) -> SwapResult {
    if deps.darwin {
        return SwapResult::fail(SwapError::Unsupported);
    }
    if !is_account_id(account_id) {
        return SwapResult::fail(SwapError::Invalid);
    }
    let Some(_slot) = deps.slot.try_claim() else { return SwapResult::fail(SwapError::Busy) };
    let run = || -> Result<SwapResult, Stop> {
        if has_pending_swap(&*deps.fs, &deps.backup_dir)? {
            return Ok(SwapResult::fail(SwapError::Pending));
        }
        perform(deps, account_id)
    };
    match run() {
        Ok(r) => r,
        Err(Stop::Fail(code)) => {
            if code == SwapError::Manual {
                deps.slot.set_unresolved(true);
            }
            SwapResult::fail(code)
        }
        Err(_) => SwapResult::fail(SwapError::Write),
    }
}

struct State {
    main_creds: Snap,
    main_json: Snap,
    target_creds: Snap,
    target_json: Option<Snap>,
    target_oauth: Rec,
    main_account: Rec,
    target_account: Rec,
    main_identity: Identity,
    target_identity: Identity,
}

fn inspect(deps: &ActivateDeps, paths: &SwapPaths, account_id: &str) -> Result<State, Stop> {
    let fs = &*deps.fs;
    let store = &deps.store;
    let Some(entry) = store.list().into_iter().find(|a| a.id == account_id) else { return Err(Stop::Fail(SwapError::NoTarget)) };
    let target_dir = store.dir_of(account_id)?;
    let main_creds = read_snap(fs, &paths.credentials)?;
    let main_json = read_snap(fs, &paths.claude_json)?;
    let main_oauth = main_creds.as_ref().and_then(|c| oauth(&c.data)).cloned();
    let (Some(main_creds), Some(main_json)) = (main_creds, main_json) else { return Err(Stop::Fail(SwapError::NoMain)) };
    if !valid_oauth(main_oauth.as_ref()) {
        return Err(Stop::Fail(SwapError::NoMain));
    }
    let Some(main_account) = js::record(main_json.data.get("oauthAccount")).cloned() else {
        return Err(Stop::Fail(SwapError::NoMain));
    };
    let Some(main_identity) = identity_of(Some(&Value::Object(main_account.clone())), None) else {
        return Err(Stop::Fail(SwapError::NoMain));
    };
    let target_creds = read_snap(fs, &target_dir.join(".credentials.json"))?;
    let target_oauth = target_creds.as_ref().and_then(|c| oauth(&c.data)).cloned();
    let (Some(target_creds), Some(target_oauth)) = (target_creds, target_oauth) else {
        return Err(Stop::Fail(SwapError::NoTarget));
    };
    if str_of(target_oauth.get("accessToken")).is_none() {
        return Err(Stop::Fail(SwapError::NoTarget));
    }
    let target_json = read_snap(fs, &target_dir.join(".claude.json"))?;
    let file_account = target_json.as_ref().and_then(|j| js::record(j.data.get("oauthAccount"))).cloned();
    let fallback = (entry.identity.email.as_deref(), entry.identity.org.as_deref());
    let Some(target_identity) = identity_of(file_account.as_ref().map(|a| Value::Object(a.clone())).as_ref(), Some(fallback))
    else {
        return Err(Stop::Fail(SwapError::NoTarget));
    };
    // An account object without an e-mail is completed from the stored entry.
    let target_account = match &file_account {
        Some(a) if str_of(a.get("emailAddress")).is_some() => a.clone(),
        Some(a) => {
            let mut m = a.clone();
            m.insert("emailAddress".into(), entry.identity.email.clone().map_or(Value::Null, Value::String));
            if entry.identity.email.is_none() {
                m.shift_remove("emailAddress");
            }
            if let Some(org) = entry.identity.org.as_ref().filter(|o| !o.is_empty())
                && str_of(a.get("organizationName")).is_none()
            {
                m.insert("organizationName".into(), Value::String(org.clone()));
            }
            m
        }
        None => {
            let mut m = Map::new();
            if let Some(e) = &entry.identity.email {
                m.insert("emailAddress".into(), Value::String(e.clone()));
            }
            if let Some(org) = entry.identity.org.as_ref().filter(|o| !o.is_empty()) {
                m.insert("organizationName".into(), Value::String(org.clone()));
            }
            m
        }
    };
    if same_identity(&main_identity, &target_identity) {
        return Err(Stop::Fail(SwapError::SameAccount));
    }
    for other in store.list() {
        if other.id == account_id {
            continue;
        }
        let other_json = read_snap(fs, &store.dir_of(&other.id)?.join(".claude.json"))?;
        let other_identity = identity_of(
            other_json.as_ref().and_then(|j| j.data.get("oauthAccount")),
            Some((other.identity.email.as_deref(), other.identity.org.as_deref())),
        );
        if other_identity.is_some_and(|o| same_identity(&o, &main_identity)) {
            return Err(Stop::Fail(SwapError::Duplicate));
        }
    }
    Ok(State {
        main_creds,
        main_json,
        target_creds,
        target_json,
        target_oauth,
        main_account,
        target_account,
        main_identity,
        target_identity,
    })
}

fn perform(deps: &ActivateDeps, account_id: &str) -> Result<SwapResult, Stop> {
    if env_get(&deps.env, "CLAUDE_CODE_OAUTH_TOKEN").is_some_and(|t| !js::trim(t).is_empty()) {
        return Err(Stop::Fail(SwapError::EnvToken));
    }
    let paths = swap_paths(&deps.home, &deps.env).ok_or(Stop::Fail(SwapError::NoMain))?;
    inspect(deps, &paths, account_id)?;
    let target_dir = deps.store.dir_of(account_id)?;
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (deps.refresh)(&target_dir)))
        .unwrap_or(RefreshOutcome::Transient(None));
    if matches!(outcome, RefreshOutcome::Dead | RefreshOutcome::Unusable) {
        return Err(Stop::Fail(SwapError::Dead));
    }
    let _profile = deps.profiles.lock(&target_dir);
    run_swap(deps, &paths, account_id, &target_dir, matches!(outcome, RefreshOutcome::Transient(_)))
}

struct Ctx<'a> {
    deps: &'a ActivateDeps,
    paths: &'a SwapPaths,
    s: &'a State,
    account_id: &'a str,
    target_creds_path: PathBuf,
    target_json_path: PathBuf,
    target_creds_written: bool,
    target_json_written: bool,
    main_creds_replaced: bool,
    phase: Option<Phase>,
    /// Exact text we wrote to main credentials.
    written_main_creds: Option<String>,
}

impl Ctx<'_> {
    fn fs(&self) -> &dyn SwapFs {
        &*self.deps.fs
    }

    fn write(&self, path: &Path, data: &str, guard: Option<&dyn Fn() -> io::Result<bool>>) -> Result<(), WriteError> {
        atomic_write(&*self.deps.delay, self.fs(), path, data, guard)
    }

    fn journal(&mut self, phase: Phase) -> Result<(), Stop> {
        if self.phase == Some(phase) {
            return Ok(());
        }
        let mut m = Map::new();
        m.insert("version".into(), Value::from(1));
        m.insert("accountId".into(), Value::String(self.account_id.into()));
        m.insert("startedAt".into(), js::num((self.deps.now)()));
        m.insert("phase".into(), Value::String(phase.as_str().into()));
        m.insert("targetJsonExisted".into(), Value::Bool(self.s.target_json.is_some()));
        self.write(&self.deps.backup_dir.join(JOURNAL), &stringify(&Value::Object(m)), None)?;
        self.phase = Some(phase);
        Ok(())
    }

    /// Moves the CURRENT main blob into the target profile and `to_main` into main. Main is re-read on every try and guarded
    /// right before every rename attempt; when Claude Code wrote meanwhile the target copy is recomputed from the fresh blob.
    fn exchange_creds(&mut self, to_main: &Rec, journaled: bool, expect_text: Option<&str>) -> Result<(), Stop> {
        let mut displaced: Option<String> = None;
        let mut touched = false;
        let result = (|| -> Result<(), Stop> {
            for _ in 0..MAX_TRIES {
                let main = read_snap(self.fs(), &self.paths.credentials)?;
                let main_oauth = main.as_ref().and_then(|m| oauth(&m.data)).cloned();
                let Some(main) = main.filter(|_| valid_oauth(main_oauth.as_ref())) else {
                    return Err(Stop::Fail(SwapError::Write));
                };
                let main_oauth = main_oauth.unwrap_or_default();
                if let Some(expect) = expect_text
                    && main.text != expect
                {
                    return Err(Stop::Unprovable);
                }
                let target = read_snap(self.fs(), &self.target_creds_path)?;
                // The backup always holds the CURRENT blob of both logins, so a token rotated since the first snapshot is never
                // in no file.
                let backup_dir = self.deps.backup_dir.clone();
                if journaled {
                    self.write(&backup_dir.join(MAIN_CREDS), &main.text, None)?;
                } else {
                    let only = |o: &Rec| {
                        let mut m = Map::new();
                        m.insert("claudeAiOauth".into(), Value::Object(o.clone()));
                        stringify(&Value::Object(m))
                    };
                    self.write(&backup_dir.join(MAIN_CREDS), &only(to_main), None)?;
                    self.write(&backup_dir.join(TARGET_CREDS), &only(&main_oauth), None)?;
                }
                if journaled {
                    self.journal(Phase::TargetWritten)?;
                }
                if displaced.is_none() {
                    displaced = Some(target.as_ref().map_or_else(|| self.s.target_creds.text.clone(), |t| t.text.clone()));
                }
                touched = true;
                let base = target.as_ref().map_or(&self.s.target_creds.data, |t| &t.data);
                let text = stringify(&with_key(base, "claudeAiOauth", Value::Object(main_oauth.clone())));
                self.write(&self.target_creds_path.clone(), &text, None)?;
                self.target_creds_written = true;
                if journaled {
                    self.journal(Phase::MainCredsWritten)?;
                }
                let text = stringify(&with_key(&main.data, "claudeAiOauth", Value::Object(to_main.clone())));
                let fs = self.fs();
                let creds = self.paths.credentials.clone();
                let guard = || unchanged(fs, &creds, &main);
                match self.write(&creds, &text, Some(&guard)) {
                    Ok(()) => {
                        self.main_creds_replaced = true;
                        self.written_main_creds = Some(text);
                        return Ok(());
                    }
                    Err(WriteError::Changed) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            Err(Stop::Fail(SwapError::Write))
        })();
        if result.is_err()
            && touched
            && let Some(d) = &displaced
        {
            // Whatever failed after the target was overwritten: the blob it displaced is put back first (it may be the only
            // live copy).
            let _ = self.write(&self.target_creds_path.clone(), d, None);
        }
        result
    }
}

/// `setKey`: sets one key of a JSON file from its current content (guarded and recomputed on change when `guarded`).
fn set_key(
    deps: &ActivateDeps,
    path: &Path,
    key: &str,
    value: &Value,
    guarded: bool,
    accept: Option<&dyn Fn(&Rec) -> bool>,
) -> Result<(), Stop> {
    let fs = &*deps.fs;
    for _ in 0..MAX_TRIES {
        let snap = read_snap(fs, path)?;
        let Some(snap) = snap.filter(|s| accept.is_none_or(|a| a(&s.data))) else { return Err(Stop::Fail(SwapError::Write)) };
        let guard = || unchanged(fs, path, &snap);
        let g: Option<&dyn Fn() -> io::Result<bool>> = if guarded { Some(&guard) } else { None };
        match atomic_write(&*deps.delay, fs, path, &stringify2(&with_key(&snap.data, key, value.clone())), g) {
            Ok(()) => return Ok(()),
            Err(WriteError::Changed) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(Stop::Fail(SwapError::Write))
}

fn remove_backups(deps: &ActivateDeps) -> io::Result<()> {
    let fs = &*deps.fs;
    // The journal goes first: a crash in between leaves backups without a journal, which means no credential file changed.
    for name in std::iter::once(JOURNAL).chain(BACKUPS) {
        let _ = fs.rm(&deps.backup_dir.join(name));
    }
    for name in fs.readdir(&deps.backup_dir)? {
        if is_uuid_tmp(&name) {
            let _ = fs.rm(&deps.backup_dir.join(&name));
        }
    }
    let _ = fs.rmdir(&deps.backup_dir);
    Ok(())
}

/// Only our own leftover temp files (`.credentials.json.<uuid>.tmp`, `.claude.json.<uuid>.tmp`) in the config dirs.
fn remove_stale_temps(deps: &ActivateDeps) -> io::Result<()> {
    let fs = &*deps.fs;
    let mut dirs: BTreeSet<PathBuf> = BTreeSet::new();
    let mut order: Vec<PathBuf> = Vec::new();
    let mut add = |d: PathBuf| {
        if dirs.insert(d.clone()) {
            order.push(d);
        }
    };
    if let Some(p) = swap_paths(&deps.home, &deps.env) {
        if let Some(d) = p.credentials.parent() {
            add(d.to_path_buf());
        }
        if let Some(d) = p.claude_json.parent() {
            add(d.to_path_buf());
        }
    }
    for account in deps.store.list() {
        if let Ok(d) = deps.store.dir_of(&account.id) {
            add(d);
        }
    }
    for dir in order {
        for name in fs.readdir(&dir)? {
            if is_own_temp(&name) {
                let _ = fs.rm(&dir.join(&name));
            }
        }
    }
    Ok(())
}

fn run_swap(
    deps: &ActivateDeps,
    paths: &SwapPaths,
    account_id: &str,
    target_dir: &Path,
    require_valid_token: bool,
) -> Result<SwapResult, Stop> {
    let s = inspect(deps, paths, account_id)?;
    if require_valid_token {
        let expires = s.target_oauth.get("expiresAt").and_then(Value::as_f64);
        if expires.is_none_or(|e| e <= (deps.now)() + EXPIRY_MARGIN_MS) {
            return Err(Stop::Fail(SwapError::Transient));
        }
    }
    let fs = &*deps.fs;
    let mut c = Ctx {
        deps,
        paths,
        s: &s,
        account_id,
        target_creds_path: target_dir.join(".credentials.json"),
        target_json_path: target_dir.join(".claude.json"),
        target_creds_written: false,
        target_json_written: false,
        main_creds_replaced: false,
        phase: None,
        written_main_creds: None,
    };
    let steps = (|| -> Result<(), Stop> {
        fs.mkdir(&deps.backup_dir)?;
        c.write(&deps.backup_dir.join(MAIN_CREDS), &s.main_creds.text, None)?;
        c.write(&deps.backup_dir.join(MAIN_JSON), &s.main_json.text, None)?;
        c.write(&deps.backup_dir.join(TARGET_CREDS), &s.target_creds.text, None)?;
        match &s.target_json {
            Some(j) => c.write(&deps.backup_dir.join(TARGET_JSON), &j.text, None)?,
            None => fs.rm(&deps.backup_dir.join(TARGET_JSON))?,
        }
        c.journal(Phase::BackedUp)?;

        // 1. target profile: identity, then credentials (together with main credentials)
        c.journal(Phase::TargetWritten)?;
        let empty = Map::new();
        let base = s.target_json.as_ref().map_or(&empty, |j| &j.data);
        let text = stringify2(&with_key(base, "oauthAccount", Value::Object(s.main_account.clone())));
        c.write(&c.target_json_path.clone(), &text, None)?;
        c.target_json_written = true;
        c.exchange_creds(&s.target_oauth, true, None)?;
        settle(&c)?;

        // 2. main identity
        c.journal(Phase::MainJsonWritten)?;
        let main_identity = s.main_identity.clone();
        let accept =
            move |data: &Rec| identity_of(data.get("oauthAccount"), None).is_some_and(|id| same_identity(&id, &main_identity));
        set_key(deps, &paths.claude_json, "oauthAccount", &Value::Object(s.target_account.clone()), true, Some(&accept))?;
        settle(&c)?;

        // 3. verify by reading everything back (a refreshed access token is fine; identity and a usable login are checked)
        let main = read_snap(fs, &paths.credentials)?;
        let main_json = read_snap(fs, &paths.claude_json)?;
        let target = read_snap(fs, &c.target_creds_path)?;
        let target_json = read_snap(fs, &c.target_json_path)?;
        let main_identity = identity_of(main_json.as_ref().and_then(|j| j.data.get("oauthAccount")), None);
        let target_identity = identity_of(target_json.as_ref().and_then(|j| j.data.get("oauthAccount")), None);
        let ok = main.as_ref().is_some_and(|m| Some(&m.text) == c.written_main_creds.as_ref() && valid_oauth(oauth(&m.data)))
            && target.as_ref().is_some_and(|t| valid_oauth(oauth(&t.data)))
            && main_identity.as_ref().is_some_and(|m| same_identity(m, &s.target_identity))
            && target_identity.as_ref().is_some_and(|t| same_identity(t, &s.main_identity));
        if !ok {
            return Err(Stop::Fail(SwapError::Write));
        }
        // Last look right before 'verified' is persisted: Claude Code may have written main credentials or .claude.json since.
        let last_creds = read_snap(fs, &paths.credentials)?;
        let last_json = read_snap(fs, &paths.claude_json)?;
        let last_identity = identity_of(last_json.as_ref().and_then(|j| j.data.get("oauthAccount")), None);
        if last_creds.as_ref().map(|l| &l.text) != c.written_main_creds.as_ref()
            || !last_identity.is_some_and(|l| same_identity(&l, &s.target_identity))
        {
            return Err(Stop::Unprovable);
        }
        c.journal(Phase::Verified)?;
        Ok(())
    })();
    if let Err(error) = steps {
        if matches!(error, Stop::Unprovable) {
            return Err(Stop::Fail(SwapError::Manual));
        }
        if !rollback(&mut c) {
            return Err(Stop::Fail(SwapError::Manual));
        }
        remove_backups(deps)?;
        return Err(match error {
            Stop::Fail(code) if code != SwapError::Manual => Stop::Fail(code),
            _ => Stop::Fail(SwapError::Write),
        });
    }
    // The label goes first and cleanup is best effort: a completed swap never turns into an error because a file could not
    // be deleted (a leftover 'verified' journal or journal-less backups are removed by the next start).
    let _ = deps.store.update(
        account_id,
        Some(str_of(s.main_account.get("emailAddress"))),
        Some(str_of(s.main_account.get("organizationName"))),
    );
    let _ = remove_backups(deps);
    Ok(SwapResult::ok(str_of(s.target_account.get("emailAddress")).map(str::to_string)))
}

/// Gives Claude Code time to write its own result, then requires main credentials to still be exactly what we wrote.
fn settle(c: &Ctx<'_>) -> Result<(), Stop> {
    (c.deps.delay)(SETTLE);
    let now = read_snap(c.fs(), &c.paths.credentials)?;
    if now.as_ref().map(|n| &n.text) != c.written_main_creds.as_ref() {
        return Err(Stop::Unprovable);
    }
    Ok(())
}

/// Undoes a failed swap on the CURRENT content. Before main was replaced only the target profile was touched and its own
/// originals go back. Afterwards it is a reverse exchange. Returns false when anything could not be undone.
fn rollback(c: &mut Ctx<'_>) -> bool {
    let mut clean = true;
    let mut moved: Option<Rec> = None;
    if c.main_creds_replaced {
        if c.journal(Phase::RollingBack).is_err() {
            clean = false;
        }
        let r = (|| -> Result<(), Stop> {
            let target = read_snap(c.fs(), &c.target_creds_path)?;
            let back = target.as_ref().and_then(|t| oauth(&t.data)).cloned();
            let Some(back) = back.filter(|b| valid_oauth(Some(b))) else { return Err(Stop::Fail(SwapError::Manual)) };
            moved = Some(back.clone());
            let expect = c.written_main_creds.clone();
            c.exchange_creds(&back, false, expect.as_deref())
        })();
        if r.is_err() {
            clean = false;
        }
    } else if c.target_creds_written {
        let text = c.s.target_creds.text.clone();
        if c.write(&c.target_creds_path.clone(), &text, None).is_err() {
            clean = false;
        }
    }
    // After a failed credential step the identities stay as they are.
    if c.target_json_written && clean {
        let r = match &c.s.target_json {
            Some(j) => c.write(&c.target_json_path.clone(), &j.text, None).map_err(Stop::from),
            None => c.fs().rm(&c.target_json_path).map_err(Stop::from),
        };
        if r.is_err() {
            clean = false;
        }
    }
    if c.main_creds_replaced && clean {
        let r = (|| -> Result<(), Stop> {
            let now = read_snap(c.fs(), &c.paths.claude_json)?;
            let id = now.as_ref().and_then(|n| identity_of(n.data.get("oauthAccount"), None));
            if id.is_some_and(|i| same_identity(&i, &c.s.main_identity)) {
                return Ok(());
            }
            set_key(c.deps, &c.paths.claude_json, "oauthAccount", &Value::Object(c.s.main_account.clone()), true, None)
        })();
        if r.is_err() {
            clean = false;
        }
    }
    // Only a verified rollback may be reported as "nothing was changed".
    if clean {
        let r = (|| -> Result<(), Stop> {
            if c.main_creds_replaced {
                let main = read_snap(c.fs(), &c.paths.credentials)?;
                let now = main.as_ref().and_then(|m| oauth(&m.data));
                let same = match (&moved, now) {
                    (Some(m), Some(n)) => {
                        js_json::js_equal(
                            m.get("refreshToken").unwrap_or(&Value::Null),
                            n.get("refreshToken").unwrap_or(&Value::Null),
                        ) && m.get("refreshToken").is_some() == n.get("refreshToken").is_some()
                    }
                    _ => false,
                };
                if !same {
                    return Err(Stop::Fail(SwapError::Manual));
                }
            } else if c.target_creds_written {
                let target = read_snap(c.fs(), &c.target_creds_path)?;
                if target.as_ref().map(|t| &t.text) != Some(&c.s.target_creds.text) {
                    return Err(Stop::Fail(SwapError::Manual));
                }
            }
            Ok(())
        })();
        if r.is_err() {
            clean = false;
        }
    }
    clean
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lineage {
    A,
    X,
    Unknown,
    None,
}

/// `recoverInterruptedSwap`: call once at app start (after a `Legacy` answer of the version-2 recovery). It acts only when
/// the lineage of every credentials file is provable; otherwise nothing is modified, backup and journal stay, and `Manual`
/// is returned. Only the `claudeAiOauth` / `oauthAccount` keys are ever written.
pub fn recover_interrupted_swap(deps: &ActivateDeps) -> Recovery {
    let Some(_slot) = deps.slot.try_claim() else { return Recovery::None };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| recover(deps))).unwrap_or(Err(Stop::Other));
    match result {
        Ok(r) => {
            deps.slot.set_unresolved(r == Recovery::Manual);
            r
        }
        Err(_) => {
            deps.slot.set_unresolved(true);
            Recovery::Manual
        }
    }
}

fn read_backup(fs: &dyn SwapFs, dir: &Path, name: &str) -> io::Result<Option<Rec>> {
    let text = fs.read_file(&dir.join(name))?;
    Ok(text.and_then(|t| match js_json::parse(&t) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }))
}

fn recover(deps: &ActivateDeps) -> Result<Recovery, Stop> {
    let fs = &*deps.fs;
    let Some(journal_text) = fs.read_file(&deps.backup_dir.join(JOURNAL))? else {
        // No journal: it is written before the first credential file changes, so nothing was modified. Stray backups only
        // hold live tokens and go away.
        let _ = remove_backups(deps).and_then(|()| remove_stale_temps(deps));
        return Ok(Recovery::None);
    };
    let info = match js_json::parse(&journal_text) {
        Ok(Value::Object(m)) => m,
        _ => return Ok(Recovery::Manual),
    };
    let (Some(account_id), Some(phase)) = (
        info.get("accountId").and_then(Value::as_str).filter(|a| is_account_id(a)).map(str::to_string),
        info.get("phase").and_then(Value::as_str).map(str::to_string),
    ) else {
        return Ok(Recovery::Manual);
    };
    if phase == "verified" {
        // The swap was complete; only the label of the saved account may still show the old owner. But if main holds the old
        // main login again (a stale write), the old target login may exist only in the backup: keep everything.
        let stale = (|| -> Result<bool, ()> {
            let a_text = fs.read_file(&deps.backup_dir.join(MAIN_CREDS)).map_err(drop)?;
            let a_refresh = match a_text {
                None => None,
                Some(t) => {
                    let v = js_json::parse(&t).map_err(drop)?;
                    // `oauthOf(JSON.parse(aText))` on null throws.
                    if v.is_null() {
                        return Err(());
                    }
                    v.as_object().and_then(oauth).and_then(|o| str_of(o.get("refreshToken"))).map(str::to_string)
                }
            };
            let main = match swap_paths(&deps.home, &deps.env) {
                Some(p) => read_snap(fs, &p.credentials).map_err(drop)?,
                None => None,
            };
            let main_refresh =
                main.as_ref().and_then(|m| oauth(&m.data)).and_then(|o| str_of(o.get("refreshToken"))).map(str::to_string);
            Ok(a_refresh.is_some() && main_refresh.is_some() && a_refresh == main_refresh)
        })();
        match stale {
            Ok(false) => {}
            _ => return Ok(Recovery::Manual),
        }
        if let Ok(Some(text)) = fs.read_file(&deps.backup_dir.join(MAIN_JSON))
            && let Ok(v) = js_json::parse(&text)
            && let Some(acct) = js::record(v.get("oauthAccount"))
        {
            let _ = deps.store.update(
                &account_id,
                Some(str_of(acct.get("emailAddress"))),
                Some(str_of(acct.get("organizationName"))),
            );
        }
    }
    if phase == "verified" || phase == "backed-up" {
        remove_backups(deps)?;
        let _ = remove_stale_temps(deps);
        return Ok(Recovery::None);
    }
    let Some(paths) = swap_paths(&deps.home, &deps.env) else { return Ok(Recovery::Manual) };
    let main_creds_b = read_backup(fs, &deps.backup_dir, MAIN_CREDS)?;
    let main_json_b = read_backup(fs, &deps.backup_dir, MAIN_JSON)?;
    let target_creds_b = read_backup(fs, &deps.backup_dir, TARGET_CREDS)?;
    let target_json_b = read_backup(fs, &deps.backup_dir, TARGET_JSON)?;
    let a_blob = main_creds_b.as_ref().and_then(oauth).cloned();
    let x_blob = target_creds_b.as_ref().and_then(oauth).cloned();
    let account_a = main_json_b.as_ref().and_then(|j| js::record(j.get("oauthAccount"))).cloned();
    let (Some(a_blob), Some(x_blob), Some(account_a)) = (a_blob, x_blob, account_a) else { return Ok(Recovery::Manual) };
    if !valid_oauth(Some(&a_blob)) || !valid_oauth(Some(&x_blob)) {
        return Ok(Recovery::Manual);
    }
    let a_refresh = str_of(a_blob.get("refreshToken")).unwrap_or_default().to_string();
    let x_refresh = str_of(x_blob.get("refreshToken")).unwrap_or_default().to_string();
    let refresh_of = |snap: &Option<Snap>| -> Option<String> {
        snap.as_ref().and_then(|s| oauth(&s.data)).and_then(|o| str_of(o.get("refreshToken"))).map(str::to_string)
    };
    let classify = |snap: &Option<Snap>| match refresh_of(snap) {
        None => Lineage::None,
        Some(r) if r == a_refresh => Lineage::A,
        Some(r) if r == x_refresh => Lineage::X,
        Some(_) => Lineage::Unknown,
    };
    let target_dir = deps.store.dir_of(&account_id)?;
    let target_creds_path = target_dir.join(".credentials.json");
    let target_json_path = target_dir.join(".claude.json");
    let outcome = {
        let _profile = deps.profiles.lock(&target_dir);
        (|| -> Result<Recovery, Stop> {
            let main_snap = read_snap(fs, &paths.credentials)?;
            let main = classify(&main_snap);
            let target_snap = read_snap(fs, &target_creds_path)?;
            let target = classify(&target_snap);
            let shared = refresh_of(&main_snap).is_some() && refresh_of(&main_snap) == refresh_of(&target_snap);
            let entry = deps.store.list().into_iter().find(|a| a.id == account_id);
            let account_x: Rec = match target_json_b.as_ref().and_then(|j| js::record(j.get("oauthAccount"))) {
                Some(a) => a.clone(),
                None => {
                    let mut m = Map::new();
                    if let Some(e) = entry.as_ref().and_then(|e| e.identity.email.clone()) {
                        m.insert("emailAddress".into(), Value::String(e));
                    }
                    if let Some(o) = entry.as_ref().and_then(|e| e.identity.org.clone()).filter(|o| !o.is_empty()) {
                        m.insert("organizationName".into(), Value::String(o));
                    }
                    m
                }
            };
            let original_x = target_json_b.as_ref().and_then(|j| js::record(j.get("oauthAccount"))).cloned();
            let set_target_account = |value: Option<&Rec>| -> Result<(), Stop> {
                let cur = read_snap(fs, &target_json_path)?;
                let Some(value) = value else {
                    let Some(cur) = cur else { return Ok(()) };
                    let mut rest = cur.data.clone();
                    rest.shift_remove("oauthAccount");
                    if rest.is_empty() {
                        fs.rm(&target_json_path)?;
                    } else {
                        atomic_write(&*deps.delay, fs, &target_json_path, &stringify2(&Value::Object(rest)), None)?;
                    }
                    return Ok(());
                };
                let empty = Map::new();
                let text =
                    stringify2(&with_key(cur.as_ref().map_or(&empty, |c| &c.data), "oauthAccount", Value::Object(value.clone())));
                atomic_write(&*deps.delay, fs, &target_json_path, &text, None)?;
                Ok(())
            };
            let set_main_account = |value: &Rec| -> Result<(), Stop> {
                let cur = read_snap(fs, &paths.claude_json)?;
                let id = cur.as_ref().and_then(|c| identity_of(c.data.get("oauthAccount"), None));
                let want = identity_of(Some(&Value::Object(value.clone())), None);
                if let (Some(id), Some(want)) = (&id, &want)
                    && same_identity(id, want)
                {
                    return Ok(());
                }
                set_key(deps, &paths.claude_json, "oauthAccount", &Value::Object(value.clone()), true, None)
            };
            let put_target_creds = |blob: &Rec| -> Result<(), Stop> {
                let empty = Map::new();
                let base = target_snap.as_ref().map_or(&empty, |t| &t.data);
                atomic_write(
                    &*deps.delay,
                    fs,
                    &target_creds_path,
                    &stringify(&with_key(base, "claudeAiOauth", Value::Object(blob.clone()))),
                    None,
                )?;
                Ok(())
            };
            let relabel = || {
                let _ = deps.store.update(
                    &account_id,
                    Some(str_of(account_a.get("emailAddress"))),
                    Some(str_of(account_a.get("organizationName"))),
                );
            };
            let forward = phase == "target-written" || phase == "main-creds-written";
            if shared && main != Lineage::X && forward {
                // Identical tokens: the target copy provably came from main (forward), so the target gets its own login back.
                put_target_creds(&x_blob)?;
                set_target_account(original_x.as_ref())?;
                set_main_account(&account_a)?;
                return Ok(Recovery::Recovered);
            }
            if shared && main == Lineage::X && phase == "rolling-back" {
                // Reverse exchange: the target copy came from main (the target login X); the old main login A returns.
                put_target_creds(&a_blob)?;
                set_target_account(Some(&account_a))?;
                set_main_account(&account_x)?;
                relabel();
                return Ok(Recovery::Recovered);
            }
            let original_positions = main == Lineage::A && target == Lineage::X;
            let target_copied_only = main == Lineage::A
                && target == Lineage::A
                && (phase == "target-written" || phase == "main-creds-written" || phase == "main-json-written");
            if original_positions || target_copied_only {
                // Main still holds exactly the old main login: the target profile gets its own login back.
                if target_copied_only {
                    put_target_creds(&x_blob)?;
                }
                set_target_account(original_x.as_ref())?;
                set_main_account(&account_a)?;
                return Ok(Recovery::Recovered);
            }
            if main == Lineage::X
                && target == Lineage::A
                && (phase == "main-creds-written" || phase == "main-json-written" || phase == "rolling-back")
            {
                // The credentials were exchanged: finish the identity half.
                set_target_account(Some(&account_a))?;
                set_main_account(&account_x)?;
                relabel();
                return Ok(Recovery::Recovered);
            }
            Ok(Recovery::Manual)
        })()
    };
    match outcome {
        Ok(Recovery::Recovered) => {
            remove_backups(deps)?;
            let _ = remove_stale_temps(deps);
            Ok(Recovery::Recovered)
        }
        Ok(r) => Ok(r),
        Err(_) => Ok(Recovery::Manual),
    }
}

#[cfg(test)]
mod tests;
