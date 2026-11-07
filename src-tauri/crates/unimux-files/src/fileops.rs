//! File operations of the project tree (1.1.4 src/main/fileOps.ts with the pure helpers of src/shared/fileOps.ts):
//! rename (case-only through a temporary name), create, delete to the trash, copy and move with conflict policies
//! (ask / replace / keepBoth / skip), links copied as links (a folder link as a junction on Windows), the cross-device
//! move (EXDEV: copy, then remove the source, never when something could not be copied), the large-copy confirmation
//! (500 MiB / 20000 entries), cancel and progress at most every 120 ms.
//!
//! Everything is confined to the project root like the read handlers of G5: no absolute paths, no "..", no link or
//! junction escapes (real paths are compared), and nothing is ever deleted permanently (replaced and deleted items go to
//! the trash). Answers are the JSON objects 1.1.4 answered (same keys, same order, same Polish texts).

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::fserr::FsError;
use crate::fsx::{self, LinkType};
use crate::jspath::{self, Flavor};
use crate::local::LocalPlatform;

const F: Flavor = Flavor::native();
/// `process.platform === 'win32' || process.platform === 'darwin'`.
const CASE_INSENSITIVE: bool = cfg!(any(windows, target_os = "macos"));

/// Above this a copy asks for confirmation first.
pub const LARGE_COPY_BYTES: u64 = 500 * 1024 * 1024;
pub const LARGE_COPY_ENTRIES: u64 = 20000;
/// Limits for lists and strings coming from the renderer.
pub const MAX_OP_PATHS: usize = 5000;
pub const MAX_OP_PATH_LENGTH: usize = 4096;
/// Progress goes out at most this often (`now - last > 120`).
pub const PROGRESS_MS: u64 = 120;

pub const OUTSIDE: &str = "Ścieżka jest poza projektem.";
pub const LINK_OUTSIDE: &str = "Ten link prowadzi poza folder projektu.";
pub const ROOT_REFUSED: &str = "Nie można zmieniać katalogu głównego projektu.";
pub const NOT_A_FOLDER: &str = "Miejsce docelowe nie jest folderem.";
pub const GONE: &str = "Plik lub folder już nie istnieje. Odśwież listę.";
pub const BUSY: &str = "Brak uprawnień lub element jest używany przez inny program.";
pub const EXISTS: &str = "Element o takiej nazwie już istnieje.";
pub const TOO_LONG: &str = "Nazwa jest zbyt długa.";
pub const NO_SPACE: &str = "Brak miejsca na dysku.";
pub const FAILED: &str = "Operacja na plikach nie powiodła się.";
pub const EMPTY_NAME: &str = "Nazwa nie może być pusta.";
pub const RESERVED: &str = "Ta nazwa jest zarezerwowana.";
pub const BAD_CHARS: &str = "Nazwa zawiera niedozwolone znaki.";
pub const TRAILING: &str = "Nazwa nie może kończyć się kropką ani spacją.";
pub const NOTHING_SELECTED: &str = "Nie wybrano żadnych elementów.";
pub const TOO_MANY: &str = "Zbyt wiele elementów lub zbyt długa ścieżka.";
pub const UNKNOWN_OP: &str = "Nieznana operacja.";
pub const INTO_ITSELF: &str = "Nie można przenieść folderu do niego samego ani do jego podfolderu.";
pub const LARGE: &str = "Kopiowanie jest bardzo duże.";
pub const CANCELLED: &str = "Operacja została anulowana.";
pub const REPLACE_ANCESTOR: &str = "Nie można zastąpić folderu, który zawiera przenoszony element.";
pub const MOVE_UNCOPYABLE: &str = "Nie można przenieść: część elementów (linki lub pliki specjalne) nie daje się skopiować.";

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

// ---------- pure helpers (src/shared/fileOps.ts) ----------

/// `toPosix`: backslashes to slashes, runs of slashes to one, no leading or trailing slash.
pub fn to_posix(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut slash = false;
    for c in path.chars() {
        let c = if c == '\\' { '/' } else { c };
        if c == '/' {
            if slash {
                continue;
            }
            slash = true;
        } else {
            slash = false;
        }
        out.push(c);
    }
    let out = out.strip_prefix('/').unwrap_or(&out);
    out.strip_suffix('/').unwrap_or(out).to_string()
}

pub fn base_name(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

pub fn parent_path(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

pub fn join_path(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

/// `topLevelPaths`: drops entries inside another listed entry (moving a folder already moves its content), first
/// occurrences in order, linear in the number of paths.
pub fn top_level_paths(paths: &[String]) -> Vec<String> {
    let mut unique: Vec<&str> = Vec::with_capacity(paths.len());
    let mut set: HashSet<&str> = HashSet::with_capacity(paths.len());
    for p in paths {
        if set.insert(p.as_str()) {
            unique.push(p);
        }
    }
    let mut result = Vec::new();
    for path in unique {
        let mut covered = !path.is_empty() && set.contains("");
        let mut end = path.len();
        while !covered {
            match path[..end].rfind('/') {
                Some(i) if i > 0 => {
                    covered = set.contains(&path[..i]);
                    end = i;
                }
                _ => break,
            }
        }
        if !covered {
            result.push(path.to_string());
        }
    }
    result
}

/// `validPathList`: 1..=5000 strings of at most 4096 UTF-16 units.
pub fn valid_path_list(paths: &Value) -> Option<Vec<String>> {
    let list = paths.as_array()?;
    if list.is_empty() || list.len() > MAX_OP_PATHS {
        return None;
    }
    list.iter().map(|p| p.as_str().filter(|s| units(s) <= MAX_OP_PATH_LENGTH).map(str::to_string)).collect()
}

/// JS `String.prototype.trim` white space (WhiteSpace and LineTerminator of ECMAScript).
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// A JS line terminator (what `.` of a JS regex never matches).
fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^(<stems>)(\..*)?$/i`: a reserved Windows device name, alone or with an extension (ASCII letters ignore their case;
/// ¹²³ match exactly, as in a JS regex without the `u` flag).
pub fn windows_device_name(name: &str, clock: bool) -> bool {
    let mut stems: Vec<String> = ["con", "prn", "aux", "nul", "conin$", "conout$"].iter().map(|s| s.to_string()).collect();
    if clock {
        stems.push("clock$".into());
    }
    for prefix in ["com", "lpt"] {
        for d in "0123456789¹²³".chars() {
            stems.push(format!("{prefix}{d}"));
        }
    }
    stems.iter().any(|stem| {
        let mut chars = name.chars();
        let matched = stem.chars().all(|s| chars.next().is_some_and(|c| c.eq_ignore_ascii_case(&s)));
        if !matched {
            return false;
        }
        let rest: String = chars.collect();
        rest.is_empty() || (rest.starts_with('.') && !rest.chars().any(line_terminator))
    })
}

/// `validateEntryName`: the Polish message (the translation key) when the name cannot be used for a file or folder.
pub fn validate_entry_name(name: &str, platform: LocalPlatform) -> Option<&'static str> {
    if name.is_empty() || name.chars().all(js_space) {
        return Some(EMPTY_NAME);
    }
    if name == "." || name == ".." {
        return Some(RESERVED);
    }
    if units(name) > 255 {
        return Some(TOO_LONG);
    }
    if name.contains(['/', '\0']) {
        return Some(BAD_CHARS);
    }
    if platform == LocalPlatform::Windows {
        if name.chars().any(|c| matches!(c, '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0'..='\u{1f}')) {
            return Some(BAD_CHARS);
        }
        if name.ends_with(['.', ' ']) {
            return Some(TRAILING);
        }
        if windows_device_name(name, false) {
            return Some(RESERVED);
        }
    }
    None
}

/// `copyName`: "name.txt" -> "name copy.txt" (n = 1), "name copy 2.txt" (n = 2) ... Folders and dotfiles keep their whole
/// name as the stem.
pub fn copy_name(name: &str, n: u32, directory: bool) -> String {
    let dot = if directory { None } else { name.rfind('.') };
    let (stem, ext) = match dot {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let stem = strip_copy_suffix(stem);
    if n > 1 { format!("{stem} copy {n}{ext}") } else { format!("{stem} copy{ext}") }
}

/// `.replace(/ copy(?: \d+)?$/, '')`.
fn strip_copy_suffix(stem: &str) -> &str {
    if let Some(s) = stem.strip_suffix(" copy") {
        return s;
    }
    let digits = stem.len() - stem.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    if digits > 0 {
        let head = &stem[..stem.len() - digits];
        if let Some(s) = head.strip_suffix(" copy ") {
            return s;
        }
    }
    stem
}

/// JS truthiness of a JSON value (`!request.force`).
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

// ---------- errors ----------

/// `opMessage`: the text the renderer shows for a failure.
pub fn op_message(error: &FsError) -> String {
    match error.code {
        None => {
            if error.message.is_empty() {
                FAILED.into()
            } else {
                error.message.clone()
            }
        }
        Some("ENOENT") => GONE.into(),
        Some("EACCES") | Some("EPERM") | Some("EBUSY") => BUSY.into(),
        Some("EEXIST") => EXISTS.into(),
        Some("ENAMETOOLONG") => TOO_LONG.into(),
        Some("ENOSPC") => NO_SPACE.into(),
        Some(_) => error.message.clone(),
    }
}

fn op(message: &str) -> FsError {
    FsError::plain(message)
}

fn failed(error: &FsError) -> Value {
    json!({ "ok": false, "error": op_message(error) })
}

// ---------- containment ----------

fn norm(path: &str) -> String {
    if CASE_INSENSITIVE { path.to_lowercase() } else { path.to_string() }
}

/// `sameOrInside(parent, child)` on real paths (case folded on Windows and macOS).
fn same_or_inside(parent: &str, child: &str) -> bool {
    let (a, b) = (norm(parent), norm(child));
    if a == b {
        return true;
    }
    let sep = jspath::sep_of(F);
    if a.ends_with(sep) { b.starts_with(&a) } else { b.starts_with(&format!("{a}{sep}")) }
}

struct Context {
    root: String,
    real_root: String,
}

fn context(project_root: &str) -> Result<Context, FsError> {
    let root = jspath::resolve(F, &[project_root]);
    let real_root = fsx::realpath(&root)?;
    Ok(Context { root, real_root })
}

/// An entry of the project (never the root itself); only its parent is resolved, so the entry may be a link.
struct Entry {
    rel: String,
    name: String,
    real: String,
    parent_real: String,
}

/// The common string checks of `entryOf` / `folderOf`.
fn checked_rel(value: &Value) -> Result<String, FsError> {
    let Some(raw) = value.as_str() else { return Err(op(OUTSIDE)) };
    let drive = {
        let mut c = raw.chars();
        matches!((c.next(), c.next()), (Some(l), Some(':')) if l.is_ascii_alphabetic())
    };
    if units(raw) > MAX_OP_PATH_LENGTH || raw.contains('\0') || jspath::is_absolute(F, raw) || drive {
        return Err(op(OUTSIDE));
    }
    Ok(to_posix(raw))
}

fn entry_of(ctx: &Context, value: &Value) -> Result<Entry, FsError> {
    let rel = checked_rel(value)?;
    if rel.is_empty() {
        return Err(op(ROOT_REFUSED));
    }
    if rel.split('/').any(|part| part == ".." || part == ".") {
        return Err(op(OUTSIDE));
    }
    let requested = jspath::resolve(F, &[&ctx.root, &rel]);
    if !jspath::is_inside(F, &ctx.root, &requested) || requested == ctx.root {
        return Err(op(OUTSIDE));
    }
    let parent_real = fsx::realpath(&jspath::dirname(F, &requested))?;
    if !same_or_inside(&ctx.real_root, &parent_real) {
        return Err(op(LINK_OUTSIDE));
    }
    let name = jspath::basename(F, &requested);
    let real = jspath::join_name(F, &parent_real, &name);
    Ok(Entry { rel, name, real, parent_real })
}

/// An existing folder inside the project ('' = the root), as a real path.
struct Folder {
    rel: String,
    real: String,
}

fn folder_of(ctx: &Context, value: &Value) -> Result<Folder, FsError> {
    let rel = checked_rel(value)?;
    if rel.split('/').any(|part| part == ".." || part == ".") {
        return Err(op(OUTSIDE));
    }
    let requested = jspath::resolve(F, &[&ctx.root, &rel]);
    if !jspath::is_inside(F, &ctx.root, &requested) {
        return Err(op(OUTSIDE));
    }
    let real = fsx::realpath(&requested)?;
    if !same_or_inside(&ctx.real_root, &real) {
        return Err(op(LINK_OUTSIDE));
    }
    if !fsx::stat(&real)?.is_dir {
        return Err(op(NOT_A_FOLDER));
    }
    Ok(Folder { rel, real })
}

// ---------- options ----------

/// Moves one absolute path to the OS trash (Electron's shell.trashItem; replaceable in tests and by MC_TRASH_DIR).
pub type TrashFn = dyn Fn(&str) -> Result<(), FsError> + Send + Sync;
pub type RenameFn = dyn Fn(&str, &str) -> Result<(), FsError> + Send + Sync;
pub type SymlinkFn = dyn Fn(&str, &str, LinkType) -> Result<(), FsError> + Send + Sync;
pub type ProgressFn = dyn Fn(u64, u64) + Send + Sync;

/// Test hooks: the calls that cannot be provoked portably (EXDEV, link creation).
#[derive(Default)]
pub struct Hooks {
    pub rename: Option<Box<RenameFn>>,
    pub symlink: Option<Box<SymlinkFn>>,
}

pub struct OpOptions {
    pub trash: Arc<TrashFn>,
    pub platform: LocalPlatform,
    /// The renderer's cancel (`fs:cancelOp`).
    pub cancel: Option<Arc<AtomicBool>>,
    /// `(entries, bytes)` at most every 120 ms and once at the end.
    pub on_progress: Option<Box<ProgressFn>>,
    /// `(bytes, entries)` above which a copy asks first.
    pub limits: (u64, u64),
    pub hooks: Hooks,
}

impl OpOptions {
    pub fn new(trash: Arc<TrashFn>) -> Self {
        Self {
            trash,
            platform: LocalPlatform::native(),
            cancel: None,
            on_progress: None,
            limits: (LARGE_COPY_BYTES, LARGE_COPY_ENTRIES),
            hooks: Hooks::default(),
        }
    }

    fn aborted(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst))
    }
}

// ---------- rename ----------

/// `renameProjectEntry(projectRoot, path, newName)`.
pub fn rename_project_entry(project_root: &str, path: &Value, new_name: &Value, platform: LocalPlatform) -> Value {
    match rename_inner(project_root, path, new_name, platform) {
        Ok(v) => v,
        Err(e) => failed(&e),
    }
}

fn rename_inner(project_root: &str, path: &Value, new_name: &Value, platform: LocalPlatform) -> Result<Value, FsError> {
    let ctx = context(project_root)?;
    let entry = entry_of(&ctx, path)?;
    let Some(new_name) = new_name.as_str() else { return Err(op(EMPTY_NAME)) };
    if let Some(invalid) = validate_entry_name(new_name, platform) {
        return Err(op(invalid));
    }
    let to = join_path(parent_path(&entry.rel), new_name);
    if new_name == entry.name {
        return Ok(json!({ "ok": true, "from": entry.rel, "to": to }));
    }
    if fsx::lstat_or_none(&entry.real).is_none() {
        return Err(op(GONE));
    }
    let target = jspath::join_name(F, &entry.parent_real, new_name);
    if fsx::lstat_or_none(&target).is_some() {
        // A case-only rename on a case-insensitive volume "exists" already: go through a temporary name.
        if new_name.to_lowercase() == entry.name.to_lowercase() && fsx::same_file(&entry.real, &target) {
            let temporary = jspath::join_name(F, &entry.parent_real, &format!(".mc-rename-{}", uuid::Uuid::new_v4()));
            fsx::rename(&entry.real, &temporary)?;
            if let Err(e) = fsx::rename(&temporary, &target) {
                let _ = fsx::rename(&temporary, &entry.real);
                return Err(e);
            }
            return Ok(json!({ "ok": true, "from": entry.rel, "to": to }));
        }
        return Err(op(EXISTS));
    }
    fsx::rename(&entry.real, &target)?;
    Ok(json!({ "ok": true, "from": entry.rel, "to": to }))
}

// ---------- create ----------

/// `createProjectEntry(projectRoot, directory, name, kind)`.
pub fn create_project_entry(project_root: &str, directory: &Value, name: &Value, folder: bool, platform: LocalPlatform) -> Value {
    let run = || -> Result<Value, FsError> {
        let ctx = context(project_root)?;
        let dir = folder_of(&ctx, directory)?;
        let Some(name) = name.as_str() else { return Err(op(EMPTY_NAME)) };
        if let Some(invalid) = validate_entry_name(name, platform) {
            return Err(op(invalid));
        }
        let target = jspath::join_name(F, &dir.real, name);
        if fsx::lstat_or_none(&target).is_some() {
            return Err(op(EXISTS));
        }
        if folder {
            fsx::mkdir(&target, None)?;
        } else {
            fsx::create_new_file(&target)?;
        }
        Ok(json!({ "ok": true, "path": join_path(&dir.rel, name) }))
    };
    run().unwrap_or_else(|e| failed(&e))
}

// ---------- delete (to the trash only) ----------

/// `deleteProjectEntries(projectRoot, paths)`: every top-level entry to the trash, failures per item.
pub fn delete_project_entries(project_root: &str, paths: &Value, trash: &TrashFn) -> Value {
    let run = || -> Result<Value, FsError> {
        if paths.as_array().is_none_or(|a| a.is_empty()) {
            return Err(op(NOTHING_SELECTED));
        }
        let Some(list) = valid_path_list(paths) else { return Err(op(TOO_MANY)) };
        let ctx = context(project_root)?;
        let posix: Vec<String> = list.iter().map(|p| to_posix(p)).collect();
        let mut entries = Vec::new();
        for path in top_level_paths(&posix) {
            entries.push(entry_of(&ctx, &Value::String(path))?);
        }
        let mut trashed = Vec::new();
        let mut failures = Vec::new();
        for entry in entries {
            let result = if fsx::lstat_or_none(&entry.real).is_none() { Err(op(GONE)) } else { trash(&entry.real) };
            match result {
                Ok(()) => trashed.push(Value::String(entry.rel)),
                Err(e) => failures.push(json!({ "path": entry.rel, "error": op_message(&e) })),
            }
        }
        Ok(json!({ "ok": true, "trashed": trashed, "failed": failures }))
    };
    run().unwrap_or_else(|e| failed(&e))
}

// ---------- copy / move ----------

struct Plan {
    entry: Entry,
    directory: bool,
    target: String,
    target_rel: String,
    same: bool,
}

/// `measure`: walks the sources (links not followed) until a limit is passed.
fn measure(paths: &[String], limits: (u64, u64)) -> (u64, u64, bool) {
    let (max_bytes, max_entries) = limits;
    let (mut entries, mut bytes) = (0u64, 0u64);
    // Depth first in readdir order like 1.1.4's recursion, kept on the heap (a deep tree never overflows the stack).
    let mut stack: Vec<String> = paths.iter().rev().cloned().collect();
    while let Some(path) = stack.pop() {
        let Some(info) = fsx::lstat_or_none(&path) else { continue };
        entries += 1;
        if info.is_file {
            bytes += info.size;
        }
        if entries > max_entries || bytes > max_bytes {
            return (entries, bytes, true);
        }
        if info.is_dir {
            let Ok(names) = fsx::readdir_names(&path) else { continue };
            for name in names.iter().rev() {
                stack.push(jspath::join_name(F, &path, name));
            }
        }
    }
    (entries, bytes, false)
}

struct Counter<'a> {
    entries: u64,
    bytes: u64,
    notes: Vec<String>,
    last: Option<Instant>,
    options: &'a OpOptions,
}

impl Counter<'_> {
    fn tick(&mut self) -> Result<(), FsError> {
        if self.options.aborted() {
            return Err(op(CANCELLED));
        }
        if let Some(progress) = &self.options.on_progress {
            let now = Instant::now();
            if self.last.is_none_or(|last| now.duration_since(last) > Duration::from_millis(PROGRESS_MS)) {
                self.last = Some(now);
                progress(self.entries, self.bytes);
            }
        }
        Ok(())
    }
}

enum Step {
    Visit(String, String),
    /// A copied folder gets its times back once everything in it is there.
    Times(String, f64, f64),
}

/// `copyTree(source, target)`: links are copied as links (never followed; where that is not allowed the link is skipped
/// with a note), folders with their mode and times, files with COPYFILE_EXCL and their times; special files get a note.
fn copy_tree(source: &str, target: &str, counter: &mut Counter) -> Result<(), FsError> {
    let mut stack = vec![Step::Visit(source.to_string(), target.to_string())];
    while let Some(step) = stack.pop() {
        let (source, target) = match step {
            Step::Times(path, atime, mtime) => {
                let _ = fsx::utimes(&path, atime, mtime);
                continue;
            }
            Step::Visit(s, t) => (s, t),
        };
        counter.tick()?;
        let info = fsx::lstat(&source)?;
        counter.entries += 1;
        if info.is_link {
            let linked = (|| -> Result<(), FsError> {
                let destination = fsx::readlink(&source)?;
                let kind =
                    if cfg!(windows) && fsx::stat(&source).is_ok_and(|s| s.is_dir) { LinkType::Junction } else { LinkType::File };
                match &counter.options.hooks.symlink {
                    Some(hook) => hook(&destination, &target, kind),
                    None => fsx::symlink(&destination, &target, kind),
                }
            })();
            if linked.is_err() {
                counter.notes.push(jspath::basename(F, &source));
            }
            continue;
        }
        if info.is_dir {
            fsx::mkdir(&target, Some(info.mode & 0o777))?;
            let names = fsx::readdir_names(&source)?;
            stack.push(Step::Times(target.clone(), info.atime_ms, info.mtime_ms));
            for name in names.iter().rev() {
                stack.push(Step::Visit(jspath::join_name(F, &source, name), jspath::join_name(F, &target, name)));
            }
            continue;
        }
        if !info.is_file {
            counter.notes.push(jspath::basename(F, &source));
            continue;
        }
        fsx::copy_file_excl(&source, &target)?;
        counter.bytes += info.size;
        let _ = fsx::utimes(&target, info.atime_ms, info.mtime_ms);
    }
    Ok(())
}

fn free_name(dir: &str, name: &str, directory: bool, claimed: &HashSet<String>) -> Result<String, FsError> {
    for n in 1..10000 {
        let candidate = copy_name(name, n, directory);
        if !claimed.contains(&norm(&candidate)) && fsx::lstat_or_none(&jspath::join_name(F, dir, &candidate)).is_none() {
            return Ok(candidate);
        }
    }
    Err(op(EXISTS))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Policy {
    Ask,
    Skip,
    KeepBoth,
    Replace,
}

/// `transferProjectEntries(projectRoot, request)`: copy or move into a folder of the project.
pub fn transfer_project_entries(project_root: &str, request: &Value, options: &OpOptions) -> Value {
    transfer_inner(project_root, request, options).unwrap_or_else(|e| failed(&e))
}

fn transfer_inner(project_root: &str, request: &Value, options: &OpOptions) -> Result<Value, FsError> {
    let Some(req) = request.as_object() else { return Err(op(NOTHING_SELECTED)) };
    let paths = req.get("paths").unwrap_or(&Value::Null);
    if paths.as_array().is_none_or(|a| a.is_empty()) {
        return Err(op(NOTHING_SELECTED));
    }
    let Some(list) = valid_path_list(paths) else { return Err(op(TOO_MANY)) };
    let copying = match req.get("kind").and_then(Value::as_str) {
        Some("copy") => true,
        Some("move") => false,
        _ => return Err(op(UNKNOWN_OP)),
    };
    let policy = match req.get("conflict").unwrap_or(&Value::Null) {
        Value::Null => Policy::Ask,
        Value::String(s) if s == "ask" => Policy::Ask,
        Value::String(s) if s == "skip" => Policy::Skip,
        Value::String(s) if s == "keepBoth" => Policy::KeepBoth,
        Value::String(s) if s == "replace" => Policy::Replace,
        _ => return Err(op(UNKNOWN_OP)),
    };
    let ctx = context(project_root)?;
    let destination = match req.get("destination") {
        None | Some(Value::Null) => folder_of(&ctx, &Value::String(String::new()))?,
        Some(v) => folder_of(&ctx, v)?,
    };
    let mut plans: Vec<Plan> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();
    let posix: Vec<String> = list.iter().map(|p| to_posix(p)).collect();
    for path in top_level_paths(&posix) {
        let entry = entry_of(&ctx, &Value::String(path))?;
        let Some(info) = fsx::lstat_or_none(&entry.real) else { return Err(op(GONE)) };
        let directory = info.is_dir;
        if directory && same_or_inside(&entry.real, &destination.real) {
            return Err(op(INTO_ITSELF));
        }
        let target = jspath::join_name(F, &destination.real, &entry.name);
        let same = norm(&target) == norm(&entry.real);
        let target_rel = join_path(&destination.rel, &entry.name);
        let internal = claimed.contains(&norm(&entry.name));
        if !same && (internal || fsx::lstat_or_none(&target).is_some()) {
            let mut conflict = json!({ "path": target_rel, "name": entry.name, "directory": directory });
            if internal {
                conflict["internal"] = Value::Bool(true);
            }
            conflicts.push(conflict);
        }
        claimed.insert(norm(&entry.name));
        plans.push(Plan { entry, directory, target, target_rel, same });
    }
    if !conflicts.is_empty() && policy == Policy::Ask {
        return Ok(json!({ "ok": false, "code": "conflict", "error": EXISTS, "conflicts": conflicts }));
    }
    if copying && !truthy(req.get("force").unwrap_or(&Value::Null)) {
        let sources: Vec<String> = plans.iter().map(|p| p.entry.real.clone()).collect();
        let (entries, bytes, exceeded) = measure(&sources, options.limits);
        if exceeded {
            return Ok(json!({ "ok": false, "code": "large", "error": LARGE, "entries": entries, "bytes": bytes }));
        }
    }

    let mut done = Vec::new();
    let mut skipped = Vec::new();
    let mut failures = Vec::new();
    let mut counter = Counter { entries: 0, bytes: 0, notes: Vec::new(), last: None, options };
    let mut taken: HashSet<String> = HashSet::new();
    let mut replaced = Vec::new();
    let mut cancelled = false;
    for plan in &plans {
        let mut target = plan.target.clone();
        let mut target_rel = plan.target_rel.clone();
        let mut created = false;
        let step = (|| -> Result<bool, FsError> {
            counter.tick()?;
            let name = &plan.entry.name;
            if plan.same {
                if !copying {
                    taken.insert(norm(name));
                    skipped.push(Value::String(plan.entry.rel.clone()));
                    return Ok(false);
                }
                let free = free_name(&destination.real, name, plan.directory, &taken)?;
                target = jspath::join_name(F, &destination.real, &free);
                target_rel = join_path(&destination.rel, &free);
            } else if taken.contains(&norm(name)) || fsx::lstat_or_none(&target).is_some() {
                if policy == Policy::Skip {
                    skipped.push(Value::String(plan.entry.rel.clone()));
                    return Ok(false);
                }
                // An item that this very operation produced is never replaced: the second one gets a free name instead.
                if policy == Policy::KeepBoth || taken.contains(&norm(name)) {
                    let free = free_name(&destination.real, name, plan.directory, &taken)?;
                    target = jspath::join_name(F, &destination.real, &free);
                    target_rel = join_path(&destination.rel, &free);
                } else {
                    // Replace: the old item goes to the trash first (never a permanent delete).
                    if same_or_inside(&target, &plan.entry.real) {
                        return Err(op(REPLACE_ANCESTOR));
                    }
                    if fsx::lstat_or_none(&target).is_none() {
                        return Err(op(EXISTS));
                    }
                    (options.trash)(&target)?;
                    replaced.push(Value::String(target_rel.clone()));
                }
            }
            taken.insert(norm(&jspath::basename(F, &target)));
            if copying {
                created = true;
                copy_tree(&plan.entry.real, &target, &mut counter)?;
            } else {
                let renamed = match &options.hooks.rename {
                    Some(hook) => hook(&plan.entry.real, &target),
                    None => fsx::rename(&plan.entry.real, &target),
                };
                if let Err(e) = renamed {
                    if !e.is("EXDEV") {
                        return Err(e);
                    }
                    created = true;
                    let notes = counter.notes.len();
                    copy_tree(&plan.entry.real, &target, &mut counter)?;
                    if counter.notes.len() > notes {
                        // Something could not be copied: removing the source would destroy it. Keep it and undo the copy.
                        counter.notes.truncate(notes);
                        return Err(op(MOVE_UNCOPYABLE));
                    }
                    created = false;
                    fsx::rm_rf(&plan.entry.real)?;
                }
            }
            created = false;
            Ok(true)
        })();
        match step {
            Ok(true) => done.push(json!({ "from": plan.entry.rel, "to": target_rel })),
            Ok(false) => {}
            Err(e) => {
                // A half-made copy is our own leftovers: remove them so no partial tree stays behind.
                if created {
                    let _ = fsx::rm_rf(&target);
                }
                if options.aborted() {
                    cancelled = true;
                    break;
                }
                failures.push(json!({ "path": plan.entry.rel, "error": op_message(&e) }));
            }
        }
    }
    if let Some(progress) = &options.on_progress {
        progress(counter.entries, counter.bytes);
    }
    Ok(json!({
        "ok": true, "done": done, "skipped": skipped, "failed": failures, "notes": counter.notes,
        "cancelled": cancelled, "replaced": replaced,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_paths_and_parents() {
        assert_eq!(to_posix("\\a\\\\b/"), "a/b");
        assert_eq!(to_posix("//"), "");
        assert_eq!(parent_path("a/b/c"), "a/b");
        assert_eq!(base_name("a/b/c"), "c");
        assert_eq!(join_path("", "x"), "x");
    }

    #[test]
    fn copy_suffixes() {
        assert_eq!(strip_copy_suffix("a copy 12"), "a");
        assert_eq!(strip_copy_suffix("a copy x"), "a copy x");
        assert_eq!(strip_copy_suffix("a copy  2"), "a copy  2");
        assert_eq!(strip_copy_suffix("acopy"), "acopy");
    }
}
