//! A6 acceptance: the GitHub token store, the sign-in order, the status cache, the stored-token check and the device flow
//! (ports of test/github-publish.test.ts with a fake fetch, plus the same flows over a real local HTTP server through the
//! app's http_fetch client), the file format 1.1.4 writes, and the 1.1.4 token fixture (SP2, Electron 45.2.2) decrypting.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_accounts::github::api::{
    self, DeviceCode, Endpoints, GithubFetch, NowFn, PollOptions, SleepFn, err, poll_device_token, request_device_code,
};
use unimux_accounts::github::auth::{AuthSource, AuthStatus, GithubAuth, GithubAuthDeps};
use unimux_accounts::github::gh::{Env, ExecFailure, GhExec, GhPlatform};
use unimux_accounts::github::service::GithubService;
use unimux_accounts::github::token_store::GithubTokenStore;
use unimux_accounts::github::{GhFail, git_env};
use unimux_net::{CancellationToken, FetchError, Headers, HttpClient, Request, Response};
use unimux_oscrypt::{Cipher, Origin, SafeCipher, Storage};

const TOKEN: &str = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
const GH_TOKEN: &str = "gho_fromGitHubCli0000000000000000000000";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../unimux-oscrypt/tests/fixtures/win-electron45")
}

fn hex(text: &str) -> Vec<u8> {
    let text = text.trim();
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

/// The throwaway key of the SP2 profile (the DPAPI-unwrapped `Local State` key of 1.1.4's safeStorage).
fn fixture_cipher() -> Arc<dyn SafeCipher> {
    let key: [u8; 32] = hex(&std::fs::read_to_string(fixture_dir().join("key.hex")).unwrap()).try_into().unwrap();
    Arc::new(Cipher::with_gcm_key(key))
}

fn no_cipher() -> Arc<dyn SafeCipher> {
    Arc::new(Cipher::unavailable(Origin::Off))
}

// ---------- fake fetch ----------

#[derive(Debug, Clone)]
struct Seen {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    fn form(&self) -> Vec<(String, String)> {
        url::form_urlencoded::parse(self.body.as_deref().unwrap_or("").as_bytes()).into_owned().collect()
    }
    fn field(&self, name: &str) -> Option<String> {
        self.form().into_iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }
}

enum Answer {
    Ok { status: u16, body: Option<Value>, headers: Vec<(String, String)> },
    Offline,
}

fn ok(status: u16, body: Value) -> Answer {
    Answer::Ok { status, body: Some(body), headers: vec![] }
}

/// A fetch that answers from a list and records every request (`fakeFetch` of the TS test).
#[derive(Default)]
struct FakeFetch {
    answers: Mutex<VecDeque<Answer>>,
    calls: Mutex<Vec<Seen>>,
}

impl FakeFetch {
    fn new(answers: Vec<Answer>) -> Arc<Self> {
        Arc::new(Self { answers: Mutex::new(answers.into()), calls: Mutex::new(vec![]) })
    }
    fn calls(&self) -> Vec<Seen> {
        self.calls.lock().clone()
    }
}

impl GithubFetch for FakeFetch {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>> {
        self.calls.lock().push(Seen {
            url: req.url.to_string(),
            method: req.method.to_string(),
            headers: req.headers.clone(),
            body: req.body.as_ref().map(|b| String::from_utf8_lossy(b).into_owned()),
        });
        let next = self.answers.lock().pop_front();
        let url = req.url.clone();
        Box::pin(async move {
            // A real request always yields at least once (like an `await` in JS).
            tokio::task::yield_now().await;
            match next {
                None | Some(Answer::Offline) => Err(FetchError::Connect("fetch failed".into())),
                Some(Answer::Ok { status, body, headers }) => Ok(Response {
                    status,
                    headers: Headers(headers),
                    url,
                    redirected: false,
                    body: body.map(|b| b.to_string()).unwrap_or_default().into(),
                }),
            }
        })
    }
}

/// `{ deviceCode: 'dev-123', userCode: 'WDJB-MJHT', ..., expiresIn: 900, interval: 5 }`.
fn code() -> DeviceCode {
    DeviceCode {
        device_code: "dev-123".into(),
        user_code: "WDJB-MJHT".into(),
        verification_uri: "https://github.com/login/device".into(),
        expires_in: 900.0,
        interval: 5.0,
    }
}

/// A clock the sleeps advance (ms).
fn clock() -> (Arc<Mutex<f64>>, NowFn) {
    let t = Arc::new(Mutex::new(0.0));
    let c = t.clone();
    (t, Arc::new(move || *c.lock()))
}

fn ticking_sleep(t: Arc<Mutex<f64>>, waits: Arc<Mutex<Vec<u128>>>) -> SleepFn {
    Arc::new(move |d: Duration, _c: CancellationToken| {
        waits.lock().push(d.as_millis());
        *t.lock() += d.as_millis() as f64;
        Box::pin(async {})
    })
}

fn instant_sleep() -> SleepFn {
    Arc::new(|_d: Duration, _c: CancellationToken| Box::pin(async {}))
}

// ---------- device flow ----------

/// "polls at the interval GitHub asks for until the token arrives".
#[tokio::test]
async fn poll_follows_the_interval_until_the_token() {
    let fetch = FakeFetch::new(vec![
        ok(200, json!({"error": "authorization_pending"})),
        ok(200, json!({"error": "slow_down", "interval": 10})),
        Answer::Offline,
        ok(200, json!({"error": "authorization_pending"})),
        ok(200, json!({"access_token": TOKEN, "scope": "repo"})),
    ]);
    let (t, now) = clock();
    let waits = Arc::new(Mutex::new(vec![]));
    let endpoints = Endpoints::default();
    let c = code();
    let result = poll_device_token(PollOptions {
        fetch: fetch.as_ref(),
        endpoints: &endpoints,
        client_id: "Iv1.abc",
        code: &c,
        cancel: CancellationToken::new(),
        now,
        sleep: ticking_sleep(t, waits.clone()),
        max_network_failures: 4,
    })
    .await;
    assert_eq!(result, Ok(TOKEN.to_string()));
    assert_eq!(*waits.lock(), vec![5000, 5000, 10000, 10000, 10000]);
    let calls = fetch.calls();
    assert!(calls.iter().all(|c| c.url == TOKEN_URL && c.method == "POST"));
    assert_eq!(calls[0].field("grant_type").as_deref(), Some("urn:ietf:params:oauth:grant-type:device_code"));
    assert_eq!(calls[0].field("device_code").as_deref(), Some("dev-123"));
    assert_eq!(calls[0].field("client_id").as_deref(), Some("Iv1.abc"));
}

/// "ends when the code expires, the user refuses, the network stays down or the flow is cancelled".
#[tokio::test]
async fn poll_end_states() {
    let endpoints = Endpoints::default();
    let c = code();
    let pending = || FakeFetch::new((0..400).map(|_| ok(200, json!({"error": "authorization_pending"}))).collect());
    let run = |fetch: Arc<FakeFetch>, sleep: SleepFn, now: NowFn, max: u32, cancel: CancellationToken| {
        let endpoints = endpoints.clone();
        let c = c.clone();
        async move {
            poll_device_token(PollOptions {
                fetch: fetch.as_ref(),
                endpoints: &endpoints,
                client_id: "c",
                code: &c,
                cancel,
                now,
                sleep,
                max_network_failures: max,
            })
            .await
        }
    };
    let (t, now) = clock();
    let tick = ticking_sleep(t, Arc::new(Mutex::new(vec![])));
    let expired = run(pending(), tick.clone(), now.clone(), 4, CancellationToken::new()).await;
    assert_eq!(expired.unwrap_err().code, "expired");
    let denied = run(
        FakeFetch::new(vec![ok(200, json!({"error": "access_denied"}))]),
        tick.clone(),
        now.clone(),
        4,
        CancellationToken::new(),
    );
    assert_eq!(denied.await.unwrap_err(), GhFail::new("denied", err::DENIED));
    let offline = run(
        FakeFetch::new(vec![Answer::Offline, Answer::Offline, Answer::Offline]),
        tick.clone(),
        now.clone(),
        3,
        CancellationToken::new(),
    );
    assert_eq!(offline.await.unwrap_err(), GhFail::new("network", err::NETWORK));
    // Cancelled while waiting: the sleep ends early and nothing more is asked.
    let cancel = CancellationToken::new();
    let waits_for_cancel: SleepFn = Arc::new(|_d, c: CancellationToken| Box::pin(async move { c.cancelled().await }));
    let fetch = pending();
    let task = tokio::spawn(run(fetch.clone(), waits_for_cancel, api::real_now(), 4, cancel.clone()));
    tokio::time::sleep(Duration::from_millis(20)).await;
    cancel.cancel();
    assert_eq!(task.await.unwrap().unwrap_err(), GhFail::new("cancelled", err::CANCELLED));
    assert!(fetch.calls().is_empty());
}

/// "asks for a code only with a client id".
#[tokio::test]
async fn device_code_needs_a_client_id() {
    let endpoints = Endpoints::default();
    let none = FakeFetch::new(vec![]);
    assert_eq!(request_device_code(none.as_ref(), &endpoints, "", "repo").await.unwrap_err().code, "no-client");
    assert!(none.calls().is_empty());
    let fetch = FakeFetch::new(vec![ok(
        200,
        json!({"device_code": "d", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "expires_in": 899, "interval": 5}),
    )]);
    let got = request_device_code(fetch.as_ref(), &endpoints, "Iv1.abc", "repo workflow").await.unwrap();
    assert_eq!(
        got,
        DeviceCode {
            device_code: "d".into(),
            user_code: "ABCD-1234".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in: 899.0,
            interval: 5.0
        }
    );
    assert_eq!(fetch.calls()[0].form(), vec![("client_id".into(), "Iv1.abc".into()), ("scope".into(), "repo workflow".into())]);
    assert_eq!(fetch.calls()[0].url, "https://github.com/login/device/code");
    // Missing times fall back to 900 s / 5 s, large ones are capped; a refusal says GitHub's reason.
    let fetch = FakeFetch::new(vec![
        ok(
            200,
            json!({"device_code": "d", "user_code": "U", "verification_uri": "https://github.com/login/device", "expires_in": 99999, "interval": 0}),
        ),
        ok(400, json!({"error": "unauthorized_client", "error_description": "Device Flow must be explicitly enabled"})),
        Answer::Offline,
    ]);
    let capped = request_device_code(fetch.as_ref(), &endpoints, "c", "repo").await.unwrap();
    assert_eq!((capped.expires_in, capped.interval), (3600.0, 5.0));
    assert_eq!(
        request_device_code(fetch.as_ref(), &endpoints, "c", "repo").await.unwrap_err(),
        GhFail::new("failed", err::DEVICE_FAILED).with_detail(Some("Device Flow must be explicitly enabled".into()))
    );
    assert_eq!(request_device_code(fetch.as_ref(), &endpoints, "c", "repo").await.unwrap_err().code, "network");
}

/// "creates the repository with the token in the header only and checks the addresses it gets back", "reads the login".
#[tokio::test]
async fn create_repo_and_login() {
    let endpoints = Endpoints::default();
    let created = json!({"full_name": "ajzak/unimux", "html_url": "https://github.com/ajzak/unimux", "clone_url": "https://github.com/ajzak/unimux.git"});
    let fetch = FakeFetch::new(vec![ok(201, created.clone())]);
    let repo = api::create_repo(fetch.as_ref(), &endpoints, TOKEN, "unimux", true).await.unwrap();
    assert_eq!(repo.clone_url, "https://github.com/ajzak/unimux.git");
    let call = &fetch.calls()[0];
    assert_eq!((call.url.as_str(), call.method.as_str()), ("https://api.github.com/user/repos", "POST"));
    assert_eq!(call.header("Authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(call.body.as_deref(), Some(r#"{"name":"unimux","private":true,"auto_init":false}"#));
    assert!(!call.url.contains(TOKEN));
    let mut odd = created.clone();
    odd["clone_url"] = json!("https://evil.example/x.git");
    let fetch = FakeFetch::new(vec![ok(201, odd), Answer::Offline]);
    assert_eq!(
        api::create_repo(fetch.as_ref(), &endpoints, TOKEN, "unimux", true).await.unwrap_err(),
        GhFail::new("failed", err::FAILED)
    );
    assert_eq!(
        api::create_repo(fetch.as_ref(), &endpoints, TOKEN, "unimux", false).await.unwrap_err(),
        GhFail::new("network", err::NETWORK)
    );

    let fetch =
        FakeFetch::new(vec![ok(200, json!({"login": "ajzak"})), ok(401, json!({})), ok(200, json!({"login": "bad name"}))]);
    assert_eq!(api::fetch_login(fetch.as_ref(), &endpoints, TOKEN).await, Ok("ajzak".into()));
    assert_eq!(api::fetch_login(fetch.as_ref(), &endpoints, TOKEN).await.unwrap_err().code, "auth");
    assert_eq!(
        api::fetch_login(fetch.as_ref(), &endpoints, TOKEN).await.unwrap_err(),
        GhFail::new("failed", err::FAILED).with_detail(Some("HTTP 200".into()))
    );
    assert_eq!(fetch.calls()[0].url, "https://api.github.com/user");
}

// ---------- token store ----------

fn store_at(dir: &Path, cipher: Arc<dyn SafeCipher>) -> GithubTokenStore {
    GithubTokenStore::with_clock(dir.join("github").join("token.json"), cipher, Box::new(|| 1_793_974_277_199))
}

/// "keeps the token sealed on disk, reads it back and forgets it", and the bytes 1.1.4 writes.
#[test]
fn store_seals_reads_and_forgets() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("github").join("token.json");
    let store = store_at(dir.path(), fixture_cipher());
    assert_eq!(store.get(), None);
    assert_eq!(store.set(TOKEN, Some("ajzak")), Ok(true));
    let raw = std::fs::read_to_string(&file).unwrap();
    assert!(!raw.contains(TOKEN));
    let value: Value = serde_json::from_str(&raw).unwrap();
    let secret = value["secret"].as_str().unwrap();
    // JSON.stringify({ version, login, savedAt, secret }, null, 1): 1-space indent, no trailing newline.
    assert_eq!(
        raw,
        format!("{{\n \"version\": 1,\n \"login\": \"ajzak\",\n \"savedAt\": 1793974277199,\n \"secret\": \"{secret}\"\n}}")
    );
    assert!(secret.starts_with("djEw"), "a v10 blob");
    let again = store_at(dir.path(), fixture_cipher());
    assert_eq!(again.get().as_deref(), Some(TOKEN));
    assert_eq!(again.login().as_deref(), Some("ajzak"));
    again.clear();
    assert_eq!(again.get(), None);
    assert_eq!(again.login(), None);
    assert!(!file.exists());
    // A null login is written as null.
    store.set(TOKEN, None).unwrap();
    assert!(std::fs::read_to_string(&file).unwrap().contains("\"login\": null"));
}

/// "without system encryption it keeps the token in memory only".
#[test]
fn store_without_safe_storage_is_memory_only() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("github").join("token.json");
    let store = store_at(dir.path(), no_cipher());
    assert_eq!(store.storage(), Storage::Unavailable);
    assert_eq!(store.set(TOKEN, None), Ok(true));
    assert_eq!(store.get().as_deref(), Some(TOKEN));
    assert!(!file.exists());
    assert_eq!(store_at(dir.path(), no_cipher()).get(), None);
}

/// The fixture cipher with a decrypt that says it started and then waits until the test lets it go.
struct GatedCipher {
    inner: Arc<dyn SafeCipher>,
    entered: std::sync::mpsc::SyncSender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl SafeCipher for GatedCipher {
    fn storage(&self) -> Storage {
        self.inner.storage()
    }
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, unimux_oscrypt::Error> {
        self.inner.encrypt(text)
    }
    fn decrypt(&self, blob: &[u8]) -> Result<zeroize::Zeroizing<String>, unimux_oscrypt::Error> {
        let _ = self.entered.send(());
        let _ = self.release.lock().recv();
        self.inner.decrypt(blob)
    }
}

/// Forgetting a refused token compares and clears in one step: a `set` of a new token (the device flow finishing) that runs
/// at the same time is never wiped, in memory or on disk; a token that is no longer the stored one is not forgotten.
#[test]
fn store_clear_if_keeps_a_token_set_meanwhile() {
    const NEW: &str = "gho_newTokenFromTheDeviceFlow00000000000";
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("github").join("token.json");
    store_at(dir.path(), fixture_cipher()).set(TOKEN, Some("old")).unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(4);
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let cipher: Arc<dyn SafeCipher> =
        Arc::new(GatedCipher { inner: fixture_cipher(), entered: entered_tx, release: Mutex::new(release_rx) });
    // Not cached yet: clear_if has to decrypt, and waits inside its comparison.
    let store = Arc::new(store_at(dir.path(), cipher));
    let forget = std::thread::spawn({
        let store = store.clone();
        move || store.clear_if(TOKEN)
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let set = std::thread::spawn({
        let store = store.clone();
        move || store.set(NEW, Some("new"))
    });
    std::thread::sleep(Duration::from_millis(50));
    release_tx.send(()).unwrap();
    assert!(forget.join().unwrap(), "the old token was still the stored one");
    assert_eq!(set.join().unwrap(), Ok(true));
    assert_eq!(store.get().as_deref(), Some(NEW));
    assert_eq!(store.login().as_deref(), Some("new"));
    assert!(file.exists());
    // The file holds the new token.
    assert_eq!(store_at(dir.path(), fixture_cipher()).get().as_deref(), Some(NEW));
    // A token that is not the stored one any more: nothing is forgotten.
    assert!(!store.clear_if(TOKEN));
    assert_eq!(store.get().as_deref(), Some(NEW));
    assert!(file.exists());
    assert!(store.clear_if(NEW));
    assert_eq!(store.get(), None);
    assert!(!file.exists());
}

/// "refuses text that cannot be a token".
#[test]
fn store_refuses_non_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(dir.path(), fixture_cipher());
    assert_eq!(store.set("has space in it", None), Ok(false));
    assert_eq!(store.set("line\nbreak-token", None), Ok(false));
    assert_eq!(store.get(), None);
}

/// readJsonFile and the version rule: a newer or unreadable file is never written over; an unparsable one is moved aside.
#[test]
fn store_leaves_newer_and_unreadable_files_alone() {
    let dir = tempfile::tempdir().unwrap();
    let gh = dir.path().join("github");
    std::fs::create_dir_all(&gh).unwrap();
    let file = gh.join("token.json");

    let newer = r#"{"version":2,"secret":"x"}"#;
    std::fs::write(&file, newer).unwrap();
    let store = store_at(dir.path(), fixture_cipher());
    assert!(store.read_only());
    assert!(!store.has());
    assert_eq!(store.set(TOKEN, Some("a")), Ok(false));
    assert_eq!(store.get().as_deref(), Some(TOKEN), "kept for this run");
    store.clear();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer);

    for primitive in ["null", "5", "\"text\"", "true"] {
        std::fs::write(&file, primitive).unwrap();
        assert!(store_at(dir.path(), fixture_cipher()).read_only(), "{primitive}");
    }
    // An array is an object to JS: nothing in it, but writable.
    std::fs::write(&file, "[]").unwrap();
    assert!(!store_at(dir.path(), fixture_cipher()).read_only());

    // Unparsable: kept as token.json.bak-<ISO>, and the store writes a new file.
    std::fs::write(&file, "{broken").unwrap();
    let store = store_at(dir.path(), fixture_cipher());
    assert!(!store.read_only());
    assert!(!file.exists());
    let backups: Vec<String> = std::fs::read_dir(&gh)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("token.json.bak-"))
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(gh.join(&backups[0])).unwrap(), "{broken");
    assert_eq!(store.set(TOKEN, None), Ok(true));
    assert!(file.exists());

    // Unreadable (a directory where the file should be): read-only.
    let dir2 = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir2.path().join("github").join("token.json")).unwrap();
    let store = store_at(dir2.path(), fixture_cipher());
    assert!(store.read_only());
    assert_eq!(store.set(TOKEN, None), Ok(false));

    // A secret over 20,000 characters or a login over 100 is ignored; a blob of another key reads as no token.
    std::fs::write(&file, json!({"version": 1, "login": "x".repeat(101), "secret": "a".repeat(20_001)}).to_string()).unwrap();
    let store = store_at(dir.path(), fixture_cipher());
    assert!(!store.has());
    std::fs::write(&file, json!({"version": 1, "login": "ajzak", "secret": "djEwAAAA"}).to_string()).unwrap();
    let store = store_at(dir.path(), fixture_cipher());
    assert!(store.has());
    assert_eq!(store.get(), None);
    assert_eq!(store.login().as_deref(), Some("ajzak"));
}

/// The 1.1.4 token fixture (github/token.json written by unimux 1.1.4 / Electron 45.2.2 on a throwaway profile, SP2)
/// decrypts in place; what Rust writes back is a v10 blob of the same key.
#[test]
fn fixture_token_from_1_1_4_decrypts() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("github")).unwrap();
    let fixture = std::fs::read(fixture_dir().join("electron/github/token.json")).unwrap();
    std::fs::write(dir.path().join("github/token.json"), &fixture).unwrap();
    let expected: Value = serde_json::from_slice(&std::fs::read(fixture_dir().join("expected.json")).unwrap()).unwrap();
    let want = expected["github/token.json"][0].as_str().unwrap();
    let store = GithubTokenStore::new(dir.path().join("github/token.json"), fixture_cipher());
    assert!(!store.read_only());
    assert_eq!(store.get().as_deref(), Some(want));
    assert_eq!(store.login().as_deref(), Some("sp2-spike"));
    // Reading never rewrites the file.
    assert_eq!(std::fs::read(dir.path().join("github/token.json")).unwrap(), fixture);
    // Written back by Rust: another store (1.1.4 reads the same way) decrypts it.
    store.set(want, Some("sp2-spike")).unwrap();
    let again = GithubTokenStore::new(dir.path().join("github/token.json"), fixture_cipher());
    assert_eq!(again.get().as_deref(), Some(want));
}

// ---------- sign-in order ----------

#[derive(Clone, Copy)]
enum Gh<'a> {
    Missing,
    SignedOut,
    Token(&'a str),
}

struct FakeGh {
    mode: String,
    runs: Mutex<Vec<(String, Vec<String>, Env)>>,
}

impl GhExec for FakeGh {
    fn run(&self, file: &str, args: &[&str], _t: Duration, env: &Env) -> BoxFuture<'static, Result<String, ExecFailure>> {
        self.runs.lock().push((file.into(), args.iter().map(|s| s.to_string()).collect(), env.clone()));
        let answer = match self.mode.as_str() {
            "missing" => Err(ExecFailure::NotFound),
            "signed-out" => Err(ExecFailure::Failed),
            token => Ok(format!("{token}\n")),
        };
        Box::pin(async move { answer })
    }
}

struct Setup {
    auth: Arc<GithubAuth>,
    store: Arc<GithubTokenStore>,
    gh: Arc<FakeGh>,
    fetch: Arc<FakeFetch>,
    clock: Arc<Mutex<f64>>,
    _dir: tempfile::TempDir,
}

impl Setup {
    fn runs(&self) -> Vec<String> {
        self.gh.runs.lock().iter().map(|(f, _, _)| f.clone()).collect()
    }
}

fn setup(gh: Gh, client_id: &str, answers: Vec<Answer>) -> Setup {
    setup_with(gh, client_id, answers, instant_sleep())
}

fn setup_with(gh: Gh, client_id: &str, answers: Vec<Answer>, sleep: SleepFn) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(store_at(dir.path(), fixture_cipher()));
    let mode = match gh {
        Gh::Missing => "missing".to_string(),
        Gh::SignedOut => "signed-out".to_string(),
        Gh::Token(t) => t.to_string(),
    };
    let gh = Arc::new(FakeGh { mode, runs: Mutex::new(vec![]) });
    let fetch = FakeFetch::new(answers);
    let (clock, now) = clock();
    let auth = GithubAuth::new(GithubAuthDeps {
        fetch: fetch.clone(),
        endpoints: Endpoints::default(),
        store: store.clone(),
        client_id: client_id.into(),
        exec: gh.clone(),
        env: Arc::new(|| Box::pin(async { vec![("PATH".to_string(), "/bin".to_string()), ("NO_COLOR".into(), "0".into())] })),
        platform: GhPlatform::Mac,
        now,
        sleep,
        max_network_failures: 4,
    });
    Setup { auth, store, gh, fetch, clock, _dir: dir }
}

fn status(signed_in: bool, source: Option<AuthSource>, login: Option<&str>, device_flow: bool) -> AuthStatus {
    AuthStatus { device_flow, storage: Storage::Dpapi, signed_in, source, login: login.map(str::to_string) }
}

/// "uses the stored token first, then the GitHub CLI's, else none".
#[tokio::test]
async fn sign_in_order() {
    let stored = setup(Gh::Token(GH_TOKEN), "", vec![ok(200, json!({"login": "ajzak"}))]);
    stored.store.set(TOKEN, Some("ajzak")).unwrap();
    assert_eq!(stored.auth.token().await, Some((TOKEN.into(), AuthSource::Stored)));
    assert!(stored.runs().is_empty());
    assert_eq!(stored.auth.status(false).await, status(true, Some(AuthSource::Stored), Some("ajzak"), false));

    let gh = setup(Gh::Token(GH_TOKEN), "", vec![ok(200, json!({"login": "cli-user"}))]);
    assert_eq!(gh.auth.token().await, Some((GH_TOKEN.into(), AuthSource::Gh)));
    let (file, args, env) = gh.gh.runs.lock()[0].clone();
    assert_eq!(file, "gh");
    assert_eq!(args, ["auth", "token", "--hostname", "github.com"]);
    // `{ ...env, GH_PROMPT_DISABLED, GH_NO_UPDATE_NOTIFIER, NO_COLOR }`: an existing key keeps its place.
    assert_eq!(
        env,
        vec![
            ("PATH".to_string(), "/bin".to_string()),
            ("NO_COLOR".into(), "1".into()),
            ("GH_PROMPT_DISABLED".into(), "1".into()),
            ("GH_NO_UPDATE_NOTIFIER".into(), "1".into())
        ]
    );
    assert_eq!(gh.auth.status(false).await, status(true, Some(AuthSource::Gh), Some("cli-user"), false));
    assert_eq!(gh.fetch.calls()[0].header("Authorization"), Some(format!("Bearer {GH_TOKEN}").as_str()));

    let none = setup(Gh::Missing, "Iv1.abc", vec![]);
    assert_eq!(none.auth.token().await, None);
    // A missing gh is looked for in the usual places too, and is no error.
    assert_eq!(none.runs(), ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);
    assert_eq!(none.auth.status(false).await, status(false, None, None, true));

    let signed_out = setup(Gh::SignedOut, "", vec![]);
    assert_eq!(signed_out.auth.token().await, None);
    assert_eq!(signed_out.runs().len(), 1);

    // The quick status of the panel's menu looks at the stored sign-in only: no gh, no network.
    let quick = setup(Gh::Token(GH_TOKEN), "", vec![]);
    assert_eq!(quick.auth.status(true).await, status(false, None, None, false));
    assert!(quick.runs().is_empty());
    assert!(quick.fetch.calls().is_empty());
    quick.store.set(TOKEN, Some("ajzak")).unwrap();
    assert_eq!(quick.auth.status(true).await, status(true, Some(AuthSource::Stored), Some("ajzak"), false));

    // gh's output is trimmed and must be token text.
    let odd = setup(Gh::Token("not a token"), "", vec![]);
    assert_eq!(odd.auth.token().await, None);
}

/// "forgets a stored token GitHub refused, and signs out".
#[tokio::test]
async fn rejected_and_sign_out() {
    let s = setup(Gh::Missing, "", vec![]);
    s.store.set(TOKEN, Some("ajzak")).unwrap();
    s.auth.rejected(AuthSource::Stored);
    assert_eq!(s.store.get(), None);
    s.store.set(TOKEN, Some("ajzak")).unwrap();
    s.auth.rejected(AuthSource::Gh);
    assert_eq!(s.store.get().as_deref(), Some(TOKEN));
    let out = s.auth.sign_out().await;
    assert_eq!(out, status(false, None, None, false));
    assert_eq!(s.store.get(), None);
    assert!(!s._dir.path().join("github/token.json").exists());
}

/// "the dialog's status checks a stored token with GitHub and forgets a dead one" (and the 10 minute login cache).
#[tokio::test]
async fn status_checks_and_caches() {
    let dead = setup(Gh::Missing, "", vec![ok(401, json!({"message": "Bad credentials"}))]);
    dead.store.set(TOKEN, Some("ajzak")).unwrap();
    assert_eq!(dead.auth.status(false).await, status(false, None, None, false));
    let call = &dead.fetch.calls()[0];
    assert_eq!(call.url, "https://api.github.com/user");
    assert_eq!(call.header("Authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(dead.store.get(), None);

    // Then the GitHub CLI's sign-in takes over.
    let cli = setup(Gh::Token(GH_TOKEN), "", vec![ok(401, json!({})), ok(200, json!({"login": "cli-user"}))]);
    cli.store.set(TOKEN, Some("ajzak")).unwrap();
    assert_eq!(cli.auth.status(false).await, status(true, Some(AuthSource::Gh), Some("cli-user"), false));

    // A dead gh token: signed out.
    let dead_cli = setup(Gh::Token(GH_TOKEN), "", vec![ok(401, json!({}))]);
    assert_eq!(dead_cli.auth.status(false).await, status(false, None, None, false));

    // A live one shows GitHub's current name, asked once for 10 minutes.
    let live = setup(Gh::Missing, "", vec![ok(200, json!({"login": "renamed"})), ok(200, json!({"login": "again"}))]);
    live.store.set(TOKEN, Some("ajzak")).unwrap();
    assert_eq!(live.auth.status(false).await.login.as_deref(), Some("renamed"));
    *live.clock.lock() += 9.0 * 60_000.0;
    assert_eq!(live.auth.status(false).await.login.as_deref(), Some("renamed"));
    assert_eq!(live.fetch.calls().len(), 1);
    // The quick status of the panel's menu never asks.
    assert_eq!(live.auth.status(true).await.login.as_deref(), Some("ajzak"));
    assert_eq!(live.fetch.calls().len(), 1);
    *live.clock.lock() += 60_000.0;
    assert_eq!(live.auth.status(false).await.login.as_deref(), Some("again"));
    assert_eq!(live.fetch.calls().len(), 2);

    // Offline: still signed in with the saved name, and the unknown answer is remembered too (1.1.4 caches it).
    let offline = setup(Gh::Missing, "", vec![Answer::Offline, ok(200, json!({"login": "x"}))]);
    offline.store.set(TOKEN, Some("ajzak")).unwrap();
    assert_eq!(offline.auth.status(false).await, status(true, Some(AuthSource::Stored), Some("ajzak"), false));
    assert_eq!(offline.auth.status(false).await.login.as_deref(), Some("ajzak"));
    assert_eq!(offline.fetch.calls().len(), 1);
}

/// "a refused fetch, pull or push has the stored token checked: a dead one is forgotten, at most once a minute".
#[tokio::test]
async fn check_stored_once_a_minute() {
    let dead = setup(Gh::Missing, "", vec![ok(401, json!({}))]);
    dead.store.set(TOKEN, Some("ajzak")).unwrap();
    dead.auth.check_stored().await;
    assert_eq!(dead.store.get(), None);

    let live = setup(Gh::Missing, "", vec![ok(200, json!({"login": "ajzak"})), ok(401, json!({}))]);
    live.store.set(TOKEN, Some("ajzak")).unwrap();
    futures::join!(live.auth.check_stored(), live.auth.check_stored());
    live.auth.check_stored().await;
    assert_eq!(live.fetch.calls().len(), 1);
    assert_eq!(live.store.get().as_deref(), Some(TOKEN));
    // A minute later GitHub is asked again (and that answer is fresh, not the cache).
    *live.clock.lock() += 60_000.0;
    live.auth.check_stored().await;
    assert_eq!(live.fetch.calls().len(), 2);
    assert_eq!(live.store.get(), None);

    // Offline: nothing is known, the token stays.
    let offline = setup(Gh::Missing, "", vec![Answer::Offline]);
    offline.store.set(TOKEN, Some("ajzak")).unwrap();
    offline.auth.check_stored().await;
    assert_eq!(offline.store.get().as_deref(), Some(TOKEN));
    // Without a stored token there is nothing to ask.
    let none = setup(Gh::Missing, "", vec![]);
    none.auth.check_stored().await;
    assert!(none.fetch.calls().is_empty());

    // Not awaited (`void auth.checkStored()` of remoteAuthRefused): it still runs.
    let fire = setup(Gh::Missing, "", vec![ok(401, json!({}))]);
    fire.store.set(TOKEN, Some("ajzak")).unwrap();
    drop(fire.auth.check_stored());
    for _ in 0..200 {
        if fire.store.get().is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(fire.store.get(), None);
}

fn device(user: &str, dev: &str, uri: &str) -> Answer {
    ok(200, json!({"device_code": dev, "user_code": user, "verification_uri": uri, "expires_in": 900, "interval": 5}))
}

/// "device flow: a double start polls one code only, a sign-out drops a start still waiting for its code".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_flow_double_start_and_sign_out() {
    let s = setup(
        Gh::Missing,
        "Iv1.abc",
        vec![
            device("AAAA-1111", "d1", "https://github.com/login/device"),
            device("BBBB-2222", "d2", "https://github.com/login/device"),
            ok(200, json!({"access_token": TOKEN})),
            ok(200, json!({"login": "ajzak"})),
        ],
    );
    let (first, second) = futures::join!(s.auth.start_device(), s.auth.start_device());
    // Both asked for a code; the later start is the one polled.
    assert_eq!(first.unwrap_err(), GhFail::new("cancelled", err::CANCELLED));
    let won = second.unwrap();
    assert_eq!(won.user_code, "BBBB-2222");
    let outcome = s.auth.wait_device(&won.flow_id).await.unwrap();
    assert_eq!(outcome, Ok(Some("ajzak".into())));
    let polls: Vec<Seen> = s.fetch.calls().into_iter().filter(|c| c.url == TOKEN_URL).collect();
    assert_eq!(polls.len(), 1);
    let codes = s.fetch.calls().into_iter().filter(|c| c.url.ends_with("/login/device/code")).count();
    assert_eq!(codes, 2);
    assert_eq!(polls[0].field("device_code").as_deref(), Some("d2"));

    let late = setup(Gh::Missing, "Iv1.abc", vec![device("CCCC-3333", "d", "https://github.com/login/device")]);
    // The code arrives only after the sign-out: a gate in the fetch holds it.
    let gate = Arc::new(tokio::sync::Notify::new());
    let gated = Arc::new(GatedFetch { inner: late.fetch.clone(), gate: gate.clone() });
    let late_auth = GithubAuth::new(GithubAuthDeps {
        fetch: gated,
        endpoints: Endpoints::default(),
        store: late.store.clone(),
        client_id: "Iv1.abc".into(),
        exec: late.gh.clone(),
        env: Arc::new(|| Box::pin(async { vec![] })),
        platform: GhPlatform::Mac,
        now: api::real_now(),
        sleep: instant_sleep(),
        max_network_failures: 4,
    });
    let pending = tokio::spawn({
        let a = late_auth.clone();
        async move { a.start_device().await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    late_auth.sign_out().await;
    gate.notify_one();
    assert_eq!(pending.await.unwrap().unwrap_err().code, "cancelled");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(late.fetch.calls().iter().all(|c| c.url != TOKEN_URL));
}

/// Holds every answer until the gate opens.
struct GatedFetch {
    inner: Arc<FakeFetch>,
    gate: Arc<tokio::sync::Notify>,
}

impl GithubFetch for GatedFetch {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>> {
        let answer = self.inner.fetch(req);
        let gate = self.gate.clone();
        Box::pin(async move {
            gate.notified().await;
            answer.await
        })
    }
}

/// "device flow: hidden without a client id, stores the token it gets".
#[tokio::test]
async fn device_flow_stores_the_token() {
    assert_eq!(setup(Gh::Missing, "", vec![]).auth.start_device().await.unwrap_err().code, "no-client");
    let s = setup(
        Gh::Missing,
        "Iv1.abc",
        vec![
            device("ABCD-1234", "d", "https://evil.example/device"),
            ok(200, json!({"error": "authorization_pending"})),
            ok(200, json!({"access_token": TOKEN})),
            ok(200, json!({"login": "ajzak"})),
        ],
    );
    let started = s.auth.start_device().await.unwrap();
    assert_eq!(started.user_code, "ABCD-1234");
    // An address that is not GitHub's own page is replaced by it.
    assert_eq!(started.verification_uri, "https://github.com/login/device");
    assert_eq!(started.expires_in, 900.0);
    assert_eq!(
        started.to_json().as_object().unwrap().keys().collect::<Vec<_>>(),
        ["flowId", "userCode", "verificationUri", "expiresIn"]
    );
    assert_eq!(started.to_json()["expiresIn"], json!(900));
    assert_eq!(
        s.auth.wait_device("00000000-0000-4000-8000-000000000000").await.unwrap(),
        Err(GhFail::new("cancelled", err::CANCELLED))
    );
    assert_eq!(s.auth.wait_device(&started.flow_id).await.unwrap(), Ok(Some("ajzak".into())));
    // A finished flow still answers until the next start or a cancel.
    assert_eq!(s.auth.wait_device(&started.flow_id).await.unwrap(), Ok(Some("ajzak".into())));
    assert_eq!(s.store.get().as_deref(), Some(TOKEN));
    assert_eq!(s.store.login().as_deref(), Some("ajzak"));
    s.auth.cancel_device(Some(&started.flow_id));
    assert_eq!(s.auth.wait_device(&started.flow_id).await.unwrap().unwrap_err().code, "cancelled");
}

/// A cancel by id stops that flow only; the renderer's ids are checked (`isFlowId`).
#[tokio::test]
async fn device_cancel_by_id_and_handlers() {
    let waits_for_cancel: SleepFn = Arc::new(|_d, c: CancellationToken| Box::pin(async move { c.cancelled().await }));
    let s = setup_with(
        Gh::Missing,
        "Iv1.abc",
        vec![device("ABCD-1234", "d", "https://github.com/login/device")]
            .into_iter()
            .chain((0..50).map(|_| ok(200, json!({"error": "authorization_pending"}))))
            .collect(),
        waits_for_cancel,
    );
    let service = GithubService { store: s.store.clone(), auth: s.auth.clone() };
    let started = service.device_start().await;
    assert_eq!(started["ok"], json!(true));
    let flow_id = started["data"]["flowId"].as_str().unwrap().to_string();
    // A wrong id cancels nothing; a non-id answers cancelled at once.
    service.device_cancel(&json!("00000000-0000-4000-8000-000000000000"));
    service.device_cancel(&json!(42));
    assert_eq!(
        service.device_wait(&json!("not-a-flow")).await.unwrap(),
        json!({"ok": false, "code": "cancelled", "error": err::CANCELLED})
    );
    let waiting = tokio::spawn({
        let auth = s.auth.clone();
        let id = flow_id.clone();
        async move { auth.wait_device(&id).await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!waiting.is_finished());
    service.device_cancel(&json!(flow_id));
    assert_eq!(waiting.await.unwrap().unwrap(), Err(GhFail::new("cancelled", err::CANCELLED)));
    // status(options): only `{ local: true }` is the quick status.
    for (options, quick) in
        [(json!(null), false), (json!({"local": true}), true), (json!({"local": "yes"}), false), (json!([true]), false)]
    {
        let before = s.fetch.calls().len();
        s.store.set(TOKEN, Some("ajzak")).unwrap();
        let st = service.status(&options).await;
        assert_eq!(st["signedIn"], json!(true));
        assert_eq!(s.fetch.calls().len() == before, quick, "{options}");
        s.auth.rejected(AuthSource::Stored);
    }
    let out = service.sign_out().await;
    assert_eq!(
        serde_json::to_string(&out).unwrap(),
        r#"{"deviceFlow":true,"storage":"dpapi","signedIn":false,"source":null,"login":null}"#
    );
}

/// remoteAuth: the stored sign-in as the git header, or none.
#[test]
fn remote_auth_env() {
    let s = setup(Gh::Missing, "", vec![]);
    let service = GithubService { store: s.store.clone(), auth: s.auth.clone() };
    assert_eq!(service.remote_auth(), None);
    s.store.set(TOKEN, None).unwrap();
    assert_eq!(service.remote_auth(), Some(git_env::github_git_env(TOKEN, git_env::GITHUB_ORIGIN)));
}

// ---------- against a mock GitHub over HTTP (the app's http_fetch client) ----------

#[derive(Debug, Clone)]
struct Got {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Got {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

type Route = Arc<dyn Fn(&Got) -> (u16, String) + Send + Sync>;

/// A local HTTP/1.1 server that records every request and answers with `route`.
async fn mock_github(route: Route) -> (String, Arc<Mutex<Vec<Got>>>) {
    use http_body_util::{BodyExt, Full};
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let (route, log) = (route.clone(), log.clone());
            tokio::spawn(async move {
                let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                    let (route, log) = (route.clone(), log.clone());
                    async move {
                        let method = req.method().to_string();
                        let path = req.uri().path().to_string();
                        let headers = req
                            .headers()
                            .iter()
                            .map(|(n, v)| (n.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                            .collect();
                        let body = req.into_body().collect().await.unwrap().to_bytes();
                        let got = Got { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() };
                        let (status, text) = route(&got);
                        log.lock().push(got);
                        let mut res = hyper::Response::new(Full::new(bytes::Bytes::from(text)));
                        *res.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
                        res.headers_mut().insert("content-type", "application/json".parse().unwrap());
                        Ok::<_, std::convert::Infallible>(res)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    });
    (format!("http://{addr}"), seen)
}

/// The device flow end to end over HTTP: code, two pending polls, token, login, stored on disk; status then reads the
/// stored sign-in; the exact header sets of 1.1.4 (api.ts formHeaders / apiHeaders) reach the server.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn device_flow_against_a_mock_server() {
    let polls = Arc::new(Mutex::new(0));
    let p = polls.clone();
    let route: Route = Arc::new(move |got: &Got| {
        match got.path.as_str() {
        "/login/device/code" => (
            200,
            json!({"device_code": "dc-1", "user_code": "WDJB-MJHT", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 1}).to_string(),
        ),
        "/login/oauth/access_token" => {
            let mut n = p.lock();
            *n += 1;
            if *n < 3 {
                (200, json!({"error": "authorization_pending"}).to_string())
            } else {
                (200, json!({"access_token": TOKEN, "token_type": "bearer", "scope": "repo"}).to_string())
            }
        }
        "/user" if got.header("authorization") == Some(&format!("Bearer {TOKEN}")) => {
            (200, json!({"login": "ajzak"}).to_string())
        }
        "/user" => (401, json!({"message": "Bad credentials"}).to_string()),
        _ => (404, "{}".into()),
    }
    });
    let (base, seen) = mock_github(route).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(GithubTokenStore::new(dir.path().join("github/token.json"), fixture_cipher()));
    let service = GithubService::from_deps(GithubAuthDeps {
        fetch: Arc::new(HttpClient::new().unwrap()),
        endpoints: Endpoints::local(&base),
        store: store.clone(),
        client_id: "Iv1.mock".into(),
        exec: Arc::new(FakeGh { mode: "missing".into(), runs: Mutex::new(vec![]) }),
        env: Arc::new(|| Box::pin(async { vec![] })),
        platform: GhPlatform::Windows,
        now: api::real_now(),
        // Real waits, shortened: the interval is 1 s, waited 10 ms here.
        sleep: Arc::new(|d: Duration, c: CancellationToken| {
            Box::pin(async move {
                tokio::select! { _ = tokio::time::sleep(d / 100) => {}, _ = c.cancelled() => {} }
            })
        }),
        max_network_failures: 4,
    });
    let started = service.device_start().await;
    assert_eq!(started["ok"], json!(true), "{started}");
    assert_eq!(started["data"]["userCode"], "WDJB-MJHT");
    let flow_id = started["data"]["flowId"].clone();
    let done = service.device_wait(&flow_id).await.unwrap();
    assert_eq!(done, json!({"ok": true, "data": {"login": "ajzak"}}));
    assert_eq!(store.get().as_deref(), Some(TOKEN));
    let on_disk = std::fs::read_to_string(dir.path().join("github/token.json")).unwrap();
    assert!(!on_disk.contains(TOKEN));
    assert!(on_disk.contains("\"login\": \"ajzak\""));

    let status = service.status(&json!(null)).await;
    assert_eq!(status, json!({"deviceFlow": true, "storage": "dpapi", "signedIn": true, "source": "stored", "login": "ajzak"}));

    let seen = seen.lock().clone();
    let paths: Vec<&str> = seen.iter().map(|g| g.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/login/device/code",
            "/login/oauth/access_token",
            "/login/oauth/access_token",
            "/login/oauth/access_token",
            "/user",
            "/user"
        ]
    );
    // Only GitHub's header sets: no library Accept, User-Agent or Accept-Encoding.
    let names = |g: &Got| {
        let mut n: Vec<String> = g.headers.iter().map(|(k, _)| k.to_ascii_lowercase()).collect();
        n.sort();
        n
    };
    assert_eq!(names(&seen[0]), ["accept", "content-length", "content-type", "host", "user-agent"]);
    assert_eq!(seen[0].method, "POST");
    assert_eq!(seen[0].header("accept"), Some("application/json"));
    assert_eq!(seen[0].header("content-type"), Some("application/x-www-form-urlencoded"));
    assert_eq!(seen[0].header("user-agent"), Some("unimux"));
    assert_eq!(seen[0].body, "client_id=Iv1.mock&scope=repo");
    assert_eq!(
        seen[1].body,
        "client_id=Iv1.mock&device_code=dc-1&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
    );
    assert_eq!(names(&seen[4]), ["accept", "authorization", "host", "user-agent", "x-github-api-version"]);
    assert_eq!(seen[4].method, "GET");
    assert_eq!(seen[4].header("accept"), Some("application/vnd.github+json"));
    assert_eq!(seen[4].header("x-github-api-version"), Some("2022-11-28"));
    assert!(seen.iter().all(|g| !g.path.contains(TOKEN)));
}

/// Status and the stored check over HTTP: a revoked stored token (401) is forgotten and the file removed; a server that does
/// not answer JSON leaves the token alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stored_token_checks_against_a_mock_server() {
    let route: Route = Arc::new(|got: &Got| match got.header("authorization") {
        Some(a) if a.ends_with("revoked0000000000") => (401, json!({"message": "Bad credentials"}).to_string()),
        _ => (502, "<html>bad gateway</html>".into()),
    });
    let (base, seen) = mock_github(route).await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("github/token.json");
    let store = Arc::new(GithubTokenStore::new(&file, fixture_cipher()));
    let service = GithubService::from_deps(GithubAuthDeps {
        fetch: Arc::new(HttpClient::new().unwrap()),
        endpoints: Endpoints::local(&base),
        store: store.clone(),
        client_id: String::new(),
        exec: Arc::new(FakeGh { mode: "missing".into(), runs: Mutex::new(vec![]) }),
        env: Arc::new(|| Box::pin(async { vec![] })),
        platform: GhPlatform::Other,
        now: api::real_now(),
        sleep: instant_sleep(),
        max_network_failures: 4,
    });
    store.set("gho_working0000000000", Some("ajzak")).unwrap();
    service.auth.check_stored().await;
    assert_eq!(store.get().as_deref(), Some("gho_working0000000000"), "a 502 says nothing about the token");
    assert_eq!(
        service.status(&json!({})).await,
        json!({"deviceFlow": false, "storage": "dpapi", "signedIn": true, "source": "stored", "login": "ajzak"})
    );
    store.set("gho_revoked0000000000", Some("ajzak")).unwrap();
    assert!(file.exists());
    assert_eq!(
        service.status(&json!({})).await,
        json!({"deviceFlow": false, "storage": "dpapi", "signedIn": false, "source": null, "login": null})
    );
    assert!(!file.exists());
    assert_eq!(seen.lock().len(), 2, "the 502 answer was remembered for that token");
}

/// "every message main sends for publishing is translated": each key is a key of src/shared/githubMessages.ts (the renderer's
/// tr() table, which test/i18n.test.ts checks for all six languages); the device flow asks for "repo" only.
#[test]
fn every_message_key_is_translated() {
    let table =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/shared/githubMessages.ts")).unwrap();
    for key in err::ALL {
        assert!(table.contains(&format!("'{key}': [")), "{key}");
    }
    assert_eq!(unimux_accounts::github::GITHUB_DEVICE_SCOPE, "repo");
    assert_eq!(unimux_accounts::github::GITHUB_OAUTH_CLIENT_ID, "", "1.1.4 has no OAuth App: the device flow stays hidden");
}

// ---------- publishing (G3) ----------

/// A lab for publishing with real git: the https address of the created repository leads to a local bare repository
/// (`insteadOf` in the lab's global configuration), so github.com is never contacted.
struct PublishLab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    env: std::collections::HashMap<std::ffi::OsString, std::ffi::OsString>,
}

const DEMO_URL: &str = "https://github.com/ajzak/demo.git";

impl PublishLab {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("mc-ghpub-rs-").tempdir().unwrap();
        let dir = PathBuf::from(unimux_git::paths::realpath_native(&tmp.path().to_string_lossy()).unwrap());
        let bare = dir.join("demo.git").to_string_lossy().replace('\\', "/");
        let global = dir.join("global.gitconfig");
        std::fs::write(
            &global,
            format!(
                "[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[url \"{bare}\"]\n\tinsteadOf = {DEMO_URL}\n"
            ),
        )
        .unwrap();
        let mut env: std::collections::HashMap<std::ffi::OsString, std::ffi::OsString> = std::env::vars_os().collect();
        for (k, v) in [("GIT_CONFIG_GLOBAL", global.into_os_string()), ("GIT_CONFIG_NOSYSTEM", "1".into())] {
            env.retain(|key, _| !key.to_string_lossy().eq_ignore_ascii_case(k));
            env.insert(k.into(), v);
        }
        let lab = PublishLab { _tmp: tmp, dir, env };
        lab.sh(&lab.dir, &["init", "-q", "--bare", "-b", "main", &bare]);
        lab
    }

    fn sh(&self, cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(&self.env)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn repo(&self, name: &str, commits: usize) -> String {
        let dir = self.dir.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        self.sh(&dir, &["init", "-q", "-b", "main", "."]);
        for i in 1..=commits {
            std::fs::write(dir.join("file.txt"), format!("line {i}\n")).unwrap();
            self.sh(&dir, &["add", "."]);
            self.sh(&dir, &["commit", "-q", "-m", &format!("commit {i}")]);
        }
        dir.to_string_lossy().into_owned()
    }

    fn git(&self) -> Arc<unimux_git::Git> {
        Arc::new(unimux_git::Git::new(unimux_git::GitOptions { env: Some(self.env.clone()), ..Default::default() }))
    }
}

fn created() -> Answer {
    ok(201, json!({"full_name": "ajzak/demo", "html_url": "https://github.com/ajzak/demo", "clone_url": DEMO_URL}))
}

/// test/github-publish.test.ts "publishing": creates the repository, adds it as origin and pushes the branch; refuses before
/// creating anything when the repository is not ready; says why GitHub refused (with test/github-git.test.ts's real git).
#[tokio::test]
async fn publishing_creates_the_repository_adds_origin_and_pushes() {
    use unimux_accounts::github::publish::{PublishRequest, Publisher, publish_err};
    let lab = PublishLab::new();
    let req = |name: &str| PublishRequest {
        request_id: format!("req-{name}-000001"),
        name: name.into(),
        private: true,
        worktree: None,
    };

    let s = setup(Gh::Token(GH_TOKEN), "", vec![created()]);
    let publisher = Publisher::new(lab.git(), s.auth.clone());
    let work = lab.repo("work", 2);
    let answer = publisher.publish(&work, &work, &req("demo")).await;
    assert_eq!(
        answer,
        json!({"ok": true, "data": {"fullName": "ajzak/demo", "htmlUrl": "https://github.com/ajzak/demo", "branch": "main"}})
    );
    let calls = s.fetch.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "POST");
    assert!(calls[0].url.ends_with("/user/repos"));
    assert_eq!(calls[0].header("authorization"), Some(format!("Bearer {GH_TOKEN}").as_str()));
    assert_eq!(lab.sh(Path::new(&work), &["config", "--get", "remote.origin.url"]).trim(), DEMO_URL);
    assert_eq!(
        lab.sh(&lab.dir.join("demo.git"), &["rev-parse", "refs/heads/main"]).trim(),
        lab.sh(Path::new(&work), &["rev-parse", "HEAD"]).trim()
    );
    // it has a remote now: refused before GitHub is asked
    let again = publisher.publish(&work, &work, &req("demo2")).await;
    assert_eq!(again["code"], "remote-exists");
    assert_eq!(s.fetch.calls().len(), 1);

    // not ready: no commit yet, or a detached HEAD
    let empty = lab.repo("empty", 0);
    let answer = publisher.publish(&empty, &empty, &req("x-empty")).await;
    assert_eq!(answer, json!({"ok": false, "code": "no-commits", "error": publish_err::NO_COMMITS}));
    let detached = lab.repo("detached", 2);
    lab.sh(Path::new(&detached), &["checkout", "-q", "--detach", "HEAD~1"]);
    assert_eq!(publisher.publish(&detached, &detached, &req("x-detached")).await["code"], "detached");
    assert_eq!(s.fetch.calls().len(), 1);

    // a repository above the project folder answers like a refused write
    let inner = Path::new(&work).join("sub");
    std::fs::create_dir(&inner).unwrap();
    let inner = inner.to_string_lossy().into_owned();
    assert_eq!(publisher.publish(&inner, &inner, &req("x-inner")).await["code"], "parent");

    // GitHub refuses the sign-in: its answer, and nothing is added
    let refused = setup(Gh::Token(GH_TOKEN), "", vec![ok(401, json!({"message": "Bad credentials"}))]);
    let publisher = Publisher::new(lab.git(), refused.auth.clone());
    let fresh = lab.repo("fresh", 1);
    assert_eq!(publisher.publish(&fresh, &fresh, &req("fresh")).await["code"], "auth");
    assert_eq!(lab.sh(Path::new(&fresh), &["remote"]).trim(), "");

    // no sign-in at all
    let none = setup(Gh::SignedOut, "", vec![]);
    let publisher = Publisher::new(lab.git(), none.auth.clone());
    assert_eq!(
        publisher.publish(&fresh, &fresh, &req("fresh2")).await,
        json!({"ok": false, "code": "auth", "error": publish_err::SIGN_IN})
    );

    // the IPC half: a missing project and an invalid request
    assert_eq!(publisher.handle(None, &json!({}), &[]).await["code"], "gone");
    assert_eq!(publisher.handle(Some(&fresh), &json!({"name": "x"}), &[]).await["code"], "invalid");
}

/// test/github-publish.test.ts "publishing": GitHub's refusal is said and a stored token it no longer accepts is forgotten; a failed push or remote keeps the address of the repository that now
/// exists; one publish per repository at a time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publishing_failures_keep_the_address_forget_a_refused_stored_token_and_run_once_per_repository() {
    use unimux_accounts::github::publish::{PublishRequest, Publisher, publish_err};
    let req = |name: &str| PublishRequest {
        request_id: format!("req-{name}-000001"),
        name: name.into(),
        private: true,
        worktree: None,
    };
    let lab = PublishLab::new();

    // A stored token GitHub refuses (401) is forgotten; a taken name and no network are said as such; nothing is added.
    let s = setup(Gh::Missing, "", vec![ok(401, json!({"message": "Bad credentials"}))]);
    s.store.set(TOKEN, Some("ajzak")).unwrap();
    let publisher = Publisher::new(lab.git(), s.auth.clone());
    let work = lab.repo("refused", 1);
    assert_eq!(publisher.publish(&work, &work, &req("refused")).await["code"], "auth");
    assert_eq!(s.store.get(), None);
    let taken =
        setup(Gh::Token(GH_TOKEN), "", vec![ok(422, json!({"errors": [{"message": "name already exists on this account"}]}))]);
    assert_eq!(Publisher::new(lab.git(), taken.auth.clone()).publish(&work, &work, &req("refused")).await["code"], "exists");
    let offline = setup(Gh::Token(GH_TOKEN), "", vec![Answer::Offline]);
    assert_eq!(Publisher::new(lab.git(), offline.auth.clone()).publish(&work, &work, &req("refused")).await["code"], "network");
    assert_eq!(lab.sh(Path::new(&work), &["remote"]).trim(), "");

    // The push is refused by the server: push-failed with git's text and the address of the created repository.
    let hook = lab.dir.join("demo.git").join("hooks").join("pre-receive");
    std::fs::write(&hook, "#!/bin/sh\necho 'Permission denied for this test' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let s = setup(Gh::Token(GH_TOKEN), "", vec![created()]);
    let pushing = lab.repo("pushing", 1);
    let answer = Publisher::new(lab.git(), s.auth.clone()).publish(&pushing, &pushing, &req("pushing")).await;
    assert_eq!(answer["code"], "push-failed", "{answer}");
    assert_eq!(answer["error"], publish_err::PUSH_FAILED);
    assert_eq!(answer["url"], "https://github.com/ajzak/demo");
    assert!(answer["detail"].as_str().unwrap().contains("Permission denied for this test"), "{answer}");
    std::fs::remove_file(&hook).unwrap();

    // origin cannot be added (the configuration is locked): remote-failed, with the address.
    let s = setup(Gh::Token(GH_TOKEN), "", vec![created()]);
    let locked = lab.repo("locked", 1);
    std::fs::write(Path::new(&locked).join(".git").join("config.lock"), "").unwrap();
    let answer = Publisher::new(lab.git(), s.auth.clone()).publish(&locked, &locked, &req("locked")).await;
    assert_eq!(answer["code"], "remote-failed", "{answer}");
    assert_eq!(answer["error"], publish_err::REMOTE_FAILED);
    assert_eq!(answer["url"], "https://github.com/ajzak/demo");

    // Two publishes of one repository at once: the second is refused as busy, the first completes.
    let s = setup(Gh::Token(GH_TOKEN), "", vec![created()]);
    let publisher = Publisher::new(lab.git(), s.auth.clone());
    let once = lab.repo("once", 1);
    let request = req("once");
    let (first, second) = tokio::join!(publisher.publish(&once, &once, &request), publisher.publish(&once, &once, &request));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(second, json!({"ok": false, "code": "busy", "error": publish_err::BUSY}));
    assert_eq!(s.fetch.calls().len(), 1);
}

// ---------- the header with real git (test/github-git.test.ts) ----------

/// An HTTP "GitHub" that refuses every request (401 + Basic challenge) and records the Authorization header of each.
fn refusing_git_server() -> (String, Arc<Mutex<Vec<Option<String>>>>) {
    use std::io::{Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut head = Vec::new();
            let mut buf = [0u8; 4096];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => head.extend_from_slice(&buf[..n]),
                }
            }
            let text = String::from_utf8_lossy(&head).into_owned();
            let auth = text.lines().find_map(|l| {
                let (name, value) = l.split_once(':')?;
                name.trim().eq_ignore_ascii_case("authorization").then(|| value.trim().to_string())
            });
            log.lock().push(auth);
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"github\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    });
    (origin, seen)
}

/// The sign-in as git's network runs see it: the real header environment; a refusal is what git says without a prompt.
#[derive(Debug)]
struct HeaderAuth {
    env: Vec<(String, String)>,
    retry: bool,
    reports: std::sync::atomic::AtomicUsize,
}

impl unimux_git::RemoteAuth for HeaderAuth {
    fn env(&self) -> Option<Vec<(String, String)>> {
        Some(self.env.clone())
    }
    fn auth_refused(&self, message: &str) -> bool {
        self.retry && message.contains("could not read Username")
    }
    fn token_refused(&self, message: &str) -> bool {
        self.auth_refused(message)
    }
    fn refused(&self) {
        self.reports.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// test/github-git.test.ts: the push carries the token as one header in git's environment and no command line ever holds it
/// (every git process is traced with GIT_TRACE2_EVENT); a refused header is retried once without it and its owner told; and
/// while the header is sent git neither asks the user's credential helper nor makes it erase its credential (without the
/// helper reset it does both).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn git_sends_the_header_from_its_environment_only_retries_without_it_and_leaves_the_users_helper_alone() {
    use base64::Engine as _;
    let (origin, seen) = refusing_git_server();
    let tmp = tempfile::Builder::new().prefix("mc-ghgit-rs-").tempdir().unwrap();
    let dir = PathBuf::from(unimux_git::paths::realpath_native(&tmp.path().to_string_lossy()).unwrap());
    let slash = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let helper_log = dir.join("helper.log");
    let trace = dir.join("trace2.json");
    let global = dir.join("global.gitconfig");
    std::fs::write(
        &global,
        format!(
            "[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[url \"{origin}/\"]\n\tinsteadOf = https://github.com/\n[credential]\n\thelper = \"!f() {{ echo \\\"$1\\\" >> '{log}'; if [ \\\"$1\\\" = get ]; then echo username=user; echo password=secret; fi; cat >/dev/null; }}; f\"\n",
            log = slash(&helper_log)
        ),
    )
    .unwrap();
    let mut env: std::collections::HashMap<std::ffi::OsString, std::ffi::OsString> = std::env::vars_os().collect();
    for (k, v) in [
        ("GIT_CONFIG_GLOBAL", global.clone().into_os_string()),
        ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ("HOME", dir.clone().into_os_string()),
        ("USERPROFILE", dir.clone().into_os_string()),
        ("GIT_TRACE2_EVENT", trace.clone().into_os_string()),
    ] {
        env.retain(|key, _| !key.to_string_lossy().eq_ignore_ascii_case(k));
        env.insert(k.into(), v);
    }
    let sh = |cwd: &Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(&env)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    sh(&work, &["init", "-q", "-b", "main", "."]);
    std::fs::write(work.join("file.txt"), "line\n").unwrap();
    sh(&work, &["add", "."]);
    sh(&work, &["commit", "-q", "-m", "first"]);
    let w = work.to_string_lossy().into_owned();
    let asked = || std::fs::read_to_string(&helper_log).unwrap_or_default().lines().map(str::to_string).collect::<Vec<_>>();
    let header = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{TOKEN}"));
    let token_env = git_env::github_git_env(TOKEN, &origin);
    let auth = |env: Vec<(String, String)>, retry: bool| {
        Arc::new(HeaderAuth { env, retry, reports: std::sync::atomic::AtomicUsize::new(0) })
    };
    let git_with = |auth: Option<Arc<HeaderAuth>>| {
        unimux_git::Git::new(unimux_git::GitOptions {
            env: Some(env.clone()),
            remote_auth: auth.map(|a| a as Arc<dyn unimux_git::RemoteAuth>),
            ..Default::default()
        })
    };

    // Publishing: origin is added and the push carries the header; GitHub refuses, git cannot prompt, the helper is untouched.
    let git = git_with(None);
    let pushed = git.publish_push(&w, "req-push-000001", DEMO_URL, "main", token_env.clone(), Some(&w)).await.unwrap();
    assert!(!pushed.pushed);
    assert!(pushed.message.contains("could not read Username"), "{}", pushed.message);
    assert_eq!(*seen.lock(), [Some(format!("basic {header}"))]);
    assert_eq!(asked(), Vec::<String>::new());
    let traced = std::fs::read_to_string(&trace).unwrap();
    assert!(traced.contains("\"push\""), "every git process is traced");
    assert!(!traced.contains(TOKEN) && !traced.contains(&header), "no command line holds the token");

    // A fetch: the header first; refused, the same fetch once more without it (the user's helper gets its try), owner told.
    seen.lock().clear();
    let signed = auth(token_env.clone(), true);
    let git = git_with(Some(signed.clone()));
    assert!(git.fetch(&w, "req-fetch-000001", Some(&w)).await.is_err());
    assert_eq!(signed.reports.load(std::sync::atomic::Ordering::SeqCst), 1);
    let requests = seen.lock().clone();
    assert_eq!(requests[0], Some(format!("basic {header}")));
    assert!(requests.len() > 1 && requests[1..].iter().all(|a| a.as_deref() != Some(&format!("basic {header}"))), "{requests:?}");
    assert_eq!(asked(), ["get", "erase"], "only the run without the header asked the helper");

    // The check of the check: without the helper reset git asks the helper and makes it erase a credential it never sent.
    std::fs::remove_file(&helper_log).unwrap();
    let mut no_reset = token_env.clone();
    for (k, v) in no_reset.iter_mut() {
        if k == "GIT_CONFIG_COUNT" {
            *v = "1".into();
        }
    }
    let git = git_with(Some(auth(no_reset, false)));
    assert!(git.fetch(&w, "req-fetch-000002", Some(&w)).await.is_err());
    assert_eq!(asked(), ["get", "erase"]);
    assert!(!std::fs::read_to_string(&trace).unwrap().contains(TOKEN));
}
