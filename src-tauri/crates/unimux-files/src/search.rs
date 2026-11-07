//! Find and replace across a project (1.1.4 src/shared/search.ts and src/main/search.ts): the pattern of the search box,
//! the per-line matches with UTF-16 lines, columns and previews, the replacement tokens, the include / exclude globs, the
//! depth-first walk in name order with 6 readers ahead and its budgets (20000 files, 10 s, 5000 matches), a cancel flag per
//! window, and the replace through the editor's conflict-safe writer. Every text is handled as UTF-16 code units, like the
//! JS strings of 1.1.4. Golden rows: test/golden/search-*.jsonl.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};

use serde_json::{Map, Value, json};

use crate::collate::compare_names;
use crate::fsx::{self, DirentKind};
use crate::jspath::{self, Flavor};
use crate::jsregex::{JsRegex, v8_message};
use crate::preview::{self, PREVIEW_BYTES, Preview};
use crate::project::{self, IGNORED_FOLDERS};
use crate::save::{self, SaveResult};

pub const MAX_MATCHES: usize = 5000;
pub const MAX_LINE_LENGTH: usize = 5000;
pub const MAX_FILES: usize = 20000;
pub const TIME_BUDGET_MS: f64 = 10000.0;
/// Files of one folder read at the same time; results are still taken in name order.
const READERS: usize = 6;
const PREVIEW_BEFORE: usize = 60;
const PREVIEW_AFTER: usize = 160;

const INVALID_REGEX: &str = "Nieprawidłowe wyrażenie regularne: ";
const F: Flavor = Flavor::native();

/// What 1.1.4 threw (a TypeError of a malformed request): the IPC call fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown(pub String);

/// `!!value` of JS.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `SearchOptions` as the renderer sent them.
#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub query: String,
    /// The query was a truthy value that is no string (a regex search only): `String(value)` may be empty (`[]`), and
    /// 1.1.4 still compiled it, since its empty check was `!options.query`.
    pub query_object: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    pub include: Option<String>,
    pub exclude: Option<String>,
    pub include_ignored: bool,
}

impl SearchOptions {
    /// Reads the options like 1.1.4 used them; what made its code throw is a [`Thrown`].
    pub fn from_json(v: &Value) -> Result<Self, Thrown> {
        let Some(o) = v.as_object() else {
            return Err(Thrown(format!(
                "Cannot read properties of {} (reading 'query')",
                if v.is_null() { "null" } else { "undefined" }
            )));
        };
        let get = |k: &str| o.get(k).unwrap_or(&Value::Null);
        // Only escapeRegExp called `.replace` on the query; a regex search gave any value to `new RegExp`, which took
        // `String(value)`.
        let (query, query_object) = match get("query") {
            Value::String(s) => (s.clone(), false),
            q if !truthy(q) => (String::new(), false),
            q if truthy(get("regex")) => (js_string(q), true),
            _ => return Err(Thrown("text.replace is not a function".into())),
        };
        let spec = |k: &str| match get(k) {
            Value::Null => Ok(None),
            Value::String(s) => Ok(Some(s.clone())),
            _ => Err(Thrown("(spec ?? '').split is not a function".into())),
        };
        Ok(Self {
            query,
            query_object,
            case_sensitive: truthy(get("caseSensitive")),
            whole_word: truthy(get("wholeWord")),
            regex: truthy(get("regex")),
            include: spec("include")?,
            exclude: spec("exclude")?,
            include_ignored: truthy(get("includeIgnored")),
        })
    }
}

/// `String(value)` of a JSON value: numbers as JS prints them, arrays joined with `,` (null as empty), objects as
/// `[object Object]`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => "0".into(), // -0 too
            Some(f) => ryu_js::Buffer::new().format(f).to_string(),
            None => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            items.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `escapeRegExp`: `.*+?^${}()|[]\` get a backslash.
pub fn escape_regexp(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `buildPattern`: the compiled search, `Err(None)` for an empty query, `Err(Some(message))` for an invalid expression.
pub fn build_pattern(options: &SearchOptions) -> Result<JsRegex, Option<String>> {
    if options.query.is_empty() && !options.query_object {
        return Err(None);
    }
    let body = if options.regex { options.query.clone() } else { escape_regexp(&options.query) };
    let icase = !options.case_sensitive;
    let unicode =
        if options.whole_word { format!("(?<![\\p{{L}}\\p{{N}}_])(?:{body})(?![\\p{{L}}\\p{{N}}_])") } else { body.clone() };
    if let Ok(re) = JsRegex::new(&unicode, icase, true) {
        return Ok(re);
    }
    let legacy = if options.whole_word { format!("(?<![\\w])(?:{body})(?![\\w])") } else { body };
    match JsRegex::new(&legacy, icase, false) {
        Ok(re) => Ok(re),
        Err(reason) => Err(Some(v8_message(&legacy, if icase { "gi" } else { "g" }, &reason))),
    }
}

/// `text.split(/\r\n|\r|\n/)` on UTF-16: (start, end) of every line.
fn line_spans(text: &[u16]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < text.len() {
        match text[i] {
            0x0d => {
                spans.push((start, i));
                i += if text.get(i + 1) == Some(&0x0a) { 2 } else { 1 };
                start = i;
            }
            0x0a => {
                spans.push((start, i));
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    spans.push((start, text.len()));
    spans
}

/// A JS string slice as a Rust string (a lone surrogate half becomes U+FFFD, one unit for one).
fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `SearchMatch`.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchMatch {
    pub line: usize,
    pub column: usize,
    pub text: String,
    pub preview: String,
    pub match_start: usize,
    pub match_length: usize,
}

impl SearchMatch {
    pub fn to_json(&self) -> Value {
        json!({
            "line": self.line, "column": self.column, "text": self.text, "preview": self.preview,
            "matchStart": self.match_start, "matchLength": self.match_length,
        })
    }
}

/// Every non-empty match of `line`, in order (`regex.exec` from `lastIndex` with the empty-match skip).
fn for_each_match(regex: &JsRegex, line: &[u16], mut f: impl FnMut(&regress::Match) -> bool) {
    let mut last = 0;
    while let Some(m) = regex.exec(line, last) {
        if m.start() == m.end() {
            last = regex.after_empty(line, m.end());
            continue;
        }
        last = m.end();
        if !f(&m) {
            return;
        }
    }
}

/// `searchText(text, regex, limit)`: the matches of every line (lines longer than 5000 units skipped) and whether the
/// limit stopped it.
pub fn search_text(text: &[u16], regex: &JsRegex, limit: usize) -> (Vec<SearchMatch>, bool) {
    let mut matches = Vec::new();
    for (i, (start, end)) in line_spans(text).into_iter().enumerate() {
        let line = &text[start..end];
        if line.len() > MAX_LINE_LENGTH {
            continue;
        }
        let mut truncated = false;
        for_each_match(regex, line, |m| {
            if matches.len() >= limit {
                truncated = true;
                return false;
            }
            let from = m.start().saturating_sub(PREVIEW_BEFORE);
            let to = line.len().min(m.end() + PREVIEW_AFTER);
            let mut preview = String::new();
            if from > 0 {
                preview.push('…');
            }
            preview.push_str(&lossy(&line[from..to]));
            if to < line.len() {
                preview.push('…');
            }
            matches.push(SearchMatch {
                line: i + 1,
                column: m.start(),
                text: lossy(&line[m.range()]),
                preview,
                match_start: m.start() - from + usize::from(from > 0),
                match_length: m.end() - m.start(),
            });
            true
        });
        if truncated {
            return (matches, true);
        }
    }
    (matches, false)
}

/// `expandReplacement`: `$1`, `$&`, `$<name>` and `$$` of `replacement` for the match `m` of `line`.
pub fn expand_replacement(replacement: &[u16], m: &regress::Match, line: &[u16], out: &mut Vec<u16>) {
    let r = replacement;
    let mut i = 0;
    while i < r.len() {
        if r[i] != u16::from(b'$') || i + 1 >= r.len() {
            out.push(r[i]);
            i += 1;
            continue;
        }
        let next = r[i + 1];
        if next == u16::from(b'$') {
            out.push(next);
            i += 2;
        } else if next == u16::from(b'&') {
            out.extend_from_slice(&line[m.range()]);
            i += 2;
        } else if next == u16::from(b'<')
            && let Some(close) = r[i + 2..].iter().position(|&c| c == u16::from(b'>')).filter(|&n| n > 0)
        {
            let name = String::from_utf16_lossy(&r[i + 2..i + 2 + close]);
            if let Some((_, Some(range))) = m.named_groups().find(|(n, _)| *n == name) {
                out.extend_from_slice(&line[range]);
            }
            i += close + 3;
        } else if (u16::from(b'0')..=u16::from(b'9')).contains(&next) {
            let mut digits = 1;
            if r.get(i + 2).is_some_and(|c| (u16::from(b'0')..=u16::from(b'9')).contains(c)) {
                digits = 2;
            }
            let group = r[i + 1..i + 1 + digits].iter().fold(0usize, |v, &d| v * 10 + usize::from(d - u16::from(b'0')));
            if group >= 1 && group <= m.captures.len() {
                if let Some(range) = m.group(group) {
                    out.extend_from_slice(&line[range]);
                }
            } else {
                out.extend_from_slice(&r[i..i + 1 + digits]);
            }
            i += 1 + digits;
        } else {
            out.push(r[i]);
            i += 1;
        }
    }
}

/// The occurrence a single replacement targets (`only`); a field of the wrong type never matches (`!==`).
#[derive(Debug, Clone, Default)]
pub struct Only {
    pub line: Option<f64>,
    pub column: Option<f64>,
    pub text: Option<String>,
}

/// `replaceInText`: replaces matches line by line, every line ending kept. Answers the new UTF-16 text and the count.
pub fn replace_in_text(
    text: &[u16],
    regex: &JsRegex,
    replacement: &[u16],
    expand: bool,
    only: Option<&Only>,
) -> (Vec<u16>, usize) {
    let mut out = Vec::with_capacity(text.len());
    let mut count = 0;
    let spans = line_spans(text);
    for (i, &(start, end)) in spans.iter().enumerate() {
        let line = &text[start..end];
        let line_number = (i + 1) as f64;
        let skip = line.len() > MAX_LINE_LENGTH || only.is_some_and(|o| o.line != Some(line_number));
        let mut last = 0;
        if !skip {
            for_each_match(regex, line, |m| {
                if let Some(o) = only
                    && (o.column != Some(m.start() as f64) || o.text.as_deref() != Some(lossy(&line[m.range()]).as_str()))
                {
                    return true;
                }
                out.extend_from_slice(&line[last..m.start()]);
                if expand {
                    expand_replacement(replacement, m, line, &mut out);
                } else {
                    out.extend_from_slice(replacement);
                }
                last = m.end();
                count += 1;
                true
            });
        }
        out.extend_from_slice(&line[last..]);
        // The line break that followed (the original one).
        let next = spans.get(i + 1).map_or(text.len(), |s| s.0);
        out.extend_from_slice(&text[end..next]);
    }
    (out, count)
}

/// `String.prototype.trim`'s white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// One compiled glob of `compileGlobs`.
struct GlobMatcher {
    re: JsRegex,
    whole_path: bool,
}

/// `compileGlobs(spec)`: a glob list (`*.ts, src/**`) as a path predicate; `None` when the list is empty. A pattern without a
/// slash matches file names anywhere.
pub struct Globs(Vec<GlobMatcher>);

pub fn compile_globs(spec: Option<&str>) -> Option<Globs> {
    let mut matchers = Vec::new();
    for part in spec.unwrap_or("").split(',') {
        let pattern = part.trim_matches(js_space).replace('\\', "/");
        if pattern.is_empty() {
            continue;
        }
        let body = if pattern.ends_with('/') { format!("{pattern}**") } else { pattern };
        let mut source = String::from("^");
        let mut chars = body.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '*' if chars.peek() == Some(&'*') => {
                    chars.next();
                    source.push_str(".*");
                }
                '*' => source.push_str("[^/]*"),
                '?' => source.push_str("[^/]"),
                // A NUL stood for `**` in 1.1.4's replacement chain, so a typed one means the same.
                '\0' => source.push_str(".*"),
                '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                    source.push('\\');
                    source.push(c);
                }
                c => source.push(c),
            }
        }
        source.push('$');
        // Every metacharacter is escaped, so the expression always compiles.
        let re = JsRegex::new(&source, true, false).expect("an escaped glob compiles");
        matchers.push(GlobMatcher { re, whole_path: body.contains('/') });
    }
    (!matchers.is_empty()).then_some(Globs(matchers))
}

impl Globs {
    pub fn matches(&self, path: &str) -> bool {
        let path = path.replace('\\', "/");
        let whole: Vec<u16> = path.encode_utf16().collect();
        let name: Vec<u16> = path.rsplit('/').next().unwrap_or(&path).encode_utf16().collect();
        self.0.iter().any(|g| g.re.exec(if g.whole_path { &whole } else { &name }, 0).is_some())
    }
}

/// What a searched file holds.
enum Read {
    Text(Vec<u16>),
    /// Binary, unreadable or larger than the preview limit: counted as skipped.
    Skipped,
}

/// `readSearchableText`: the decoded text of a small text file (UTF-8, or UTF-16 with its BOM).
fn read_searchable_text(path: &str) -> Read {
    let Ok(mut file) = fsx::open_read(path) else { return Read::Skipped };
    let Ok(stat) = fsx::fstat(&file) else { return Read::Skipped };
    if !stat.is_file || stat.size > PREVIEW_BYTES as u64 {
        return Read::Skipped;
    }
    let Ok(data) = fsx::read_start(&mut file, stat.size as usize) else { return Read::Skipped };
    let encoding = preview::encoding_of(&data);
    if encoding == encoding_rs::UTF_8 && data.contains(&0) {
        return Read::Skipped;
    }
    match preview::decode_fatal(encoding, &data, false) {
        Some(text) if !preview::has_binary_controls(&text) => Read::Text(text.encode_utf16().collect()),
        _ => Read::Skipped,
    }
}

fn path_join(directory: &str, name: &str) -> String {
    if directory.is_empty() { name.to_string() } else { format!("{directory}/{name}") }
}

/// The answer of a search a newer one replaced (nobody shows it).
fn cancelled() -> Value {
    json!({ "ok": true, "files": [], "matches": 0, "scanned": 0, "skipped": 0, "truncated": true })
}

/// `searchProject(root, options, now, signal)`: every small text file of the project, depth first in name order; links are
/// never followed. `now` is the clock in ms; `cancel` stops a search that a newer one replaced, between files.
pub fn search_project(root: &str, options: &Value, now: &dyn Fn() -> f64, cancel: Option<&AtomicBool>) -> Result<Value, Thrown> {
    let options = SearchOptions::from_json(options)?;
    let regex = match build_pattern(&options) {
        Ok(r) => r,
        Err(Some(error)) => return Ok(json!({ "ok": false, "error": format!("{INVALID_REGEX}{error}") })),
        Err(None) => return Ok(json!({ "ok": true, "files": [], "matches": 0, "scanned": 0, "skipped": 0, "truncated": false })),
    };
    let include = compile_globs(options.include.as_deref());
    let exclude = compile_globs(options.exclude.as_deref());
    let aborted = || cancel.is_some_and(|c| c.load(Ordering::SeqCst));
    let base = jspath::resolve(F, &[root]);
    let mut files: Vec<(String, Vec<SearchMatch>)> = Vec::new();
    let (mut matches, mut scanned, mut skipped, mut truncated) = (0usize, 0usize, 0usize, false);
    let started = now();

    let (job_tx, job_rx) = mpsc::channel::<(usize, String)>();
    let job_rx = Mutex::new(job_rx);
    let (done_tx, done_rx) = mpsc::channel::<(usize, Read)>();
    let outcome = std::thread::scope(|scope| {
        for _ in 0..READERS {
            let (rx, tx) = (&job_rx, done_tx.clone());
            scope.spawn(move || {
                loop {
                    let job = rx.lock().expect("the job queue").recv();
                    let Ok((index, path)) = job else { break };
                    if tx.send((index, read_searchable_text(&path))).is_err() {
                        break;
                    }
                }
            });
        }
        drop(done_tx);
        let mut stack = vec![String::new()];
        let result = (|| {
            while !truncated && let Some(directory) = stack.pop() {
                if aborted() {
                    return None;
                }
                let Ok(mut items) = fsx::readdir(&jspath::resolve(F, &[&base, &directory])) else { continue };
                items.sort_by(|a, b| compare_names(&a.name, &b.name));
                let mut folders = Vec::new();
                let mut candidates = Vec::new();
                for item in items {
                    let path = path_join(&directory, &item.name);
                    if item.kind == DirentKind::Dir {
                        let ignored = !options.include_ignored && IGNORED_FOLDERS.contains(&item.name.as_str());
                        if !ignored && !exclude.as_ref().is_some_and(|g| g.matches(&format!("{path}/"))) {
                            folders.push(path);
                        }
                        continue;
                    }
                    if item.kind != DirentKind::File
                        || include.as_ref().is_some_and(|g| !g.matches(&path))
                        || exclude.as_ref().is_some_and(|g| g.matches(&path))
                    {
                        continue;
                    }
                    candidates.push(path);
                }
                // A few readers fetch the folder's files ahead; the budget is checked before each file is started, in name order.
                let before = scanned;
                let mut queued = 0;
                let mut slots: Vec<Option<Read>> = (0..candidates.len()).map(|_| None).collect();
                let mut received = 0;
                let start = |queued: &mut usize| -> bool {
                    if *queued >= candidates.len() || aborted() {
                        return false;
                    }
                    if before + *queued >= MAX_FILES || now() - started > TIME_BUDGET_MS {
                        return false;
                    }
                    let path = jspath::resolve(F, &[&base, &candidates[*queued]]);
                    job_tx.send((*queued, path)).expect("the readers run");
                    *queued += 1;
                    true
                };
                for _ in 0..READERS {
                    if !start(&mut queued) {
                        break;
                    }
                }
                let mut stopped_cancelled = false;
                for i in 0..candidates.len() {
                    if i >= queued {
                        if aborted() {
                            stopped_cancelled = true;
                        } else {
                            truncated = true;
                        }
                        break;
                    }
                    while slots[i].is_none() {
                        let (index, read) = done_rx.recv().expect("the readers answer");
                        slots[index] = Some(read);
                        received += 1;
                    }
                    let read = slots[i].take().expect("filled above");
                    start(&mut queued);
                    scanned += 1;
                    let Read::Text(text) = read else {
                        skipped += 1;
                        continue;
                    };
                    let (found, cut) = search_text(&text, &regex, MAX_MATCHES - matches);
                    if !found.is_empty() {
                        matches += found.len();
                        files.push((candidates[i].clone(), found));
                    }
                    if cut || matches >= MAX_MATCHES {
                        truncated = true;
                        break;
                    }
                }
                // Let reads that were started ahead finish before the folder is left.
                while received < queued {
                    done_rx.recv().expect("the readers answer");
                    received += 1;
                }
                if stopped_cancelled || aborted() {
                    return None;
                }
                // Depth-first in name order: push in reverse so the first folder is searched first.
                stack.extend(folders.into_iter().rev());
            }
            Some(())
        })();
        drop(job_tx);
        result
    });
    if outcome.is_none() {
        return Ok(cancelled());
    }
    files.sort_by(|a, b| compare_names(&a.0, &b.0));
    let files: Vec<Value> = files
        .into_iter()
        .map(|(path, found)| json!({ "path": path, "matches": found.iter().map(SearchMatch::to_json).collect::<Vec<_>>() }))
        .collect();
    Ok(json!({ "ok": true, "files": files, "matches": matches, "scanned": scanned, "skipped": skipped, "truncated": truncated }))
}

/// `replaceInProject(root, request)`: replaces in one match, one file or every matching file. Every file is read fresh and
/// written back through the editor's writer only if it did not change in between (line endings and BOM kept).
pub fn replace_in_project(root: &str, request: &Value) -> Result<Value, Thrown> {
    let Some(request) = request.as_object() else {
        return Err(Thrown("Cannot destructure the request".into()));
    };
    let field = |k: &str| request.get(k).unwrap_or(&Value::Null);
    let options_value = field("options");
    let scope = field("scope");
    let Some(replacement) = field("replacement").as_str() else {
        return Ok(json!({ "ok": false, "error": "Nieprawidłowy tekst zamiany." }));
    };
    let options = SearchOptions::from_json(options_value)?;
    let regex = match build_pattern(&options) {
        Ok(r) => r,
        Err(error) => {
            let error = error.map_or_else(|| "Wpisz, czego szukać.".to_string(), |e| format!("{INVALID_REGEX}{e}"));
            return Ok(json!({ "ok": false, "error": error }));
        }
    };
    // `scope.kind` threw for null / undefined only; any other non-object has no fields (`kind` and `path` undefined).
    if scope.is_null() {
        return Err(Thrown("Cannot read properties of undefined (reading 'kind')".into()));
    }
    let empty = Map::new();
    let scope = scope.as_object().unwrap_or(&empty);
    let kind = scope.get("kind").and_then(Value::as_str);
    let paths: Vec<Value> = if kind == Some("all") {
        let found = search_project(root, options_value, &clock(), None)?;
        if found["ok"] != Value::Bool(true) {
            return Ok(found);
        }
        found["files"].as_array().map(|f| f.iter().map(|file| file["path"].clone()).collect()).unwrap_or_default()
    } else {
        vec![scope.get("path").cloned().unwrap_or(Value::Null)]
    };
    let only = (kind == Some("match")).then(|| Only {
        line: scope.get("line").and_then(Value::as_f64),
        column: scope.get("column").and_then(Value::as_f64),
        text: scope.get("text").and_then(Value::as_str).map(str::to_string),
    });
    let replacement: Vec<u16> = replacement.encode_utf16().collect();
    let mut results = Vec::new();
    let mut replaced = 0;
    for path_value in paths {
        let path = path_value.as_str();
        let read = project::read_project_file(root, path, PREVIEW_BYTES);
        let text = match read {
            Preview::Text { text, truncated: false, .. } => text,
            Preview::Error { message } => {
                results.push(json!({ "path": path_value, "replaced": 0, "error": message }));
                continue;
            }
            _ => {
                results.push(
                    json!({ "path": path_value, "replaced": 0, "error": "Plik jest binarny albo zbyt duży do bezpiecznej zamiany." }),
                );
                continue;
            }
        };
        let units: Vec<u16> = text.encode_utf16().collect();
        let (edited, count) = replace_in_text(&units, &regex, &replacement, options.regex, only.as_ref());
        if count == 0 {
            let mut row = Map::new();
            row.insert("path".into(), path_value.clone());
            row.insert("replaced".into(), json!(0));
            if only.is_some() {
                row.insert("error".into(), json!("Plik zmienił się od wyszukiwania. Wyszukaj ponownie."));
            }
            results.push(Value::Object(row));
            continue;
        }
        // A replacement may leave half a surrogate pair (a `.` without `u`): the writer refuses such a text like 1.1.4.
        let (new_text, ill_formed) = match String::from_utf16(&edited) {
            Ok(s) => (s, false),
            Err(_) => (String::from_utf16_lossy(&edited), true),
        };
        let written =
            save::write_text(&|| project::project_file_path(root, path, None), Some(&new_text), ill_formed, Some(&text));
        match written {
            SaveResult::Ok => {
                results.push(json!({ "path": path_value, "replaced": count }));
                replaced += count;
            }
            other => {
                let error = other.to_json()["error"].clone();
                results.push(json!({ "path": path_value, "replaced": 0, "error": error }));
            }
        }
    }
    Ok(json!({ "ok": true, "replaced": replaced, "files": results }))
}

/// The clock of [`search_project`] in ms (1.1.4: `Date.now`; a monotonic clock, so a wall clock change never cuts a search).
pub fn clock() -> impl Fn() -> f64 {
    let origin = std::time::Instant::now();
    move || origin.elapsed().as_secs_f64() * 1000.0
}
