//! Project files (1.1.4 src/main/files.ts): the containment check of every project-relative path, the tree listings (one
//! folder, a batch, every folder breadth first), the stamp of a file and its preview.

use std::cmp::Ordering;

use serde_json::{Map, Value, json};

use crate::collate::compare_names;
use crate::fserr::FsError;
use crate::fsx::{self, DirentKind};
use crate::jspath::{self, Flavor};
use crate::preview::{self, PREVIEW_BYTES, Preview};

const DIRECTORY_LIMIT: usize = 2000;
const LIST_CONCURRENCY: usize = 24;
/// At most this many folders per batch request of the tree.
pub const BATCH_LIMIT: usize = 500;
/// Folders "expand all" lists at most.
pub const DIRECTORIES_LIMIT: usize = 2500;

pub const OUTSIDE: &str = "Ścieżka jest poza projektem.";
pub const LINK_OUTSIDE: &str = "Ten link prowadzi poza folder projektu.";

/// Folders the search and "expand all" skip (src/shared/search.ts IGNORED_FOLDERS).
pub const IGNORED_FOLDERS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "out",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "release",
];

const F: Flavor = Flavor::native();

/// The message 1.1.4's `fileError` shows for a failure.
pub fn file_error(error: &FsError) -> String {
    match error.code {
        Some("ENOENT") => "Plik lub folder już nie istnieje. Odśwież listę.".into(),
        Some("EACCES") | Some("EPERM") => "Brak uprawnień do odczytu tego pliku lub folderu.".into(),
        _ => error.message.clone(),
    }
}

/// `realpath(resolve(root))`, computed once for a batch.
pub fn root_real(root: &str) -> Result<String, FsError> {
    fsx::realpath(&jspath::resolve(F, &[root]))
}

/// 1.1.4 `projectFilePath`: `relative` must stay inside the project both as written and after links and junctions are
/// resolved. Answers the real path. `None` is a non-string argument.
pub fn project_file_path(
    project_root: &str,
    relative: Option<&str>,
    root_real: Option<&Result<String, FsError>>,
) -> Result<String, FsError> {
    let Some(relative) = relative else { return Err(FsError::plain(OUTSIDE)) };
    if jspath::is_absolute(F, relative) || relative.contains('\0') {
        return Err(FsError::plain(OUTSIDE));
    }
    let root = jspath::resolve(F, &[project_root]);
    let requested = jspath::resolve(F, &[&root, relative]);
    if !jspath::is_inside(F, &root, &requested) {
        return Err(FsError::plain(OUTSIDE));
    }
    // Promise.all([rootReal, realpath(requested)]): the first rejection in argument order wins when both fail.
    let real_root = match root_real {
        Some(r) => r.clone(),
        None => fsx::realpath(&root),
    };
    let target = fsx::realpath(&requested);
    let real_root = real_root?;
    let target = target?;
    if !jspath::is_inside(F, &real_root, &target) {
        return Err(FsError::plain(LINK_OUTSIDE));
    }
    Ok(target)
}

/// One entry of a listing (`ProjectFileEntry`).
fn entry_json(dir_path: &str, name: &str, kind: DirentKind) -> Value {
    let prefix = dir_path.replace('\\', "/");
    let prefix = prefix.strip_suffix('/').unwrap_or(&prefix);
    let path = if prefix.is_empty() {
        name.to_string()
    } else if name.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}/{name}")
    };
    let kind = match kind {
        DirentKind::Dir => "directory",
        DirentKind::Link => "symlink",
        _ => "file",
    };
    json!({ "name": name, "path": path, "kind": kind })
}

/// `listProjectDirectory(root, path)`: folders first, then the natural Polish name order; at most 2000 entries.
pub fn list_project_directory(root: &str, path: Option<&str>, root_real: Option<&Result<String, FsError>>) -> Value {
    let result = (|| {
        let path = path.unwrap_or("");
        let target = project_file_path(root, Some(path), root_real)?;
        let items = fsx::readdir(&target)?;
        let total = items.len();
        let mut entries: Vec<_> = items.into_iter().filter(|d| d.kind != DirentKind::Other).collect();
        // Array.prototype.sort is stable, like sort_by.
        entries.sort_by(|a, b| match ((b.kind == DirentKind::Dir) as i32).cmp(&((a.kind == DirentKind::Dir) as i32)) {
            Ordering::Equal => compare_names(&a.name, &b.name),
            other => other,
        });
        entries.truncate(DIRECTORY_LIMIT);
        let entries: Vec<Value> = entries.iter().map(|d| entry_json(path, &d.name, d.kind)).collect();
        Ok::<_, FsError>(json!({ "ok": true, "entries": entries, "truncated": total > DIRECTORY_LIMIT }))
    })();
    result.unwrap_or_else(|e| json!({ "ok": false, "error": file_error(&e) }))
}

/// `fn` over `items` with at most `limit` running at once; results in the order of `items`.
fn map_limited<T: Sync, R: Send>(items: &[T], limit: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    if items.len() <= 1 {
        return items.iter().map(&f).collect();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<parking_lot::Mutex<Option<R>>> = items.iter().map(|_| parking_lot::Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..limit.min(items.len()) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if i >= items.len() {
                        break;
                    }
                    *results[i].lock() = Some(f(&items[i]));
                }
            });
        }
    });
    results.into_iter().map(|m| m.into_inner().expect("every item ran")).collect()
}

/// `listProjectDirectoryBatch(root, paths)`: the listings of up to 500 distinct folders (non-strings ignored).
pub fn list_project_directory_batch(root: &str, paths: &Value) -> Value {
    let mut list: Vec<String> = Vec::new();
    if let Some(items) = paths.as_array() {
        for p in items.iter().filter_map(Value::as_str) {
            if !list.iter().any(|x| x == p) {
                list.push(p.to_string());
            }
        }
    }
    list.truncate(BATCH_LIMIT);
    let mut result = Map::new();
    if list.is_empty() {
        return Value::Object(result);
    }
    let real = root_real(root);
    let listings = map_limited(&list, LIST_CONCURRENCY, |p| list_project_directory(root, Some(p), Some(&real)));
    for (path, listing) in list.into_iter().zip(listings) {
        result.insert(path, listing);
    }
    Value::Object(result)
}

/// `listProjectDirectories(root, limit)`: every folder of the project (dependency and build folders excluded), breadth first,
/// each level in name order, for "expand all".
pub fn list_project_directories(root: &str, limit: usize) -> Value {
    let base = match project_file_path(root, Some(""), None) {
        Ok(b) => b,
        Err(e) => return json!({ "ok": false, "error": file_error(&e) }),
    };
    let mut paths: Vec<String> = Vec::new();
    let mut level = vec![String::new()];
    while !level.is_empty() {
        let listed =
            map_limited(&level, LIST_CONCURRENCY, |dir| fsx::readdir(&jspath::resolve(F, &[&base, dir])).unwrap_or_default());
        let mut next = Vec::new();
        for (directory, items) in level.iter().zip(listed) {
            let mut items: Vec<_> =
                items.into_iter().filter(|d| d.kind == DirentKind::Dir && !IGNORED_FOLDERS.contains(&d.name.as_str())).collect();
            items.sort_by(|a, b| compare_names(&a.name, &b.name));
            for item in items {
                if paths.len() >= limit {
                    return json!({ "ok": true, "paths": paths, "truncated": true });
                }
                let path = if directory.is_empty() { item.name.clone() } else { format!("{directory}/{}", item.name) };
                paths.push(path.clone());
                next.push(path);
            }
        }
        level = next;
    }
    json!({ "ok": true, "paths": paths, "truncated": false })
}

/// `statProjectFile`: `{size, mtimeMs}` of a file, `"gone"` when nothing is there any more, `null` otherwise.
pub fn stat_project_file(root: &str, path: Option<&str>) -> Value {
    match project_file_path(root, path, None).and_then(|target| fsx::stat(&target)) {
        Ok(st) if st.is_file => json!({ "size": st.size, "mtimeMs": st.mtime_ms }),
        Ok(_) => Value::Null,
        Err(e) if e.is("ENOENT") || e.is("ENOTDIR") => json!("gone"),
        Err(_) => Value::Null,
    }
}

/// `readProjectFile(root, path, limit)`.
pub fn read_project_file(root: &str, path: Option<&str>, limit: usize) -> Preview {
    let result = project_file_path(root, path, None).and_then(|target| preview::read_file_at(&target, path.unwrap_or(""), limit));
    result.unwrap_or_else(|e| Preview::error(file_error(&e)))
}

/// The `limit` of `fs:readProjectFile`: the editor asks for the large view.
pub fn read_limit(large: bool) -> usize {
    if large { preview::LARGE_VIEW_BYTES } else { PREVIEW_BYTES }
}
