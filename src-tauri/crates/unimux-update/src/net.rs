//! The coordinator's [`Backend`] for Tauri clients: `latest.json` through unimux-net (B3: system proxy, `Cache-Control:
//! no-cache`, GitHub hosts only, 90 s), the artifact downloaded with progress and cancel into `<updater root>/pending`, then
//! verified with the embedded minisign key. 1.1.4's electron-updater kept its download in `%LOCALAPPDATA%\unimux-updater\pending`
//! too, and reused a complete copy there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;

use unimux_net::{HttpClient, Url, calls};

use crate::coordinator::{Backend, BoxFut, CHECK_FAILED, FoundUpdate, LookupResult, Manual, Progress, ProgressFn};
use crate::feed::{self, FeedAsset};

/// macUpdate MAC_MESSAGES (translated in the renderer): the same texts for the same failures.
pub const SERVER_ERROR: &str = "Serwer aktualizacji zwrócił błąd. Spróbuj ponownie później.";
pub const VERIFY_FAILED: &str = "Pobrana aktualizacja nie przeszła weryfikacji i nie zostanie zainstalowana.";
pub const DOWNLOAD_CANCELLED: &str = "download cancelled";
/// How often a running download reports (electron-updater reports about every second; the status bar and the gate want more).
const REPORT_EVERY_MS: u128 = 250;

pub struct NetBackendOptions {
    /// None: made on first use with the system settings (B3).
    pub client: Option<Arc<HttpClient>>,
    /// MC_UPDATE_FEED (dev-overrides builds): a folder with `latest.json` and the artifacts, served over HTTP.
    pub dev_feed: Option<String>,
    /// base64 of the minisign public key file ([`crate::UPDATER_PUBLIC_KEY`], or a test key in a check build).
    pub public_key: String,
    pub current_version: String,
    /// Where downloads go (`<updater root>/pending`).
    pub download_dir: PathBuf,
    /// Some: this app cannot install by itself (macOS until the U5 engine): every update is offered as the download page, with
    /// this reason.
    pub manual: Option<Manual>,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

pub struct NetBackend {
    o: NetBackendOptions,
    /// Offers by version: a stale (older) answer of the feed must not replace the asset a download is about to use.
    offers: Mutex<HashMap<String, FeedAsset>>,
    downloaded: Mutex<HashMap<String, PathBuf>>,
    client: Mutex<Option<Arc<HttpClient>>>,
    me: std::sync::Weak<NetBackend>,
}

/// The file name of an artifact URL (its last path segment, made safe), so a reused copy is found again.
pub fn file_name_of(url: &str, version: &str) -> String {
    let fallback = format!("unimux-update-{version}");
    let name = Url::parse(url)
        .ok()
        .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_string)))
        .map(|s| percent_decode(&s))
        .unwrap_or_default();
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    let safe = safe.trim_start_matches('.').to_string();
    if safe.is_empty() { fallback } else { safe }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl NetBackend {
    pub fn new(o: NetBackendOptions) -> Arc<Self> {
        let client = o.client.clone();
        Arc::new_cyclic(|me| Self {
            o,
            offers: Mutex::new(HashMap::new()),
            downloaded: Mutex::new(HashMap::new()),
            client: Mutex::new(client),
            me: me.clone(),
        })
    }

    /// The verified artifact of `version`, once its download finished.
    pub fn artifact(&self, version: &str) -> Option<PathBuf> {
        self.downloaded.lock().get(version).cloned().filter(|p| p.is_file())
    }

    /// The HTTP client, made on first use (its TLS setup reads the system certificate store).
    fn client(&self) -> Result<Arc<HttpClient>, String> {
        let mut client = self.client.lock();
        if let Some(c) = &*client {
            return Ok(c.clone());
        }
        let made = Arc::new(HttpClient::new().map_err(|e| {
            (self.o.log)(&format!("update client: {e}"));
            CHECK_FAILED.to_string()
        })?);
        *client = Some(made.clone());
        Ok(made)
    }

    fn extra_origins(&self) -> Vec<String> {
        self.o
            .dev_feed
            .as_deref()
            .and_then(|f| Url::parse(f).ok())
            .map(|u| vec![u.origin().ascii_serialization()])
            .unwrap_or_default()
    }

    async fn lookup_feed(self: Arc<Self>) -> Result<LookupResult, String> {
        let url = feed::feed_url(self.o.dev_feed.as_deref());
        let req =
            calls::update_request(&url, self.extra_origins(), Some(calls::UPDATE_FEED_TIMEOUT)).map_err(|e| e.to_string())?;
        let response = self.client()?.fetch(req).await.map_err(|e| {
            (self.o.log)(&format!("update feed: {e}"));
            CHECK_FAILED.to_string()
        })?;
        if !response.ok() {
            (self.o.log)(&format!("update feed: HTTP {}", response.status));
            return Err(SERVER_ERROR.to_string());
        }
        let feed = feed::parse_feed(&response.text(), feed::platform_keys()).map_err(|e| {
            (self.o.log)(&format!("update feed: {e}"));
            CHECK_FAILED.to_string()
        })?;
        let latest = Some(feed.version.clone());
        if !feed::offers_update(&feed, &self.o.current_version) {
            return Ok(LookupResult { latest, update: None });
        }
        let manual = match &feed.asset {
            Some(asset) => {
                self.offers.lock().insert(feed.version.clone(), asset.clone());
                self.o.manual.clone()
            }
            // A release without an artifact for this platform: only the download page.
            None => Some(Manual::default()),
        };
        Ok(LookupResult { latest, update: Some(FoundUpdate { version: feed.version, manual }) })
    }

    async fn fetch_artifact(
        self: Arc<Self>,
        version: String,
        on_progress: ProgressFn,
        cancel: CancellationToken,
    ) -> Result<(), String> {
        let asset = self.offers.lock().get(&version).cloned().ok_or_else(|| CHECK_FAILED.to_string())?;
        let dir = self.o.download_dir.clone();
        let name = file_name_of(&asset.url, &version);
        let dest = dir.join(&name);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("{}: {e}", dir.display()))?;
        remove_others(&dir, &name);
        // A complete copy from an earlier run (or an earlier attempt of this one) is used again when it still verifies.
        if dest.is_file() {
            let (key, sig, file) = (self.o.public_key.clone(), asset.signature.clone(), dest.clone());
            if tokio::task::spawn_blocking(move || feed::verify_file(&key, &sig, &file)).await.is_ok_and(|r| r.is_ok()) {
                let size = std::fs::metadata(&dest).map(|m| m.len() as f64).unwrap_or(0.0);
                on_progress(Progress { percent: 100.0, transferred: Some(size), total: Some(size), bytes_per_second: Some(0.0) });
                self.downloaded.lock().insert(version, dest);
                return Ok(());
            }
            let _ = std::fs::remove_file(&dest);
        }
        let partial = dir.join(format!("{name}.partial-{}", std::process::id()));
        let result = self.stream_to(&asset.url, &partial, &on_progress, &cancel).await;
        if let Err(e) = result {
            let _ = tokio::fs::remove_file(&partial).await;
            if cancel.is_cancelled() {
                return Err(DOWNLOAD_CANCELLED.into());
            }
            return Err(e);
        }
        let (key, sig, file) = (self.o.public_key.clone(), asset.signature.clone(), partial.clone());
        let verified = tokio::task::spawn_blocking(move || feed::verify_file(&key, &sig, &file))
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        if let Err(e) = verified {
            (self.o.log)(&format!("update {version}: {e}"));
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(VERIFY_FAILED.into());
        }
        tokio::fs::rename(&partial, &dest).await.map_err(|e| format!("{}: {e}", dest.display()))?;
        self.downloaded.lock().insert(version, dest);
        Ok(())
    }

    async fn stream_to(
        &self,
        url: &str,
        partial: &Path,
        on_progress: &ProgressFn,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let req = calls::update_request(url, self.extra_origins(), None).map_err(|e| e.to_string())?.cancel(cancel.clone());
        let mut response = self.client()?.fetch_stream(req).await.map_err(|e| {
            (self.o.log)(&format!("update download: {e}"));
            e.to_string()
        })?;
        if !response.ok() {
            (self.o.log)(&format!("update download: HTTP {}", response.status));
            return Err(SERVER_ERROR.into());
        }
        let total = response.content_length().map(|t| t as f64);
        let mut file = tokio::fs::File::create(partial).await.map_err(|e| format!("{}: {e}", partial.display()))?;
        let started = Instant::now();
        let mut last_report = Instant::now();
        let mut transferred = 0f64;
        let report = |transferred: f64| {
            let secs = started.elapsed().as_secs_f64().max(0.001);
            let percent = match total {
                Some(t) if t > 0.0 => transferred / t * 100.0,
                _ => 0.0,
            };
            on_progress(Progress {
                percent,
                transferred: Some(transferred),
                total: Some(total.unwrap_or(0.0)),
                bytes_per_second: Some((transferred / secs).round()),
            });
        };
        report(0.0);
        while let Some(chunk) = response.body.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            transferred += chunk.len() as f64;
            if last_report.elapsed().as_millis() >= REPORT_EVERY_MS {
                last_report = Instant::now();
                report(transferred);
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        if total.is_some_and(|t| t != transferred) {
            return Err("Pobrana aktualizacja jest uszkodzona (zła suma kontrolna lub rozmiar).".into());
        }
        report(transferred);
        Ok(())
    }
}

/// Earlier downloads (other versions, partial files of killed runs) go before a new one starts.
fn remove_others(dir: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() != keep && entry.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

impl Backend for NetBackend {
    fn lookup(&self) -> BoxFut<Result<LookupResult, String>> {
        let me = self.self_arc();
        Box::pin(me.lookup_feed())
    }

    fn download(&self, version: &str, on_progress: ProgressFn, cancel: CancellationToken) -> BoxFut<Result<(), String>> {
        let me = self.self_arc();
        Box::pin(me.fetch_artifact(version.to_string(), on_progress, cancel))
    }
}

impl NetBackend {
    /// The backend is always held in an Arc ([`NetBackend::new`]); the trait methods take `&self`.
    fn self_arc(&self) -> Arc<Self> {
        self.me.upgrade().expect("NetBackend lives in the Arc NetBackend::new made")
    }
}
