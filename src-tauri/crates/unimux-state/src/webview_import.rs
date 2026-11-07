//! The one-time import of 1.1.x's localStorage (PLAN W3, ARCHITECTURE section 6).
//!
//! 1.1.x loaded the renderer from `file://`, so Chromium kept its localStorage (unsaved file drafts, detached-window drafts,
//! Redis console history, the DB tree, panel sizes, split view, file zoom, notes sort, SSH folds, the right panel order) in
//! `DATA_DIR/Local Storage/leveldb` under the origin `file://`. 1.2.0 runs on `http://tauri.localhost` (Windows) or
//! `tauri://localhost` (macOS) with its own WebView2 / WKWebView storage, so the entries are read here once and handed to the
//! first page through the boot script (unimux-app `webview_import`); the marker `DATA_DIR/webview-import.json` stops a
//! second import.
//!
//! WebView2 writes localStorage to disk a few seconds after a change, so the page's report does not prove the entries are
//! stored for good: an app killed in that gap would lose them. The page therefore also stores a sentinel key
//! (`SENTINEL_KEY` = the import id) after the entries, and the report writes an unconfirmed marker. The next start reads the
//! old entries again and its page looks for the sentinel: present means everything written before it reached the disk
//! (Chromium writes the changes of an origin to leveldb in order), so the marker becomes confirmed and the sentinel is
//! removed; missing means the earlier run ended too early, and the import runs again (still never overwriting a key).
//!
//! Chromium's format (components/services/storage/dom_storage/local_storage_impl.cc): a key is
//! `_` + origin + `\x00` + the script key, a value is the script value; both encoded as a prefix byte `0x00` (UTF-16LE) or
//! `0x01` (Latin-1) and the units. Other rows (`VERSION`, `META:<origin>`, `METAACCESS:<origin>`) are skipped.
//!
//! Electron's files are never modified: the folder is copied to a scratch folder first (rusty-leveldb replays the log into a
//! new table and writes a new manifest when it opens a database) and only the copy is opened.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The marker of a finished (or abandoned) import, next to state.json.
pub const MARKER_FILE: &str = "webview-import.json";
/// The localStorage (and sessionStorage) key of the import id, see the module comment.
pub const SENTINEL_KEY: &str = "mc:webview-import";
/// The origin of 1.1.x's renderer (`BrowserWindow.loadFile`).
pub const ELECTRON_ORIGIN: &str = "file://";

/// `DATA_DIR/Local Storage/leveldb`, where Electron keeps the localStorage of every origin.
pub fn leveldb_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("Local Storage").join("leveldb")
}

/// A JavaScript string as UTF-16 code units: localStorage strings may hold lone surrogates (a draft cut by `.slice()`), which
/// a Rust `String` cannot, and they must reach the new storage unchanged.
pub type JsString = Vec<u16>;

/// One localStorage entry of the old origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub key: JsString,
    pub value: JsString,
}

impl Entry {
    /// Test helper and logs: both sides as Rust strings (a lone surrogate becomes U+FFFD).
    pub fn lossy(&self) -> (String, String) {
        (String::from_utf16_lossy(&self.key), String::from_utf16_lossy(&self.value))
    }
}

/// What the start does about the import.
#[derive(Debug)]
pub enum Prepared {
    /// The marker exists: imported (or given up) by an earlier start.
    Done,
    /// No 1.1.x localStorage (a fresh install, or 1.1.x never stored anything): the marker was written, nothing to inject.
    Nothing,
    /// Entries to inject on the first page load; the marker is written once the page reports, and confirmed by a later start.
    Pending(Import),
    /// The old database could not be read: the marker records the error, so the start does not try again every time.
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct Import {
    /// Names this import in the page's sessionStorage, so a reload of the same window does not apply it twice.
    pub id: String,
    pub entries: Vec<Entry>,
    /// The id of an earlier, unconfirmed import: when the page finds it as the sentinel, it confirms instead of importing.
    pub confirm: Option<String>,
}

/// `webview-import.json`. Written by 1.2.0 only; 1.1.x never reads it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub version: u32,
    pub imported_at: String,
    /// `Local Storage/leveldb`, or null when there was nothing.
    pub source: Option<String>,
    pub origin: String,
    /// Entries read from the old database.
    pub entries: usize,
    /// Entries the page stored.
    pub imported: usize,
    /// Entries the page already had (never overwritten).
    pub kept: usize,
    pub error: Option<String>,
    /// The import whose sentinel a later start looks for (null when nothing was handed to a page).
    #[serde(default)]
    pub id: Option<String>,
    /// False until a later start has seen the sentinel on disk; an unconfirmed marker does not stop the import.
    #[serde(default = "confirmed_by_default")]
    pub confirmed: bool,
}

fn confirmed_by_default() -> bool {
    true
}

impl Marker {
    /// A final marker (nothing to import, or the import was given up).
    pub fn new(entries: usize, imported: usize, kept: usize, error: Option<String>, had_source: bool) -> Self {
        Self {
            version: 1,
            imported_at: unimux_core::time::iso_now(),
            source: had_source.then(|| "Local Storage/leveldb".to_string()),
            origin: ELECTRON_ORIGIN.to_string(),
            entries,
            imported,
            kept,
            error,
            id: None,
            confirmed: true,
        }
    }

    /// The marker of an import the page reported but WebView2 may not have written to disk yet.
    pub fn unconfirmed(id: String, entries: usize, imported: usize, kept: usize, error: Option<String>) -> Self {
        Self { id: Some(id), confirmed: false, ..Self::new(entries, imported, kept, error, true) }
    }
}

pub fn marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(MARKER_FILE)
}

/// The marker on disk, if it exists and parses.
pub fn read_marker(data_dir: &Path) -> Option<Marker> {
    serde_json::from_str(&fs::read_to_string(marker_path(data_dir)).ok()?).ok()
}

/// A later start saw the sentinel: the earlier import is on disk for good.
pub fn confirm_marker(data_dir: &Path) -> io::Result<()> {
    let mut marker = read_marker(data_dir).ok_or_else(|| io::Error::other("no unconfirmed marker"))?;
    marker.confirmed = true;
    write_marker(data_dir, &marker)
}

pub fn write_marker(data_dir: &Path, marker: &Marker) -> io::Result<()> {
    let mut text = serde_json::to_string_pretty(marker).map_err(io::Error::other)?;
    text.push('\n');
    unimux_core::atomic_write::atomic_write(&marker_path(data_dir), text.as_bytes(), &Default::default())
}

/// Decides at start: done, nothing, entries to inject, or failed (none of them touch Electron's files; `Nothing` and
/// `Failed` write a final marker right away). An unconfirmed marker (see the module comment) hands the entries out again
/// with the id to confirm.
pub fn prepare(data_dir: &Path, scratch_root: &Path) -> Prepared {
    let mut earlier = None;
    if marker_path(data_dir).exists() {
        match read_marker(data_dir) {
            Some(marker) if !marker.confirmed => earlier = Some(marker),
            // Confirmed, or unreadable: importing again could bring back keys deleted since, so it stays done.
            _ => return Prepared::Done,
        }
    }
    // An earlier import whose old database is gone or broken now cannot be offered again: its marker becomes final.
    let finish = |error: Option<String>, fresh: Marker| {
        let marker = match &earlier {
            Some(m) => Marker { confirmed: true, error: error.or_else(|| m.error.clone()), ..m.clone() },
            None => fresh,
        };
        let _ = write_marker(data_dir, &marker);
    };
    let source = leveldb_dir(data_dir);
    if !source.join("CURRENT").is_file() {
        finish(None, Marker::new(0, 0, 0, None, false));
        return Prepared::Nothing;
    }
    match read_local_storage(&source, scratch_root, ELECTRON_ORIGIN) {
        Ok(entries) if entries.is_empty() => {
            finish(None, Marker::new(0, 0, 0, None, true));
            Prepared::Nothing
        }
        Ok(entries) => Prepared::Pending(Import {
            id: uuid::Uuid::new_v4().to_string(),
            entries,
            confirm: earlier.as_ref().and_then(|m| m.id.clone()),
        }),
        Err(e) => {
            let error = e.to_string();
            finish(Some(error.clone()), Marker::new(0, 0, 0, Some(error.clone()), true));
            Prepared::Failed(error)
        }
    }
}

/// Every localStorage entry of `origin` in Chromium's leveldb at `source`, in key order. `source` is copied into a fresh
/// folder under `scratch_root` first and only the copy is opened; the copy is removed afterwards.
pub fn read_local_storage(source: &Path, scratch_root: &Path, origin: &str) -> io::Result<Vec<Entry>> {
    let scratch = scratch_root.join(format!("unimux-ls-import-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
    let result = copy_db(source, &scratch).and_then(|()| read_copy(&scratch, origin));
    let _ = fs::remove_dir_all(&scratch);
    result
}

/// The files leveldb needs (CURRENT, MANIFEST-*, *.log, *.ldb, *.sst); not LOCK (held by a running Electron) or LOG.
fn copy_db(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let wanted = name == "CURRENT"
            || name.starts_with("MANIFEST-")
            || name.ends_with(".log")
            || name.ends_with(".ldb")
            || name.ends_with(".sst");
        if wanted && entry.file_type()?.is_file() {
            fs::copy(entry.path(), target.join(&*name))?;
        }
    }
    Ok(())
}

fn read_copy(dir: &Path, origin: &str) -> io::Result<Vec<Entry>> {
    let options = rusty_leveldb::Options { create_if_missing: false, ..rusty_leveldb::Options::default() };
    let mut db = rusty_leveldb::DB::open(dir, options).map_err(|e| io::Error::other(format!("leveldb: {e}")))?;
    let prefix = key_prefix(origin);
    let mut out = Vec::new();
    {
        use rusty_leveldb::LdbIterator;
        let mut it = db.new_iter().map_err(|e| io::Error::other(format!("leveldb: {e}")))?;
        // seek() stands on the first row at or after the prefix (next() would skip it).
        it.seek(&prefix);
        while let Some((key, value)) = it.current() {
            if !key.starts_with(&prefix) {
                break;
            }
            // A row that does not decode (a damaged or foreign one) is skipped, the others still come over.
            if let (Some(k), Some(v)) = (decode_string(&key[prefix.len()..]), decode_string(&value)) {
                out.push(Entry { key: k, value: v });
            }
            if !it.advance() {
                break;
            }
        }
    }
    let _ = db.close();
    Ok(out)
}

/// `_` + origin + `\x00`: the prefix of every script key of that origin.
pub fn key_prefix(origin: &str) -> Vec<u8> {
    let mut p = Vec::with_capacity(origin.len() + 2);
    p.push(b'_');
    p.extend_from_slice(origin.as_bytes());
    p.push(0);
    p
}

/// Chromium's string encoding of localStorage keys and values: `0x00` + UTF-16LE units, or `0x01` + Latin-1 bytes.
pub fn decode_string(bytes: &[u8]) -> Option<JsString> {
    let (&format, rest) = bytes.split_first()?;
    match format {
        0 if rest.len() % 2 == 0 => Some(rest.as_chunks::<2>().0.iter().map(|&c| u16::from_le_bytes(c)).collect()),
        1 => Some(rest.iter().map(|&b| u16::from(b)).collect()),
        _ => None,
    }
}

/// The encoding Chromium writes (Latin-1 when every unit fits, else UTF-16LE); tests build databases with it.
pub fn encode_string(units: &[u16]) -> Vec<u8> {
    if units.iter().all(|&u| u <= 0xff) {
        let mut out = vec![1u8];
        out.extend(units.iter().map(|&u| u as u8));
        out
    } else {
        let mut out = vec![0u8];
        for u in units {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }
}

/// A JavaScript string literal (double quotes) of UTF-16 units. Text stays as it is (a draft in Polish costs no more than
/// its UTF-8); control characters, the line separators and lone surrogates are written as escapes, so the literal is
/// exactly the stored string.
pub fn js_literal(units: &[u16], out: &mut String) {
    use std::fmt::Write;
    out.push('"');
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (' '..='~').contains(&c) || (c > '\u{9f}' && c != '\u{2028}' && c != '\u{2029}') => out.push(c),
            Ok(c) => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            Err(lone) => {
                let _ = write!(out, "\\u{:04x}", lone.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> JsString {
        s.encode_utf16().collect()
    }

    /// A Chromium-shaped database written by rusty-leveldb (the real Electron files are in test/fixtures, see below).
    fn make_db(dir: &Path, rows: &[(Vec<u8>, Vec<u8>)]) {
        let options = rusty_leveldb::Options { create_if_missing: true, ..rusty_leveldb::Options::default() };
        let mut db = rusty_leveldb::DB::open(dir, options).unwrap();
        for (k, v) in rows {
            db.put(k, v).unwrap();
        }
        db.flush().unwrap();
        db.close().unwrap();
    }

    fn script_key(origin: &str, key: &[u16]) -> Vec<u8> {
        let mut k = key_prefix(origin);
        k.extend(encode_string(key));
        k
    }

    #[test]
    fn strings_decode_in_both_encodings() {
        assert_eq!(decode_string(b"\x01abc\xe9").unwrap(), units("abcé"));
        assert_eq!(decode_string(&[0, 0x41, 0, 0x3d, 0xd8]).unwrap(), vec![0x41, 0xd83d]);
        assert_eq!(decode_string(&[0, 0x41]), None, "odd UTF-16 length");
        assert_eq!(decode_string(&[2, 0x41]), None);
        assert_eq!(decode_string(&[]), None);
        assert_eq!(decode_string(&encode_string(&units("zażółć 😀"))).unwrap(), units("zażółć 😀"));
    }

    #[test]
    fn js_literals_keep_text_and_lone_surrogates() {
        let mut s = String::new();
        js_literal(&[0x61, 0x22, 0x5c, 0x0a, 0xd800, 0x2028, 0x7f, 0x105, 0x3c, 0xd83d, 0xde00, 0xdc00], &mut s);
        let b = '\\';
        assert_eq!(s, format!("\"a{b}\"{b}{b}{b}n{b}ud800{b}u2028{b}u007fą<😀{b}udc00\""));
    }

    #[test]
    fn only_the_file_origin_is_read_and_the_source_is_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("leveldb");
        let draft = units("[{\"path\":\"a.ts\",\"text\":\"zażółć \u{1F600}\"}]");
        let mut lone = units("half ");
        lone.push(0xd83d);
        make_db(
            &source,
            &[
                (b"VERSION".to_vec(), b"1".to_vec()),
                (b"META:file://".to_vec(), vec![8, 1, 16, 2]),
                (script_key("file://", &units("unimux:fileDrafts")), encode_string(&draft)),
                (script_key("file://", &units("redis-history:c1")), encode_string(&units("[\"PING\"]"))),
                (script_key("file://", &units("lone")), encode_string(&lone)),
                (script_key("file://", &units("ключ")), encode_string(&units("1"))),
                (script_key("http://other", &units("x")), encode_string(&units("y"))),
                (script_key("file:///x", &units("x")), encode_string(&units("y"))),
            ],
        );
        let before = snapshot(&source);
        let entries = read_local_storage(&source, tmp.path(), ELECTRON_ORIGIN).unwrap();
        let keys: Vec<String> = entries.iter().map(|e| e.lossy().0).collect();
        // leveldb orders by bytes: a UTF-16 key (prefix 0x00) before the Latin-1 ones (0x01).
        assert_eq!(keys, ["ключ", "lone", "redis-history:c1", "unimux:fileDrafts"]);
        assert_eq!(entries[1].value, lone);
        assert_eq!(entries[3].value, draft);
        assert_eq!(before, snapshot(&source), "the source folder must not change");
        // The scratch copy is gone.
        let left: Vec<_> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["leveldb"]);
    }

    #[test]
    fn prepare_writes_the_marker_when_there_is_nothing_and_stops_after_it() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        fs::create_dir_all(&data).unwrap();
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Nothing));
        let marker: Marker = serde_json::from_str(&fs::read_to_string(marker_path(&data)).unwrap()).unwrap();
        assert_eq!((marker.version, marker.source, marker.entries), (1, None, 0));
        // A database appearing later (a 1.1.x run after 1.2.0) is not imported again.
        make_db(&leveldb_dir(&data), &[(script_key("file://", &units("k")), encode_string(&units("v")))]);
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Done));
    }

    #[test]
    fn prepare_hands_out_the_entries_without_a_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        make_db(&leveldb_dir(&data), &[(script_key("file://", &units("k")), encode_string(&units("v")))]);
        let Prepared::Pending(import) = prepare(&data, tmp.path()) else { panic!("expected entries") };
        assert_eq!(import.entries, vec![Entry { key: units("k"), value: units("v") }]);
        assert_eq!(import.confirm, None);
        assert!(!marker_path(&data).exists(), "the marker waits for the page");
        // Not reported (the app ended before the page loaded): the next start offers them again.
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Pending(_)));
    }

    #[test]
    fn a_reported_import_is_offered_again_until_a_later_start_confirms_it() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        make_db(&leveldb_dir(&data), &[(script_key("file://", &units("k")), encode_string(&units("v")))]);
        let Prepared::Pending(first) = prepare(&data, tmp.path()) else { panic!("expected entries") };
        // The page reported: WebView2 may still hold the writes in memory.
        write_marker(&data, &Marker::unconfirmed(first.id.clone(), 1, 1, 0, None)).unwrap();
        let text = fs::read_to_string(marker_path(&data)).unwrap();
        assert!(text.contains("\"confirmed\": false") && text.contains(&first.id), "{text}");
        // The app was killed before the write: the next start hands the entries out again, with the id to look for.
        let Prepared::Pending(second) = prepare(&data, tmp.path()) else { panic!("expected entries again") };
        assert_eq!(second.entries, first.entries);
        assert_eq!(second.confirm.as_deref(), Some(first.id.as_str()));
        assert_ne!(second.id, first.id);
        // That page found the sentinel: confirmed, and later starts are done.
        confirm_marker(&data).unwrap();
        let marker = read_marker(&data).unwrap();
        assert!(marker.confirmed);
        assert_eq!((marker.entries, marker.imported, marker.id), (1, 1, Some(first.id)));
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Done));
    }

    #[test]
    fn an_unconfirmed_import_whose_database_is_gone_becomes_final() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        fs::create_dir_all(&data).unwrap();
        write_marker(&data, &Marker::unconfirmed("old".into(), 3, 2, 1, None)).unwrap();
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Nothing));
        let marker = read_marker(&data).unwrap();
        assert!(marker.confirmed);
        assert_eq!((marker.entries, marker.imported, marker.kept, marker.id.as_deref()), (3, 2, 1, Some("old")));
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Done));
    }

    #[test]
    fn markers_without_the_new_fields_and_unreadable_ones_count_as_done() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        make_db(&leveldb_dir(&data), &[(script_key("file://", &units("k")), encode_string(&units("v")))]);
        fs::write(
            marker_path(&data),
            r#"{"version":1,"importedAt":"x","source":null,"origin":"file://","entries":0,"imported":0,"kept":0,"error":null}"#,
        )
        .unwrap();
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Done));
        fs::write(marker_path(&data), "not json").unwrap();
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Done));
    }

    #[test]
    fn a_damaged_database_is_given_up_with_the_error_in_the_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let dir = leveldb_dir(&data);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("CURRENT"), "MANIFEST-000099\n").unwrap();
        let Prepared::Failed(error) = prepare(&data, tmp.path()) else { panic!("expected a failure") };
        let marker: Marker = serde_json::from_str(&fs::read_to_string(marker_path(&data)).unwrap()).unwrap();
        assert_eq!(marker.error.as_deref(), Some(error.as_str()));
        assert!(matches!(prepare(&data, tmp.path()), Prepared::Done));
    }

    /// The real files of Electron 45 (1.1.4's runtime), made by `node scripts/verify-tauri-w3.mjs --write-fixture`: one
    /// run that left its writes in the log, a second that compacted them into a table and wrote more.
    #[test]
    fn electron_45_local_storage_fixture() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/electron-local-storage");
        let expected: Vec<(String, String)> =
            serde_json::from_str(&fs::read_to_string(fixture.join("expected.json")).unwrap()).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let before = snapshot(&fixture.join("leveldb"));
        let entries = read_local_storage(&fixture.join("leveldb"), tmp.path(), ELECTRON_ORIGIN).unwrap();
        let got: Vec<(String, String)> = entries.iter().map(Entry::lossy).collect();
        let mut want = expected;
        // leveldb orders rows by their bytes, i.e. by the encoded key.
        want.sort_by_key(|(key, _)| encode_string(&units(key)));
        assert_eq!(got, want);
        assert_eq!(before, snapshot(&fixture.join("leveldb")));
    }

    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (e.file_name().to_string_lossy().into_owned(), fs::read(e.path()).unwrap())
            })
            .collect();
        out.sort();
        out
    }
}
