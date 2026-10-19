// In-process SSH server for tests and real-app checks: 127.0.0.1 only, keys generated at run time, user "alice".
// Erasable TypeScript only and no relative imports: scripts/ssh-test-server.mjs loads this file with Node's type stripping.
import { closeSync, constants as fsc, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, chmodSync, writeSync, existsSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import ssh2 from 'ssh2';
import type { Attributes, Connection, FileEntry, ServerChannel, SFTPWrapper } from 'ssh2';

export interface TestServerOptions {
  port?: number;
  /** Accepted password for alice. */
  password?: string;
  /** authorized_keys line accepted for alice. */
  publicKey?: string;
  /** Answer accepted by the keyboard-interactive prompt "Code: ". */
  keyboardCode?: string;
  /** Pre-auth banner. */
  banner?: string;
  /** Printed when a shell opens. */
  greeting?: string;
  /** Accept alice without any credential ("none" method): only for real-app checks of many cells. */
  noAuth?: boolean;
  /** After `exit`: 'reset' answers the client's next packet with a TCP RST, right after exit-status (a hard-closing server). */
  onExit?: 'reset';
  /** Serves the sftp subsystem over this local folder (the remote "/" is this folder; nothing outside it is reachable). */
  sftpRoot?: string;
  /** The remote login folder (realpath of "." and relative paths); default "/". */
  sftpHome?: string;
  /** Advertises and serves posix-rename@openssh.com (an overwriting rename), like OpenSSH. */
  sftpPosixRename?: boolean;
}

/** Test knobs and counters of the SFTP subsystem (mutable while the server runs). */
export interface SftpServerStats {
  /** Each READ and WRITE answer waits this long (a slow link). */
  delayMs: number;
  /** Write handles open right now, and the most at the same time. */
  openWrites: number;
  maxOpenWrites: number;
  /** Request names in order (OPEN, READ, RENAME ...). */
  ops: string[];
  /** Answers every WRITE with a failure once this many bytes were written in total (a full disk); null: never. */
  failWritesAfter: number | null;
  written: number;
  /** Answers RENAME (and posix-rename) from -> to with a failure when this returns true (remote paths). */
  renameFail: ((from: string, to: string) => boolean) | null;
}

export interface TestServer {
  port: number;
  /** Raw public key blob of the host key (what the client's host verifier receives). */
  hostKeyBlob: Buffer;
  ptys: Array<{ term: string; cols: number; rows: number }>;
  windowChanges: Array<{ cols: number; rows: number }>;
  /** Everything the shells received, chunk by chunk. */
  input: string[];
  /** Writes to every open shell. */
  write(data: string | Buffer): void;
  /** Writes `total` ASCII bytes to the first shell, waiting for 'drain' when the channel is full. */
  flood(total: number): { done: Promise<void>; sent(): number };
  /** Destroys every client socket (network loss). */
  dropConnections(): void;
  connections(): number;
  /** Present with `sftpRoot`. */
  sftp: SftpServerStats;
  close(): Promise<void>;
}

const { Server, utils } = ssh2;
const SFTP_STATUS = utils.sftp.STATUS_CODE;
const OPEN_MODE = utils.sftp.OPEN_MODE;

function statusOf(error: unknown): number {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return SFTP_STATUS.NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM') return SFTP_STATUS.PERMISSION_DENIED;
  return SFTP_STATUS.FAILURE;
}

function attrsOf(st: Stats): Attributes {
  return { mode: st.mode, uid: 1000, gid: 1000, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

function lsMode(mode: number): string {
  const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  let out = type;
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7;
    out += `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
  }
  return out;
}

function entryOf(name: string, st: Stats): FileEntry {
  return { filename: name, longname: `${lsMode(st.mode)}    1 alice    staff ${String(st.size).padStart(8)} Jan  1 00:00 ${name}`, attrs: attrsOf(st) };
}

/** Normalizes a remote path ("." and ".." resolved against `home`); the result is absolute and never leaves "/". */
function remoteNormalize(path: string, home: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${home}/${path}`).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** The VERSION packet with the posix-rename@openssh.com extension (ssh2's server sends a bare version 3). */
function versionWithPosixRename(): Buffer {
  const name = Buffer.from('posix-rename@openssh.com');
  const data = Buffer.from('1');
  const body = Buffer.alloc(1 + 4 + 4 + name.length + 4 + data.length);
  let p = 0;
  body[p++] = 2; // VERSION
  body.writeUInt32BE(3, p); p += 4;
  body.writeUInt32BE(name.length, p); p += 4; name.copy(body, p); p += name.length;
  body.writeUInt32BE(data.length, p); p += 4; data.copy(body, p);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}
const BARE_VERSION = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]);

type SftpHandle = { kind: 'file'; fd: number; write: boolean } | { kind: 'dir'; path: string; sent: boolean };

function serveSftp(sftp: SFTPWrapper, root: string, home: string, stats: SftpServerStats, posixRename: boolean): void {
  if (posixRename) {
    // Swap the bare VERSION answer for one that names the extension (the only way to advertise it with ssh2's server).
    const proto = (sftp as unknown as { _protocol: { channelData(id: number, data: Buffer): void } })._protocol;
    const channelId = (sftp as unknown as { outgoing: { id: number } }).outgoing.id;
    const original = proto.channelData.bind(proto);
    proto.channelData = (id: number, data: Buffer) => original(id, id === channelId && Buffer.isBuffer(data) && data.equals(BARE_VERSION) ? versionWithPosixRename() : data);
  }
  const handles = new Map<number, SftpHandle>();
  let nextHandle = 1;
  const real = (path: string) => join(root, ...remoteNormalize(path, home).split('/').filter(Boolean));
  const handleOf = (buf: Buffer) => (buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined);
  const newHandle = (h: SftpHandle) => { const id = nextHandle++; handles.set(id, h); const b = Buffer.alloc(4); b.writeUInt32BE(id, 0); return b; };
  const later = (fn: () => void) => { if (stats.delayMs > 0) setTimeout(fn, stats.delayMs); else fn(); };
  const run = (reqId: number, name: string, fn: () => void) => {
    stats.ops.push(name);
    try { fn(); } catch (error) { sftp.status(reqId, statusOf(error)); }
  };
  sftp.on('OPEN', (reqId, filename, flags, attrs) => run(reqId, 'OPEN', () => {
    const write = (flags & OPEN_MODE.WRITE) !== 0;
    let f = (flags & OPEN_MODE.READ) && write ? fsc.O_RDWR : write ? fsc.O_WRONLY : fsc.O_RDONLY;
    if (flags & OPEN_MODE.CREAT) f |= fsc.O_CREAT;
    if (flags & OPEN_MODE.TRUNC) f |= fsc.O_TRUNC;
    if (flags & OPEN_MODE.EXCL) f |= fsc.O_EXCL;
    if (flags & OPEN_MODE.APPEND) f |= fsc.O_APPEND;
    const path = real(filename);
    if (existsSync(path) && statSync(path).isDirectory()) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'is a directory'); return; }
    const fd = openSync(path, f, typeof attrs?.mode === 'number' ? attrs.mode & 0o7777 : 0o644);
    if (write) { stats.openWrites++; stats.maxOpenWrites = Math.max(stats.maxOpenWrites, stats.openWrites); }
    sftp.handle(reqId, newHandle({ kind: 'file', fd, write }));
  }));
  sftp.on('READ', (reqId, handle, offset, length) => run(reqId, 'READ', () => {
    const h = handleOf(handle);
    if (h?.kind !== 'file') { sftp.status(reqId, SFTP_STATUS.FAILURE); return; }
    const buf = Buffer.alloc(Math.min(length, 256 * 1024));
    const n = readSync(h.fd, buf, 0, buf.length, offset);
    later(() => { if (n === 0) sftp.status(reqId, SFTP_STATUS.EOF); else sftp.data(reqId, buf.subarray(0, n)); });
  }));
  sftp.on('WRITE', (reqId, handle, offset, data) => run(reqId, 'WRITE', () => {
    const h = handleOf(handle);
    if (h?.kind !== 'file') { sftp.status(reqId, SFTP_STATUS.FAILURE); return; }
    if (stats.failWritesAfter !== null && stats.written + data.length > stats.failWritesAfter) { later(() => sftp.status(reqId, SFTP_STATUS.FAILURE, 'disk full')); return; }
    writeSync(h.fd, data, 0, data.length, offset);
    stats.written += data.length;
    later(() => sftp.status(reqId, SFTP_STATUS.OK));
  }));
  sftp.on('CLOSE', (reqId, handle) => run(reqId, 'CLOSE', () => {
    const h = handleOf(handle);
    if (!h) { sftp.status(reqId, SFTP_STATUS.FAILURE); return; }
    handles.delete(handle.readUInt32BE(0));
    if (h.kind === 'file') { closeSync(h.fd); if (h.write) stats.openWrites--; }
    sftp.status(reqId, SFTP_STATUS.OK);
  }));
  sftp.on('OPENDIR', (reqId, path) => run(reqId, 'OPENDIR', () => {
    const p = real(path);
    if (!statSync(p).isDirectory()) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'not a directory'); return; }
    sftp.handle(reqId, newHandle({ kind: 'dir', path: p, sent: false }));
  }));
  sftp.on('READDIR', (reqId, handle) => run(reqId, 'READDIR', () => {
    const h = handleOf(handle);
    if (h?.kind !== 'dir') { sftp.status(reqId, SFTP_STATUS.FAILURE); return; }
    if (h.sent) { sftp.status(reqId, SFTP_STATUS.EOF); return; }
    h.sent = true;
    const names = readdirSync(h.path).flatMap((name) => { try { return [entryOf(name, lstatSync(join(h.path, name)))]; } catch { return []; } });
    if (!names.length) { sftp.status(reqId, SFTP_STATUS.EOF); return; }
    sftp.name(reqId, names);
  }));
  sftp.on('STAT', (reqId, path) => run(reqId, 'STAT', () => sftp.attrs(reqId, attrsOf(statSync(real(path))))));
  sftp.on('LSTAT', (reqId, path) => run(reqId, 'LSTAT', () => sftp.attrs(reqId, attrsOf(lstatSync(real(path))))));
  sftp.on('FSTAT', (reqId, handle) => run(reqId, 'FSTAT', () => {
    const h = handleOf(handle);
    if (h?.kind !== 'file') { sftp.status(reqId, SFTP_STATUS.FAILURE); return; }
    sftp.attrs(reqId, attrsOf(fstatSync(h.fd)));
  }));
  sftp.on('MKDIR', (reqId, path) => run(reqId, 'MKDIR', () => { mkdirSync(real(path)); sftp.status(reqId, SFTP_STATUS.OK); }));
  sftp.on('RMDIR', (reqId, path) => run(reqId, 'RMDIR', () => { rmdirSync(real(path)); sftp.status(reqId, SFTP_STATUS.OK); }));
  sftp.on('REMOVE', (reqId, path) => run(reqId, 'REMOVE', () => {
    const p = real(path);
    if (lstatSync(p).isDirectory()) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'is a directory'); return; }
    unlinkSync(p);
    sftp.status(reqId, SFTP_STATUS.OK);
  }));
  // SFTP v3 semantics (like OpenSSH without posix-rename): an existing target is refused, never overwritten.
  sftp.on('RENAME', (reqId, oldPath, newPath) => run(reqId, 'RENAME', () => {
    const from = real(oldPath), to = real(newPath);
    lstatSync(from);
    if (stats.renameFail?.(remoteNormalize(oldPath, home), remoteNormalize(newPath, home))) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'rename refused'); return; }
    if (existsSync(to)) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'target exists'); return; }
    renameSync(from, to);
    sftp.status(reqId, SFTP_STATUS.OK);
  }));
  sftp.on('EXTENDED', (reqId: number, name: string, data: Buffer | undefined) => run(reqId, 'EXTENDED', () => {
    if (!posixRename || name !== 'posix-rename@openssh.com' || !data) { sftp.status(reqId, SFTP_STATUS.OP_UNSUPPORTED); return; }
    const a = data.readUInt32BE(0);
    const oldPath = data.subarray(4, 4 + a).toString('utf8');
    const newPath = data.subarray(8 + a, 8 + a + data.readUInt32BE(4 + a)).toString('utf8');
    stats.ops.push('POSIX_RENAME');
    if (stats.renameFail?.(remoteNormalize(oldPath, home), remoteNormalize(newPath, home))) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'rename refused'); return; }
    renameSync(real(oldPath), real(newPath)); // overwrites, like OpenSSH
    sftp.status(reqId, SFTP_STATUS.OK);
  }));
  sftp.on('REALPATH', (reqId, path) => run(reqId, 'REALPATH', () => {
    let normalized = remoteNormalize(path, home);
    // Symlinks resolve like OpenSSH's realpath; a target outside the served folder reads as "/..outside/...".
    try {
      const rel = relative(realpathSync(root), realpathSync(real(path)));
      normalized = rel.startsWith('..') || isAbsolute(rel) ? `/..outside/${rel.split(sep).join('/')}` : `/${rel.split(sep).join('/')}`.replace(/\/$/, '') || '/';
    } catch { /* not there: the lexical path, like OpenSSH for a missing last segment */ }
    sftp.name(reqId, [{ filename: normalized, longname: normalized, attrs: {} as Attributes }]);
  }));
  const setstat = (reqId: number, path: string, attrs: Attributes) => {
    if (typeof attrs.mode === 'number') chmodSync(path, attrs.mode & 0o7777);
    if (typeof attrs.mtime === 'number') utimesSync(path, attrs.atime ?? attrs.mtime, attrs.mtime);
    sftp.status(reqId, SFTP_STATUS.OK);
  };
  sftp.on('SETSTAT', (reqId, path, attrs) => run(reqId, 'SETSTAT', () => setstat(reqId, real(path), attrs)));
  sftp.on('FSETSTAT', (reqId, _handle, _attrs) => run(reqId, 'FSETSTAT', () => sftp.status(reqId, SFTP_STATUS.OK)));
  sftp.on('end', () => {
    for (const h of handles.values()) if (h.kind === 'file') { try { closeSync(h.fd); } catch { /* closed */ } if (h.write) stats.openWrites--; }
    handles.clear();
  });
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  // ssh2 writes a key it cannot read back about 1 in 200 times: generate the host key again until both halves parse.
  let host = utils.generateKeyPairSync('ed25519');
  for (let tries = 1; tries < 20 && [utils.parseKey(host.private), utils.parseKey(host.public)].some((k) => k instanceof Error || Array.isArray(k)); tries++) {
    host = utils.generateKeyPairSync('ed25519');
  }
  const hostParsed = utils.parseKey(host.public);
  if (hostParsed instanceof Error || Array.isArray(hostParsed)) throw new Error('host key');
  const userKey = opts.publicKey ? utils.parseKey(opts.publicKey) : null;
  if (userKey instanceof Error || Array.isArray(userKey)) throw new Error('user key');
  const methods = [...(userKey ? ['publickey'] : []), ...(opts.password !== undefined ? ['password'] : []), ...(opts.keyboardCode !== undefined ? ['keyboard-interactive'] : [])] as Array<'publickey' | 'password' | 'keyboard-interactive'>;
  const ptys: TestServer['ptys'] = [];
  const windowChanges: TestServer['windowChanges'] = [];
  const input: string[] = [];
  const shells: ServerChannel[] = [];
  const conns = new Set<Connection>();
  const sftpStats: SftpServerStats = { delayMs: 0, openWrites: 0, maxOpenWrites: 0, ops: [], failWritesAfter: null, written: 0, renameFail: null };

  const server = new Server({ hostKeys: [host.private], ...(opts.banner ? { banner: opts.banner } : {}) }, (conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.username !== 'alice') return ctx.reject(methods);
      if (opts.noAuth && ctx.method === 'none') return ctx.accept();
      if (ctx.method === 'password' && opts.password !== undefined && ctx.password === opts.password) return ctx.accept();
      if (ctx.method === 'publickey' && userKey && ctx.key.algo === userKey.type && ctx.key.data.equals(userKey.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        return userKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(methods);
      }
      if (ctx.method === 'keyboard-interactive' && opts.keyboardCode !== undefined) {
        return ctx.prompt([{ prompt: 'Code: ', echo: true }], 'Second factor', 'Type the code', (answers) => (answers[0] === opts.keyboardCode ? ctx.accept() : ctx.reject(methods)));
      }
      return ctx.reject(methods);
    });
    conn.on('ready', () => conn.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (acceptSftp, reject) => {
        if (!opts.sftpRoot) { reject(); return; }
        serveSftp(acceptSftp(), opts.sftpRoot, remoteNormalize(opts.sftpHome ?? '/', '/'), sftpStats, opts.sftpPosixRename === true);
      });
      session.on('pty', (ok, _no, info) => { ptys.push({ term: info.term, cols: info.cols, rows: info.rows }); ok?.(); });
      session.on('window-change', (ok, _no, info) => { windowChanges.push({ cols: info.cols, rows: info.rows }); ok?.(); });
      session.on('shell', (ok) => {
        const stream = ok();
        shells.push(stream);
        stream.write(opts.greeting ?? 'Welcome to the test server\r\n$ ');
        let line = '';
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          input.push(text);
          for (const ch of text.replace(/\u001b\[20[01]~/g, '')) {
            if (ch !== '\r') { line += ch; stream.write(ch); continue; }
            const command = line.trim();
            line = '';
            if (command === 'exit') {
              stream.exit(3);
              stream.end();
              if (opts.onExit === 'reset') {
                // The client's next packet (its channel close or DISCONNECT) is answered with a TCP RST.
                const sock = (conn as unknown as { _sock: { resetAndDestroy?(): void; destroy(): void; prependOnceListener(e: 'data', f: () => void): void } })._sock;
                sock.prependOnceListener('data', () => { if (sock.resetAndDestroy) sock.resetAndDestroy(); else sock.destroy(); });
              }
              return;
            }
            const tail = /^tail (\d+)$/.exec(command);
            if (tail) {
              // Writes N bytes and a marker, exits and hangs up: the tail must reach a paused (back-pressured) client.
              stream.write(Buffer.alloc(Number(tail[1]), 'x'));
              stream.write('TAIL-END');
              stream.exit(0);
              stream.end();
              setTimeout(() => conn.end(), 100);
              return;
            }
            stream.write(command.startsWith('echo ') ? `\r\n${command.slice(5)}\r\n$ ` : '\r\n$ ');
          }
        });
      });
    }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    hostKeyBlob: hostParsed.getPublicSSH(),
    ptys, windowChanges, input,
    write: (data) => { for (const s of shells) s.write(data); },
    flood(total) {
      let sent = 0;
      const stream = shells[0];
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const done = (async () => {
        while (sent < total) {
          const part = chunk.subarray(0, Math.min(chunk.length, total - sent));
          sent += part.length;
          if (!stream.write(part)) await new Promise((r) => stream.once('drain', r));
        }
      })();
      return { done, sent: () => sent };
    },
    dropConnections: () => { for (const c of conns) (c as unknown as { _sock: { destroy(): void } })._sock.destroy(); },
    connections: () => conns.size,
    sftp: sftpStats,
    close: () => new Promise<void>((resolve) => { for (const c of conns) c.end(); server.close(() => resolve()); }),
  };
}
