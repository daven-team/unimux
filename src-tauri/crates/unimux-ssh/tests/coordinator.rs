//! SshCoordinator cases ported from test/ssh-coordinator.test.ts and test/ssh-identity-main.test.ts (S3).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_oscrypt::Cipher;
use unimux_ssh::coordinator::{
    ConnectCellRequest, CoordinatorDeps, CoordinatorEvents, CoordinatorState, SshCoordinator, SshHostLink,
};
use unimux_ssh::js_value::JsNum;
use unimux_ssh::keys::{KeyGenRequest, KeyType, check_passphrase, generate_key_blocking};
use unimux_ssh::protocol::{AuthPromptInfo, AuthPromptKind, HostCommand, HostKeyChoice, HostMessage, PromptAnswer, PromptField};
use unimux_ssh::session::{SessionState, SshErrorCode, SshPhase};
use unimux_ssh::stores::SshStores;
use unimux_ssh::vault::{AddKey, KeySource, NewKey};
use zeroize::Zeroizing;

const HOST: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
const IDENTITY: &str = "00000000-0000-4000-8000-000000000003";
const CELLS: [&str; 4] = [
    "00000000-0000-4000-8000-0000000000a1",
    "00000000-0000-4000-8000-0000000000a2",
    "00000000-0000-4000-8000-0000000000a3",
    "00000000-0000-4000-8000-0000000000a4",
];

#[derive(Default)]
struct Rec {
    sent: Mutex<Vec<HostCommand>>,
    prompts: Mutex<Vec<(String, Option<Value>)>>,
    sessions: Mutex<Vec<SessionState>>,
    vault_changes: AtomicUsize,
    host_down: AtomicBool,
}

struct StateOf(Mutex<Arc<Value>>);
impl CoordinatorState for StateOf {
    fn state(&self) -> Arc<Value> {
        self.0.lock().clone()
    }
}

struct Link(Arc<Rec>);
impl SshHostLink for Link {
    fn send(&self, cmd: HostCommand) -> bool {
        if self.0.host_down.load(Ordering::SeqCst) {
            return false;
        }
        self.0.sent.lock().push(cmd);
        true
    }
}

struct Events(Arc<Rec>);
impl CoordinatorEvents for Events {
    fn session(&self, s: &SessionState) {
        self.0.sessions.lock().push(s.clone());
    }
    fn prompt(&self, cell_id: &str, prompt: Option<&Value>) {
        self.0.prompts.lock().push((cell_id.to_string(), prompt.cloned()));
    }
    fn vault_changed(&self) {
        self.0.vault_changes.fetch_add(1, Ordering::SeqCst);
    }
}

struct Fx {
    coord: Arc<SshCoordinator>,
    stores: Arc<SshStores>,
    rec: Arc<Rec>,
    state: Arc<StateOf>,
    key_id: Option<String>,
    checks: Arc<AtomicUsize>,
    _dir: tempfile::TempDir,
}

#[derive(Default)]
struct Opts {
    encrypted_key: bool,
    save_passphrase: bool,
    prompt_timeout: Option<Duration>,
    identity: bool,
}

fn state(key_id: Option<&str>, identity: bool) -> Value {
    let cells: Vec<Value> = CELLS
        .iter()
        .enumerate()
        .map(|(i, id)| json!({ "id": id, "profileId": "shell", "ssh": { "hostId": if i < 3 { HOST } else { OTHER } } }))
        .collect();
    let mut web = json!({ "id": HOST, "label": "web", "address": "web.example", "port": 2222, "username": "deploy" });
    if let Some(k) = key_id {
        web["keyId"] = json!(k);
    }
    if identity {
        web["identityId"] = json!(IDENTITY);
    }
    json!({
        "projects": [{ "id": "p", "tabs": [{ "id": "t", "cells": cells }] }],
        "sshHosts": [web, { "id": OTHER, "label": "db", "address": "db.example", "port": 22, "username": "deploy" }],
        "sshIdentities": if identity { json!([{ "id": IDENTITY, "label": "ops", "username": "ops" }]) } else { json!([]) },
    })
}

async fn setup(o: Opts) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let stores = SshStores::new(dir.path(), Arc::new(Cipher::with_gcm_key([7u8; 32])), Arc::new(|_: &str| true));
    stores.init().await;
    let mut key_id = None;
    if o.encrypted_key {
        let generated = generate_key_blocking(&KeyGenRequest {
            key_type: KeyType::Ed25519,
            bits: None,
            comment: String::new(),
            passphrase: Some(Zeroizing::new("right".into())),
        })
        .unwrap();
        let m = generated.meta;
        let added = stores
            .vault()
            .await
            .lock()
            .add_key(NewKey {
                label: "laptop".into(),
                key_type: m.key_type.as_str().into(),
                bits: JsNum::from(m.bits),
                fingerprint: m.fingerprint,
                public_key: m.public_key,
                comment: m.comment,
                encrypted: true,
                private_key: generated.private_key,
                passphrase: Some(Zeroizing::new("right".into())),
                save_passphrase: o.save_passphrase,
                certificate: None,
                source: KeySource::Generated,
            })
            .unwrap();
        let AddKey::Added { key, .. } = added else { panic!("added") };
        key_id = Some(key.meta.id);
    }
    let rec = Arc::new(Rec::default());
    let st = Arc::new(StateOf(Mutex::new(Arc::new(state(key_id.as_deref(), o.identity)))));
    let checks = Arc::new(AtomicUsize::new(0));
    let c = checks.clone();
    let ids = Arc::new(AtomicUsize::new(0));
    let coord = SshCoordinator::new(CoordinatorDeps {
        state: st.clone(),
        stores: stores.clone(),
        host: Arc::new(Link(rec.clone())),
        events: Arc::new(Events(rec.clone())),
        spawn: Arc::new(|f| {
            tokio::spawn(f);
        }),
        now: Arc::new(|| 1000),
        new_id: Arc::new(move || format!("00000000-0000-4000-8000-{:012x}", ids.fetch_add(1, Ordering::SeqCst) + 0x100)),
        debug: false,
        prompt_timeout: o.prompt_timeout.unwrap_or(Duration::from_secs(300)),
        check_passphrase: Arc::new(move |k, p| {
            c.fetch_add(1, Ordering::SeqCst);
            check_passphrase(k, p)
        }),
    });
    Fx { coord, stores, rec, state: st, key_id, checks, _dir: dir }
}

impl Fx {
    fn open(&self, cell: &str) -> Option<Value> {
        self.rec.prompts.lock().iter().rev().find(|(c, _)| c == cell).and_then(|(_, p)| p.clone())
    }
    fn connects(&self) -> Vec<String> {
        self.rec
            .sent
            .lock()
            .iter()
            .filter_map(|m| match m {
                HostCommand::Connect(r) => Some(r.id.clone()),
                _ => None,
            })
            .collect()
    }
    fn last_session(&self) -> SessionState {
        self.rec.sessions.lock().last().cloned().unwrap()
    }
    fn connect(&self, i: usize) -> tokio::task::JoinHandle<Result<(), SshErrorCode>> {
        let (c, host) = (self.coord.clone(), if i < 3 { HOST } else { OTHER });
        let req = ConnectCellRequest { cell_id: CELLS[i].into(), host_id: host.into(), cols: 80, rows: 24, restore_cwd: false };
        tokio::spawn(async move { c.connect(req).await })
    }
    fn values(&self, i: usize, prompt: &Value, values: &[&str], remember: bool) -> bool {
        self.coord.answer(PromptAnswer::Values {
            cell_id: CELLS[i].into(),
            prompt_id: prompt["id"].as_str().unwrap().into(),
            values: values.iter().map(|v| Zeroizing::new(v.to_string())).collect(),
            remember,
            use_saved: false,
        })
    }
}

async fn tick() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(30)).await;
}

async fn until(mut f: impl FnMut() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached");
}

fn ed25519_blob(fill: u8) -> String {
    use base64::Engine;
    let mut b = Vec::new();
    b.extend_from_slice(&11u32.to_be_bytes());
    b.extend_from_slice(b"ssh-ed25519");
    b.extend_from_slice(&32u32.to_be_bytes());
    b.extend_from_slice(&[fill; 32]);
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[tokio::test(flavor = "multi_thread")]
async fn coalesces_the_passphrase_prompt_and_remembers_the_answer() {
    let f = setup(Opts { encrypted_key: true, ..Opts::default() }).await;
    let first = f.connect(0);
    let second = f.connect(1);
    until(|| f.open(CELLS[0]).is_some() && f.open(CELLS[1]).is_some()).await;
    let (pa, pb) = (f.open(CELLS[0]).unwrap(), f.open(CELLS[1]).unwrap());
    assert_eq!(pa["kind"], "passphrase");
    assert_eq!(pa["id"], pb["id"]);
    // The prompt object keeps the TS key order: the body first, then the id.
    assert_eq!(pa.as_object().unwrap().keys().collect::<Vec<_>>(), ["kind", "keyId", "keyLabel", "retry", "id"]);
    f.checks.store(0, Ordering::SeqCst);
    assert!(f.values(1, &pb, &["right"], true));
    assert_eq!(first.await.unwrap(), Ok(()));
    assert_eq!(second.await.unwrap(), Ok(()));
    assert_eq!(f.connects().len(), 2);
    if let HostCommand::Connect(r) = &f.rec.sent.lock()[0] {
        assert_eq!((r.host.as_str(), r.port, r.username.as_str()), ("web.example", 2222, "deploy"));
        assert_eq!(r.passphrase.as_deref().map(String::as_str), Some("right"));
        assert!(r.allow_password_prompt && r.private_key.is_some());
    }
    let key_id = f.key_id.clone().unwrap();
    assert_eq!(f.stores.vault().await.lock().remembered(&key_id).as_deref().map(String::as_str), Some("right"));
    assert_eq!(f.checks.load(Ordering::SeqCst), 1);
    let before = f.rec.prompts.lock().len();
    assert_eq!(f.connect(2).await.unwrap(), Ok(()));
    assert!(f.rec.prompts.lock()[before..].iter().all(|(c, _)| c != CELLS[2]));
    // M2: a remembered passphrase is trusted without another check.
    assert_eq!(f.checks.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_again_after_a_wrong_passphrase_and_gives_up_after_three_tries() {
    let f = setup(Opts { encrypted_key: true, ..Opts::default() }).await;
    let result = f.connect(0);
    let mut seen = Vec::new();
    for i in 0..3 {
        until(|| f.open(CELLS[0]).is_some_and(|p| !seen.contains(&p["id"]))).await;
        let p = f.open(CELLS[0]).unwrap();
        assert_eq!(p["retry"], json!(i > 0));
        seen.push(p["id"].clone());
        assert!(f.values(0, &p, &["wrong"], false));
    }
    assert_eq!(result.await.unwrap(), Err(SshErrorCode::Passphrase));
    assert!(f.rec.sent.lock().is_empty());
    let s = f.last_session();
    assert_eq!((s.phase, s.error), (SshPhase::Error, Some(SshErrorCode::Passphrase)));
}

#[tokio::test(flavor = "multi_thread")]
async fn withdraws_a_killed_cell_from_a_coalesced_prompt() {
    let f = setup(Opts { encrypted_key: true, ..Opts::default() }).await;
    let first = f.connect(0);
    let second = f.connect(1);
    until(|| f.open(CELLS[0]).is_some() && f.open(CELLS[1]).is_some()).await;
    f.coord.killed(CELLS[0]);
    assert!(f.open(CELLS[0]).is_none());
    assert_eq!(first.await.unwrap(), Err(SshErrorCode::Cancelled));
    let p = f.open(CELLS[1]).unwrap();
    assert!(f.values(1, &p, &["right"], false));
    assert_eq!(second.await.unwrap(), Ok(()));
    assert_eq!(f.connects(), [CELLS[1]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn returns_open_prompts_with_the_snapshot() {
    let f = setup(Opts { encrypted_key: true, ..Opts::default() }).await;
    let _pending = f.connect(0);
    until(|| f.open(CELLS[0]).is_some()).await;
    let snap = f.coord.sessions();
    let s = snap["sessions"].as_array().unwrap().iter().find(|s| s["cellId"] == CELLS[0]).unwrap();
    assert_eq!((s["phase"].as_str(), s["hostId"].as_str()), (Some("connecting"), Some(HOST)));
    assert_eq!(snap["prompts"], json!([{ "cellId": CELLS[0], "prompt": f.open(CELLS[0]).unwrap() }]));
}

#[tokio::test(flavor = "multi_thread")]
async fn coalesces_host_key_prompts_saves_trust_and_accepts_known_keys() {
    let f = setup(Opts::default()).await;
    f.connect(0).await.unwrap().unwrap();
    f.connect(1).await.unwrap().unwrap();
    let key = ed25519_blob(1);
    f.coord.on_host_message(HostMessage::HostKey { id: CELLS[0].into(), prompt_id: "pa".into(), key: key.clone() });
    f.coord.on_host_message(HostMessage::HostKey { id: CELLS[1].into(), prompt_id: "pb".into(), key: key.clone() });
    until(|| f.open(CELLS[0]).is_some() && f.open(CELLS[1]).is_some()).await;
    let p = f.open(CELLS[0]).unwrap();
    assert_eq!(p["kind"], "hostKey");
    assert_eq!(p["endpoint"], "web.example:2222");
    assert_eq!(p["keyType"], "ssh-ed25519");
    assert_eq!(p["reason"], "unknown");
    assert_eq!(f.open(CELLS[1]).unwrap()["id"], p["id"]);
    assert!(f.coord.answer(PromptAnswer::HostKey {
        cell_id: CELLS[1].into(),
        prompt_id: p["id"].as_str().unwrap().into(),
        choice: HostKeyChoice::Save
    }));
    until(|| f.rec.sent.lock().iter().filter(|m| matches!(m, HostCommand::HostKeyAnswer { accept: true, .. })).count() == 2)
        .await;
    assert_eq!(f.stores.known_hosts().await.lock().list().len(), 1);
    // A known key is accepted without a question.
    f.connect(2).await.unwrap().unwrap();
    let before = f.rec.prompts.lock().len();
    f.coord.on_host_message(HostMessage::HostKey { id: CELLS[2].into(), prompt_id: "pc".into(), key });
    until(|| {
        f.rec
            .sent
            .lock()
            .iter()
            .any(|m| matches!(m, HostCommand::HostKeyAnswer { prompt_id, accept: true, .. } if prompt_id == "pc"))
    })
    .await;
    assert_eq!(f.rec.prompts.lock().len(), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn allows_only_replace_for_a_changed_key_and_reports_host_key_changed_on_cancel() {
    let f = setup(Opts::default()).await;
    f.stores
        .known_hosts()
        .await
        .lock()
        .trust(
            "web.example",
            2222,
            &unimux_ssh::keys::js::node_base64(&ed25519_blob(1)),
            unimux_ssh::known_hosts::TrustMode::Save,
        )
        .unwrap();
    f.connect(0).await.unwrap().unwrap();
    f.coord.on_host_message(HostMessage::HostKey { id: CELLS[0].into(), prompt_id: "pa".into(), key: ed25519_blob(2) });
    until(|| f.open(CELLS[0]).is_some()).await;
    let p = f.open(CELLS[0]).unwrap();
    assert_eq!(p["reason"], "changed");
    assert_eq!(p["knownFingerprints"].as_array().unwrap().len(), 1);
    let pid = p["id"].as_str().unwrap().to_string();
    assert!(!f.coord.answer(PromptAnswer::HostKey {
        cell_id: CELLS[0].into(),
        prompt_id: pid.clone(),
        choice: HostKeyChoice::Once
    }));
    assert!(f.coord.answer(PromptAnswer::Cancel { cell_id: CELLS[0].into(), prompt_id: pid }));
    until(|| {
        f.rec
            .sent
            .lock()
            .iter()
            .any(|m| matches!(m, HostCommand::HostKeyAnswer { accept: false, error: Some(SshErrorCode::HostKeyChanged), .. }))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn saves_a_typed_password_only_after_the_session_connected_and_only_the_latest_answer() {
    let f = setup(Opts::default()).await;
    f.connect(0).await.unwrap().unwrap();
    let ask = |pid: &str, retry: bool| HostMessage::AuthPrompt {
        id: CELLS[0].into(),
        prompt_id: pid.into(),
        prompt: AuthPromptInfo { kind: AuthPromptKind::Password, name: None, instructions: None, fields: vec![], retry },
    };
    f.coord.on_host_message(ask("a1", false));
    until(|| f.open(CELLS[0]).is_some()).await;
    let p = f.open(CELLS[0]).unwrap();
    assert_eq!(p["kind"], "password");
    assert_eq!(p["user"], "deploy");
    assert_eq!(p["canSave"], true);
    assert!(f.values(0, &p, &["wrong"], true));
    until(|| f.rec.sent.lock().iter().any(|m| matches!(m, HostCommand::AuthAnswer { prompt_id, .. } if prompt_id == "a1"))).await;
    // I1: the retry is answered without "remember": the earlier (wrong) password is not saved.
    f.coord.on_host_message(ask("a2", true));
    until(|| f.open(CELLS[0]).is_some_and(|q| q["id"] != p["id"])).await;
    let q = f.open(CELLS[0]).unwrap();
    assert!(f.values(0, &q, &["right"], false));
    until(|| f.rec.sent.lock().iter().any(|m| matches!(m, HostCommand::AuthAnswer { prompt_id, .. } if prompt_id == "a2"))).await;
    f.coord.on_host_message(HostMessage::Status {
        id: CELLS[0].into(),
        phase: SshPhase::Connected,
        error: None,
        exit_code: None,
        banner: None,
    });
    tick().await;
    assert!(f.stores.vault().await.lock().password(HOST).is_err());

    // A remembered answer is saved once connected.
    f.connect(1).await.unwrap().unwrap();
    f.coord.on_host_message(HostMessage::AuthPrompt {
        id: CELLS[1].into(),
        prompt_id: "b1".into(),
        prompt: AuthPromptInfo { kind: AuthPromptKind::Password, name: None, instructions: None, fields: vec![], retry: false },
    });
    until(|| f.open(CELLS[1]).is_some()).await;
    let p = f.open(CELLS[1]).unwrap();
    assert!(f.values(1, &p, &["secret"], true));
    until(|| f.rec.sent.lock().iter().any(|m| matches!(m, HostCommand::AuthAnswer { prompt_id, .. } if prompt_id == "b1"))).await;
    tick().await;
    assert!(f.stores.vault().await.lock().password(HOST).is_err());
    f.coord.on_host_message(HostMessage::Status {
        id: CELLS[1].into(),
        phase: SshPhase::Connected,
        error: None,
        exit_code: None,
        banner: None,
    });
    let stores = f.stores.clone();
    let vault = stores.vault().await;
    until(|| vault.lock().password(HOST).is_ok()).await;
    assert_eq!(vault.lock().password(HOST).unwrap().as_str(), "secret");
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_a_connect_no_owner_took_and_lets_a_later_one_through() {
    let f = setup(Opts::default()).await;
    f.rec.host_down.store(true, Ordering::SeqCst);
    assert_eq!(f.connect(0).await.unwrap(), Err(SshErrorCode::PtyHostCrashed));
    f.rec.host_down.store(false, Ordering::SeqCst);
    assert_eq!(f.connect(0).await.unwrap(), Ok(()));
    f.rec.host_down.store(true, Ordering::SeqCst);
    let id = "db:00000000-0000-4000-8000-0000000000d1";
    assert_eq!(f.coord.connect_session(id, HOST, false).await, Err(SshErrorCode::DbHostCrashed));
    let id = "sftp:00000000-0000-4000-8000-0000000000d2";
    assert_eq!(f.coord.connect_session(id, HOST, true).await, Err(SshErrorCode::SftpHostCrashed));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancels_an_unanswered_prompt_after_the_timeout() {
    let f = setup(Opts { encrypted_key: true, prompt_timeout: Some(Duration::from_millis(100)), ..Opts::default() }).await;
    assert_eq!(f.connect(0).await.unwrap(), Err(SshErrorCode::Cancelled));
    assert!(f.open(CELLS[0]).is_none());
    assert_eq!(f.last_session().error, Some(SshErrorCode::Cancelled));
}

#[tokio::test(flavor = "multi_thread")]
async fn validates_cells_and_hosts_and_ignores_messages_for_unknown_cells() {
    let f = setup(Opts::default()).await;
    let bad = ConnectCellRequest { cell_id: CELLS[0].into(), host_id: OTHER.into(), cols: 80, rows: 24, restore_cwd: false };
    assert_eq!(f.coord.connect(bad).await, Err(SshErrorCode::HostMissing));
    assert_eq!(f.coord.connect_session("nope", HOST, false).await, Err(SshErrorCode::Unknown));
    assert_eq!(
        f.coord.connect_session("db:00000000-0000-4000-8000-0000000000d1", OTHER.replace('2', "9").as_str(), false).await,
        Err(SshErrorCode::HostMissing)
    );
    assert!(f.coord.on_host_message(HostMessage::Status {
        id: "x".into(),
        phase: SshPhase::Connected,
        error: None,
        exit_code: None,
        banner: None
    }));
    f.coord.on_host_message(HostMessage::HostKey { id: "x".into(), prompt_id: "p".into(), key: ed25519_blob(1) });
    until(|| {
        f.rec
            .sent
            .lock()
            .iter()
            .any(|m| matches!(m, HostCommand::HostKeyAnswer { accept: false, error: Some(SshErrorCode::Cancelled), .. }))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ignores_a_second_connect_and_ends_live_sessions_when_the_owner_crashes() {
    let f = setup(Opts::default()).await;
    f.connect(0).await.unwrap().unwrap();
    f.connect(0).await.unwrap().unwrap();
    assert_eq!(f.connects().len(), 1);
    f.coord.host_crashed();
    let s = f.coord.session_state(CELLS[0]).unwrap();
    assert_eq!((s.phase, s.error), (SshPhase::Error, Some(SshErrorCode::PtyHostCrashed)));
}

#[tokio::test(flavor = "multi_thread")]
async fn passes_the_startup_command_and_prunes_passwords_of_deleted_hosts() {
    let f = setup(Opts::default()).await;
    {
        let mut st = f.state.0.lock();
        let mut s = (**st).clone();
        s["sshHosts"][0]["startupCommand"] = json!("cd /srv\nls\n");
        s["projects"][0]["tabs"][0]["cells"][0]["ssh"]["cwd"] = json!("/var/www");
        *st = Arc::new(s);
    }
    let c = f.coord.clone();
    let req = ConnectCellRequest { cell_id: CELLS[0].into(), host_id: HOST.into(), cols: 80, rows: 24, restore_cwd: true };
    c.connect(req).await.unwrap();
    if let HostCommand::Connect(r) = &f.rec.sent.lock()[0] {
        assert_eq!(r.startup.as_deref(), Some(" cd '/var/www'\rcd /srv\rls\r"));
    }
    let vault = f.stores.vault().await;
    vault.lock().set_password(OTHER, "pw").unwrap();
    let mut s = (*f.state.state()).clone();
    s["sshHosts"].as_array_mut().unwrap().retain(|h| h["id"] != OTHER);
    f.coord.state_changed(&s);
    until(|| vault.lock().password(OTHER).is_err()).await;
    until(|| f.rec.vault_changes.load(Ordering::SeqCst) > 0).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn checks_a_saved_passphrase_once_per_run() {
    let f = setup(Opts { encrypted_key: true, save_passphrase: true, ..Opts::default() }).await;
    f.connect(0).await.unwrap().unwrap();
    f.connect(1).await.unwrap().unwrap();
    assert_eq!(f.checks.load(Ordering::SeqCst), 1);
    assert!(f.rec.prompts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn signs_in_with_the_identity_and_offers_its_password_to_sudo() {
    let f = setup(Opts { identity: true, ..Opts::default() }).await;
    let vault = f.stores.vault().await;
    vault.lock().set_identity_password(IDENTITY, "idpw").unwrap();
    f.connect(0).await.unwrap().unwrap();
    if let HostCommand::Connect(r) = &f.rec.sent.lock()[0] {
        assert_eq!(r.username, "ops");
        assert_eq!(r.password.as_deref().map(String::as_str), Some("idpw"));
    }
    // sudo is asked for SFTP sessions only.
    let sid = "sftp:00000000-0000-4000-8000-0000000000d2";
    f.coord.connect_session(sid, HOST, true).await.unwrap();
    f.coord.on_host_message(HostMessage::AuthPrompt {
        id: sid.into(),
        prompt_id: "s1".into(),
        prompt: AuthPromptInfo { kind: AuthPromptKind::Sudo, name: None, instructions: None, fields: vec![], retry: false },
    });
    until(|| f.open(sid).is_some()).await;
    let p = f.open(sid).unwrap();
    assert_eq!((p["kind"].as_str(), p["canUseSaved"].as_bool()), (Some("sudo"), Some(true)));
    assert!(f.coord.answer(PromptAnswer::Values {
        cell_id: sid.into(),
        prompt_id: p["id"].as_str().unwrap().into(),
        values: vec![Zeroizing::new(String::new())],
        remember: false,
        use_saved: true,
    }));
    until(|| {
        f.rec.sent.lock().iter().any(|m| match m {
            HostCommand::AuthAnswer { prompt_id, values: Some(v), .. } => prompt_id == "s1" && v[0].as_str() == "idpw",
            _ => false,
        })
    })
    .await;
    // A cell never gets a sudo question.
    f.coord.on_host_message(HostMessage::AuthPrompt {
        id: CELLS[0].into(),
        prompt_id: "s2".into(),
        prompt: AuthPromptInfo { kind: AuthPromptKind::Sudo, name: None, instructions: None, fields: vec![], retry: false },
    });
    until(|| {
        f.rec
            .sent
            .lock()
            .iter()
            .any(|m| matches!(m, HostCommand::AuthAnswer { prompt_id, values: None, .. } if prompt_id == "s2"))
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keyboard_prompts_are_sanitized_and_need_one_value_per_field() {
    let f = setup(Opts::default()).await;
    f.connect(0).await.unwrap().unwrap();
    f.coord.on_host_message(HostMessage::AuthPrompt {
        id: CELLS[0].into(),
        prompt_id: "k1".into(),
        prompt: AuthPromptInfo {
            kind: AuthPromptKind::Keyboard,
            name: Some("\x1b[31mOTP".into()),
            instructions: Some("line\r\n".into()),
            fields: vec![PromptField { text: "Code:".into(), echo: true }, PromptField { text: "Pin:".into(), echo: false }],
            retry: false,
        },
    });
    until(|| f.open(CELLS[0]).is_some()).await;
    let p = f.open(CELLS[0]).unwrap();
    assert_eq!(p["name"], "OTP");
    assert_eq!(p["instructions"], "line\n");
    assert!(!f.values(0, &p, &["1"], false));
    assert!(f.values(0, &p, &["1", "2"], false));
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_missing_identity_key_like_a_missing_host_key() {
    let f = setup(Opts { identity: true, ..Opts::default() }).await;
    {
        let mut st = f.state.0.lock();
        let mut s = (**st).clone();
        s["sshIdentities"][0]["keyId"] = json!("00000000-0000-4000-8000-0000000000ee");
        *st = Arc::new(s);
    }
    assert_eq!(f.connect(0).await.unwrap(), Err(SshErrorCode::KeyMissing));
    assert_eq!(f.rec.vault_changes.load(Ordering::SeqCst), 1);
    assert!(f.rec.sent.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_the_owner_for_debug_lines_only_when_main_says_so() {
    let f = setup(Opts::default()).await;
    f.connect(3).await.unwrap().unwrap();
    assert!(matches!(&f.rec.sent.lock()[0], HostCommand::Connect(r) if !r.debug && r.password.is_none()));
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_and_end_session_close_and_forget() {
    let f = setup(Opts::default()).await;
    f.connect(0).await.unwrap().unwrap();
    assert!(!f.coord.on_host_message(HostMessage::Exit { id: CELLS[0].into(), code: 0 }));
    let s = f.coord.session_state(CELLS[0]).unwrap();
    assert_eq!((s.phase, s.exit_code), (SshPhase::Closed, Some(0)));
    let sid = "db:00000000-0000-4000-8000-0000000000d1";
    f.coord.connect_session(sid, HOST, false).await.unwrap();
    assert_eq!(f.coord.session_snapshot(unimux_ssh::session::SessionHostKind::Db)["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(f.coord.sessions()["sessions"].as_array().unwrap().len(), 1);
    f.coord.end_session(sid);
    assert!(f.coord.session_state(sid).is_none());
    assert_eq!(f.last_session().phase, SshPhase::Closed);
}
