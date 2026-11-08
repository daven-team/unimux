//! Ports of test/mac-update-engine.test.ts for the 1.2.0 engine, on a scratch file system: a fake installed `unimux.app`, a
//! signed `.app.tar.gz` served over loopback HTTP, fake system tools (ditto copies, codesign answers as told), and the swap of
//! the update window run on the real files.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering as AtomicOrdering};

use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::mac::swap::{self, SwapOps};
use crate::mac::target::tests::FakeTargetFs;

// ── scratch tree ─────────────────────────────────────────────────────────────

/// The scratch folder lives on the drive of the working directory, so the POSIX paths the engine works with (it derives the
/// bundle from `/…/unimux.app/Contents/MacOS/unimux` like on macOS) resolve on Windows too.
fn scratch() -> tempfile::TempDir {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/u5-tests");
    fs::create_dir_all(&base).unwrap();
    tempfile::tempdir_in(base).unwrap()
}

/// `D:\a\b` -> `/a/b` (Windows resolves a rooted path on the current drive); unchanged on Unix.
fn posix(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    match text.as_bytes() {
        [_, b':', ..] => text[2..].to_string(),
        _ => text,
    }
}

fn info_plist(version: &str, identifier: &str, executable: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n\
         <key>CFBundleExecutable</key>\n<string>{executable}</string>\n\
         <key>CFBundleIdentifier</key>\n<string>{identifier}</string>\n\
         <key>CFBundleShortVersionString</key>\n<string>{version}</string>\n</dict></plist>\n"
    )
}

fn write_exe(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn make_app(bundle: &Path, version: &str, identifier: &str, exe_content: &str) {
    fs::create_dir_all(bundle.join("Contents")).unwrap();
    fs::write(bundle.join("Contents/Info.plist"), info_plist(version, identifier, "unimux")).unwrap();
    write_exe(&bundle.join("Contents/MacOS/unimux"), exe_content);
}

/// The `.app.tar.gz` the release builds: `unimux.app/` at the top.
fn tar_gz_of(apps: &[(&str, &str, &str)]) -> Vec<u8> {
    let tmp = scratch();
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    for (name, version, identifier) in apps {
        let bundle = tmp.path().join(name);
        make_app(&bundle, version, identifier, "new");
        builder.append_dir_all(name, &bundle).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

struct Keys {
    pk: minisign::PublicKey,
    sk: minisign::SecretKey,
}

impl Keys {
    fn new() -> Self {
        let kp = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        Self { pk: kp.pk, sk: kp.sk }
    }
    fn public_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.pk.to_box().unwrap().into_string())
    }
    fn sign_b64(&self, data: &[u8]) -> String {
        let sig = minisign::sign(Some(&self.pk), &self.sk, Cursor::new(data), None, None).unwrap();
        base64::engine::general_purpose::STANDARD.encode(sig.into_string())
    }
}

// ── fakes ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct FakeTools {
    calls: Mutex<Vec<String>>,
    codesign: Mutex<Option<ExecResult>>,
    /// `ditto <src> <dst>` fails.
    copy_fails: Mutex<bool>,
    /// plutil converts this file's content.
    plutil: Mutex<HashMap<String, String>>,
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        if e.file_type()?.is_dir() {
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        } else {
            fs::copy(e.path(), to.join(e.file_name()))?;
        }
    }
    Ok(())
}

impl MacTools for FakeTools {
    fn exec(&self, program: &str, args: &[String], _timeout: Duration) -> ExecResult {
        self.calls.lock().unwrap().push(format!("{program} {}", args.join(" ")));
        let ok = ExecResult { code: Some(0), ..Default::default() };
        match program {
            "/usr/bin/ditto" if args.len() == 2 => {
                if *self.copy_fails.lock().unwrap() {
                    return ExecResult { code: Some(1), stderr: "ditto: no space".into(), ..Default::default() };
                }
                match copy_tree(Path::new(&args[0]), Path::new(&args[1])) {
                    Ok(()) => ok,
                    Err(e) => ExecResult { code: Some(1), stderr: e.to_string(), ..Default::default() },
                }
            }
            "/usr/bin/codesign" => self.codesign.lock().unwrap().clone().unwrap_or(ok),
            "/usr/bin/plutil" => match self.plutil.lock().unwrap().get(args.last().unwrap()) {
                Some(xml) => ExecResult { code: Some(0), stdout: xml.clone(), ..Default::default() },
                None => ExecResult { code: Some(1), ..Default::default() },
            },
            _ => ok,
        }
    }
}

struct Env {
    tmp: tempfile::TempDir,
    keys: Keys,
    tools: Arc<FakeTools>,
    now: Arc<AtomicI64>,
    fs: Arc<FakeTargetFs>,
    packaged: bool,
    current: String,
    trusted: Vec<String>,
    stall: Duration,
    total: Duration,
}

impl Env {
    fn new() -> Self {
        let tmp = scratch();
        make_app(&tmp.path().join("Applications/unimux.app"), "1.2.0", "com.ajzakomator.app", "old");
        Self {
            tmp,
            keys: Keys::new(),
            tools: Arc::new(FakeTools::default()),
            now: Arc::new(AtomicI64::new(1_762_500_000_000)),
            fs: Arc::new(FakeTargetFs::owned(501)),
            packaged: true,
            current: "1.2.0".into(),
            trusted: vec![],
            stall: MAC_DOWNLOAD_STALL,
            total: MAC_DOWNLOAD_TOTAL,
        }
    }
    fn bundle(&self) -> PathBuf {
        self.tmp.path().join("Applications/unimux.app")
    }
    fn bundle_posix(&self) -> String {
        posix(&self.bundle())
    }
    fn data(&self) -> PathBuf {
        self.tmp.path().join("data")
    }
    fn updater(&self) -> Arc<MacUpdater> {
        let now = self.now.clone();
        MacUpdater::new(MacUpdaterDeps {
            arch: "arm64".into(),
            current_version: self.current.clone(),
            exec_path: format!("{}/Contents/MacOS/unimux", self.bundle_posix()),
            packaged: self.packaged,
            update_dir: PathBuf::from(posix(&self.data().join("updates/mac"))),
            fs: self.fs.clone(),
            tools: self.tools.clone(),
            now: Arc::new(move || now.load(AtomicOrdering::SeqCst)),
            log: None,
            trusted_origins: self.trusted.clone(),
            public_key: self.keys.public_b64(),
            stall: self.stall,
            total: self.total,
        })
    }
    fn mac_dir(&self) -> PathBuf {
        self.data().join("updates/mac")
    }
    fn log(&self) -> String {
        fs::read_to_string(self.mac_dir().join("update.log")).unwrap_or_default()
    }
    fn names(&self, dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|e| e.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}

fn feed(version: &str, url: &str, signature: &str) -> Value {
    serde_json::json!({
        "version": version,
        "notes": "",
        "pub_date": "2026-11-07T00:00:00Z",
        "platforms": {
            "darwin-aarch64": { "signature": signature, "url": url },
            "darwin-x86_64": { "signature": "x64sig", "url": url.replace("arm64", "x64") },
            "windows-x86_64": { "signature": "w", "url": "https://github.com/daven-team/unimux/releases/download/v1.2.1/unimux-Setup-1.2.1.exe" }
        }
    })
}

const GH: &str = "https://github.com/daven-team/unimux/releases/download/v1.2.1/unimux-1.2.1-mac-arm64.app.tar.gz";

// ── loopback server ─────────────────────────────────────────────────────────

#[derive(Clone)]
enum Answer {
    Body(Vec<u8>),
    Status(u16),
    /// Headers announcing `len` bytes, `prefix` sent, then silence.
    Stall {
        prefix: Vec<u8>,
        len: usize,
    },
    /// Headers announcing `len` bytes, then `piece` bytes every `every` (never silent for long, never done).
    Trickle {
        len: usize,
        piece: usize,
        every: Duration,
    },
    /// Headers announcing more than is sent, then the connection closes.
    Truncated {
        body: Vec<u8>,
        len: usize,
    },
    /// A body per request path (filled in once the origin is known); 404 for anything else.
    Routes(Arc<Mutex<HashMap<String, Vec<u8>>>>),
}

struct Server {
    origin: String,
    hits: Arc<AtomicUsize>,
}

async fn serve(answer: Answer) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let count = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            count.fetch_add(1, AtomicOrdering::SeqCst);
            let answer = answer.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let head = |status: u16, len: usize| {
                    format!("HTTP/1.1 {status} X\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n").into_bytes()
                };
                let path = String::from_utf8_lossy(&request).split(' ').nth(1).unwrap_or("").to_string();
                match answer {
                    Answer::Routes(routes) => {
                        let body = routes.lock().unwrap().get(&path).cloned();
                        match body {
                            Some(body) => {
                                let _ = socket.write_all(&head(200, body.len())).await;
                                let _ = socket.write_all(&body).await;
                            }
                            None => {
                                let _ = socket.write_all(&head(404, 0)).await;
                            }
                        }
                    }
                    Answer::Body(body) => {
                        let _ = socket.write_all(&head(200, body.len())).await;
                        for piece in body.chunks(64 * 1024) {
                            let _ = socket.write_all(piece).await;
                        }
                    }
                    Answer::Status(code) => {
                        let _ = socket.write_all(&head(code, 0)).await;
                    }
                    Answer::Stall { prefix, len } => {
                        let _ = socket.write_all(&head(200, len)).await;
                        let _ = socket.write_all(&prefix).await;
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                    Answer::Trickle { len, piece, every } => {
                        let _ = socket.write_all(&head(200, len)).await;
                        let mut sent = 0;
                        while sent + piece < len {
                            if socket.write_all(&vec![0u8; piece]).await.is_err() {
                                return;
                            }
                            sent += piece;
                            tokio::time::sleep(every).await;
                        }
                    }
                    Answer::Truncated { body, len } => {
                        let _ = socket.write_all(&head(200, len)).await;
                        let _ = socket.write_all(&body).await;
                    }
                }
                let _ = socket.shutdown().await;
            });
        }
    });
    Server { origin, hits }
}

fn offer_for(env: &Env, server: &Server, archive: &[u8]) -> MacOffer {
    MacOffer {
        version: "1.2.1".into(),
        name: "unimux-1.2.1-mac-arm64.app.tar.gz".into(),
        url: format!("{}/unimux-1.2.1-mac-arm64.app.tar.gz", server.origin),
        signature: env.keys.sign_b64(archive),
        refusal: None,
    }
}

async fn download(env: &Env, offer: &MacOffer) -> (Result<MacStaged, String>, Vec<MacProgress>) {
    let client = HttpClient::new().unwrap();
    let mut seen = Vec::new();
    let result = env.updater().download(&client, offer, &mut |p| seen.push(p), &CancellationToken::new()).await;
    (result, seen)
}

// ── check ─────────────────────────────────────────────────────────────────────

#[test]
fn offers_the_newer_version_with_the_archive_of_this_architecture() {
    let env = Env::new();
    let result = env.updater().check(&feed("1.2.1", GH, "sig")).unwrap();
    let offer = result.offer.unwrap();
    assert_eq!(result.latest, "1.2.1");
    assert_eq!(offer.name, "unimux-1.2.1-mac-arm64.app.tar.gz");
    assert_eq!(offer.url, GH);
    assert_eq!(offer.signature, "sig");
    assert_eq!(offer.refusal, None);
    // The `-app` entry wins over the plain one, like tauri-plugin-updater.
    let mut both = feed("1.2.1", GH, "plain");
    both["platforms"]["darwin-aarch64-app"] = serde_json::json!({ "signature": "app", "url": GH });
    assert_eq!(env.updater().check(&both).unwrap().offer.unwrap().signature, "app");
}

#[test]
fn picks_the_x64_archive_on_intel() {
    let env = Env::new();
    let mut deps = MacUpdaterDeps::for_app(&env.data(), "1.2.0", true, vec![]);
    deps.arch = "x64".into();
    deps.exec_path = format!("{}/Contents/MacOS/unimux", env.bundle_posix());
    deps.fs = env.fs.clone();
    let offer = MacUpdater::new(deps).check(&feed("1.2.1", GH, "s")).unwrap().offer.unwrap();
    assert_eq!(offer.name, "unimux-1.2.1-mac-x64.app.tar.gz");
    assert_eq!(offer.signature, "x64sig");
}

#[test]
fn reports_current_for_the_same_or_an_older_version() {
    let env = Env::new();
    for version in ["1.2.0", "1.1.4", "1.2.0-test.1"] {
        let result = env.updater().check(&feed(version, GH, "s")).unwrap();
        assert_eq!(result, MacCheckResult { latest: version.into(), offer: None });
    }
}

#[test]
fn fails_clearly_without_an_archive_for_this_mac_or_with_a_bad_feed() {
    let env = Env::new();
    let mut none = feed("1.2.1", GH, "s");
    none["platforms"].as_object_mut().unwrap().remove("darwin-aarch64");
    assert_eq!(env.updater().check(&none).unwrap_err(), messages::NO_ASSET);
    assert!(env.log().contains("the feed lists no archive for arm64 (version 1.2.1)"));
    // Outside GitHub, a name of another version or architecture, or no signature: not offered.
    for url in [
        "https://evil.example/unimux-1.2.1-mac-arm64.app.tar.gz",
        "http://github.com/daven-team/unimux/releases/download/v1.2.1/unimux-1.2.1-mac-arm64.app.tar.gz",
        "https://github.com/daven-team/unimux/releases/download/v1.2.1/unimux-1.2.0-mac-arm64.app.tar.gz",
        "https://github.com/daven-team/unimux/releases/download/v1.2.1/unimux-1.2.1-mac-x64.app.tar.gz",
        "https://github.com/daven-team/unimux/releases/download/v1.2.1/..%2Funimux-1.2.1-mac-arm64.app.tar.gz",
    ] {
        assert_eq!(env.updater().check(&feed("1.2.1", url, "s")).unwrap_err(), messages::NO_ASSET, "{url}");
    }
    assert_eq!(env.updater().check(&feed("1.2.1", GH, " ")).unwrap_err(), messages::NO_ASSET);
    assert_eq!(env.updater().check(&serde_json::json!({ "version": "v1.2.1" })).unwrap_err(), messages::BAD_FEED);
    assert_eq!(env.updater().check(&serde_json::json!({})).unwrap_err(), messages::BAD_FEED);
}

#[test]
fn flags_an_offer_the_app_cannot_install_itself_and_says_why() {
    let mut env = Env::new();
    env.packaged = false;
    let offer = env.updater().check(&feed("1.2.1", GH, "s")).unwrap().offer.unwrap();
    assert_eq!(offer.refusal, Some(MacRefusal::NotBundle));
    assert!(env.log().contains("but this app is not replaced in place: not-bundle"));
    let mut env = Env::new();
    let mut fs_ = FakeTargetFs::owned(501);
    fs_.owners.insert(env.bundle_posix(), 0);
    env.fs = Arc::new(fs_);
    assert_eq!(env.updater().check(&feed("1.2.1", GH, "s")).unwrap().offer.unwrap().refusal, Some(MacRefusal::NotOwner));
}

// ── download, verify, stage ───────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn downloads_verifies_the_signature_unpacks_and_stages_next_to_the_app() {
    let mut env = Env::new();
    let archive = tar_gz_of(&[("unimux.app", "1.2.1", "com.ajzakomator.app")]);
    let server = serve(Answer::Body(archive.clone())).await;
    env.trusted = vec![server.origin.clone()];
    // A leftover of another version and a stale staged copy go.
    fs::create_dir_all(env.mac_dir()).unwrap();
    fs::write(env.mac_dir().join("unimux-1.1.9-mac-arm64.app.tar.gz.part"), "x").unwrap();
    fs::create_dir_all(env.bundle().with_file_name("unimux.app.new-1.1.9")).unwrap();
    let offer = offer_for(&env, &server, &archive);
    let (result, progress) = download(&env, &offer).await;
    let staged = result.unwrap();
    assert_eq!(staged.version, "1.2.1");
    assert_eq!(staged.bundle, format!("{}.new-1.2.1", env.bundle_posix()));
    assert_eq!(staged.executable, "unimux");
    assert_eq!(fs::read_to_string(env.bundle().with_file_name("unimux.app.new-1.2.1/Contents/MacOS/unimux")).unwrap(), "new");
    assert_eq!(progress.last().unwrap().percent, 100.0);
    assert_eq!(progress.last().unwrap().transferred, archive.len() as u64);
    // The progress only grows while the data arrives.
    assert!(progress.windows(2).all(|w| w[0].percent <= w[1].percent && w[0].transferred <= w[1].transferred), "{progress:?}");
    // The verified archive stays (cleanup after the swap), the unpacked copy is gone, nothing else is left.
    assert_eq!(env.names(&env.mac_dir()), ["unimux-1.2.1-mac-arm64.app.tar.gz", "update.log"]);
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app", "unimux.app.new-1.2.1"]);
    let calls = env.tools.calls.lock().unwrap().join("\n");
    assert!(calls.contains("/usr/bin/xattr -cr"), "{calls}");
    assert!(calls.contains(&format!("/usr/bin/codesign --verify --deep --strict {}.new-1.2.1", env.bundle_posix())), "{calls}");
    assert!(env.log().contains("update 1.2.1 downloaded, verified and staged at"));
    assert_eq!(server.hits.load(AtomicOrdering::SeqCst), 1);

    // The verified archive on disk is reused, without downloading again.
    let (again, progress) = download(&env, &offer).await;
    again.unwrap();
    assert_eq!(server.hits.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(progress.len(), 1);
    assert!(env.log().contains("reusing the verified archive unimux-1.2.1-mac-arm64.app.tar.gz"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_an_archive_whose_signature_does_not_match_and_leaves_nothing() {
    let mut env = Env::new();
    let archive = tar_gz_of(&[("unimux.app", "1.2.1", "com.ajzakomator.app")]);
    let server = serve(Answer::Body(archive.clone())).await;
    env.trusted = vec![server.origin.clone()];
    // Signed by another key.
    let mut offer = offer_for(&env, &server, &archive);
    offer.signature = Keys::new().sign_b64(&archive);
    assert_eq!(download(&env, &offer).await.0.unwrap_err(), messages::VERIFY);
    // The right key over other bytes.
    offer.signature = env.keys.sign_b64(b"something else");
    assert_eq!(download(&env, &offer).await.0.unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("does not match"));
    // Not a signature at all.
    offer.signature = "bm90IGEgc2lnbmF0dXJl".into();
    assert_eq!(download(&env, &offer).await.0.unwrap_err(), messages::VERIFY);
    assert_eq!(env.names(&env.mac_dir()), ["update.log"]);
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app"]);
    // A damaged archive on disk is not reused: it is downloaded again.
    fs::write(env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz"), "damaged").unwrap();
    let good = offer_for(&env, &server, &archive);
    download(&env, &good).await.0.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_errors_truncation_stalls_and_cancels() {
    let mut env = Env::new();
    let archive = tar_gz_of(&[("unimux.app", "1.2.1", "com.ajzakomator.app")]);

    let missing = serve(Answer::Status(404)).await;
    env.trusted = vec![missing.origin.clone()];
    assert_eq!(download(&env, &offer_for(&env, &missing, &archive)).await.0.unwrap_err(), messages::SERVER);
    assert!(env.log().contains("HTTP 404"));

    let cut = serve(Answer::Truncated { body: archive[..archive.len() / 2].to_vec(), len: archive.len() }).await;
    env.trusted = vec![cut.origin.clone()];
    let err = download(&env, &offer_for(&env, &cut, &archive)).await.0.unwrap_err();
    assert!(err == messages::SERVER || err == messages::DAMAGED, "{err}");

    let silent = serve(Answer::Stall { prefix: archive[..100].to_vec(), len: archive.len() }).await;
    env.trusted = vec![silent.origin.clone()];
    env.stall = Duration::from_millis(400);
    assert_eq!(download(&env, &offer_for(&env, &silent, &archive)).await.0.unwrap_err(), messages::STALLED);
    assert!(env.log().contains("the download stalled or took too long"));

    // Cancelled while the server is silent: the cancel message, not a failure.
    env.stall = Duration::from_secs(20);
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stopper.cancel();
    });
    let client = HttpClient::new().unwrap();
    let offer = offer_for(&env, &silent, &archive);
    let started = Instant::now();
    let result = env.updater().download(&client, &offer, &mut |_| {}, &cancel).await;
    assert_eq!(result.unwrap_err(), DOWNLOAD_CANCELLED);
    assert!(started.elapsed() < Duration::from_secs(10));
    // No partial file is ever left.
    assert_eq!(env.names(&env.mac_dir()), ["update.log"]);

    // An address outside GitHub (the development origin not configured) is refused before any request.
    env.trusted = vec![];
    let ok = serve(Answer::Body(archive.clone())).await;
    assert_eq!(download(&env, &offer_for(&env, &ok, &archive)).await.0.unwrap_err(), messages::SERVER);
    assert_eq!(ok.hits.load(AtomicOrdering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_total_download_time_is_capped_even_when_bytes_keep_coming() {
    let mut env = Env::new();
    let archive = tar_gz_of(&[("unimux.app", "1.2.1", "com.ajzakomator.app")]);
    // A chunk every 100 ms keeps the stall limit (2 s) from ever firing; the total (500 ms) ends it.
    let slow = serve(Answer::Trickle { len: 10 * 1024 * 1024, piece: 512, every: Duration::from_millis(100) }).await;
    env.trusted = vec![slow.origin.clone()];
    env.stall = Duration::from_secs(2);
    env.total = Duration::from_millis(500);
    let started = Instant::now();
    assert_eq!(download(&env, &offer_for(&env, &slow, &archive)).await.0.unwrap_err(), messages::STALLED);
    let took = started.elapsed();
    assert!(took >= Duration::from_millis(450) && took < Duration::from_millis(1900), "{took:?}");
    assert!(env.log().contains("the download stalled or took too long"));
    // No partial file is left.
    assert_eq!(env.names(&env.mac_dir()), ["update.log"]);
}

#[test]
fn a_cancel_during_staging_stops_after_the_unpack_and_before_the_copy() {
    let env = Env::new();
    let archive = tar_gz_of(&[("unimux.app", "1.2.1", "com.ajzakomator.app")]);
    fs::create_dir_all(env.mac_dir()).unwrap();
    let path = PathBuf::from(posix(&env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz")));
    fs::write(&path, archive).unwrap();
    // An older staged copy next to the app: a cancelled staging must not touch it.
    make_app(&env.bundle().with_file_name("unimux.app.new-1.2.0"), "1.2.0", "com.ajzakomator.app", "staged");
    let copies = |env: &Env| env.tools.calls.lock().unwrap().iter().filter(|c| c.starts_with("/usr/bin/ditto ")).count();

    // Cancelled while unpacking: nothing after the unpack runs.
    let err = env.updater().stage_archive_until("1.2.1", &path, &|| true).unwrap_err();
    assert_eq!(err, DOWNLOAD_CANCELLED);
    assert!(env.tools.calls.lock().unwrap().is_empty(), "{:?}", env.tools.calls.lock().unwrap());

    // Cancelled during the quick bundle check: no install target check, no sibling removal, no copy, no deep codesign.
    let checks = AtomicUsize::new(0);
    let err =
        env.updater().stage_archive_until("1.2.1", &path, &|| checks.fetch_add(1, AtomicOrdering::SeqCst) >= 1).unwrap_err();
    assert_eq!(err, DOWNLOAD_CANCELLED);
    assert_eq!(checks.load(AtomicOrdering::SeqCst), 2);
    assert_eq!(copies(&env), 0);
    assert!(!env.tools.calls.lock().unwrap().iter().any(|c| c.contains("--deep")));
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app", "unimux.app.new-1.2.0"]);

    // Not cancelled: the same archive stages as before.
    env.updater().stage_archive_until("1.2.1", &path, &|| false).unwrap();
    assert_eq!(copies(&env), 1);
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app", "unimux.app.new-1.2.1"]);
}

fn stage_with(env: &Env, apps: &[(&str, &str, &str)]) -> Result<MacStaged, String> {
    let archive = tar_gz_of(apps);
    fs::create_dir_all(env.mac_dir()).unwrap();
    let path = PathBuf::from(posix(&env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz")));
    fs::write(&path, archive).unwrap();
    env.updater().stage_archive("1.2.1", &path)
}

#[test]
fn bundle_verification() {
    let env = Env::new();
    // Another version inside the archive, another app, several or no bundles.
    assert_eq!(stage_with(&env, &[("unimux.app", "1.2.2", "com.ajzakomator.app")]).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("verification failed: version 1.2.2 instead of 1.2.1"));
    assert_eq!(stage_with(&env, &[("unimux.app", "1.2.1", "com.example.other")]).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("identifier com.example.other does not match the running app"));
    assert_eq!(
        stage_with(&env, &[("unimux.app", "1.2.1", "com.ajzakomator.app"), ("other.app", "1.2.1", "com.ajzakomator.app")])
            .unwrap_err(),
        messages::VERIFY
    );
    assert!(env.log().contains("the archive holds 2 app bundles, expected 1"));
    // The identifier from before the rebranding and the current one are the same app.
    stage_with(&env, &[("unimux.app", "1.2.1", "com.unimux.app")]).unwrap();
    // Nothing unverified was ever copied next to the app, and failed copies are gone.
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app", "unimux.app.new-1.2.1"]);
}

#[test]
fn rejects_a_missing_or_badly_named_executable() {
    let env = Env::new();
    let updater = env.updater();
    let bundle = env.tmp.path().join("x.app");
    make_app(&bundle, "1.2.1", "com.unimux.app", "new");
    let b = posix(&bundle);
    assert_eq!(updater.verify_bundle(&b, "1.2.1", false).unwrap(), "unimux");
    fs::write(bundle.join("Contents/Info.plist"), info_plist("1.2.1", "com.unimux.app", "../unimux")).unwrap();
    assert_eq!(updater.verify_bundle(&b, "1.2.1", false).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("no valid CFBundleExecutable"));
    fs::write(bundle.join("Contents/Info.plist"), info_plist("1.2.1", "com.unimux.app", "missing")).unwrap();
    assert_eq!(updater.verify_bundle(&b, "1.2.1", false).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("the executable missing is missing"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(bundle.join("Contents/Info.plist"), info_plist("1.2.1", "com.unimux.app", "unimux")).unwrap();
        fs::set_permissions(bundle.join("Contents/MacOS/unimux"), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(updater.verify_bundle(&b, "1.2.1", false).unwrap_err(), messages::VERIFY);
        assert!(env.log().contains("the executable unimux is not executable"));
    }
}

#[test]
fn the_code_signature_decides_and_a_missing_codesign_is_noted() {
    let env = Env::new();
    let bundle = env.tmp.path().join("x.app");
    make_app(&bundle, "1.2.1", "com.unimux.app", "new");
    let b = posix(&bundle);
    *env.tools.codesign.lock().unwrap() =
        Some(ExecResult { code: Some(1), stderr: "x.app: code object is not signed at all".into(), ..Default::default() });
    assert_eq!(env.updater().verify_bundle(&b, "1.2.1", true).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("verification failed: codesign: x.app: code object is not signed at all"));
    // A staged copy that fails the signature check is removed.
    assert_eq!(stage_with(&env, &[("unimux.app", "1.2.1", "com.unimux.app")]).unwrap_err(), messages::VERIFY);
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app"]);
    *env.tools.codesign.lock().unwrap() = Some(ExecResult { code: None, missing: true, ..Default::default() });
    assert_eq!(env.updater().verify_bundle(&b, "1.2.1", true).unwrap(), "unimux");
    assert!(env.log().contains("codesign is not available, the signature was not checked"));
}

#[test]
fn reads_a_binary_info_plist_through_plutil() {
    let env = Env::new();
    let bundle = env.tmp.path().join("x.app");
    make_app(&bundle, "1.2.1", "com.unimux.app", "new");
    fs::write(bundle.join("Contents/Info.plist"), b"bplist00\x01\x02").unwrap();
    let path = format!("{}/Contents/Info.plist", posix(&bundle));
    env.tools.plutil.lock().unwrap().insert(path, info_plist("1.2.1", "com.unimux.app", "unimux"));
    assert_eq!(env.updater().verify_bundle(&posix(&bundle), "1.2.1", false).unwrap(), "unimux");
    let calls = env.tools.calls.lock().unwrap().join("\n");
    assert!(calls.contains("/usr/bin/plutil -convert xml1 -o -"), "{calls}");
}

#[test]
fn staging_refusals_copy_nothing_and_a_failed_copy_is_removed() {
    let mut env = Env::new();
    let mut locked = FakeTargetFs::owned(501);
    locked.denied.insert(posix(env.bundle().parent().unwrap()), 13);
    env.fs = Arc::new(locked);
    assert_eq!(stage_with(&env, &[("unimux.app", "1.2.1", "com.unimux.app")]).unwrap_err(), MacRefusal::NotWritable.message());
    assert!(env.log().contains("staging refused: not-writable"));
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app"]);

    let env = Env::new();
    *env.tools.copy_fails.lock().unwrap() = true;
    assert_eq!(stage_with(&env, &[("unimux.app", "1.2.1", "com.unimux.app")]).unwrap_err(), messages::EXTRACT);
    assert!(env.log().contains("ditto copy failed (1): ditto: no space"));
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app"]);
    // Not an archive at all.
    fs::write(env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz"), "not gzip").unwrap();
    let path = PathBuf::from(posix(&env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz")));
    assert_eq!(env.updater().stage_archive("1.2.1", &path).unwrap_err(), messages::EXTRACT);
}

#[test]
fn a_ditto_zip_is_unpacked_with_ditto() {
    let env = Env::new();
    fs::create_dir_all(env.mac_dir()).unwrap();
    let zip = PathBuf::from(posix(&env.mac_dir().join("unimux-1.2.1-mac-arm64.zip")));
    fs::write(&zip, "zip").unwrap();
    // The fake ditto -x -k unpacks nothing: no bundle in the archive.
    assert_eq!(env.updater().stage_archive("1.2.1", &zip).unwrap_err(), messages::VERIFY);
    let calls = env.tools.calls.lock().unwrap().join("\n");
    assert!(calls.contains(&format!("/usr/bin/ditto -x -k {}", posix(&zip))), "{calls}");
}

// ── install ───────────────────────────────────────────────────────────────────

fn staged(env: &Env) -> MacStaged {
    stage_with(env, &[("unimux.app", "1.2.1", "com.ajzakomator.app")]).unwrap()
}

#[test]
fn install_checks_again_writes_the_marker_and_returns_the_swap() {
    let env = Env::new();
    let staged = staged(&env);
    let MacInstall::Ready(plan) = env.updater().install(&staged).unwrap() else { panic!("refused") };
    assert_eq!(plan.bundle, PathBuf::from(env.bundle_posix()));
    assert_eq!(plan.new_bundle, PathBuf::from(&staged.bundle));
    assert_eq!(plan.backup, PathBuf::from(format!("{}.old-1.2.0", env.bundle_posix())));
    assert_eq!(plan.cleanup, [staged.extract_dir.clone(), staged.archive.clone()]);
    assert_eq!((plan.from_version.as_str(), plan.to_version.as_str()), ("1.2.0", "1.2.1"));
    assert!(plan.ready_flag.ends_with("updates/mac/ready") && plan.failed_flag.ends_with("updates/mac/rolled-back"));
    let marker = fs::read_to_string(env.mac_dir().join("pending.json")).unwrap();
    assert_eq!(
        marker,
        format!(
            r#"{{"from":"1.2.0","to":"1.2.1","at":1762500000000,"bundle":"{0}","backup":"{0}.old-1.2.0"}}"#,
            env.bundle_posix()
        )
    );
    // The probe file is gone again.
    assert!(!env.bundle().join("Contents/.unimux-write-probe").exists());
    // The window could not be started: no marker stays.
    assert_eq!(env.updater().abandon_install(), messages::SPAWN);
    assert!(!env.mac_dir().join("pending.json").exists());
}

#[test]
fn install_refuses_an_app_it_can_no_longer_replace() {
    let mut env = Env::new();
    let staged = staged(&env);
    let mut admin = FakeTargetFs::owned(501);
    admin.owners.insert(env.bundle_posix(), 0);
    env.fs = Arc::new(admin);
    assert_eq!(env.updater().install(&staged).unwrap(), MacInstall::Refused(MacRefusal::NotOwner));
    // macOS denies writing into the bundle (App Management): the probe cannot create its file.
    let env = Env::new();
    let staged = super::tests::staged(&env);
    fs::create_dir_all(env.bundle().join("Contents/.unimux-write-probe")).unwrap();
    assert_eq!(env.updater().install(&staged).unwrap(), MacInstall::Refused(MacRefusal::AppManagement));
    assert!(env.log().contains("App Management permission?"));
    assert!(!env.mac_dir().join("pending.json").exists());
}

#[test]
fn install_aborts_when_the_staged_app_disappeared_moved_or_changed() {
    let env = Env::new();
    let good = staged(&env);
    let mut moved = good.clone();
    moved.bundle = format!("{}/elsewhere.app", posix(env.tmp.path()));
    assert_eq!(env.updater().install(&moved).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("the staged app is not next to the installed one"));
    let mut renamed = good.clone();
    renamed.executable = "other".into();
    assert_eq!(env.updater().install(&renamed).unwrap_err(), messages::VERIFY);
    fs::write(Path::new(&good.bundle).join("Contents/Info.plist"), info_plist("1.2.1", "com.ajzakomator.app", "unimux2"))
        .unwrap();
    write_exe(&Path::new(&good.bundle).join("Contents/MacOS/unimux2"), "x");
    assert_eq!(env.updater().install(&good).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("the staged executable changed"));
    fs::remove_dir_all(&good.bundle).unwrap();
    assert_eq!(env.updater().install(&good).unwrap_err(), messages::VERIFY);
    assert!(env.log().contains("install aborted: the staged app is missing"));
    assert!(!env.mac_dir().join("pending.json").exists());
}

// ── after the swap ────────────────────────────────────────────────────────────

fn write_marker(env: &Env, to: &str, at: i64) {
    fs::create_dir_all(env.mac_dir()).unwrap();
    let marker = PendingMarker {
        from: "1.2.0".into(),
        to: to.into(),
        at,
        bundle: env.bundle_posix(),
        backup: format!("{}.old-1.2.0", env.bundle_posix()),
    };
    fs::write(env.mac_dir().join("pending.json"), serde_json::to_string(&marker).unwrap()).unwrap();
}

#[test]
fn has_nothing_to_report_without_a_marker_and_ignores_a_corrupt_one() {
    let env = Env::new();
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::None);
    fs::create_dir_all(env.mac_dir()).unwrap();
    fs::write(env.mac_dir().join("pending.json"), "{not json").unwrap();
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::None);
    fs::write(env.mac_dir().join("pending.json"), r#"{"from":"1.2.0","to":1}"#).unwrap();
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::None);
}

#[test]
fn recognises_a_finished_update_releases_the_waiter_and_cleans_up() {
    let mut env = Env::new();
    env.current = "1.2.1".into();
    write_marker(&env, "1.2.1", 1);
    for name in ["unimux-1.2.1-mac-arm64.app.tar.gz", "unimux-1.2.2-mac-arm64.app.tar.gz.part", "install-1.2.1.sh", "keep.txt"] {
        fs::write(env.mac_dir().join(name), "x").unwrap();
    }
    fs::create_dir_all(env.mac_dir().join("extracted-1.2.1")).unwrap();
    let apps = env.bundle().parent().unwrap().to_path_buf();
    for sibling in ["unimux.app.old-1.2.0", "unimux.app.new-1.2.1", "unimux.app.new-1.2.2"] {
        fs::create_dir_all(apps.join(sibling)).unwrap();
    }
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::Updated { version: "1.2.1".into() });
    env.updater().mark_ready();
    assert_eq!(fs::read_to_string(env.mac_dir().join("ready")).unwrap(), "1.2.1");
    assert!(!env.mac_dir().join("pending.json").exists());
    assert!(env.log().contains("update 1.2.0 -> 1.2.1 is running"));
    // This version and older go; a newer download in flight and unrelated files stay.
    assert_eq!(env.names(&env.mac_dir()), ["keep.txt", "ready", "unimux-1.2.2-mac-arm64.app.tar.gz.part", "update.log"]);
    assert_eq!(env.names(&apps), ["unimux.app", "unimux.app.new-1.2.2"]);
}

#[test]
fn mark_ready_does_nothing_for_an_app_that_was_not_just_updated() {
    let env = Env::new();
    env.updater().mark_ready();
    assert!(!env.mac_dir().join("ready").exists());
    write_marker(&env, "1.2.1", 1);
    env.updater().mark_ready();
    assert!(!env.mac_dir().join("ready").exists());
    assert!(env.mac_dir().join("pending.json").exists());
}

#[test]
fn reports_a_swap_that_did_not_happen_once_it_had_time_and_notes_the_backup() {
    let env = Env::new();
    let now = env.now.load(AtomicOrdering::SeqCst);
    // Fresh: the swap may still be working.
    write_marker(&env, "1.2.1", now - 1000);
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::None);
    assert!(env.mac_dir().join("pending.json").exists());
    // A marker from the future (clock changed) counts as old.
    write_marker(&env, "1.2.1", now + 60_000);
    fs::write(env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz"), "x").unwrap();
    fs::create_dir_all(format!("{}.old-1.2.0", env.bundle().display())).unwrap();
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::Failed { version: "1.2.1".into() });
    assert!(env.log().contains(&format!(
        "update 1.2.0 -> 1.2.1 did not take effect; running 1.2.0; the previous version is still at {}.old-1.2.0",
        env.bundle_posix()
    )));
    assert!(!env.mac_dir().join("pending.json").exists());
    assert!(!env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz").exists());
    write_marker(&env, "1.2.1", now - PENDING_GRACE_MS - 1);
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::Failed { version: "1.2.1".into() });
}

#[test]
fn a_rollback_by_the_swap_is_a_failure_at_once_and_that_version_is_cleaned_up() {
    let env = Env::new();
    let now = env.now.load(AtomicOrdering::SeqCst);
    write_marker(&env, "1.2.1", now);
    fs::write(env.mac_dir().join("rolled-back"), "1.2.1\n").unwrap();
    fs::write(env.mac_dir().join("unimux-1.2.1-mac-arm64.app.tar.gz"), "x").unwrap();
    fs::write(env.mac_dir().join("unimux-1.2.2-mac-arm64.app.tar.gz"), "x").unwrap();
    let apps = env.bundle().parent().unwrap().to_path_buf();
    fs::create_dir_all(apps.join("unimux.app.new-1.2.1")).unwrap();
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::Failed { version: "1.2.1".into() });
    assert!(env.log().contains("update to 1.2.1 was rolled back by the update script; running 1.2.0"));
    assert!(!env.mac_dir().join("rolled-back").exists() && !env.mac_dir().join("pending.json").exists());
    assert_eq!(env.names(&env.mac_dir()), ["unimux-1.2.2-mac-arm64.app.tar.gz", "update.log"]);
    assert_eq!(env.names(&apps), ["unimux.app"]);
    // A flag of a version that is already running is only removed.
    let mut env = Env::new();
    env.current = "1.2.1".into();
    fs::create_dir_all(env.mac_dir()).unwrap();
    fs::write(env.mac_dir().join("rolled-back"), "1.2.1\n").unwrap();
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::None);
    assert!(!env.mac_dir().join("rolled-back").exists());
}

#[test]
fn the_start_step_touches_nothing_unless_updates_are_active_and_records_a_failure_for_the_gate() {
    let env = Env::new();
    let data = env.data();
    let now = env.now.load(AtomicOrdering::SeqCst);
    write_marker(&env, "1.2.1", now);
    fs::write(
        env.mac_dir().join("rolled-back"),
        "1.2.1
",
    )
    .unwrap();
    // A dev build on the real profile (no packaged build, no dev feed): the installed app's evidence stays.
    let outcome = crate::mac::previous_update_at_start(&data, "1.2.0", false, false, |_| {});
    assert_eq!(outcome, MacPreviousOutcome::None);
    assert!(env.mac_dir().join("rolled-back").exists() && env.mac_dir().join("pending.json").exists());
    assert!(!data.join(crate::mac::GATE_FILE).exists());
    assert_eq!(crate::mac::outcome_at_start(), MacPreviousOutcome::None);

    // Updates active: the failure is consumed and recorded for the gate before it runs (1.1.4's recordUpdateFailure).
    let before = unimux_core::time::now_ms();
    let outcome = crate::mac::previous_update_at_start(&data, "1.2.0", false, true, |_| {});
    assert_eq!(outcome, MacPreviousOutcome::Failed { version: "1.2.1".into() });
    assert!(!env.mac_dir().join("rolled-back").exists() && !env.mac_dir().join("pending.json").exists());
    let record: Value = serde_json::from_str(&fs::read_to_string(data.join(crate::mac::GATE_FILE)).unwrap()).unwrap();
    assert_eq!(record.as_object().unwrap().keys().collect::<Vec<_>>(), ["version", "at"]);
    assert_eq!(record["version"], "1.2.1");
    assert!(record["at"].as_i64().unwrap() >= before);
    assert_eq!(crate::mac::outcome_at_start(), outcome);
}

#[test]
fn keeps_the_update_log_small() {
    let env = Env::new();
    fs::create_dir_all(env.mac_dir()).unwrap();
    fs::write(env.mac_dir().join("update.log"), vec![b'x'; 100 * 1024 + 1]).unwrap();
    env.updater().note("fresh");
    assert_eq!(env.log(), "2025-11-07T07:20:00.000Z fresh\n");
}

// ── end to end: download -> install -> the window's swap -> the new app ───────

struct OpenRecorder {
    opened: Mutex<Vec<PathBuf>>,
    fail: bool,
}

impl SwapOps for OpenRecorder {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        swap::RealSwapOps.rename(from, to)
    }
    fn remove_all(&self, path: &Path) -> io::Result<()> {
        swap::RealSwapOps.remove_all(path)
    }
    fn clear_quarantine(&self, _bundle: &Path) {}
    fn open(&self, bundle: &Path, _executable: &str) -> io::Result<()> {
        self.opened.lock().unwrap().push(bundle.to_path_buf());
        if self.fail { Err(io::Error::other("open failed")) } else { Ok(()) }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_whole_update_on_a_scratch_bundle_and_its_rollback() {
    let mut env = Env::new();
    let archive = tar_gz_of(&[("unimux.app", "1.2.1", "com.ajzakomator.app")]);
    let server = serve(Answer::Body(archive.clone())).await;
    env.trusted = vec![server.origin.clone()];
    let offer = offer_for(&env, &server, &archive);
    let staged = download(&env, &offer).await.0.unwrap();
    let MacInstall::Ready(plan) = env.updater().install(&staged).unwrap() else { panic!("refused") };
    // The plan crosses the process boundary inside work/config.json.
    let plan: BundleSwapPlan = serde_json::from_str(&serde_json::to_string(&plan).unwrap()).unwrap();

    // The new app cannot be opened: the old one comes back, is started, and the next start reports the failure.
    let failing = OpenRecorder { opened: Mutex::new(vec![]), fail: true };
    let log = |line: &str| env.updater().note(line);
    swap::swap(&plan, &failing, &log).unwrap();
    assert_eq!(fs::read_to_string(env.bundle().join("Contents/MacOS/unimux")).unwrap(), "new");
    let failure = swap::launch_new(&plan, &[], &failing, &log).unwrap_err();
    assert!(failure.old_app_in_place);
    assert_eq!(fs::read_to_string(env.bundle().join("Contents/MacOS/unimux")).unwrap(), "old");
    assert_eq!(failing.opened.lock().unwrap().len(), 2, "the new app, then the restored old one");
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::Failed { version: "1.2.1".into() });
    assert!(env.log().contains("the new app could not be opened, restoring the previous version"));
    assert!(env.log().contains("the previous version was restored"));

    // Again, this time the new app starts and reports ready.
    let staged = download(&env, &offer).await.0.unwrap();
    let MacInstall::Ready(plan) = env.updater().install(&staged).unwrap() else { panic!("refused") };
    let ops = OpenRecorder { opened: Mutex::new(vec![]), fail: false };
    swap::swap(&plan, &ops, &log).unwrap();
    swap::launch_new(&plan, &[], &ops, &log).unwrap();
    assert_eq!(fs::read_to_string(env.bundle().join("Contents/MacOS/unimux")).unwrap(), "new");
    // The new version starts: its markReady writes `ready`, the window sees it and completes.
    env.current = "1.2.1".into();
    let log = |line: &str| env.updater().note(line);
    assert_eq!(env.updater().finish_previous(), MacPreviousOutcome::Updated { version: "1.2.1".into() });
    env.updater().mark_ready();
    assert!(plan.ready_flag.exists());
    swap::complete(&plan, &ops, &log);
    assert_eq!(env.names(env.bundle().parent().unwrap()), ["unimux.app"]);
    assert_eq!(env.names(&env.mac_dir()), ["ready", "update.log"]);
    assert!(env.log().contains("update 1.2.0 -> 1.2.1 complete"));
}

// ── the coordinator's backend (1.1.4 updater.ts on macOS, test/mac-update-state.test.ts) ─────────────────────────────

struct Coordinated {
    backend: Arc<crate::mac::MacBackend>,
    coordinator: Arc<crate::coordinator::UpdateCoordinator>,
    states: Arc<Mutex<Vec<crate::state::UpdateState>>>,
    server: Server,
}

fn mac_backend(env: &Env, origin: &str) -> Arc<crate::mac::MacBackend> {
    crate::mac::MacBackend::new(
        env.updater(),
        crate::mac::MacBackendOptions { client: None, dev_feed: Some(origin.to_string()), log: Arc::new(|_| {}) },
    )
}

/// A feed of 1.2.1 and its signed archive on a loopback "development feed", the engine of `env` behind a coordinator.
async fn coordinated(env: &mut Env) -> Coordinated {
    use crate::coordinator::{CoordinatorOptions, UpdateCoordinator};
    let routes = Arc::new(Mutex::new(HashMap::new()));
    let server = serve(Answer::Routes(routes.clone())).await;
    let archive = tar_gz_of(&[("unimux.app", "1.2.1", "com.ajzakomator.app")]);
    let url = format!("{}/unimux-1.2.1-mac-arm64.app.tar.gz", server.origin);
    let feed = feed("1.2.1", &url, &env.keys.sign_b64(&archive));
    routes.lock().unwrap().insert("/latest.json".to_string(), feed.to_string().into_bytes());
    routes.lock().unwrap().insert("/unimux-1.2.1-mac-arm64.app.tar.gz".to_string(), archive);
    env.trusted = vec![server.origin.clone()];
    let backend = mac_backend(env, &server.origin);
    let states = Arc::new(Mutex::new(Vec::new()));
    let seen = states.clone();
    let coordinator = UpdateCoordinator::new(CoordinatorOptions::new(
        backend.clone(),
        Arc::new(move |s: &crate::state::UpdateState| seen.lock().unwrap().push(s.clone())),
        crate::RELEASES_URL,
    ));
    Coordinated { backend, coordinator, states, server }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mac_backend_takes_the_coordinator_from_the_feed_to_the_swap_and_reports_the_window_not_starting() {
    use crate::coordinator::CheckReason;
    use crate::state::Status;
    let mut env = Env::new();
    let c = coordinated(&mut env).await;
    assert_eq!(c.coordinator.check(CheckReason::Startup).await.unwrap().as_deref(), Some("1.2.1"));
    c.coordinator.download().await.unwrap();
    let state = c.coordinator.get_state();
    assert_eq!((state.status, state.version.as_deref(), state.portable), (Status::Ready, Some("1.2.1"), Some(false)));
    let statuses: Vec<Status> = c.states.lock().unwrap().iter().map(|s| s.status).collect();
    assert_eq!(statuses.first(), Some(&Status::Checking));
    assert!(statuses.contains(&Status::Available) && statuses.contains(&Status::Downloading), "{statuses:?}");
    assert!(c.coordinator.installable());
    // A second look does not download again.
    let hits = c.server.hits.load(AtomicOrdering::SeqCst);
    c.coordinator.check(CheckReason::Background).await.unwrap();
    c.coordinator.download().await.unwrap();
    assert_eq!(c.server.hits.load(AtomicOrdering::SeqCst), hits + 1, "only the feed was asked again");
    assert_eq!(c.backend.staged("1.2.1").unwrap().bundle, format!("{}.new-1.2.1", env.bundle_posix()));

    // The hand-over: the staged copy is checked again and the swap for the update window comes back with the marker.
    assert!(c.coordinator.lock_handover(Some("1.2.1")));
    let MacInstall::Ready(plan) = c.backend.install("1.2.1").unwrap() else { panic!("refused") };
    assert_eq!(plan.to_version, "1.2.1");
    assert_eq!(plan.new_bundle, PathBuf::from(format!("{}.new-1.2.1", env.bundle_posix())));
    assert!(env.mac_dir().join("pending.json").exists());
    // The window could not be started: no marker stays, and the message is the spawn failure.
    assert_eq!(c.backend.abandon_install(), messages::SPAWN);
    assert!(!env.mac_dir().join("pending.json").exists());
    // Only a version that was staged can be installed.
    assert_eq!(c.backend.install("1.2.2").unwrap_err(), messages::VERIFY);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_app_that_cannot_replace_itself_gets_the_download_page_with_the_reason_before_and_at_the_install() {
    use crate::coordinator::CheckReason;
    use crate::state::Status;
    // Owned by another user: the offer is only the download page, nothing is downloaded.
    let mut env = Env::new();
    let mut admin = FakeTargetFs::owned(501);
    admin.owners.insert(env.bundle_posix(), 0);
    env.fs = Arc::new(admin);
    let c = coordinated(&mut env).await;
    assert_eq!(c.coordinator.check(CheckReason::Startup).await.unwrap(), None);
    let state = c.coordinator.get_state();
    assert_eq!((state.status, state.portable), (Status::Available, Some(true)));
    assert_eq!(state.url.as_deref(), Some(crate::RELEASES_URL));
    assert_eq!(state.message.as_deref(), Some(MacRefusal::NotOwner.message()));
    assert!(!c.coordinator.installable());
    assert!(!c.coordinator.lock_handover(Some("1.2.1")));
    assert_eq!(c.server.hits.load(AtomicOrdering::SeqCst), 1, "the feed only");

    // Refused at the last moment (App Management): the download page with that reason; the staged copy is not used again.
    let mut env = Env::new();
    let c = coordinated(&mut env).await;
    c.coordinator.check(CheckReason::Startup).await.unwrap();
    c.coordinator.download().await.unwrap();
    assert!(c.coordinator.lock_handover(Some("1.2.1")));
    fs::create_dir_all(env.bundle().join("Contents/.unimux-write-probe")).unwrap();
    assert_eq!(c.backend.install("1.2.1").unwrap(), MacInstall::Refused(MacRefusal::AppManagement));
    c.coordinator.refuse_install("1.2.1", Some(MacRefusal::AppManagement.message().to_string()));
    let state = c.coordinator.get_state();
    assert_eq!((state.status, state.portable), (Status::Available, Some(true)));
    assert_eq!(state.message.as_deref(), Some(MacRefusal::AppManagement.message()));
    assert!(c.backend.staged("1.2.1").is_none());
    assert!(!env.mac_dir().join("pending.json").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_feed_with_nothing_newer_is_current_and_a_feed_without_this_mac_or_a_server_error_fails_the_look() {
    use crate::coordinator::{Backend as _, CheckReason};
    use crate::state::Status;
    let mut env = Env::new();
    env.current = "1.2.1".into();
    let c = coordinated(&mut env).await;
    assert_eq!(c.coordinator.check(CheckReason::Startup).await.unwrap(), None);
    let state = c.coordinator.get_state();
    assert_eq!((state.status, state.version.as_deref()), (Status::Current, Some("1.2.1")));

    // No archive for this Mac in the feed: the engine's message.
    let env = Env::new();
    let routes = Arc::new(Mutex::new(HashMap::new()));
    routes.lock().unwrap().insert("/latest.json".to_string(), br#"{"version":"1.2.1","platforms":{}}"#.to_vec());
    let empty = serve(Answer::Routes(routes)).await;
    assert_eq!(mac_backend(&env, &empty.origin).lookup().await.unwrap_err(), messages::NO_ASSET);
    // A server error.
    let failing = serve(Answer::Status(500)).await;
    assert_eq!(mac_backend(&env, &failing.origin).lookup().await.unwrap_err(), messages::SERVER);
}
