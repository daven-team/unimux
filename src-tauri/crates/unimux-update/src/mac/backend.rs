//! The coordinator's [`Backend`] on macOS (1.1.4's updater.ts with `isMac()`): the [`MacUpdater`] engine behind the same
//! [`crate::coordinator::UpdateCoordinator`] as the Windows background update. A lookup reads `latest.json` and asks the engine
//! for an offer; an app that cannot replace itself gets the download page with the refusal's reason (`portable` + message); a
//! download fetches, verifies and stages the bundle next to the app; [`MacBackend::install`] re-checks the staged copy and
//! returns the swap the update window runs once this process is gone.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use unimux_net::HttpClient;

use super::engine::{MacInstall, MacOffer, MacProgress, MacStaged, MacUpdater, messages};
use crate::coordinator::{Backend, BoxFut, CHECK_FAILED, FoundUpdate, LookupResult, Manual, Progress, ProgressFn};
use crate::net::fetch_feed_text;

pub struct MacBackendOptions {
    /// None: made on first use with the system settings (B3).
    pub client: Option<Arc<HttpClient>>,
    /// MC_UPDATE_FEED (dev-overrides builds): a folder with `latest.json` and the archives, served over HTTP. Its origin must
    /// also be in the engine's `trusted_origins`.
    pub dev_feed: Option<String>,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

pub struct MacBackend {
    updater: Arc<MacUpdater>,
    o: MacBackendOptions,
    client: Mutex<Option<Arc<HttpClient>>>,
    /// Offers by version: a stale (older) feed answer must not replace the archive a download is about to use.
    offers: Mutex<HashMap<String, MacOffer>>,
    /// Verified bundles staged next to the app, by version.
    staged: Mutex<HashMap<String, MacStaged>>,
    me: Weak<MacBackend>,
}

impl MacBackend {
    pub fn new(updater: Arc<MacUpdater>, o: MacBackendOptions) -> Arc<Self> {
        let client = o.client.clone();
        Arc::new_cyclic(|me| Self {
            updater,
            o,
            client: Mutex::new(client),
            offers: Mutex::new(HashMap::new()),
            staged: Mutex::new(HashMap::new()),
            me: me.clone(),
        })
    }

    pub fn updater(&self) -> &Arc<MacUpdater> {
        &self.updater
    }

    /// The staged bundle of `version`, once its download finished.
    pub fn staged(&self, version: &str) -> Option<MacStaged> {
        self.staged.lock().get(version).cloned()
    }

    /// `install(staged)` of 1.1.4: re-checks the install target and the staged copy and writes `pending.json`. Ready: the swap
    /// for the update window. Refused: the app can no longer replace itself (the caller offers the download page). Err: the
    /// staged copy is gone or changed (the message to show).
    pub fn install(&self, version: &str) -> Result<MacInstall, String> {
        let staged = self.staged(version).ok_or_else(|| messages::VERIFY.to_string())?;
        let result = self.updater.install(&staged);
        if !matches!(result, Ok(MacInstall::Ready(_))) {
            // A refused or failed install never runs from this copy again; the next download stages a fresh one.
            self.staged.lock().remove(version);
        }
        result
    }

    /// The update window could not be started after [`MacBackend::install`]: the marker goes, the message to show.
    pub fn abandon_install(&self) -> &'static str {
        self.updater.abandon_install()
    }

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

    async fn lookup_feed(self: Arc<Self>) -> Result<LookupResult, String> {
        let text = fetch_feed_text(&*self.client()?, self.o.dev_feed.as_deref(), &*self.o.log).await?;
        let feed: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| {
            (self.o.log)(&format!("update feed: latest.json: {e}"));
            messages::BAD_FEED.to_string()
        })?;
        // The install target check reads the file system: off the async workers.
        let updater = self.updater.clone();
        let result = tokio::task::spawn_blocking(move || updater.check(&feed)).await.map_err(|e| e.to_string())??;
        let latest = Some(result.latest);
        let Some(offer) = result.offer else { return Ok(LookupResult { latest, update: None }) };
        let manual = offer.refusal.map(|reason| Manual { message: Some(reason.message().to_string()) });
        let version = offer.version.clone();
        self.offers.lock().insert(version.clone(), offer);
        Ok(LookupResult { latest, update: Some(FoundUpdate { version, manual }) })
    }

    async fn fetch(self: Arc<Self>, version: String, on_progress: ProgressFn, cancel: CancellationToken) -> Result<(), String> {
        let offer = self.offers.lock().get(&version).cloned().ok_or_else(|| CHECK_FAILED.to_string())?;
        let client = self.client()?;
        let mut report = move |p: MacProgress| {
            on_progress(Progress {
                percent: p.percent,
                transferred: Some(p.transferred as f64),
                total: Some(p.total as f64),
                bytes_per_second: Some(p.bytes_per_second),
            })
        };
        let staged = self.updater.download(&client, &offer, &mut report, &cancel).await?;
        self.staged.lock().insert(version, staged);
        Ok(())
    }

    fn self_arc(&self) -> Arc<Self> {
        self.me.upgrade().expect("MacBackend lives in the Arc MacBackend::new made")
    }
}

impl Backend for MacBackend {
    fn lookup(&self) -> BoxFut<Result<LookupResult, String>> {
        Box::pin(self.self_arc().lookup_feed())
    }

    fn download(&self, version: &str, on_progress: ProgressFn, cancel: CancellationToken) -> BoxFut<Result<(), String>> {
        Box::pin(self.self_arc().fetch(version.to_string(), on_progress, cancel))
    }

    /// The engine limits silent downloads itself (60 s stall, 15 min total) and unpacks and checks the bundle without progress.
    fn self_watched(&self) -> bool {
        true
    }
}
