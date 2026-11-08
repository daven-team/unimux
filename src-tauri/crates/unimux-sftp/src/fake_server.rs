//! Test-only: a small in-memory SFTP v3 server on a duplex stream (files and folders, binary handles, short reads,
//! optional posix-rename, a rename that can be made to fail), enough to drive the client and the remote side.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use crate::proto::{self, Attrs, Reader, put_bytes, put_str, put_u32, status};

#[derive(Debug, Clone)]
pub enum Node {
    File(Vec<u8>, u32),
    Dir,
    /// A symlink to an absolute path: STAT, OPEN, OPENDIR, SETSTAT and REALPATH follow it (also as a folder on the way),
    /// LSTAT and listings show the link itself.
    Link(String),
}

#[derive(Default)]
pub struct Config {
    pub posix_rename: bool,
    pub lsetstat: bool,
    /// Plain renames whose target is this path (or "from>to") fail.
    pub fail_rename_to: Mutex<Vec<String>>,
    /// Reads answer at most this many bytes.
    pub short_reads: Option<usize>,
    /// Attributes carry uid / gid: [`Fake::owners`] per path, else the SSH user's 1000:1000 (a new file is the user's,
    /// and a chown to anyone else is ignored, like on a server where the user is not root).
    pub owners: bool,
    /// A write that would end past this offset fails (a full disk).
    pub fail_writes_after: Option<usize>,
    /// A refused rename answers a plain failure (what OpenSSH sends for a rename across file systems) instead of
    /// permission denied.
    pub refuse_rename_as_failure: bool,
}

pub struct Fake {
    pub fs: Mutex<BTreeMap<String, Node>>,
    pub cfg: Config,
    pub max_inflight_reads: AtomicUsize,
    pub writes: AtomicUsize,
    pub open_handles: Mutex<HashMap<Vec<u8>, Handle>>,
    /// Permission bits per path (default 0644 for files, 0755 for folders); SETSTAT, FSETSTAT and lsetstat change them and
    /// a rename carries them.
    pub modes: Mutex<HashMap<String, u32>>,
    /// The attribute changes in order: "SETSTAT <path>", "FSETSTAT <path of the handle>", "LSETSTAT <path>".
    pub log: Mutex<Vec<String>>,
    /// READDIR requests answered.
    pub readdirs: AtomicUsize,
    /// When a folder at this path is opened for reading (after its listing was taken), this node takes its place: another
    /// user swapping the folder between the listing and what comes next.
    pub swap_on_opendir: Mutex<Option<(String, Node)>>,
    /// The uid / gid per path; a rename carries it. Paths without one are sent without an owner, or with
    /// [`Config::owners`] as the SSH user's 1000:1000.
    pub owners: Mutex<HashMap<String, (u32, u32)>>,
    /// Every OPEN for writing: (path, exclusive, the mode it asked for).
    pub opens: Mutex<Vec<(String, bool, Option<u32>)>>,
}

#[derive(Debug, Clone)]
pub enum Handle {
    File(String),
    Dir(Vec<String>),
}

impl Fake {
    pub fn new(cfg: Config) -> Arc<Fake> {
        let mut fs = BTreeMap::new();
        fs.insert("/".to_string(), Node::Dir);
        Arc::new(Fake {
            fs: Mutex::new(fs),
            cfg,
            max_inflight_reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            open_handles: Mutex::new(HashMap::new()),
            modes: Mutex::new(HashMap::new()),
            log: Mutex::new(Vec::new()),
            readdirs: AtomicUsize::new(0),
            swap_on_opendir: Mutex::new(None),
            owners: Mutex::new(HashMap::new()),
            opens: Mutex::new(Vec::new()),
        })
    }

    /// The node's attributes with the permission bits of [`Fake::modes`] (and the owner, see [`Config::owners`]).
    fn attrs_at(&self, path: &str, node: &Node) -> Attrs {
        let mut a = Self::attrs(node);
        if let (Some(bits), Some(m)) = (self.modes.lock().get(path), a.mode) {
            a.mode = Some((m & !0o7777) | (bits & 0o7777));
        }
        let owner = self.owners.lock().get(path).copied().or(self.cfg.owners.then_some((1000, 1000)));
        if let Some((uid, gid)) = owner {
            a.uid = Some(uid);
            a.gid = Some(gid);
        }
        a
    }

    /// SETSTAT and friends: the mode (when sent) and the mtime of a file.
    fn set_attrs(&self, path: &str, a: &Attrs) -> u32 {
        let mut fs = self.fs.lock();
        let Some(node) = fs.get_mut(path) else { return status::NO_SUCH_FILE };
        if let (Node::File(_, m), Some(t)) = (node, a.mtime) {
            *m = t;
        }
        if let Some(mode) = a.mode {
            self.modes.lock().insert(path.to_string(), mode & 0o7777);
        }
        status::OK
    }

    pub fn put(&self, path: &str, node: Node) {
        self.fs.lock().insert(path.to_string(), node);
    }

    pub fn get(&self, path: &str) -> Option<Node> {
        self.fs.lock().get(path).cloned()
    }

    /// The path with every link on it followed (the last component too).
    fn real(&self, path: &str) -> String {
        let mut done = String::new();
        let mut rest: Vec<String> = path.split('/').filter(|c| !c.is_empty()).map(str::to_string).collect();
        rest.reverse();
        let mut hops = 0;
        while let Some(c) = rest.pop() {
            let next = format!("{done}/{c}");
            match self.get(&next) {
                Some(Node::Link(to)) if hops < 16 => {
                    hops += 1;
                    let mut parts: Vec<String> = to.split('/').filter(|c| !c.is_empty()).map(str::to_string).collect();
                    parts.reverse();
                    rest.extend(parts);
                    done.clear();
                }
                _ => done = next,
            }
        }
        if done.is_empty() { "/".into() } else { done }
    }

    /// The path with the links of its folders followed, the last component as it is.
    fn real_parent(&self, path: &str) -> String {
        match path.rsplit_once('/') {
            Some((parent, name)) if !name.is_empty() => {
                let p = self.real(if parent.is_empty() { "/" } else { parent });
                if p == "/" { format!("/{name}") } else { format!("{p}/{name}") }
            }
            _ => path.to_string(),
        }
    }

    fn attrs(node: &Node) -> Attrs {
        match node {
            Node::File(d, m) => {
                Attrs { size: Some(d.len() as u64), mode: Some(0o100644), atime: Some(*m), mtime: Some(*m), ..Attrs::default() }
            }
            Node::Dir => Attrs { size: Some(4096), mode: Some(0o40755), atime: Some(0), mtime: Some(0), ..Attrs::default() },
            Node::Link(to) => {
                Attrs { size: Some(to.len() as u64), mode: Some(0o120777), atime: Some(0), mtime: Some(0), ..Attrs::default() }
            }
        }
    }

    fn children(&self, dir: &str) -> Vec<String> {
        let prefix = if dir == "/" { "/".to_string() } else { format!("{dir}/") };
        self.fs
            .lock()
            .keys()
            .filter(|k| k.len() > prefix.len() && k.starts_with(&prefix) && !k[prefix.len()..].contains('/'))
            .map(|k| k[prefix.len()..].to_string())
            .collect()
    }

    /// Serves the stream until it closes.
    pub async fn serve(self: Arc<Self>, s: DuplexStream) {
        let (mut r, w) = tokio::io::split(s);
        let w = Arc::new(tokio::sync::Mutex::new(w));
        let next_handle = AtomicUsize::new(0);
        let reads = Arc::new(AtomicUsize::new(0));
        loop {
            let Ok(len) = r.read_u32().await else { return };
            let mut buf = vec![0u8; len as usize];
            if r.read_exact(&mut buf).await.is_err() {
                return;
            }
            let kind = buf[0];
            if kind == proto::INIT {
                let mut body = Vec::new();
                put_u32(&mut body, 3);
                if self.cfg.posix_rename {
                    put_str(&mut body, "posix-rename@openssh.com");
                    put_str(&mut body, "1");
                }
                if self.cfg.lsetstat {
                    put_str(&mut body, "lsetstat@openssh.com");
                    put_str(&mut body, "1");
                }
                let _ = w.lock().await.write_all(&proto::frame(proto::VERSION, None, &body)).await;
                continue;
            }
            let mut rd = Reader::new(&buf[1..]);
            let id = rd.u32().unwrap();
            let in_flight = reads.fetch_add(1, Ordering::SeqCst) + 1;
            if kind == proto::READ {
                self.max_inflight_reads.fetch_max(in_flight, Ordering::SeqCst);
            }
            let (t, body) = self.handle(kind, &mut rd, &next_handle);
            // Answers go out on their own task after a yield, so many requests are in flight at once.
            let (w, reads) = (w.clone(), reads.clone());
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                let _ = w.lock().await.write_all(&proto::frame(t, Some(id), &body)).await;
                reads.fetch_sub(1, Ordering::SeqCst);
            });
        }
    }

    fn handle(&self, kind: u8, rd: &mut Reader<'_>, next_handle: &AtomicUsize) -> (u8, Vec<u8>) {
        let st = |code: u32| {
            let mut b = Vec::new();
            put_u32(&mut b, code);
            put_str(&mut b, "");
            put_str(&mut b, "");
            (proto::STATUS, b)
        };
        let new_handle = |h: Handle| {
            // Bytes that are not UTF-8: the client must send them back unchanged.
            let mut key = vec![0xff, 0xfe];
            key.extend_from_slice(&(next_handle.fetch_add(1, Ordering::SeqCst) as u32).to_be_bytes());
            self.open_handles.lock().insert(key.clone(), h);
            let mut b = Vec::new();
            put_bytes(&mut b, &key);
            (proto::HANDLE, b)
        };
        let attrs_reply = |a: Attrs| {
            let mut b = Vec::new();
            a.encode(&mut b);
            (proto::ATTRS, b)
        };
        match kind {
            proto::OPEN => {
                let path = self.real(&rd.string().unwrap());
                let flags = rd.u32().unwrap();
                let exists = self.get(&path);
                if flags & proto::open_flags::WRITE != 0 {
                    let mode = Attrs::decode(rd).ok().and_then(|a| a.mode);
                    let excl = flags & proto::open_flags::EXCL != 0;
                    self.opens.lock().push((path.clone(), excl, mode));
                    if flags & proto::open_flags::EXCL != 0 && exists.is_some() {
                        return st(status::FAILURE);
                    }
                    if matches!(exists, Some(Node::Dir)) {
                        return st(status::FAILURE);
                    }
                    if flags & proto::open_flags::TRUNC != 0 || exists.is_none() {
                        self.put(&path, Node::File(Vec::new(), 0));
                    }
                } else if !matches!(exists, Some(Node::File(..))) {
                    return st(if exists.is_none() { status::NO_SUCH_FILE } else { status::FAILURE });
                }
                new_handle(Handle::File(path))
            }
            proto::OPENDIR => {
                let asked = rd.string().unwrap();
                let real = self.real(&asked);
                // A listing of a folder link names the entries under the path that was asked for.
                let path = if matches!(self.get(&real), Some(Node::Dir)) && real != asked { real } else { asked };
                if !matches!(self.get(&path), Some(Node::Dir)) {
                    return st(status::NO_SUCH_FILE);
                }
                let mut names = vec![".".to_string(), "..".to_string()];
                names.extend(self.children(&path).into_iter().map(|n| format!("{path}\0{n}")));
                let swap = self.swap_on_opendir.lock().take_if(|(p, _)| *p == path);
                if let Some((p, node)) = swap {
                    self.put(&p, node);
                }
                new_handle(Handle::Dir(names))
            }
            proto::CLOSE => {
                let h = rd.bytes().unwrap().to_vec();
                match self.open_handles.lock().remove(&h) {
                    Some(_) => st(status::OK),
                    None => st(status::FAILURE),
                }
            }
            proto::READ => {
                let h = rd.bytes().unwrap().to_vec();
                let offset = rd.u64().unwrap() as usize;
                let mut len = rd.u32().unwrap() as usize;
                if let Some(max) = self.cfg.short_reads {
                    len = len.min(max);
                }
                let Some(Handle::File(path)) = self.open_handles.lock().get(&h).cloned() else { return st(status::FAILURE) };
                let Some(Node::File(data, _)) = self.get(&path) else { return st(status::NO_SUCH_FILE) };
                if offset >= data.len() {
                    return st(status::EOF);
                }
                let mut b = Vec::new();
                put_bytes(&mut b, &data[offset..(offset + len).min(data.len())]);
                (proto::DATA, b)
            }
            proto::WRITE => {
                let h = rd.bytes().unwrap().to_vec();
                let offset = rd.u64().unwrap() as usize;
                let data = rd.bytes().unwrap().to_vec();
                self.writes.fetch_add(1, Ordering::SeqCst);
                let Some(Handle::File(path)) = self.open_handles.lock().get(&h).cloned() else { return st(status::FAILURE) };
                if self.cfg.fail_writes_after.is_some_and(|limit| offset + data.len() > limit) {
                    return st(status::FAILURE);
                }
                let mut fs = self.fs.lock();
                let Some(Node::File(file, _)) = fs.get_mut(&path) else { return st(status::NO_SUCH_FILE) };
                if file.len() < offset + data.len() {
                    file.resize(offset + data.len(), 0);
                }
                file[offset..offset + data.len()].copy_from_slice(&data);
                st(status::OK)
            }
            proto::READDIR => {
                self.readdirs.fetch_add(1, Ordering::SeqCst);
                let h = rd.bytes().unwrap().to_vec();
                let mut handles = self.open_handles.lock();
                let Some(Handle::Dir(names)) = handles.get_mut(&h) else { return st(status::FAILURE) };
                if names.is_empty() {
                    return st(status::EOF);
                }
                let batch: Vec<String> = names.drain(..names.len().min(100)).collect();
                drop(handles);
                let mut b = Vec::new();
                put_u32(&mut b, batch.len() as u32);
                for n in batch {
                    let (full, name) = match n.split_once('\0') {
                        Some((dir, name)) => {
                            (if dir == "/" { format!("/{name}") } else { format!("{dir}/{name}") }, name.to_string())
                        }
                        None => (String::new(), n.clone()),
                    };
                    let node = self.get(&full).unwrap_or(Node::Dir);
                    put_str(&mut b, &name);
                    let long = if matches!(node, Node::Dir) { "drwxr-xr-x" } else { "-rw-r--r--" };
                    put_str(&mut b, &format!("{long}    1 user     group    0 Jan  1 00:00 {name}"));
                    self.attrs_at(&full, &node).encode(&mut b);
                }
                (proto::NAME, b)
            }
            proto::STAT | proto::LSTAT => {
                let asked = rd.string().unwrap();
                let path = if kind == proto::STAT { self.real(&asked) } else { self.real_parent(&asked) };
                match self.get(&path) {
                    Some(n) => attrs_reply(self.attrs_at(&path, &n)),
                    None => st(status::NO_SUCH_FILE),
                }
            }
            proto::FSTAT => {
                let h = rd.bytes().unwrap().to_vec();
                let Some(Handle::File(path)) = self.open_handles.lock().get(&h).cloned() else { return st(status::FAILURE) };
                match self.get(&path) {
                    Some(n) => attrs_reply(self.attrs_at(&path, &n)),
                    None => st(status::NO_SUCH_FILE),
                }
            }
            proto::SETSTAT => {
                let path = rd.string().unwrap();
                let a = Attrs::decode(rd).unwrap();
                self.log.lock().push(format!("SETSTAT {path}"));
                st(self.set_attrs(&self.real(&path), &a))
            }
            proto::FSETSTAT => {
                let h = rd.bytes().unwrap().to_vec();
                let a = Attrs::decode(rd).unwrap();
                let Some(Handle::File(path)) = self.open_handles.lock().get(&h).cloned() else { return st(status::FAILURE) };
                self.log.lock().push(format!("FSETSTAT {path}"));
                st(self.set_attrs(&path, &a))
            }
            proto::REMOVE => {
                let path = rd.string().unwrap();
                let mut fs = self.fs.lock();
                match fs.get(&path) {
                    Some(Node::File(..) | Node::Link(_)) => {
                        fs.remove(&path);
                        st(status::OK)
                    }
                    Some(Node::Dir) => st(status::FAILURE),
                    None => st(status::NO_SUCH_FILE),
                }
            }
            proto::MKDIR => {
                let path = rd.string().unwrap();
                if self.get(&path).is_some() {
                    return st(status::FAILURE);
                }
                self.put(&path, Node::Dir);
                st(status::OK)
            }
            proto::RMDIR => {
                let path = rd.string().unwrap();
                if !matches!(self.get(&path), Some(Node::Dir)) {
                    return st(status::NO_SUCH_FILE);
                }
                if !self.children(&path).is_empty() {
                    return st(status::FAILURE);
                }
                self.fs.lock().remove(&path);
                st(status::OK)
            }
            proto::REALPATH => {
                let path = rd.string().unwrap();
                let p = crate::limits::posix_normalize(&if path.starts_with('/') { path } else { format!("/home/{path}") });
                let p = self.real(&p);
                if self.get(&p).is_none() {
                    return st(status::NO_SUCH_FILE);
                }
                let mut b = Vec::new();
                put_u32(&mut b, 1);
                put_str(&mut b, &p);
                put_str(&mut b, "");
                Attrs::default().encode(&mut b);
                (proto::NAME, b)
            }
            proto::RENAME => {
                let from = rd.string().unwrap();
                let to = rd.string().unwrap();
                let refused = self.cfg.fail_rename_to.lock();
                if refused.contains(&to) || refused.contains(&format!("{from}>{to}")) {
                    return st(if self.cfg.refuse_rename_as_failure { status::FAILURE } else { status::PERMISSION_DENIED });
                }
                self.rename(&from, &to, false)
            }
            proto::EXTENDED => {
                let name = rd.string().unwrap();
                match name.as_str() {
                    "posix-rename@openssh.com" if self.cfg.posix_rename => {
                        let from = rd.string().unwrap();
                        let to = rd.string().unwrap();
                        self.rename(&from, &to, true)
                    }
                    "lsetstat@openssh.com" if self.cfg.lsetstat => {
                        let path = rd.string().unwrap();
                        let a = Attrs::decode(rd).unwrap();
                        self.log.lock().push(format!("LSETSTAT {path}"));
                        st(self.set_attrs(&path, &a))
                    }
                    _ => st(status::OP_UNSUPPORTED),
                }
            }
            _ => st(status::OP_UNSUPPORTED),
        }
    }

    fn rename(&self, from: &str, to: &str, overwrite: bool) -> (u8, Vec<u8>) {
        let st = |code: u32| {
            let mut b = Vec::new();
            put_u32(&mut b, code);
            (proto::STATUS, b)
        };
        let mut fs = self.fs.lock();
        if fs.contains_key(to) && !overwrite {
            return st(status::FAILURE);
        }
        let Some(node) = fs.remove(from) else { return st(status::NO_SUCH_FILE) };
        fs.insert(to.to_string(), node);
        // A folder takes what is inside it along.
        let inside = format!("{from}/");
        let moved: Vec<String> = fs.keys().filter(|k| k.starts_with(&inside)).cloned().collect();
        for k in moved {
            if let Some(n) = fs.remove(&k) {
                fs.insert(format!("{to}/{}", &k[inside.len()..]), n);
            }
        }
        let mut modes = self.modes.lock();
        match modes.remove(from) {
            Some(m) => modes.insert(to.to_string(), m),
            None => modes.remove(to),
        };
        let mut owners = self.owners.lock();
        match owners.remove(from) {
            Some(o) => owners.insert(to.to_string(), o),
            None => owners.remove(to),
        };
        st(status::OK)
    }
}
