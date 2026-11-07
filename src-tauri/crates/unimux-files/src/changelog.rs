//! Release notes shown in the app (src/main/changelog.ts, src/shared/changelog.ts): the repository's GitHub releases, kept in
//! memory for 10 minutes and on disk (`<data>/changelog.json`, the raw API answer) for offline use. The markdown blocks are
//! made by the renderer (parseNotes stays in TS); this side gives the entries.
//!
//! The regular expressions of 1.1.4 are written out by hand: they are JS regexes without the `u` flag, so `/i` folds ASCII
//! letters only, `^` with `/m` starts after any JS line terminator and `\s` / `trim()` use JS's white space set.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use unimux_core::utf16::{is_js_space_char, js_trim};

/// changelog.ts RELEASES_API.
pub const RELEASES_API: &str = "https://api.github.com/repos/daven-team/unimux/releases?per_page=30";
/// changelog.ts FRESH_MS.
pub const FRESH_MS: i64 = 10 * 60 * 1000;

/// One release as the renderer shows it (`ChangelogEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct ChangelogEntry {
    pub version: String,
    pub name: String,
    /// ISO publication date.
    pub date: String,
    pub url: String,
    /// Markdown without the download guide that every release body ends with.
    pub notes: String,
    pub prerelease: bool,
}

impl ChangelogEntry {
    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "name": self.name,
            "date": self.date,
            "url": self.url,
            "notes": self.notes,
            "prerelease": self.prerelease,
        })
    }
}

fn entries_json(entries: &[ChangelogEntry]) -> Value {
    Value::Array(entries.iter().map(ChangelogEntry::to_json).collect())
}

/// `/^v?(\d+)\.(\d+)\.(\d+)$/`: the three digit strings.
fn semver(tag: &str) -> Option<[&str; 3]> {
    let rest = tag.strip_prefix('v').unwrap_or(tag);
    let mut parts = rest.split('.');
    let out = [parts.next()?, parts.next()?, parts.next()?];
    if parts.next().is_some() || out.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    Some(out)
}

/// `compareVersions`: negative, 0 or positive like the TS function (0 when either is not a version). The captures are compared
/// as strings first, so "01" against "1" ends the comparison with `Number("01") - Number("1")` = 0.
pub fn compare_versions(a: &str, b: &str) -> f64 {
    let (Some(left), Some(right)) = (semver(a), semver(b)) else { return 0.0 };
    let number = |s: &str| s.parse::<f64>().unwrap_or(f64::INFINITY);
    for i in 0..3 {
        if left[i] != right[i] {
            return number(left[i]) - number(right[i]);
        }
    }
    0.0
}

/// JS line terminators (where `^` matches with the `m` flag).
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// ASCII-only case-insensitive prefix check (`/i` without `u` on an ASCII pattern).
fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// `\s+` at the start: the rest after one or more JS white space characters, None without one.
fn after_spaces(s: &str) -> Option<&str> {
    let rest = s.trim_start_matches(is_js_space_char);
    (rest.len() < s.len()).then_some(rest)
}

/// `#{1,3}\s+Which download should I choose\?` at the start of `s`.
fn is_guide_heading(s: &str) -> bool {
    let hashes = s.bytes().take_while(|b| *b == b'#').count();
    if !(1..=3).contains(&hashes) {
        return false;
    }
    after_spaces(&s[hashes..]).is_some_and(|rest| starts_with_ci(rest, "Which download should I choose?"))
}

/// `body.search(/^#{1,3}\s+Which download should I choose\?/im)` as a byte index.
fn guide_start(body: &str) -> Option<usize> {
    if is_guide_heading(body) {
        return Some(0);
    }
    body.char_indices()
        .filter(|(_, c)| is_line_terminator(*c))
        .map(|(i, c)| i + c.len_utf8())
        .find(|&i| is_guide_heading(&body[i..]))
}

/// `/^#\s+(?:unimux|ajzakomator)\s+\d/i`
fn is_title(part: &str) -> bool {
    let Some(rest) = part.strip_prefix('#').and_then(after_spaces) else { return false };
    let rest = if starts_with_ci(rest, "unimux") {
        &rest[6..]
    } else if starts_with_ci(rest, "ajzakomator") {
        &rest[11..]
    } else {
        return false;
    };
    after_spaces(rest).is_some_and(|r| r.as_bytes().first().is_some_and(u8::is_ascii_digit))
}

/// `/^Windows packages for (?:unimux|ajzakomator)/i`
fn is_packages_line(part: &str) -> bool {
    starts_with_ci(part, "Windows packages for ") && {
        let rest = &part[21..];
        starts_with_ci(rest, "unimux") || starts_with_ci(rest, "ajzakomator")
    }
}

/// `/^Validated with\b/i` (`\b` with JS's ASCII word characters).
fn is_validated_line(part: &str) -> bool {
    starts_with_ci(part, "Validated with") && !part.as_bytes().get(14).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// `cleanReleaseNotes`: drops the title, the download guide and housekeeping lines so only what changed remains.
pub fn clean_release_notes(body: &str) -> String {
    let text = match guide_start(body) {
        Some(i) => &body[..i],
        None => body,
    }
    .replace("\r\n", "\n");
    let mut kept: Vec<&str> = Vec::new();
    let mut rest = text.as_str();
    // `.split(/\n{2,}/)`
    loop {
        let (part, next) = match rest.find("\n\n") {
            Some(i) => {
                let run = rest[i..].bytes().take_while(|b| *b == b'\n').count();
                (&rest[..i], Some(&rest[i + run..]))
            }
            None => (rest, None),
        };
        let part = js_trim(part);
        if !part.is_empty() && !is_title(part) && !is_packages_line(part) && !is_validated_line(part) {
            kept.push(part);
        }
        match next {
            Some(n) => rest = n,
            None => break,
        }
    }
    js_trim(&kept.join("\n\n")).to_string()
}

/// JS truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn str_of<'a>(item: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Value::as_str)
}

/// `parseReleases`: published releases of the GitHub API response, newest version first.
pub fn parse_releases(json: &Value) -> Vec<ChangelogEntry> {
    let Some(list) = json.as_array() else { return Vec::new() };
    let empty = Map::new();
    let mut entries: Vec<ChangelogEntry> = Vec::new();
    for item in list {
        let item = item.as_object().unwrap_or(&empty);
        let tag = str_of(item, "tag_name").unwrap_or("");
        if truthy(item.get("draft")) || semver(tag).is_none() {
            continue;
        }
        let version = tag.strip_prefix('v').unwrap_or(tag).to_string();
        entries.push(ChangelogEntry {
            name: str_of(item, "name")
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("unimux {version}")),
            date: str_of(item, "published_at").or_else(|| str_of(item, "created_at")).unwrap_or("").to_string(),
            url: str_of(item, "html_url").unwrap_or("").to_string(),
            notes: clean_release_notes(str_of(item, "body").unwrap_or("")),
            prerelease: truthy(item.get("prerelease")),
            version,
        });
    }
    // Array.prototype.sort is stable, like sort_by.
    entries.sort_by(|a, b| compare_versions(&b.version, &a.version).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    entries
}

/// The fetch of the release list: the parsed JSON, or the message of the error (`GitHub <status>` for a non-2xx answer).
pub type FetchJson = Arc<dyn Fn() -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn epoch_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Default)]
struct Inner {
    memory: Option<(Vec<ChangelogEntry>, i64)>,
    pending: Option<Shared<BoxFuture<'static, Value>>>,
}

/// `createChangelog`: fetches the release notes, remembers them in memory and on disk, falls back to the saved copy offline.
pub struct Changelog {
    fetch: FetchJson,
    cache_file: PathBuf,
    now: Clock,
    inner: Mutex<Inner>,
}

impl Changelog {
    pub fn new(fetch: FetchJson, cache_file: PathBuf, now: Clock) -> Arc<Self> {
        Arc::new(Self { fetch, cache_file, now, inner: Mutex::new(Inner::default()) })
    }

    /// `get(force)`: the fresh copy (under 10 minutes old) unless forced; concurrent calls share one request.
    pub async fn get(self: &Arc<Self>, force: bool) -> Value {
        let pending = {
            let mut inner = self.inner.lock();
            if !force
                && let Some((entries, at)) = &inner.memory
                && (self.now)() - at < FRESH_MS
            {
                return json!({ "entries": entries_json(entries), "stale": false });
            }
            let me = self.clone();
            inner
                .pending
                .get_or_insert_with(|| {
                    async move {
                        let result = me.load().await;
                        me.inner.lock().pending = None;
                        result
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        pending.await
    }

    /// The saved entries: the memory copy, else the file's (none when it is missing or unreadable).
    fn saved(&self) -> Vec<ChangelogEntry> {
        if let Some((entries, _)) = &self.inner.lock().memory {
            return entries.clone();
        }
        std::fs::read_to_string(&self.cache_file)
            .ok()
            .and_then(|text| unimux_core::js_json::parse(&text).ok())
            .map(|json| parse_releases(&json))
            .unwrap_or_default()
    }

    async fn load(&self) -> Value {
        match (self.fetch)().await {
            Ok(json) => {
                let entries = parse_releases(&json);
                self.inner.lock().memory = Some((entries.clone(), (self.now)()));
                // The cache is optional: a failed write changes nothing.
                if let Some(dir) = self.cache_file.parent() {
                    let _ = std::fs::create_dir_all(dir)
                        .and_then(|()| std::fs::write(&self.cache_file, unimux_core::js_json::stringify(&json)));
                }
                json!({ "entries": entries_json(&entries), "stale": false })
            }
            Err(error) => {
                let entries = self.saved();
                json!({ "entries": entries_json(&entries), "stale": !entries.is_empty(), "error": error })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    const GUIDE: &str = "\n\n## Which download should I choose?\n\nChoose from the assets attached to this release.\n";

    fn release(tag: &str, body: &str) -> Value {
        json!({
            "tag_name": tag, "name": format!("unimux {}", &tag[1..]), "published_at": "2026-10-10T12:00:00Z",
            "html_url": format!("https://example.test/{tag}"), "body": body, "draft": false, "prerelease": false,
        })
    }

    #[test]
    fn removes_the_title_the_download_guide_and_housekeeping_lines() {
        let body = format!("# unimux 0.5.4\n\n- Added a window.\n- Fixed a bug.\n\nValidated with unit tests.{GUIDE}");
        assert_eq!(clean_release_notes(&body), "- Added a window.\n- Fixed a bug.");
        assert_eq!(
            clean_release_notes(&format!("New status bar.\n\nWindows packages for unimux 0.5.5.{GUIDE}")),
            "New status bar."
        );
        assert_eq!(
            clean_release_notes(&format!(
                "# ajzakomator 0.5.4\n\n- Legacy release.\n\nWindows packages for ajzakomator 0.5.4.{GUIDE}"
            )),
            "- Legacy release."
        );
        assert_eq!(clean_release_notes(""), "");
    }

    #[test]
    fn the_hand_written_patterns_follow_js_regex_rules() {
        // `^` after a lone \r or U+2028, `\s+` across lines, four hashes are no guide, ASCII-only case folding.
        assert_eq!(clean_release_notes("a\r### which DOWNLOAD should i choose?\nx"), "a");
        assert_eq!(clean_release_notes("a\u{2028}# Which download should I choose?"), "a");
        assert_eq!(clean_release_notes("a\n#\n\nWhich download should I choose? x"), "a");
        assert_eq!(clean_release_notes("a\n#### Which download should I choose?"), "a\n#### Which download should I choose?");
        assert_eq!(clean_release_notes("a\n## Which download ſhould I choose?"), "a\n## Which download ſhould I choose?");
        assert!(is_validated_line("Validated with"));
        assert!(is_validated_line("validated with-x"));
        assert!(!is_validated_line("Validated without"));
        assert!(is_title("#\u{a0}UNIMUX\t1.0"));
        assert!(!is_title("## unimux 1.0"));
        assert!(!is_title("# unimux x"));
        assert_eq!(clean_release_notes("\u{feff}x\r\n\r\n\r\n y \n\n\n\n"), "x\n\ny");
    }

    #[test]
    fn lists_published_releases_newest_first_and_skips_drafts_and_non_version_tags() {
        let mut draft = release("v9.9.9", "- d");
        draft["draft"] = json!(true);
        let entries = parse_releases(&json!([
            release("v0.5.3", "- a"),
            release("v0.10.0", "- b"),
            release("v0.5.10", "- c"),
            release("nightly", "- x"),
            draft
        ]));
        assert_eq!(entries.iter().map(|e| e.version.as_str()).collect::<Vec<_>>(), ["0.10.0", "0.5.10", "0.5.3"]);
        assert_eq!(entries[0].name, "unimux 0.10.0");
        assert_eq!(entries[0].date, "2026-10-10T12:00:00Z");
        assert_eq!(entries[0].url, "https://example.test/v0.10.0");
        assert_eq!(entries[0].notes, "- b");
        assert!(parse_releases(&json!({ "message": "rate limited" })).is_empty());
        // Missing fields fall back like 1.1.4.
        let bare = parse_releases(&json!([{ "tag_name": "1.2.3", "name": "", "created_at": "c", "prerelease": 1 }, null, 5]));
        assert_eq!(
            bare,
            vec![ChangelogEntry {
                version: "1.2.3".into(),
                name: "unimux 1.2.3".into(),
                date: "c".into(),
                url: String::new(),
                notes: String::new(),
                prerelease: true
            }]
        );
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(compare_versions("0.5.10", "0.5.9") > 0.0);
        assert_eq!(compare_versions("v0.5.3", "0.5.3"), 0.0);
        assert!(compare_versions("0.4.9", "0.5.0") < 0.0);
        assert_eq!(compare_versions("x", "0.5.0"), 0.0);
        assert_eq!(compare_versions("0.5.0\n", "0.4.0"), 0.0);
    }

    fn fetch_counting(answer: Result<Value, String>, calls: Arc<AtomicUsize>) -> FetchJson {
        Arc::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            let answer = answer.clone();
            async move {
                // A request that takes a moment, so concurrent callers overlap.
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                answer
            }
            .boxed()
        })
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap()
    }

    #[test]
    fn fetches_once_serves_the_fresh_copy_and_refetches_when_forced() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let time = Arc::new(AtomicI64::new(0));
        let t = time.clone();
        let releases = json!([release("v0.5.5", "- new"), release("v0.5.4", "- old")]);
        let service = Changelog::new(
            fetch_counting(Ok(releases.clone()), calls.clone()),
            dir.path().join("changelog.json"),
            Arc::new(move || t.load(Ordering::SeqCst)),
        );
        rt().block_on(async {
            let first = service.get(false).await;
            let versions: Vec<&str> =
                first["entries"].as_array().unwrap().iter().map(|e| e["version"].as_str().unwrap()).collect();
            assert_eq!(versions, ["0.5.5", "0.5.4"]);
            assert_eq!(first["stale"], false);
            assert!(first.get("error").is_none());
            service.get(false).await;
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            service.get(true).await;
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            time.store(11 * 60 * 1000, Ordering::SeqCst);
            service.get(false).await;
            assert_eq!(calls.load(Ordering::SeqCst), 3);
        });
        let saved = std::fs::read_to_string(dir.path().join("changelog.json")).unwrap();
        assert_eq!(saved, unimux_core::js_json::stringify(&releases));
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap().as_array().unwrap().len(), 2);
    }

    #[test]
    fn deduplicates_concurrent_requests() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let service = Changelog::new(
            fetch_counting(Ok(json!([release("v0.5.5", "- new")])), calls.clone()),
            dir.path().join("c.json"),
            Arc::new(epoch_ms),
        );
        rt().block_on(async {
            let (a, b, c) = futures::join!(service.get(false), service.get(false), service.get(true));
            assert_eq!(a, b);
            assert_eq!(b, c);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn falls_back_to_the_saved_copy_offline_and_reports_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("c.json");
        std::fs::write(&file, json!([release("v0.5.5", "- new"), release("v0.5.4", "- old")]).to_string()).unwrap();
        let service = Changelog::new(fetch_counting(Err("offline".into()), Arc::default()), file, Arc::new(epoch_ms));
        let result = rt().block_on(service.get(false));
        assert_eq!(result["stale"], true);
        assert_eq!(result["error"], "offline");
        assert_eq!(result["entries"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn reports_an_empty_result_with_the_error_when_nothing_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let service = Changelog::new(
            fetch_counting(Err("GitHub 403".into()), Arc::default()),
            dir.path().join("missing.json"),
            Arc::new(epoch_ms),
        );
        assert_eq!(rt().block_on(service.get(false)), json!({ "entries": [], "stale": false, "error": "GitHub 403" }));
    }

    #[test]
    fn an_offline_call_after_a_good_one_serves_the_memory_copy() {
        let dir = tempfile::tempdir().unwrap();
        let ok = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let o = ok.clone();
        let fetch: FetchJson = Arc::new(move || {
            let good = o.load(Ordering::SeqCst);
            async move { if good { Ok(json!([release("v1.0.0", "- x")])) } else { Err("down".to_string()) } }.boxed()
        });
        // The saved file is never written here (a folder in the way): the memory copy answers.
        let blocked = dir.path().join("dir");
        std::fs::create_dir(&blocked).unwrap();
        let service = Changelog::new(fetch, blocked, Arc::new(epoch_ms));
        rt().block_on(async {
            assert_eq!(service.get(false).await["entries"].as_array().unwrap().len(), 1);
            ok.store(false, Ordering::SeqCst);
            let result = service.get(true).await;
            assert_eq!(result["stale"], true);
            assert_eq!(result["error"], "down");
            assert_eq!(result["entries"][0]["version"], "1.0.0");
        });
    }
}
