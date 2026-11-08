//! The manage operations of the SFTP view (T4, port of 1.1.4 src/sftphost/host.ts `deleteRoots`, `count`, `remove`,
//! `walkModes`, `chmodCount`, `chmod` and the `cancelOp` registry): delete with the confirmed count, permission changes that
//! never follow a symlink, and the progress / cancel of a recursive change by its op id.
//!
//! The walks run on an explicit stack instead of recursion (a deep tree from a server must not grow the native stack); the
//! order of visits, the limits and the errors are those of 1.1.4.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use futures::stream::{self, StreamExt, TryStreamExt};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::error::SftpErrorCode;
use crate::host::HostChannels;
use crate::limits::{PROGRESS_INTERVAL_MS, posix_contains, posix_normalize, valid_remote_name, valid_remote_path};
use crate::op::{ChmodRequest, DeleteCount};
use crate::remote::RemoteSide;
use crate::sides::{DirEntry, EntryKind, FileSide, SideError};

/// Entries one walk may visit before it gives up with `tooMany`.
pub const WALK_ENTRIES: u64 = 1_000_000;
/// Folder depth of a permission walk.
pub const WALK_DEPTH: usize = 64;
/// `CHMOD_ERRORS_MAX`: errors listed after a permission change (the rest is counted only).
pub const CHMOD_ERRORS_MAX: usize = 200;
/// `PERM_MASK`.
pub const PERM_MASK: u32 = 0o7777;
/// Files of one folder removed at the same time.
const UNLINKS_AT_ONCE: usize = 8;

/// `applyMode`: the bits in `mask` come from `bits`, the rest stays as it was.
pub fn apply_mode(current: u32, bits: u32, mask: u32) -> u32 {
    ((current & PERM_MASK) & !mask) | (bits & mask)
}

/// `deleteRoots`: normalized paths without duplicates and without paths inside another selected one (counted once,
/// removed once). Shorter paths (in UTF-16 units, a stable sort like JS) come first.
pub fn delete_roots(paths: &[String]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for p in paths {
        let n = posix_normalize(p);
        if !unique.contains(&n) {
            unique.push(n);
        }
    }
    unique.sort_by_key(|p| unimux_core::utf16::len(p));
    let mut roots: Vec<String> = Vec::new();
    for p in unique {
        if !roots.iter().any(|r| posix_contains(r, &p)) {
            roots.push(p);
        }
    }
    roots
}

fn code(e: SideError) -> SftpErrorCode {
    e.code
}

/// `count`: what deleting `paths` removes: files (symlinks count as files, never followed) and folders, recursively.
pub async fn delete_count(side: &RemoteSide, paths: &[String]) -> Result<DeleteCount, SftpErrorCode> {
    let mut total = DeleteCount::default();
    let mut seen: u64 = 0;
    for path in paths {
        if path == "/" || !valid_remote_path(path) {
            return Err(SftpErrorCode::Invalid);
        }
        // Depth first in listing order, like the recursive walk of 1.1.4: (folder, name) of a child, or a root.
        let mut stack: Vec<(Option<String>, String)> = vec![(None, path.clone())];
        while let Some((parent, name)) = stack.pop() {
            let p = match parent {
                None => name,
                Some(parent) => {
                    // A name from the server that is not one POSIX segment ("..", "a/b") would make the walk leave the
                    // folder: refused. A "\" is an ordinary character here (it never becomes a local path), so such files
                    // stay deletable.
                    if !valid_remote_name(&name) {
                        return Err(SftpErrorCode::InvalidName);
                    }
                    side.join(&parent, &name)
                }
            };
            seen += 1;
            if seen > WALK_ENTRIES {
                return Err(SftpErrorCode::TooMany);
            }
            let meta = side.lstat(&p).await.map_err(code)?.ok_or(SftpErrorCode::NotFound)?;
            if meta.kind != EntryKind::Dir {
                total.files += 1;
                continue;
            }
            total.dirs += 1;
            let children = side.readdir(&p).await.map_err(code)?;
            stack.extend(children.into_iter().rev().map(|c| (Some(p.clone()), c.name)));
        }
    }
    Ok(total)
}

enum RemoveStep {
    Enter(String),
    Rmdir(String),
}

/// `remove`: a file or link is unlinked, a folder emptied (its files 8 at a time, then its folders one by one) and removed.
pub async fn remove(side: &RemoteSide, path: &str) -> Result<(), SftpErrorCode> {
    let mut stack = vec![RemoveStep::Enter(path.to_string())];
    while let Some(step) = stack.pop() {
        match step {
            RemoveStep::Rmdir(p) => side.rmdir(&p).await.map_err(code)?,
            RemoveStep::Enter(p) => {
                let Some(meta) = side.lstat(&p).await.map_err(code)? else { continue };
                if meta.kind != EntryKind::Dir {
                    side.unlink(&p).await.map_err(code)?;
                    continue;
                }
                let children = side.readdir(&p).await.map_err(code)?;
                if children.iter().any(|c| !valid_remote_name(&c.name)) {
                    return Err(SftpErrorCode::InvalidName);
                }
                let files: Vec<String> =
                    children.iter().filter(|c| c.meta.kind != EntryKind::Dir).map(|c| side.join(&p, &c.name)).collect();
                // Boxed futures made up front (a closure that borrows `side` would not be Send for every lifetime).
                let unlinks: Vec<BoxFuture<'_, Result<(), SideError>>> = files.iter().map(|f| side.unlink(f)).collect();
                stream::iter(unlinks).buffer_unordered(UNLINKS_AT_ONCE).map_err(code).try_collect::<Vec<()>>().await?;
                stack.push(RemoveStep::Rmdir(p.clone()));
                let dirs: Vec<String> =
                    children.iter().filter(|c| c.meta.kind == EntryKind::Dir).map(|c| side.join(&p, &c.name)).collect();
                stack.extend(dirs.into_iter().rev().map(RemoveStep::Enter));
            }
        }
    }
    Ok(())
}

/// What a permission walk found at one path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisitKind {
    File,
    Dir,
    Link,
    Bad,
}

/// One visit of [`ModeWalk`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Visit {
    pub path: String,
    pub kind: VisitKind,
    pub mode: u32,
    pub error: Option<SftpErrorCode>,
}

impl Visit {
    fn bad(path: String, error: SftpErrorCode) -> Visit {
        Visit { path, kind: VisitKind::Bad, mode: 0, error: Some(error) }
    }
}

/// What [`ModeWalk::next`] gives.
#[derive(Debug)]
pub enum Step {
    Visit(Visit),
    /// The walk was cancelled (checked before each entry).
    Cancelled,
    /// Everything was visited.
    Done,
}

enum Frame {
    /// A path to look at.
    Enter { path: String, root: String, depth: usize },
    /// A folder to read (after its pre-order visit, so a new value that gives the owner r+x is in place first).
    List { path: String, root: String, depth: usize, mode: u32 },
    /// The rest of a folder's names.
    Children { path: String, root: String, depth: usize, children: VecDeque<DirEntry>, mode: u32 },
}

/// `walkModes`: walks the selection (folders recursively with `recursive`) with the delete walk's rules: a name from the
/// server that is not one safe segment is never joined (an error entry), nothing outside the selected folder is visited,
/// symlinks are never followed or changed (chmod on a link changes its target, which may be anywhere). After a folder was
/// read it is looked at again: one that turned into something else meanwhile (a link swapped in) is not walked into.
/// `post_order`: a folder is visited after its contents (a folder value that takes away the owner's r or x would lock the
/// walk out otherwise).
///
/// The caller drives it (`next` until `Done`, handling each visit before asking again) and stops early by not asking again
/// (1.1.4's visitor returning false).
pub struct ModeWalk<'a> {
    side: &'a RemoteSide,
    roots: VecDeque<String>,
    recursive: bool,
    post_order: bool,
    cancelled: Option<Arc<AtomicBool>>,
    stack: Vec<Frame>,
    seen: u64,
}

impl<'a> ModeWalk<'a> {
    pub fn new(
        side: &'a RemoteSide,
        roots: Vec<String>,
        recursive: bool,
        post_order: bool,
        cancelled: Option<Arc<AtomicBool>>,
    ) -> ModeWalk<'a> {
        ModeWalk { side, roots: roots.into(), recursive, post_order, cancelled, stack: Vec::new(), seen: 0 }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.as_ref().is_some_and(|c| c.load(Ordering::SeqCst))
    }

    /// The next visit; an error ends the whole operation (an lstat that failed, too many entries, an invalid root).
    pub async fn next(&mut self) -> Result<Step, SftpErrorCode> {
        loop {
            let Some(frame) = self.stack.pop() else {
                let Some(root) = self.roots.pop_front() else { return Ok(Step::Done) };
                if root == "/" && self.recursive {
                    return Err(SftpErrorCode::Invalid);
                }
                if !valid_remote_path(&root) {
                    return Err(SftpErrorCode::Invalid);
                }
                self.stack.push(Frame::Enter { path: root.clone(), root, depth: 0 });
                continue;
            };
            match frame {
                Frame::Children { path, root, depth, mut children, mode } => {
                    let Some(child) = children.pop_front() else {
                        if self.post_order {
                            return Ok(Step::Visit(Visit { path, kind: VisitKind::Dir, mode, error: None }));
                        }
                        continue;
                    };
                    let parent = path.clone();
                    self.stack.push(Frame::Children { path, root: root.clone(), depth, children, mode });
                    if !valid_remote_name(&child.name) {
                        return Ok(Step::Visit(Visit::bad(format!("{parent}/{}", child.name), SftpErrorCode::InvalidName)));
                    }
                    self.stack.push(Frame::Enter { path: self.side.join(&parent, &child.name), root, depth: depth + 1 });
                }
                Frame::List { path, root, depth, mode } => {
                    let children = match self.side.readdir(&path).await {
                        Ok(c) => c,
                        Err(e) => return Ok(Step::Visit(Visit::bad(path, e.code))),
                    };
                    // The listing came from whatever is at this path now: still the folder, or the walk stops here.
                    match self.side.lstat(&path).await.ok().flatten() {
                        Some(again) if again.kind == EntryKind::Dir => {
                            let mode = again.mode.unwrap_or(mode);
                            self.stack.push(Frame::Children { path, root, depth, children: children.into(), mode });
                        }
                        _ => return Ok(Step::Visit(Visit::bad(path, SftpErrorCode::Changed))),
                    }
                }
                Frame::Enter { path, root, depth } => {
                    if self.is_cancelled() {
                        return Ok(Step::Cancelled);
                    }
                    self.seen += 1;
                    if self.seen > WALK_ENTRIES || depth > WALK_DEPTH {
                        return Err(SftpErrorCode::TooMany);
                    }
                    if !posix_contains(&root, &path) {
                        return Ok(Step::Visit(Visit::bad(path, SftpErrorCode::Invalid)));
                    }
                    let Some(meta) = self.side.lstat(&path).await.map_err(code)? else {
                        return Ok(Step::Visit(Visit::bad(path, SftpErrorCode::NotFound)));
                    };
                    let mode = meta.mode.unwrap_or(0);
                    let kind = match meta.kind {
                        EntryKind::Symlink => {
                            return Ok(Step::Visit(Visit {
                                path,
                                kind: VisitKind::Link,
                                mode,
                                error: Some(SftpErrorCode::LinkSkipped),
                            }));
                        }
                        EntryKind::Other => return Ok(Step::Visit(Visit::bad(path, SftpErrorCode::Unsupported))),
                        EntryKind::Dir => VisitKind::Dir,
                        EntryKind::File => VisitKind::File,
                    };
                    if !(kind == VisitKind::Dir && self.recursive) {
                        return Ok(Step::Visit(Visit { path, kind, mode, error: None }));
                    }
                    if self.post_order {
                        self.stack.push(Frame::List { path, root, depth, mode });
                        continue;
                    }
                    self.stack.push(Frame::List { path: path.clone(), root, depth, mode });
                    return Ok(Step::Visit(Visit { path, kind, mode, error: None }));
                }
            }
        }
    }
}

/// `ChmodCount`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChmodCount {
    pub files: u64,
    pub dirs: u64,
    pub links: u64,
    pub no_follow: bool,
}

impl ChmodCount {
    pub fn to_json(self) -> Value {
        json!({ "files": self.files, "dirs": self.dirs, "links": self.links, "noFollow": self.no_follow })
    }
}

/// `chmodCount`: what a permission change of the selection touches (links are counted, never changed).
pub async fn chmod_count(
    side: &RemoteSide,
    roots: Vec<String>,
    recursive: bool,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<ChmodCount, SftpErrorCode> {
    let mut count = ChmodCount { no_follow: side.lsetstat(), ..ChmodCount::default() };
    let mut walk = ModeWalk::new(side, roots, recursive, false, cancelled);
    loop {
        match walk.next().await? {
            Step::Done | Step::Cancelled => return Ok(count),
            Step::Visit(v) => match v.kind {
                VisitKind::File => count.files += 1,
                VisitKind::Dir => count.dirs += 1,
                VisitKind::Link => count.links += 1,
                VisitKind::Bad => {}
            },
        }
    }
}

/// The running permission changes by op id (`cancelOp`).
#[derive(Default)]
pub struct RunningOps {
    ops: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl RunningOps {
    /// `cancelOp`: true when an operation of that id was running.
    pub fn cancel(&self, op_id: &str) -> bool {
        match self.ops.lock().get(op_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    fn start(&self, op_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.ops.lock().insert(op_id.to_string(), flag.clone());
        flag
    }

    fn end(&self, op_id: &str) {
        self.ops.lock().remove(op_id);
    }
}

/// Removes the op id when the change ends, however it ends.
struct OpGuard<'a> {
    ops: &'a RunningOps,
    id: Option<String>,
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            self.ops.end(id);
        }
    }
}

/// `chmod`: SETSTAT follows a symlink, so every change goes through lsetstat@openssh.com when the server offers it. Under
/// sudo (root) without it a recursive change is refused: a link swapped into the tree between the look and the change
/// could point the change at any file of the system. The folder value without the owner's r+x changes the contents first
/// (not needed as root, which reads any folder).
pub async fn chmod(
    side: &RemoteSide,
    req: &ChmodRequest,
    sudo: bool,
    ops: &RunningOps,
    channels: &HostChannels,
) -> Result<Value, SftpErrorCode> {
    let roots = delete_roots(&req.paths);
    let recursive = req.recursive;
    if recursive.is_none() && req.set.is_none() {
        return Err(SftpErrorCode::Invalid);
    }
    if recursive.is_some() && sudo && !side.lsetstat() {
        return Err(SftpErrorCode::UnsafeChmod);
    }
    let run = match &req.op_id {
        Some(id) => ops.start(id),
        None => Arc::new(AtomicBool::new(false)),
    };
    let _guard = OpGuard { ops, id: req.op_id.clone() };
    let mut changed: u64 = 0;
    let mut errors: Vec<Value> = Vec::new();
    let mut add_error = |path: &str, error: SftpErrorCode| {
        if errors.len() < CHMOD_ERRORS_MAX {
            errors.push(json!({ "path": path, "error": error.as_str() }));
        }
    };
    // The total for the progress: the dialog's count (it counted before asking), else counted here (cancellable).
    let mut total = roots.len() as u64;
    if recursive.is_some() {
        total = match req.total {
            Some(t) => t,
            None => {
                let c = chmod_count(side, roots.clone(), true, Some(run.clone())).await?;
                c.files + c.dirs
            }
        };
    }
    let mut done: u64 = 0;
    let mut last_sent: Option<Instant> = None;
    let interval = Duration::from_millis(PROGRESS_INTERVAL_MS);
    let mut progress = |done: u64, force: bool| {
        let Some(id) = &req.op_id else { return };
        let now = Instant::now();
        if !force && last_sent.is_some_and(|l| now.duration_since(l) < interval) {
            return;
        }
        last_sent = Some(now);
        channels.op_progress(id, done, total);
    };
    let post_order = recursive.is_some_and(|(dir_mode, _)| !sudo && (dir_mode & 0o500) != 0o500);
    let mut walk = ModeWalk::new(side, roots, recursive.is_some(), post_order, Some(run.clone()));
    let finished = loop {
        let v = match walk.next().await? {
            Step::Done => break true,
            Step::Cancelled => break false,
            Step::Visit(v) => v,
        };
        if run.load(Ordering::SeqCst) {
            break false;
        }
        if let Some(error) = v.error {
            if v.kind != VisitKind::Link || recursive.is_none() {
                add_error(&v.path, error);
            }
            continue;
        }
        let next = match (recursive, req.set) {
            (Some((dir_mode, file_mode)), _) => {
                if v.kind == VisitKind::Dir {
                    dir_mode
                } else {
                    file_mode
                }
            }
            (None, Some((bits, mask))) => apply_mode(v.mode, bits, mask),
            (None, None) => unreachable!("checked above"),
        };
        match side.chmod_no_follow(&v.path, next).await {
            Ok(()) => changed += 1,
            Err(e) => add_error(&v.path, e.code),
        }
        done += 1;
        progress(done, false);
    };
    let mut result = Map::new();
    result.insert("changed".into(), json!(changed));
    result.insert("errors".into(), Value::Array(errors));
    if !finished || run.load(Ordering::SeqCst) {
        result.insert("cancelled".into(), json!(true));
    }
    progress(done, true);
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_drop_duplicates_and_nested_paths() {
        let paths: Vec<String> = ["/a/b/", "/a", "/a/./b/c", "/ab", "/x//y", "/x/y"].iter().map(|s| s.to_string()).collect();
        assert_eq!(delete_roots(&paths), vec!["/a", "/ab", "/x/y"]);
        assert_eq!(delete_roots(&["/".to_string(), "/q".to_string()]), vec!["/"]);
    }

    #[test]
    fn modes_apply_under_the_mask() {
        assert_eq!(apply_mode(0o100644, 0o755, 0o111), 0o755);
        assert_eq!(apply_mode(0o4755, 0, 0o4000), 0o755);
        assert_eq!(apply_mode(0o640, 0o007, 0o007), 0o647);
    }
}
