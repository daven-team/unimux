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
}

#[derive(Default)]
pub struct Config {
    pub posix_rename: bool,
    pub lsetstat: bool,
    /// Plain renames whose target is this path (or "from>to") fail.
    pub fail_rename_to: Mutex<Vec<String>>,
    /// Reads answer at most this many bytes.
    pub short_reads: Option<usize>,
}

pub struct Fake {
    pub fs: Mutex<BTreeMap<String, Node>>,
    pub cfg: Config,
    pub max_inflight_reads: AtomicUsize,
    pub writes: AtomicUsize,
    pub open_handles: Mutex<HashMap<Vec<u8>, Handle>>,
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
        })
    }

    pub fn put(&self, path: &str, node: Node) {
        self.fs.lock().insert(path.to_string(), node);
    }

    pub fn get(&self, path: &str) -> Option<Node> {
        self.fs.lock().get(path).cloned()
    }

    fn attrs(node: &Node) -> Attrs {
        match node {
            Node::File(d, m) => {
                Attrs { size: Some(d.len() as u64), mode: Some(0o100644), atime: Some(*m), mtime: Some(*m), ..Attrs::default() }
            }
            Node::Dir => Attrs { size: Some(4096), mode: Some(0o40755), atime: Some(0), mtime: Some(0), ..Attrs::default() },
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
                let path = rd.string().unwrap();
                let flags = rd.u32().unwrap();
                let exists = self.get(&path);
                if flags & proto::open_flags::WRITE != 0 {
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
                let path = rd.string().unwrap();
                if !matches!(self.get(&path), Some(Node::Dir)) {
                    return st(status::NO_SUCH_FILE);
                }
                let mut names = vec![".".to_string(), "..".to_string()];
                names.extend(self.children(&path).into_iter().map(|n| format!("{path}\0{n}")));
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
                let mut fs = self.fs.lock();
                let Some(Node::File(file, _)) = fs.get_mut(&path) else { return st(status::NO_SUCH_FILE) };
                if file.len() < offset + data.len() {
                    file.resize(offset + data.len(), 0);
                }
                file[offset..offset + data.len()].copy_from_slice(&data);
                st(status::OK)
            }
            proto::READDIR => {
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
                    Self::attrs(&node).encode(&mut b);
                }
                (proto::NAME, b)
            }
            proto::STAT | proto::LSTAT => {
                let path = rd.string().unwrap();
                match self.get(&path) {
                    Some(n) => attrs_reply(Self::attrs(&n)),
                    None => st(status::NO_SUCH_FILE),
                }
            }
            proto::FSTAT => {
                let h = rd.bytes().unwrap().to_vec();
                let Some(Handle::File(path)) = self.open_handles.lock().get(&h).cloned() else { return st(status::FAILURE) };
                match self.get(&path) {
                    Some(n) => attrs_reply(Self::attrs(&n)),
                    None => st(status::NO_SUCH_FILE),
                }
            }
            proto::SETSTAT => {
                let path = rd.string().unwrap();
                let a = Attrs::decode(rd).unwrap();
                let mut fs = self.fs.lock();
                match fs.get_mut(&path) {
                    Some(Node::File(_, m)) => {
                        if let Some(t) = a.mtime {
                            *m = t;
                        }
                        st(status::OK)
                    }
                    Some(Node::Dir) => st(status::OK),
                    None => st(status::NO_SUCH_FILE),
                }
            }
            proto::REMOVE => {
                let path = rd.string().unwrap();
                let mut fs = self.fs.lock();
                match fs.get(&path) {
                    Some(Node::File(..)) => {
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
                    return st(status::PERMISSION_DENIED);
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
                    "lsetstat@openssh.com" if self.cfg.lsetstat => st(status::OK),
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
        st(status::OK)
    }
}
