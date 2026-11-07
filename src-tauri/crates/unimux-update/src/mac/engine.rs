//! The macOS update engine (port of src/main/macUpdate/engine.ts for Tauri -> Tauri, PLAN U5).
//!
//! 1.1.4 read `latest-mac.yml`, checked a sha512 and swapped the bundle with a shell script after quitting. 1.2.0 reads the
//! macOS entry of `latest.json` (the tauri-plugin-updater format: `platforms["darwin-aarch64"] = {url, signature}`), downloads the
//! `.app.tar.gz` (a ditto `.zip` works too), checks its minisign signature against the key embedded at build time while the bytes
//! arrive, unpacks it, verifies the bundle (version, identifier, executable, `codesign --verify --deep --strict`), stages it next
//! to the installed app and hands the swap to the update window ([`super::swap`]). The bookkeeping in `<data>/updates/mac`
//! (`update.log`, `pending.json`, `ready`, `rolled-back`, `.old-*` / `.new-*` siblings) is the 1.1.4 one, so `finish_previous`
//! and `mark_ready` also complete an update that the 1.1.4 engine started (Electron 1.1.x -> 1.2.0 through `latest-mac.yml`).
//!
//! Network, process and file system access are injected ([`MacTools`], [`TargetFs`], the `HttpClient` of B3), so the flow runs
//! in tests on any platform; every macOS command runs through [`MacTools::exec`].

use std::cmp::Ordering;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use unimux_net::{CancellationToken, HttpClient};

use super::plist::{plist_string, same_app, staged_file_version};
use super::swap::BundleSwapPlan;
use super::target::{
    MacRefusal, TargetFs, TargetResult, backup_path_for, bundle_path_from_exec_path, evaluate_install_target, posix_dirname,
    probe_bundle_write, staged_path_for,
};
use crate::version::compare_versions;

/// `MAC_MESSAGES` of engine.ts: Polish catalog keys (src/shared/macUpdateMessages.ts translates them in the renderer).
pub mod messages {
    pub const NO_ASSET: &str = "Nie znaleziono aktualizacji dla tego typu procesora Maca.";
    pub const SERVER: &str = "Serwer aktualizacji zwrócił błąd. Spróbuj ponownie później.";
    pub const STALLED: &str = "Pobieranie aktualizacji zostało przerwane - serwer przestał wysyłać dane.";
    pub const DAMAGED: &str = "Pobrana aktualizacja jest uszkodzona (zła suma kontrolna lub rozmiar).";
    pub const EXTRACT: &str = "Nie udało się rozpakować aktualizacji.";
    pub const VERIFY: &str = "Pobrana aktualizacja nie przeszła weryfikacji i nie zostanie zainstalowana.";
    pub const SPAWN: &str = "Nie udało się uruchomić instalatora aktualizacji.";
    pub const QUIT_TIMEOUT: &str = "Aplikacja nie zamknęła się na czas - aktualizacja została przerwana.";
    pub const ROLLED_BACK: &str = "Poprzednia aktualizacja nie powiodła się - działa dotychczasowa wersja.";
    /// parseLatestMacYml's error for a feed without a valid version.
    pub const BAD_FEED: &str = "Nieprawidłowy plik informacji o aktualizacji.";
    pub const ALL: [&str; 10] = [NO_ASSET, SERVER, STALLED, DAMAGED, EXTRACT, VERIFY, SPAWN, QUIT_TIMEOUT, ROLLED_BACK, BAD_FEED];
}

/// Message of the error a cancelled download ends with (the caller knows it cancelled and does not report it).
pub const DOWNLOAD_CANCELLED: &str = "download cancelled";
/// The download may be silent for this long before it counts as failed (MAC_DOWNLOAD_STALL_MS).
pub const MAC_DOWNLOAD_STALL: Duration = Duration::from_secs(60);
/// Upper bound for one download of the ~140 MB archive, however steadily it progresses (MAC_DOWNLOAD_TOTAL_MS).
pub const MAC_DOWNLOAD_TOTAL: Duration = Duration::from_secs(15 * 60);
const EXEC_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// A marker younger than this may still belong to a running swap (PENDING_GRACE_MS).
pub const PENDING_GRACE_MS: i64 = 2 * 60 * 1000;
const LOG_LIMIT_BYTES: u64 = 100 * 1024;
/// A download larger than this is refused (the archive is about 140 MB).
const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
/// How often progress is reported while the bytes arrive.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// Result of a system tool (`ExecResult` of engine.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// The command does not exist on this system.
    pub missing: bool,
}

/// The system tools the engine runs: `/usr/bin/ditto`, `/usr/bin/xattr`, `/usr/bin/plutil`, `/usr/bin/codesign`.
pub trait MacTools: Send + Sync {
    fn exec(&self, program: &str, args: &[String], timeout: Duration) -> ExecResult;
}

/// The real tools, with the fixed environment of the 1.1.4 runtime (`SCRIPT_ENV`).
pub struct RealMacTools;

impl MacTools for RealMacTools {
    fn exec(&self, program: &str, args: &[String], timeout: Duration) -> ExecResult {
        let program = unimux_exec::Program::Args { program: program.into(), args: args.iter().map(Into::into).collect() };
        let options = unimux_exec::ExecOptions {
            env: Some(super::swap::tool_env()),
            timeout,
            max_output: 4 * 1024 * 1024,
            ..Default::default()
        };
        match unimux_exec::run(&program, &options) {
            Ok(out) => ExecResult {
                code: out.code,
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                missing: false,
            },
            Err(unimux_exec::ExecError::Io(e) | unimux_exec::ExecError::Spawn { source: e, .. })
                if e.kind() == io::ErrorKind::NotFound =>
            {
                ExecResult { code: None, missing: true, ..Default::default() }
            }
            Err(e) => ExecResult { code: None, stderr: e.to_string(), ..Default::default() },
        }
    }
}

/// An extra sink for the engine's log lines (crash.log / console).
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// What the engine needs from its surroundings (`MacUpdaterDeps`).
pub struct MacUpdaterDeps {
    /// `arm64` or `x64` (Node's names, as in the archive names).
    pub arch: String,
    pub current_version: String,
    /// The running executable (`/Applications/unimux.app/Contents/MacOS/unimux`), a POSIX path.
    pub exec_path: String,
    pub packaged: bool,
    /// `<data>/updates/mac`.
    pub update_dir: PathBuf,
    pub fs: Arc<dyn TargetFs>,
    pub tools: Arc<dyn MacTools>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// Extra sink (crash.log / console); `update.log` is always written.
    pub log: Option<LogSink>,
    /// Extra origins update requests may use (the development feed, MC_UPDATE_FEED); GitHub is always allowed.
    pub trusted_origins: Vec<String>,
    /// The minisign public key (base64 of the key file), [`crate::UPDATER_PUBLIC_KEY`] in the app.
    pub public_key: String,
    pub stall: Duration,
    pub total: Duration,
}

/// `arm64` / `x64` for this build (Node's `process.arch`).
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

impl MacUpdaterDeps {
    /// The real surroundings of the running app: `<data>/updates/mac`, this executable, the real tools and file system.
    pub fn for_app(data_dir: &Path, current_version: &str, packaged: bool, trusted_origins: Vec<String>) -> Self {
        Self {
            arch: node_arch().to_string(),
            current_version: current_version.to_string(),
            exec_path: std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            packaged,
            update_dir: data_dir.join("updates").join("mac"),
            fs: Arc::new(super::target::RealTargetFs),
            tools: Arc::new(RealMacTools),
            now: Arc::new(unimux_core::time::now_ms),
            log: None,
            trusted_origins,
            public_key: crate::UPDATER_PUBLIC_KEY.to_string(),
            stall: MAC_DOWNLOAD_STALL,
            total: MAC_DOWNLOAD_TOTAL,
        }
    }
}

/// An update this app can download (`MacOffer`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacOffer {
    pub version: String,
    /// The archive's file name (the last path segment of `url`).
    pub name: String,
    pub url: String,
    /// The `signature` of the feed entry: base64 of the minisign `.sig` file.
    pub signature: String,
    /// Set when the app cannot replace itself; the offer then only links to the download page.
    pub refusal: Option<MacRefusal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacCheckResult {
    /// What the feed announces.
    pub latest: String,
    pub offer: Option<MacOffer>,
}

/// A verified bundle staged next to the installed app (`MacStaged`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacStaged {
    pub version: String,
    /// `<bundle>.new-<version>`.
    pub bundle: String,
    pub executable: String,
    pub archive: PathBuf,
    pub extract_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MacProgress {
    pub percent: f64,
    pub transferred: u64,
    pub total: u64,
    pub bytes_per_second: f64,
}

/// `MacInstallResult`: the swap for the update window, or why the app cannot be replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacInstall {
    Ready(Box<BundleSwapPlan>),
    Refused(MacRefusal),
}

/// `MacPreviousOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacPreviousOutcome {
    None,
    Updated { version: String },
    Failed { version: String },
}

/// `pending.json`: `{from, to, at, bundle, backup}` in this order (JSON.stringify of the 1.1.4 marker).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingMarker {
    pub from: String,
    pub to: String,
    pub at: i64,
    pub bundle: String,
    pub backup: String,
}

/// The `platforms` keys of latest.json for this architecture, in the order tauri-plugin-updater tries them.
pub fn platform_keys(arch: &str) -> Option<[&'static str; 2]> {
    match arch {
        "arm64" => Some(["darwin-aarch64-app", "darwin-aarch64"]),
        "x64" => Some(["darwin-x86_64-app", "darwin-x86_64"]),
        _ => None,
    }
}

/// parseLatestMacYml's version rule.
fn valid_version(version: &str) -> bool {
    static VERSION: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$").unwrap());
    VERSION.is_match(version)
}

/// Only plain archive names of this architecture and version: a feed can never point the staging at another file name.
fn archive_name_ok(name: &str, arch: &str, version: &str) -> bool {
    static NAME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*-mac-(arm64|x64)\.(?:app\.tar\.gz|zip)$").unwrap()
    });
    NAME.captures(name).is_some_and(|c| &c[1] == arch) && name.contains(&format!("-{version}-"))
}

fn is_tar_gz(name: &str) -> bool {
    name.ends_with(".tar.gz")
}

/// One line of `update.log` (`<ISO time> <line>`); the file is emptied once it is over 100 KB. The engine and the update
/// window's swap both write through here.
pub fn append_update_log(file: &Path, now_ms: i64, line: &str) {
    let _ = (|| -> io::Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        let size = fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        if size > LOG_LIMIT_BYTES {
            fs::write(file, "")?;
        }
        let mut out = fs::OpenOptions::new().create(true).append(true).open(file)?;
        out.write_all(format!("{} {line}\n", iso(now_ms)).as_bytes())
    })();
}

fn iso(ms: i64) -> String {
    unimux_core::time::iso_from_ms(ms)
}

fn excerpt(text: &str) -> String {
    text.trim().chars().take(300).collect()
}

/// Executable bit of a file (Windows has none: every file counts).
fn executable_bit(meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        true
    }
}

/// Verifies a minisign signature (the latest.json `signature`: base64 of the `.sig` file) over a stream of bytes.
pub struct SignatureCheck {
    key: minisign_verify::PublicKey,
    signature: minisign_verify::Signature,
}

impl SignatureCheck {
    pub fn new(public_key_b64: &str, signature_b64: &str) -> Result<Self, String> {
        use base64::Engine as _;
        let decode = |b64: &str| {
            base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .ok_or_else(|| "not base64 text".to_string())
        };
        let key = minisign_verify::PublicKey::decode(&decode(public_key_b64)?).map_err(|e| format!("public key: {e}"))?;
        let signature = minisign_verify::Signature::decode(&decode(signature_b64)?).map_err(|e| format!("signature: {e}"))?;
        Ok(Self { key, signature })
    }

    pub fn verifier(&self) -> Result<minisign_verify::StreamVerifier<'_>, String> {
        self.key.verify_stream(&self.signature).map_err(|e| e.to_string())
    }

    /// The whole file.
    pub fn verify_file(&self, path: &Path) -> Result<(), String> {
        let mut verifier = self.verifier()?;
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            verifier.update(&buf[..n]);
        }
        verifier.finalize().map_err(|e| e.to_string())
    }
}

pub struct MacUpdater {
    d: MacUpdaterDeps,
}

impl MacUpdater {
    pub fn new(deps: MacUpdaterDeps) -> Arc<Self> {
        Arc::new(Self { d: deps })
    }

    pub fn deps(&self) -> &MacUpdaterDeps {
        &self.d
    }

    fn dir(&self) -> &Path {
        &self.d.update_dir
    }
    pub fn log_file(&self) -> PathBuf {
        self.dir().join("update.log")
    }
    pub fn marker_file(&self) -> PathBuf {
        self.dir().join("pending.json")
    }
    pub fn ready_file(&self) -> PathBuf {
        self.dir().join("ready")
    }
    pub fn failed_file(&self) -> PathBuf {
        self.dir().join("rolled-back")
    }

    /// Appends to `update.log` (public information only: versions, file names and paths) and to the optional sink. The file is
    /// emptied once it is over 100 KB.
    pub fn note(&self, line: &str) {
        if let Some(sink) = &self.d.log {
            sink(line);
        }
        append_update_log(&self.log_file(), (self.d.now)(), line);
    }

    fn target(&self) -> TargetResult {
        evaluate_install_target(&self.d.exec_path, self.d.packaged, &*self.d.fs)
    }

    fn trusted(&self, url: &str) -> bool {
        unimux_net::Url::parse(url).is_ok_and(|u| unimux_net::calls::is_trusted_update_url(&u, &self.d.trusted_origins))
    }

    /// Reads the feed (latest.json, already fetched by the coordinator). Without an offer the running version is current.
    pub fn check(&self, feed: &Value) -> Result<MacCheckResult, String> {
        let version = feed.get("version").and_then(Value::as_str).unwrap_or("");
        if !valid_version(version) {
            return Err(messages::BAD_FEED.into());
        }
        if compare_versions(version, &self.d.current_version) != Ordering::Greater {
            return Ok(MacCheckResult { latest: version.into(), offer: None });
        }
        let entry = platform_keys(&self.d.arch)
            .into_iter()
            .flatten()
            .find_map(|key| feed.get("platforms").and_then(|p| p.get(key)))
            .and_then(|e| Some((e.get("url")?.as_str()?.to_string(), e.get("signature")?.as_str()?.to_string())));
        let Some((url, signature)) = entry else {
            self.note(&format!("the feed lists no archive for {} (version {version})", self.d.arch));
            return Err(messages::NO_ASSET.into());
        };
        let name = unimux_net::Url::parse(&url)
            .ok()
            .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_string)))
            .unwrap_or_default();
        if !self.trusted(&url) || !archive_name_ok(&name, &self.d.arch, version) || signature.trim().is_empty() {
            self.note(&format!("the feed entry for {} is not usable: {url}", self.d.arch));
            return Err(messages::NO_ASSET.into());
        }
        let mut offer = MacOffer { version: version.into(), name, url, signature, refusal: None };
        if let TargetResult::Refused { reason, .. } = self.target() {
            offer.refusal = Some(reason);
            self.note(&format!("update {version} found, but this app is not replaced in place: {}", reason.as_str()));
        }
        Ok(MacCheckResult { latest: version.into(), offer: Some(offer) })
    }

    /// Removes everything in the staging directory except the log, the flags, the marker and `keep`.
    pub fn clean_staging(&self, keep: &[&str]) {
        let preserved = ["update.log", "ready", "rolled-back", "pending.json"];
        for name in self.dir_names() {
            if !preserved.contains(&name.as_str()) && !keep.contains(&name.as_str()) {
                let _ = remove_all(&self.dir().join(&name));
            }
        }
    }

    fn dir_names(&self) -> Vec<String> {
        fs::read_dir(self.dir())
            .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    }

    /// Downloads, verifies, unpacks and checks the update; returns once the new bundle is staged next to the installed app.
    /// A cancelled `cancel` (a newer release replaced this one) ends with [`DOWNLOAD_CANCELLED`].
    pub async fn download(
        self: &Arc<Self>,
        client: &HttpClient,
        offer: &MacOffer,
        on_progress: &mut (dyn FnMut(MacProgress) + Send),
        cancel: &CancellationToken,
    ) -> Result<MacStaged, String> {
        let stop = || if cancel.is_cancelled() { Err(DOWNLOAD_CANCELLED.to_string()) } else { Ok(()) };
        stop()?;
        let check = SignatureCheck::new(&self.d.public_key, &offer.signature).map_err(|e| {
            self.note(&format!("the signature of {} cannot be read: {e}", offer.name));
            messages::VERIFY.to_string()
        })?;
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        let archive = self.dir().join(&offer.name);
        self.clean_staging(&[&offer.name]);
        let reuse = {
            let (me, archive, signature) = (self.clone(), archive.clone(), offer.signature.clone());
            tokio::task::spawn_blocking(move || {
                archive.is_file()
                    && SignatureCheck::new(&me.d.public_key, &signature).is_ok_and(|c| c.verify_file(&archive).is_ok())
            })
            .await
            .unwrap_or(false)
        };
        if reuse {
            self.note(&format!("reusing the verified archive {}", offer.name));
            let size = fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
            on_progress(MacProgress { percent: 100.0, transferred: size, total: size, bytes_per_second: 0.0 });
        } else {
            let _ = fs::remove_file(&archive);
            self.fetch_archive(client, offer, &check, &archive, on_progress, cancel).await?;
        }
        stop()?;
        let me = self.clone();
        let version = offer.version.clone();
        let staged =
            tokio::task::spawn_blocking(move || me.stage_archive(&version, &archive)).await.map_err(|e| e.to_string())??;
        if cancel.is_cancelled() {
            let _ = remove_all(Path::new(&staged.bundle));
            return Err(DOWNLOAD_CANCELLED.into());
        }
        Ok(staged)
    }

    async fn fetch_archive(
        &self,
        client: &HttpClient,
        offer: &MacOffer,
        check: &SignatureCheck,
        archive: &Path,
        on_progress: &mut (dyn FnMut(MacProgress) + Send),
        outside: &CancellationToken,
    ) -> Result<(), String> {
        let part = PathBuf::from(format!("{}.part", archive.display()));
        let token = outside.child_token();
        let result = self.fetch_into(client, offer, check, &part, on_progress, &token).await;
        token.cancel();
        match result {
            Ok(()) => fs::rename(&part, archive).map_err(|e| {
                let _ = fs::remove_file(&part);
                e.to_string()
            }),
            Err(e) => {
                let _ = fs::remove_file(&part);
                if outside.is_cancelled() {
                    return Err(DOWNLOAD_CANCELLED.into());
                }
                Err(e)
            }
        }
    }

    async fn fetch_into(
        &self,
        client: &HttpClient,
        offer: &MacOffer,
        check: &SignatureCheck,
        part: &Path,
        on_progress: &mut (dyn FnMut(MacProgress) + Send),
        token: &CancellationToken,
    ) -> Result<(), String> {
        let started = Instant::now();
        let deadline = tokio::time::Instant::now() + self.d.total;
        let stalled = || {
            self.note("the download stalled or took too long");
            messages::STALLED.to_string()
        };
        let request = unimux_net::calls::update_request(&offer.url, self.d.trusted_origins.clone(), None)
            .map_err(|e| {
                self.note(&format!("request refused: {e}"));
                messages::SERVER.to_string()
            })?
            .max_body(MAX_ARCHIVE_BYTES)
            .cancel(token.clone());
        let wait = self.d.stall.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
        let mut response = match tokio::time::timeout(wait, client.fetch_stream(request)).await {
            Err(_) => return Err(stalled()),
            Ok(Err(unimux_net::FetchError::Aborted)) => return Err(DOWNLOAD_CANCELLED.into()),
            Ok(Err(e)) => {
                self.note(&format!("request failed: {e}"));
                return Err(messages::SERVER.into());
            }
            Ok(Ok(r)) => r,
        };
        if !response.ok() {
            self.note(&format!("request failed: HTTP {} for {}", response.status, offer.url));
            return Err(messages::SERVER.into());
        }
        let total = response.content_length().unwrap_or(0);
        let mut verifier = check.verifier().map_err(|e| {
            self.note(&format!("the signature of {} is not usable: {e}", offer.name));
            messages::VERIFY.to_string()
        })?;
        let mut file = fs::File::create(part).map_err(|e| e.to_string())?;
        let mut transferred = 0u64;
        let mut reported = Instant::now() - PROGRESS_EVERY;
        loop {
            let wait = self.d.stall.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
            let chunk = match tokio::time::timeout(wait, response.body.chunk()).await {
                Err(_) => return Err(stalled()),
                Ok(Err(unimux_net::FetchError::Aborted)) => return Err(DOWNLOAD_CANCELLED.into()),
                Ok(Err(e)) => {
                    self.note(&format!("request failed: {e}"));
                    return Err(messages::SERVER.into());
                }
                Ok(Ok(None)) => break,
                Ok(Ok(Some(chunk))) => chunk,
            };
            transferred += chunk.len() as u64;
            if total > 0 && transferred > total {
                self.note(&format!("the download is larger than announced ({total} bytes)"));
                return Err(messages::DAMAGED.into());
            }
            verifier.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            if reported.elapsed() >= PROGRESS_EVERY {
                reported = Instant::now();
                let seconds = started.elapsed().as_secs_f64().max(0.001);
                let percent = if total > 0 { transferred as f64 / total as f64 * 100.0 } else { 0.0 };
                on_progress(MacProgress { percent, transferred, total, bytes_per_second: transferred as f64 / seconds });
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        if total > 0 && transferred != total {
            self.note(&format!("the downloaded archive is {transferred} of {total} bytes"));
            return Err(messages::DAMAGED.into());
        }
        if let Err(e) = verifier.finalize() {
            self.note(&format!("the signature of {} does not match: {e}", offer.name));
            return Err(messages::VERIFY.into());
        }
        on_progress(MacProgress { percent: 100.0, transferred, total: transferred, bytes_per_second: 0.0 });
        Ok(())
    }

    /// Unpacks a verified archive, checks the bundle and stages a copy next to the installed app (the part of `download` after
    /// the transfer). Blocking.
    pub fn stage_archive(&self, version: &str, archive: &Path) -> Result<MacStaged, String> {
        let extract_dir = self.dir().join(format!("extracted-{version}"));
        let _ = remove_all(&extract_dir);
        fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
        let name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if is_tar_gz(&name) {
            if let Err(e) = unpack_tar_gz(archive, &extract_dir) {
                self.note(&format!("unpacking failed: {}", excerpt(&e.to_string())));
                return Err(messages::EXTRACT.into());
            }
        } else {
            let unpacked = self.exec("/usr/bin/ditto", &["-x", "-k", &path_str(archive), &path_str(&extract_dir)]);
            if unpacked.code != Some(0) {
                self.note(&format!("ditto failed ({}): {}", code_text(unpacked.code), excerpt(&unpacked.stderr)));
                return Err(messages::EXTRACT.into());
            }
        }
        let apps: Vec<String> = fs::read_dir(&extract_dir)
            .map(|e| e.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".app")).collect())
            .unwrap_or_default();
        if apps.len() != 1 {
            self.note(&format!("the archive holds {} app bundles, expected 1", apps.len()));
            return Err(messages::VERIFY.into());
        }
        let unpacked = path_str(&extract_dir.join(&apps[0]));
        // Files written by this process carry no quarantine flag; this only guards against one that was set anyway.
        let _ = self.exec("/usr/bin/xattr", &["-cr", &unpacked]);
        // A quick look first, so nothing unverified is copied next to the installed app.
        self.verify_bundle(&unpacked, version, false)?;

        // The verified bundle waits next to the installed app (same directory and volume), so the swap is two renames.
        let bundle = match self.target() {
            TargetResult::Ok { bundle } => bundle,
            TargetResult::Refused { reason, .. } => {
                self.note(&format!("staging refused: {}", reason.as_str()));
                return Err(reason.message().into());
            }
        };
        let staged = staged_path_for(&bundle, version);
        self.remove_siblings(&bundle, ".new-", |_| true);
        let copied = self.exec("/usr/bin/ditto", &[&unpacked, &staged]);
        if copied.code != Some(0) {
            self.note(&format!("ditto copy failed ({}): {}", code_text(copied.code), excerpt(&copied.stderr)));
            let _ = remove_all(Path::new(&staged));
            return Err(messages::EXTRACT.into());
        }
        let executable = match self.verify_bundle(&staged, version, true) {
            Ok(exe) => exe,
            Err(e) => {
                let _ = remove_all(Path::new(&staged));
                return Err(e);
            }
        };
        let _ = remove_all(&extract_dir);
        self.note(&format!("update {version} downloaded, verified and staged at {staged}"));
        Ok(MacStaged { version: version.into(), bundle: staged, executable, archive: archive.to_path_buf(), extract_dir })
    }

    fn exec(&self, program: &str, args: &[&str]) -> ExecResult {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        self.d.tools.exec(program, &args, EXEC_TIMEOUT)
    }

    /// Removes the siblings `<bundle><infix><version>` of the installed app for which `remove(version)` holds.
    fn remove_siblings(&self, bundle: &str, infix: &str, remove: impl Fn(&str) -> bool) {
        let parent = posix_dirname(bundle);
        let base = bundle.rsplit('/').next().unwrap_or(bundle);
        let prefix = format!("{base}{infix}");
        let Ok(entries) = fs::read_dir(parent) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(version) = name.strip_prefix(&prefix)
                && remove(version)
            {
                let _ = remove_all(&Path::new(parent).join(&name));
            }
        }
    }

    /// Removes leftovers of updates that are already installed (or older); files of a newer version (a download in flight)
    /// are never touched.
    fn clean_finished(&self, up_to: &str) {
        let old = |version: &str| compare_versions(version, up_to) != Ordering::Greater;
        for name in self.dir_names() {
            if staged_file_version(&name).is_some_and(|v| old(&v)) {
                let _ = remove_all(&self.dir().join(&name));
            }
        }
        if self.d.packaged
            && let Some(bundle) = bundle_path_from_exec_path(&self.d.exec_path)
        {
            self.remove_siblings(&bundle, ".new-", old);
        }
    }

    fn read_plist(&self, path: &str) -> Result<String, String> {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if text.contains("<plist") {
            return Ok(text);
        }
        // A binary property list: let macOS convert it.
        let converted = self.exec("/usr/bin/plutil", &["-convert", "xml1", "-o", "-", path]);
        if converted.code != Some(0) {
            return Err("unreadable Info.plist".into());
        }
        Ok(converted.stdout)
    }

    /// Version, identifier, executable (and, with `signature`, the code signature) of a bundle; returns the executable name.
    pub fn verify_bundle(&self, bundle: &str, version: &str, signature: bool) -> Result<String, String> {
        let reject = |why: String| {
            self.note(&format!("verification failed: {why}"));
            Err(messages::VERIFY.to_string())
        };
        let read = || -> Result<(String, Option<String>), String> {
            let info = self.read_plist(&format!("{bundle}/Contents/Info.plist"))?;
            let running = match bundle_path_from_exec_path(&self.d.exec_path) {
                Some(running) => plist_string(&self.read_plist(&format!("{running}/Contents/Info.plist"))?, "CFBundleIdentifier"),
                None => None,
            };
            Ok((info, running))
        };
        let (info, running) = match read() {
            Ok(v) => v,
            Err(e) => return reject(format!("Info.plist: {e}")),
        };
        let announced = plist_string(&info, "CFBundleShortVersionString");
        if announced.as_deref() != Some(version) {
            return reject(format!("version {} instead of {version}", announced.as_deref().unwrap_or("(none)")));
        }
        let identifier = plist_string(&info, "CFBundleIdentifier");
        let matches =
            matches!((&identifier, &running), (Some(id), Some(run)) if !id.is_empty() && !run.is_empty() && same_app(id, run));
        if !matches {
            return reject(format!("identifier {} does not match the running app", identifier.as_deref().unwrap_or("(none)")));
        }
        let executable = plist_string(&info, "CFBundleExecutable").unwrap_or_default();
        if executable.is_empty() || executable.contains('/') || executable == ".." || executable == "." {
            return reject("no valid CFBundleExecutable".into());
        }
        let exe = fs::metadata(format!("{bundle}/Contents/MacOS/{executable}")).ok().filter(fs::Metadata::is_file);
        let Some(exe) = exe else { return reject(format!("the executable {executable} is missing")) };
        if !executable_bit(&exe) {
            return reject(format!("the executable {executable} is not executable"));
        }
        if !signature {
            return Ok(executable);
        }
        let checked = self.exec("/usr/bin/codesign", &["--verify", "--deep", "--strict", bundle]);
        if checked.missing {
            self.note("codesign is not available, the signature was not checked");
        } else if checked.code != Some(0) {
            return reject(format!("codesign: {}", excerpt(&checked.stderr)));
        }
        Ok(executable)
    }

    /// Checks the staged bundle once more and writes the marker; the caller then hands the returned plan to the update window
    /// (`window::hand_over` with `swap`) and calls [`Self::abandon_install`] when that fails. Nothing here quits the app.
    pub fn install(&self, staged: &MacStaged) -> Result<MacInstall, String> {
        let bundle = match self.target() {
            TargetResult::Ok { bundle } => bundle,
            TargetResult::Refused { reason, .. } => {
                self.note(&format!("install refused: {}", reason.as_str()));
                return Ok(MacInstall::Refused(reason));
            }
        };
        if !probe_bundle_write(Path::new(&bundle)) {
            self.note("install refused: the app bundle cannot be modified (App Management permission?)");
            return Ok(MacInstall::Refused(MacRefusal::AppManagement));
        }
        // The staged copy must sit next to the installed app and still be what it was when it was verified.
        if staged.bundle != staged_path_for(&bundle, &staged.version) {
            self.note("install aborted: the staged app is not next to the installed one");
            return Err(messages::VERIFY.into());
        }
        if !Path::new(&format!("{}/Contents/MacOS/{}", staged.bundle, staged.executable)).is_file() {
            self.note("install aborted: the staged app is missing");
            return Err(messages::VERIFY.into());
        }
        let executable = self.verify_bundle(&staged.bundle, &staged.version, false)?;
        if executable != staged.executable {
            self.note("install aborted: the staged executable changed");
            return Err(messages::VERIFY.into());
        }
        let backup = backup_path_for(&bundle, &self.d.current_version);
        let plan = BundleSwapPlan {
            bundle: PathBuf::from(&bundle),
            new_bundle: PathBuf::from(&staged.bundle),
            backup: PathBuf::from(&backup),
            executable: staged.executable.clone(),
            log: self.log_file(),
            ready_flag: self.ready_file(),
            failed_flag: self.failed_file(),
            cleanup: vec![staged.extract_dir.clone(), staged.archive.clone()],
            from_version: self.d.current_version.clone(),
            to_version: staged.version.clone(),
        };
        let marker = PendingMarker {
            from: self.d.current_version.clone(),
            to: staged.version.clone(),
            at: (self.d.now)(),
            bundle,
            backup,
        };
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        fs::write(self.marker_file(), serde_json::to_string(&marker).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        self.note(&format!(
            "update {} -> {}: handed to the update window, the app quits now",
            self.d.current_version, staged.version
        ));
        Ok(MacInstall::Ready(Box::new(plan)))
    }

    /// The update window could not be started: no marker is left behind. Returns the message for the status bar.
    pub fn abandon_install(&self) -> &'static str {
        let _ = fs::remove_file(self.marker_file());
        self.note("the update window could not be started");
        messages::SPAWN
    }

    fn read_marker(&self) -> Option<PendingMarker> {
        let text = fs::read_to_string(self.marker_file()).ok()?;
        let raw: Value = serde_json::from_str(&text).ok()?;
        Some(PendingMarker {
            from: raw.get("from")?.as_str()?.into(),
            to: raw.get("to")?.as_str()?.into(),
            at: raw.get("at")?.as_f64()? as i64,
            bundle: raw.get("bundle")?.as_str()?.into(),
            backup: raw.get("backup")?.as_str()?.into(),
        })
    }

    /// At start: whether the last update took effect. A marker that targets a newer version than the one running and is older
    /// than [`PENDING_GRACE_MS`] means the swap did not happen; that is logged and reported as a failure of that version.
    pub fn finish_previous(&self) -> MacPreviousOutcome {
        let current = self.d.current_version.clone();
        self.clean_finished(&current);
        // The swap restored (or never touched) the old app and relaunched it: a failure whatever the age of the marker.
        if let Ok(flagged) = fs::read_to_string(self.failed_file()) {
            let flagged = flagged.trim().to_string();
            let _ = fs::remove_file(self.failed_file());
            if !flagged.is_empty() && compare_versions(&current, &flagged) == Ordering::Less {
                let _ = fs::remove_file(self.marker_file());
                self.note(&format!("update to {flagged} was rolled back by the update script; running {current}"));
                if self.d.packaged
                    && let Some(bundle) = bundle_path_from_exec_path(&self.d.exec_path)
                {
                    self.remove_siblings(&bundle, ".new-", |v| v == flagged);
                }
                self.clean_staging_of(&flagged);
                return MacPreviousOutcome::Failed { version: flagged };
            }
        }
        let Some(marker) = self.read_marker() else { return MacPreviousOutcome::None };
        if compare_versions(&current, &marker.to) != Ordering::Less {
            return MacPreviousOutcome::Updated { version: marker.to };
        }
        let now = (self.d.now)();
        if now - marker.at < PENDING_GRACE_MS && now >= marker.at {
            return MacPreviousOutcome::None;
        }
        let backup_kept = Path::new(&marker.backup).symlink_metadata().is_ok();
        self.note(&format!(
            "update {} -> {} did not take effect; running {current}{}",
            marker.from,
            marker.to,
            if backup_kept { format!("; the previous version is still at {}", marker.backup) } else { String::new() }
        ));
        let _ = fs::remove_file(self.marker_file());
        self.clean_staging_of(&marker.to);
        MacPreviousOutcome::Failed { version: marker.to }
    }

    fn clean_staging_of(&self, version: &str) {
        for name in self.dir_names() {
            if staged_file_version(&name).as_deref() == Some(version) {
                let _ = remove_all(&self.dir().join(&name));
            }
        }
    }

    /// Called once the main window of the new version is up: writes `ready` (the 1.1.4 swap script waits for it for 30 s),
    /// removes the marker and cleans up after a finished update.
    pub fn mark_ready(&self) {
        let Some(marker) = self.read_marker() else { return };
        let current = self.d.current_version.clone();
        if compare_versions(&current, &marker.to) == Ordering::Less {
            return;
        }
        let _ = fs::create_dir_all(self.dir());
        let _ = fs::write(self.ready_file(), &current);
        let _ = fs::remove_file(self.marker_file());
        self.note(&format!("update {} -> {} is running", marker.from, marker.to));
        // Only what belongs to this version or older: a newer download may already be running.
        self.clean_finished(&current);
        // The swap normally removes the previous version itself; this covers one that gave up waiting.
        self.remove_siblings(&marker.bundle, ".old-", |_| true);
    }
}

fn code_text(code: Option<i32>) -> String {
    code.map_or_else(|| "null".into(), |c| c.to_string())
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `rm -rf` that never follows a symlink.
fn remove_all(path: &Path) -> io::Result<()> {
    match path.symlink_metadata() {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

/// Unpacks the Tauri updater archive (`tar.gz` of the `.app`), keeping modes and symlinks; entries that would land outside
/// `dest` are refused by `tar` itself.
fn unpack_tar_gz(archive: &Path, dest: &Path) -> io::Result<()> {
    let file = fs::File::open(archive)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(io::BufReader::new(file)));
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);
    tar.unpack(dest)
}

#[cfg(test)]
mod tests;
