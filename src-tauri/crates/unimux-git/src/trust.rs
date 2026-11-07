//! The trust model (G2): the pure part of src/shared/gitTrust.ts (what in a repository's own configuration can make git start
//! a program), the fingerprint of a scan (`scan()` of src/main/git.ts: sha256 of `JSON.stringify(fingerprint.sort())`) and
//! `GitTrustStore` (git-trust.json: canonical root -> fingerprint, `JSON.stringify(Object.fromEntries(map), null, 2)` written
//! atomically, byte-compatible with 1.1.4). The scan itself (git runs, file reads) is [`crate::Git::scan`].

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js::{JS_LINE_TERMINATORS, js_sort};
use crate::text::{JS_SPACE, js_trim, redact_secrets};

/// One `git config --list -z` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigEntry {
    pub key: String,
    pub value: String,
}

/// `parseConfigList`: "key" LF "value" NUL, a key without a value has no LF.
pub fn parse_config_list(stdout: &str) -> Vec<ConfigEntry> {
    stdout
        .split('\0')
        .filter(|r| !r.is_empty())
        .map(|record| match record.split_once('\n') {
            Some((key, value)) => ConfigEntry { key: key.into(), value: value.into() },
            None => ConfigEntry { key: record.into(), value: String::new() },
        })
        .collect()
}

const EXEC_KEYS: [&str; 16] = [
    "diff.external",
    "core.hookspath",
    "core.sshcommand",
    "core.pager",
    "core.editor",
    "core.askpass",
    "core.gitproxy",
    "core.worktree",
    "sequence.editor",
    "gpg.program",
    "gpg.openpgp.program",
    "gpg.x509.program",
    "gpg.ssh.program",
    "uploadpack.packobjectshook",
    "interactive.difffilter",
    "include.path",
];

/// `.+` of a JS regex without the `s` flag.
fn any_plus() -> String {
    format!("[^{JS_LINE_TERMINATORS}]+")
}

static EXEC_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let a = any_plus();
    [
        format!(r"^filter\.{a}\.(clean|smudge|process)$"),
        format!(r"^diff\.{a}\.(textconv|command)$"),
        format!(r"^merge\.{a}\.(driver|recursivedriver)$"),
        format!(r"^remote\.{a}\.(uploadpack|receivepack|uploadarchive|proxy|vcs)$"),
        format!(r"^pager\.{a}$"),
        format!(r"^includeif\.{a}\.path$"),
        format!(r"^protocol\.{a}\.allow$"),
        format!(r"^url\.{a}\.(insteadof|pushinsteadof)$"),
        format!(r"^gpg\.{a}\.program$"),
    ]
    .iter()
    .map(|p| Regex::new(p).expect("exec pattern"))
    .collect()
});
static CREDENTIAL_HELPER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^credential(\.{})?\.helper$", any_plus())).expect("credential regex"));
static SUBMODULE_UPDATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^submodule\.{}\.update$", any_plus())).expect("submodule regex"));
static ABSOLUTE_PROGRAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(!|/|[A-Za-z]:[\\/]|\\\\)").expect("absolute regex"));
/// `SAFE_CREDENTIAL_HELPER`: a credential helper named without a path runs as the shell command `git credential-<value>`, so
/// only the well-known helpers with plain `--option[=value]` arguments (or an empty value, which resets the list) pass. JS `\s`
/// is [`JS_SPACE`] and JS `\w` is ASCII only.
static SAFE_CREDENTIAL_HELPER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^((manager|manager-core|wincred|osxkeychain|libsecret|gnome-keyring|cache|store)([{JS_SPACE}]+--[A-Za-z][A-Za-z0-9_\-]*(=[A-Za-z0-9_.:/@~+\-]*)?)*)?$"
    ))
    .expect("credential helper regex")
});
static OFF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)^(false|no|off|0)?$").expect("off regex"));

/// `dangerousConfigKeys`: the configuration keys (never the values) that can start a program or redirect git to another one,
/// with credentials removed, deduplicated and in JS sort order.
pub fn dangerous_config_keys(entries: &[ConfigEntry]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for ConfigEntry { key, value } in entries {
        let k = key.to_lowercase();
        let mut hit = EXEC_KEYS.contains(&k.as_str()) || EXEC_PATTERNS.iter().any(|p| p.is_match(&k));
        if k == "core.fsmonitor" {
            hit = !OFF.is_match(js_trim(value));
        } else if k == "protocol.allow" {
            hit = true;
        } else if CREDENTIAL_HELPER.is_match(&k) {
            let v = js_trim(value);
            hit = ABSOLUTE_PROGRAM.is_match(v) || !SAFE_CREDENTIAL_HELPER.is_match(v);
        } else if SUBMODULE_UPDATE.is_match(&k) {
            hit = js_trim(value).starts_with('!');
        }
        if hit {
            let redacted = redact_secrets(key);
            if seen.insert(redacted.clone()) {
                found.push(redacted);
            }
        }
    }
    js_sort(&mut found);
    found
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Filter,
    Diff,
    Merge,
}

impl DriverKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Filter => "filter",
            Self::Diff => "diff",
            Self::Merge => "merge",
        }
    }

    fn variables(self) -> &'static [&'static str] {
        match self {
            Self::Filter => &["clean", "smudge", "process"],
            Self::Diff => &["textconv", "command"],
            Self::Merge => &["driver"],
        }
    }
}

/// A driver an attributes file hands out (`filter=lfs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttributeDriver {
    pub kind: DriverKind,
    pub name: String,
}

static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").expect("line regex"));
static DRIVER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?:^|[{JS_SPACE}])(filter|diff|merge)=([^{JS_SPACE}]+)")).expect("driver regex"));

/// `attributeDrivers`: `*.png filter=lfs diff=lfs` gives filter=lfs and diff=lfs.
pub fn attribute_drivers(text: &str) -> Vec<AttributeDriver> {
    let mut out = Vec::new();
    for line in LINE_BREAK.split(text) {
        let trimmed = js_trim(line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        for m in DRIVER.captures_iter(trimmed) {
            let kind = match &m[1] {
                "filter" => DriverKind::Filter,
                "diff" => DriverKind::Diff,
                _ => DriverKind::Merge,
            };
            out.push(AttributeDriver { kind, name: m[2].to_string() });
        }
    }
    out
}

/// `configuredAttributeDrivers`: attribute references to drivers that some configuration (any scope) defines with a program.
pub fn configured_attribute_drivers(attributes: &[AttributeDriver], all: &[ConfigEntry]) -> Vec<String> {
    let defined: HashSet<String> = all.iter().map(|e| e.key.to_lowercase()).collect();
    let mut found: Vec<String> = Vec::new();
    for AttributeDriver { kind, name } in attributes {
        let lower = name.to_lowercase();
        if kind.variables().iter().any(|v| defined.contains(&format!("{}.{lower}.{v}", kind.as_str()))) {
            let key = format!(".gitattributes: {}={name}", kind.as_str());
            if !found.contains(&key) {
                found.push(key);
            }
        }
    }
    js_sort(&mut found);
    found
}

/// `createHash('sha256').update(data).digest('hex')`.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// The hash of a scan: `sha256(JSON.stringify(fingerprint.sort()))`. Sorts `fingerprint` in place like the TS code.
pub fn fingerprint_hash(fingerprint: &mut [String]) -> String {
    js_sort(fingerprint);
    let mut json = String::from("[");
    for (i, item) in fingerprint.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        unimux_core::js_json::write_string(&mut json, item);
    }
    json.push(']');
    sha256_hex(json.as_bytes())
}

/// What a scan found: the keys the Git panel lists and the fingerprint hash the trust store remembers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoScan {
    pub keys: Vec<String>,
    pub hash: String,
}

/// The hooks part of a scan: every file in `<commonDir>/hooks` that is not a ".sample" (on POSIX only the executable ones).
/// Like git.ts, the first file that cannot be stat'ed or read ends the walk (its key stays when only the read failed), and a
/// folder that cannot be listed counts as none. Returns the keys (`hooks/<name>`) and the fingerprint lines.
pub fn hook_fingerprints(common_dir: &Path) -> (Vec<String>, Vec<String>) {
    let mut keys = Vec::new();
    let mut prints = Vec::new();
    let hooks = common_dir.join("hooks");
    let Ok(dir) = std::fs::read_dir(&hooks) else { return (keys, prints) };
    let mut names = Vec::new();
    for entry in dir {
        match entry {
            Ok(e) => names.push(e.file_name()),
            Err(_) => return (Vec::new(), Vec::new()), // fs.readdir fails as a whole
        }
    }
    // libuv lists a folder sorted by strcmp on POSIX; on Windows in the file system's own order, like FindNextFileW.
    #[cfg(not(windows))]
    names.sort_by(|a, b| a.as_encoded_bytes().cmp(b.as_encoded_bytes()));
    for os_name in names {
        let name = os_name.to_string_lossy().into_owned();
        if name.ends_with(".sample") {
            continue;
        }
        let file = hooks.join(&os_name);
        let Ok(info) = std::fs::metadata(&file) else { break };
        if !info.is_file() || !executable(&info) {
            continue;
        }
        keys.push(format!("hooks/{name}"));
        let size = info.len();
        let digest = if size <= 1024 * 1024 {
            match std::fs::read(&file) {
                Ok(bytes) => sha256_hex(&bytes),
                Err(_) => break,
            }
        } else {
            sha256_hex(size.to_string().as_bytes())
        };
        prints.push(format!("hook:{name}:{digest}"));
    }
    (keys, prints)
}

#[cfg(unix)]
fn executable(info: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    info.permissions().mode() & 0o111 != 0
}

/// On Windows git runs a hook by its shebang, so the executable bit says nothing.
#[cfg(not(unix))]
fn executable(_info: &std::fs::Metadata) -> bool {
    true
}

/// The attributes files of a scan (`<root>/.gitattributes`, `<commonDir>/info/attributes`), each read when it is at most
/// 256 KiB (a missing or unreadable one is skipped).
pub fn attribute_files(root: &str, common_dir: &str) -> Vec<AttributeDriver> {
    let mut out = Vec::new();
    for file in [Path::new(root).join(".gitattributes"), Path::new(common_dir).join("info").join("attributes")] {
        let Ok(info) = std::fs::metadata(&file) else { continue };
        if info.len() > 256 * 1024 {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&file) {
            out.extend(attribute_drivers(&String::from_utf8_lossy(&bytes)));
        }
    }
    out
}

/// `GitTrustStore`: the repositories the user trusted, canonical root -> fingerprint hash, in git-trust.json.
pub struct TrustStore {
    file: Option<PathBuf>,
    map: Mutex<IndexMap<String, String>>,
}

impl TrustStore {
    /// Loads `file` (None: memory only). A missing or damaged file trusts nothing.
    pub fn new(file: Option<PathBuf>) -> Self {
        let map = file
            .as_deref()
            .and_then(|f| std::fs::read(f).ok())
            .map(|b| entries_of(&String::from_utf8_lossy(&b)))
            .unwrap_or_default();
        Self { file, map: Mutex::new(map) }
    }

    pub fn file(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    fn key(root: &str) -> String {
        crate::paths::canonical_path(root)
    }

    pub fn get(&self, root: &str) -> Option<String> {
        self.map.lock().get(&Self::key(root)).cloned()
    }

    /// Like 1.1.4 (the map update and the synchronous write are one step on the JS thread), the file is written while the map
    /// lock is held, so concurrent grants and revokes reach the disk in the order they changed the map and the file matches it.
    pub fn set(&self, root: &str, hash: &str) {
        let key = Self::key(root);
        let mut map = self.map.lock();
        map.insert(key, hash.to_string());
        self.save(&store_text(&map));
    }

    pub fn delete(&self, root: &str) {
        let key = Self::key(root);
        let mut map = self.map.lock();
        if map.shift_remove(&key).is_none() {
            return;
        }
        self.save(&store_text(&map));
    }

    /// The remembered entries in their order.
    pub fn entries(&self) -> Vec<(String, String)> {
        self.map.lock().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    fn save(&self, text: &str) {
        let Some(file) = &self.file else { return };
        // A failed write: trust then lasts until the app closes.
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = unimux_core::atomic_write::atomic_write(file, text.as_bytes(), &Default::default());
    }
}

/// What the constructor of GitTrustStore keeps of a file's text: `JSON.parse`, then the string values of
/// `Object.entries(parsed)` of an object or array (in JS key order).
pub fn entries_of(text: &str) -> IndexMap<String, String> {
    let mut map = IndexMap::new();
    match unimux_core::js_json::parse(text) {
        Ok(Value::Object(o)) => {
            for (k, v) in o {
                if let Value::String(s) = v {
                    map.insert(k, s);
                }
            }
        }
        Ok(Value::Array(items)) => {
            for (i, v) in items.into_iter().enumerate() {
                if let Value::String(s) = v {
                    map.insert(i.to_string(), s);
                }
            }
        }
        _ => {}
    }
    map
}

/// `JSON.stringify(Object.fromEntries(map), null, 2)`.
pub fn store_text(map: &IndexMap<String, String>) -> String {
    let mut object = serde_json::Map::new();
    for (k, v) in map {
        object.insert(k.clone(), Value::String(v.clone()));
    }
    unimux_core::js_json::order_map_like_js(&mut object);
    unimux_core::js_json::stringify_pretty(&Value::Object(object), 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_of_an_empty_scan() {
        // sha256("[]")
        assert_eq!(fingerprint_hash(&mut []), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    }

    #[test]
    fn store_text_puts_index_keys_first() {
        let mut map = IndexMap::new();
        map.insert("d:/a".to_string(), "x".to_string());
        map.insert("7".to_string(), "y".to_string());
        assert_eq!(store_text(&map), "{\n  \"7\": \"y\",\n  \"d:/a\": \"x\"\n}");
        assert_eq!(store_text(&IndexMap::new()), "{}");
    }

    #[test]
    fn concurrent_grants_and_revokes_leave_the_file_equal_to_the_map() {
        let dir = tempfile::tempdir().expect("temp dir");
        for round in 0..60 {
            let file = dir.path().join(format!("git-trust-{round}.json"));
            let store = std::sync::Arc::new(TrustStore::new(Some(file.clone())));
            store.set("D:/keep", "k");
            let threads: Vec<_> = (0..6)
                .map(|i| {
                    let s = store.clone();
                    std::thread::spawn(move || {
                        s.set(&format!("D:/repo{i}"), "h");
                        if i % 2 == 0 {
                            s.delete(&format!("D:/repo{i}"));
                        }
                        if i == 5 {
                            s.delete("D:/keep");
                        }
                    })
                })
                .collect();
            for t in threads {
                t.join().expect("thread");
            }
            let reloaded = TrustStore::new(Some(file));
            assert_eq!(reloaded.entries(), store.entries(), "round {round}");
            assert_eq!(store.entries().len(), 3, "round {round}");
        }
    }

    #[test]
    fn loads_like_json_parse() {
        assert!(entries_of("\u{feff}{\"a\":\"b\"}").is_empty());
        assert_eq!(
            entries_of("{\"a\":\"b\",\"c\":5,\"a\":\"z\"}").into_iter().collect::<Vec<_>>(),
            [("a".to_string(), "z".to_string())]
        );
        assert_eq!(entries_of("[\"x\",1]").into_iter().collect::<Vec<_>>(), [("0".to_string(), "x".to_string())]);
        assert!(entries_of("\"x\"").is_empty());
        assert!(entries_of("not json").is_empty());
    }
}
