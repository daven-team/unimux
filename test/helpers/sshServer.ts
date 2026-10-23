// In-process SSH server for tests and real-app checks: 127.0.0.1 only, keys generated at run time, user "alice".
// Erasable TypeScript only and no relative imports: scripts/ssh-test-server.mjs loads this file with Node's type stripping.
import { closeSync, constants as fsc, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, chmodSync, writeSync, existsSync, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { connect as netConnect } from 'node:net';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Duplex } from 'node:stream';
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
  /**
   * 0.9.9: answers exec requests `sudo -n <server>` and `sudo -S -p '' <server>` like sudo would and then serves SFTP over the
   * exec channel (the same folder as the subsystem). `password`: sudo wants one (-n then fails, -S reads it as the first stdin
   * line; 3 wrong lines end it); `requiretty` / `denied`: sudo refuses; `serverPath`: where sftp-server is (another path is
   * "command not found"); default /usr/lib/openssh/sftp-server.
   */
  sftpSudo?: {
    password?: string; requiretty?: boolean; denied?: boolean; serverPath?: string;
    /** sudo's language when the client's LC_ALL=C is not taken ('pl': Polish messages, 'xx': messages nobody knows). */
    locale?: 'pl' | 'xx';
    /** The server ignores the client's environment requests (no AcceptEnv). */
    ignoreEnv?: boolean;
    /** `sudo -S` starts the server without asking (a cached credential): nothing may be written before the SFTP stream. */
    noPromptForS?: boolean;
    /** The -p prompt is printed this late (input that came before it is counted in stats.sudoEarlyInput). */
    promptDelayMs?: number;
    /** No sudo on this server at all ("sh: 1: sudo: not found"). */
    missing?: boolean;
  };
  /** Advertises and serves lsetstat@openssh.com (a SETSTAT that never follows a symlink). */
  sftpLsetstat?: boolean;
  /**
   * 1.0.0: direct-tcpip (client forwardOut, the DB tunnels). Default: forwards to 127.0.0.1 / localhost are served (piped to
   * that local port); `false` refuses every forward like a server with AllowTcpForwarding no.
   */
  tcpForwarding?: boolean;
  /**
   * 1.0.6: a small POSIX-like shell over this local folder (the remote "/" is the folder): the prompt shows the folder, `cd`,
   * `ls`, `pwd`, `echo` and `exit` work, `vim` / `vi` / `nano` open a full-screen program (alternate screen) left with `:q`
   * Enter or Ctrl+X, and the exec request `exec sh -s` answers the path completion script of src/shared/remotePaths.ts like a
   * Linux server would: the shell's folder, `@busy` while a program runs, the listing of the folder asked for.
   */
  shellRoot?: string;
  /** With shellRoot: the folder the shell starts in, also $HOME (default "/"). */
  shellHome?: string;
  /** With shellRoot: the shell reports its folder with OSC 7 at every prompt (fish, vte.sh); off: only the server knows it. */
  shellOsc7?: boolean;
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
  /** SETSTAT permission changes in order (remote path, bits). */
  chmods: Array<{ path: string; mode: number }>;
  /** Permission bits set by SETSTAT per local path: reported instead of the disk's (Windows keeps no POSIX bits). */
  modes: Map<string, number>;
  /** Exec commands received (sudo), in order. */
  execs: string[];
  /** Environment requests of exec channels ("LC_ALL=C"). */
  envs: string[];
  /** Bytes a sudo -S run received before it printed its prompt (a password written too early). */
  sudoEarlyInput: number;
  /** Every OPEN: the remote path, whether it was exclusive (O_EXCL) and the mode asked for (null when none). */
  opens: Array<{ path: string; exclusive: boolean; mode: number | null }>;
  /** The uid/gid STAT and LSTAT report for these remote paths (others: 1000/1000). */
  owners: Map<string, { uid: number; gid: number }>;
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
  /** direct-tcpip requests in order (where the client asked to go) and whether they were served. */
  forwards: Array<{ host: string; port: number; accepted: boolean }>;
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

function attrsOf(st: Stats, path?: string, modes?: Map<string, number>): Attributes {
  const set = path !== undefined ? modes?.get(path) : undefined;
  const mode = set === undefined ? st.mode : (st.mode & 0o170000) | set;
  return { mode, uid: 1000, gid: 1000, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}

/** Moves the permission overlay of `from` (and everything under it) to `to` after a rename; drops it for a removed path. */
function moveModes(modes: Map<string, number>, from: string, to: string | null): void {
  for (const key of [...modes.keys()]) {
    if (key !== from && !key.startsWith(from + sep)) continue;
    const bits = modes.get(key)!;
    modes.delete(key);
    if (to !== null) modes.set(to + key.slice(from.length), bits);
  }
}

const SftpClass = createRequire(import.meta.url)('ssh2/lib/protocol/SFTP.js').SFTP as new (client: unknown, info: unknown, cfg: { server: boolean }) => SFTPWrapper & { push(d: Buffer | null): void };

/** ssh2's server-side SFTP on an exec channel (what `sudo sftp-server` is to a real server). */
function sftpOnExec(stream: ServerChannel): SFTPWrapper & { push(d: Buffer | null): void } {
  const outgoing = { id: 0, window: Number.MAX_SAFE_INTEGER, packetSize: 32 * 1024, state: 'open' };
  const protocol = {
    channelData: (_id: number, data: Buffer) => { if (outgoing.state === 'open') stream.write(data); },
    channelClose: () => { try { stream.exit(0); stream.end(); } catch { /* gone */ } },
    channelEOF: () => { try { stream.end(); } catch { /* gone */ } },
  };
  const sftp = new SftpClass({ _protocol: protocol }, { type: 'session', incoming: { id: 0, window: Number.MAX_SAFE_INTEGER, packetSize: 32 * 1024, state: 'open' }, outgoing }, { server: true });
  (stream as unknown as Duplex).on('data', (d: Buffer) => sftp.push(d));
  (stream as unknown as Duplex).on('end', () => sftp.push(null));
  (stream as unknown as Duplex).on('close', () => { outgoing.state = 'closed'; sftp.emit('close'); });
  return sftp;
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

function entryOf(name: string, st: Stats, path?: string, modes?: Map<string, number>): FileEntry {
  const attrs = attrsOf(st, path, modes);
  return { filename: name, longname: `${lsMode(attrs.mode)}    1 alice    staff ${String(st.size).padStart(8)} Jan  1 00:00 ${name}`, attrs };
}

// ── the fake shell of `shellRoot` (1.0.6) ────────────────────────────────────

/** What the fake shell of one connection is doing: its folder and whether a full-screen program has the terminal. */
interface FakeShellState { cwd: string; program: boolean }

/** The local path of a remote path under `root` (null when it does not exist). */
function shellLocal(root: string, remote: string): { path: string; dir: boolean } | null {
  const path = join(root, ...remote.split('/').filter(Boolean));
  try { return { path, dir: statSync(path).isDirectory() }; } catch { return null; }
}

/** Words of a command line with quotes and backslashes removed (enough for the fake shell's commands). */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
    if (ch === ' ') { if (cur !== null) words.push(cur); cur = null; continue; }
    cur ??= '';
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\' && i + 1 < line.length) cur += line[++i];
    else cur += ch;
  }
  if (cur !== null) words.push(cur);
  return words;
}

/** A value of the completion script: '...' parts, the '\'' escape and "$HOME". */
function scriptValue(raw: string, home: string): string {
  let out = '';
  for (let i = 0; i < raw.length;) {
    if (raw.startsWith('"$HOME"', i)) { out += home; i += 7; continue; }
    if (raw[i] === "'") { const end = raw.indexOf("'", i + 1); out += raw.slice(i + 1, end); i = end + 1; continue; }
    if (raw[i] === '\\') { out += raw[i + 1]; i += 2; continue; }
    out += raw[i++];
  }
  return out;
}

/** Answers the path completion script (remotePaths.listScript) the way `sh -s` on a Linux server prints it. */
function answerListing(script: string, root: string, home: string, state: FakeShellState): string {
  if (state.program) return '@busy\n';
  const value = (name: string) => scriptValue(new RegExp(`^${name}=(.*)$`, 'm').exec(script)?.[1] ?? "''", home);
  const cwd = value('c') || state.cwd;
  let out = `@cwd ${cwd}\n`;
  if (!script.includes('ls -1ApL')) return out;
  const asked = value('d');
  const dir = asked ? remoteNormalize(asked, cwd) : cwd;
  const local = shellLocal(root, dir);
  if (!local?.dir) return `${out}@nodir\n`;
  out += `@dir ${dir}\n`;
  const names = readdirSync(local.path).sort().map((n) => (shellLocal(root, `${dir}/${n}`)?.dir ? `${n}/` : n));
  return out + names.slice(0, 501).map((n) => `${n}\n`).join('');
}

/** The fake shell on one shell channel: echo, backspace, Enter runs the command; a program takes the keys until it quits. */
function runFakeShell(stream: ServerChannel, root: string, osc7: boolean, state: FakeShellState, input: string[]): void {
  const prompt = () => `${osc7 ? `\u001b]7;file://test-server${state.cwd.split('/').map(encodeURIComponent).join('/')}\u0007` : ''}alice@test-server:${state.cwd}$ `;
  let line = '';
  let keys = '';
  stream.write(`unimux test server\r\n${prompt()}`);
  const run = (command: string): string => {
    const [name, ...args] = shellWords(command.trim());
    if (!name) return '';
    if (name === 'cd') {
      const target = remoteNormalize(args[0] ?? '/', state.cwd);
      const local = shellLocal(root, target);
      if (!local?.dir) return `-sh: cd: ${args[0]}: No such file or directory\r\n`;
      state.cwd = target;
      return '';
    }
    if (name === 'pwd') return `${state.cwd}\r\n`;
    if (name === 'echo') return `${args.join(' ')}\r\n`;
    if (name === 'ls') {
      const dir = remoteNormalize(args.find((a) => !a.startsWith('-')) ?? '.', state.cwd);
      const local = shellLocal(root, dir);
      if (!local?.dir) return `ls: cannot access '${dir}': No such file or directory\r\n`;
      const names = readdirSync(local.path).sort().map((n) => (shellLocal(root, `${dir}/${n}`)?.dir ? `\u001b[1;34m${n}\u001b[0m` : n));
      return names.length ? `${names.join('  ')}\r\n` : '';
    }
    if (name === 'vim' || name === 'vi' || name === 'nano') {
      state.program = true;
      keys = '';
      return `\u001b[?1049h\u001b[H\u001b[2J"${args[0] ?? '[No Name]'}" (fake ${name}: :q Enter or Ctrl+X quits)\r\n~\r\n~\r\n`;
    }
    return `-sh: ${name}: command not found\r\n`;
  };
  stream.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    input.push(text);
    for (const ch of text.replace(/\u001b\[20[01]~/g, '')) {
      if (state.program) {
        keys += ch;
        if (keys.endsWith(':q\r') || ch === '\u0018') {
          state.program = false;
          stream.write(`\u001b[?1049l${prompt()}`);
        }
        continue;
      }
      if (ch === '\x7f') { if (line) { line = line.slice(0, -1); stream.write('\b \b'); } continue; }
      if (ch === '\t') { stream.write('\u0007'); continue; }
      if (ch === '\u0003') { line = ''; stream.write(`^C\r\n${prompt()}`); continue; }
      if (ch !== '\r') { if (ch >= ' ') { line += ch; stream.write(ch); } continue; }
      const command = line;
      line = '';
      if (command.trim() === 'exit') { stream.write('\r\nlogout\r\n'); stream.exit(0); stream.end(); return; }
      const out = run(command);
      stream.write(`\r\n${out}${state.program ? '' : prompt()}`);
    }
  });
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

/** The VERSION packet with extensions (ssh2's server sends a bare version 3). */
function versionWith(names: string[]): Buffer {
  const str = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return Buffer.concat([l, b]); };
  const head = Buffer.alloc(5);
  head[0] = 2; // VERSION
  head.writeUInt32BE(3, 1);
  const body = Buffer.concat([head, ...names.flatMap((n) => [str(n), str('1')])]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}
const BARE_VERSION = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]);

type SftpHandle = { kind: 'file'; fd: number; write: boolean } | { kind: 'dir'; path: string; sent: boolean };

function serveSftp(sftp: SFTPWrapper, root: string, home: string, stats: SftpServerStats, ext: { posixRename: boolean; lsetstat: boolean }): void {
  const posixRename = ext.posixRename;
  const extensions = [...(ext.posixRename ? ['posix-rename@openssh.com'] : []), ...(ext.lsetstat ? ['lsetstat@openssh.com'] : [])];
  if (extensions.length) {
    // Swap the bare VERSION answer for one that names the extensions (the only way to advertise them with ssh2's server).
    const proto = (sftp as unknown as { _protocol: { channelData(id: number, data: Buffer): void } })._protocol;
    const channelId = (sftp as unknown as { outgoing: { id: number } }).outgoing.id;
    const original = proto.channelData.bind(proto);
    proto.channelData = (id: number, data: Buffer) => original(id, id === channelId && Buffer.isBuffer(data) && data.equals(BARE_VERSION) ? versionWith(extensions) : data);
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
    stats.opens.push({ path: remoteNormalize(filename, home), exclusive: (flags & OPEN_MODE.EXCL) !== 0, mode: typeof attrs?.mode === 'number' ? attrs.mode & 0o7777 : null });
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
    const names = readdirSync(h.path).flatMap((name) => { try { return [entryOf(name, lstatSync(join(h.path, name)), join(h.path, name), stats.modes)]; } catch { return []; } });
    if (!names.length) { sftp.status(reqId, SFTP_STATUS.EOF); return; }
    sftp.name(reqId, names);
  }));
  const owned = (path: string, attrs: Attributes): Attributes => ({ ...attrs, ...(stats.owners.get(remoteNormalize(path, home)) ?? {}) });
  sftp.on('STAT', (reqId, path) => run(reqId, 'STAT', () => sftp.attrs(reqId, owned(path, attrsOf(statSync(real(path)), real(path), stats.modes)))));
  sftp.on('LSTAT', (reqId, path) => run(reqId, 'LSTAT', () => sftp.attrs(reqId, owned(path, attrsOf(lstatSync(real(path)), real(path), stats.modes)))));
  sftp.on('FSTAT', (reqId, handle) => run(reqId, 'FSTAT', () => {
    const h = handleOf(handle);
    if (h?.kind !== 'file') { sftp.status(reqId, SFTP_STATUS.FAILURE); return; }
    sftp.attrs(reqId, attrsOf(fstatSync(h.fd)));
  }));
  sftp.on('MKDIR', (reqId, path) => run(reqId, 'MKDIR', () => { mkdirSync(real(path)); sftp.status(reqId, SFTP_STATUS.OK); }));
  sftp.on('RMDIR', (reqId, path) => run(reqId, 'RMDIR', () => { rmdirSync(real(path)); moveModes(stats.modes, real(path), null); sftp.status(reqId, SFTP_STATUS.OK); }));
  sftp.on('REMOVE', (reqId, path) => run(reqId, 'REMOVE', () => {
    const p = real(path);
    if (lstatSync(p).isDirectory()) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'is a directory'); return; }
    unlinkSync(p);
    moveModes(stats.modes, p, null);
    sftp.status(reqId, SFTP_STATUS.OK);
  }));
  // SFTP v3 semantics (like OpenSSH without posix-rename): an existing target is refused, never overwritten.
  sftp.on('RENAME', (reqId, oldPath, newPath) => run(reqId, 'RENAME', () => {
    const from = real(oldPath), to = real(newPath);
    lstatSync(from);
    if (stats.renameFail?.(remoteNormalize(oldPath, home), remoteNormalize(newPath, home))) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'rename refused'); return; }
    if (existsSync(to)) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'target exists'); return; }
    renameSync(from, to);
    moveModes(stats.modes, from, to);
    sftp.status(reqId, SFTP_STATUS.OK);
  }));
  sftp.on('EXTENDED', (reqId: number, name: string, data: Buffer | undefined) => run(reqId, 'EXTENDED', () => {
    if (ext.lsetstat && name === 'lsetstat@openssh.com' && data) {
      // string path, then ATTRS: flags, [size u64], [uid gid], [permissions] ...
      const n = data.readUInt32BE(0);
      const path = data.subarray(4, 4 + n).toString('utf8');
      let p = 4 + n;
      const flags = data.readUInt32BE(p); p += 4;
      if (flags & 1) p += 8;
      if (flags & 2) p += 8;
      stats.ops.push('LSETSTAT');
      const local = real(path);
      lstatSync(local);
      if (flags & 4) {
        const mode = data.readUInt32BE(p) & 0o7777;
        // Never follows: a link keeps its target's bits untouched.
        stats.modes.set(local, mode);
        stats.chmods.push({ path: remoteNormalize(path, home), mode });
        if (process.platform !== 'win32' && !lstatSync(local).isSymbolicLink()) chmodSync(local, mode);
      }
      sftp.status(reqId, SFTP_STATUS.OK);
      return;
    }
    if (!posixRename || name !== 'posix-rename@openssh.com' || !data) { sftp.status(reqId, SFTP_STATUS.OP_UNSUPPORTED); return; }
    const a = data.readUInt32BE(0);
    const oldPath = data.subarray(4, 4 + a).toString('utf8');
    const newPath = data.subarray(8 + a, 8 + a + data.readUInt32BE(4 + a)).toString('utf8');
    stats.ops.push('POSIX_RENAME');
    if (stats.renameFail?.(remoteNormalize(oldPath, home), remoteNormalize(newPath, home))) { sftp.status(reqId, SFTP_STATUS.FAILURE, 'rename refused'); return; }
    moveModes(stats.modes, real(newPath), null);
    renameSync(real(oldPath), real(newPath)); // overwrites, like OpenSSH
    moveModes(stats.modes, real(oldPath), real(newPath));
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
  const setstat = (reqId: number, path: string, attrs: Attributes, remote: string) => {
    if (typeof attrs.mode === 'number') {
      // SETSTAT follows a symlink (like OpenSSH): the bits land on the target.
      if (lstatSync(path).isSymbolicLink()) path = realpathSync(path);
      stats.modes.set(path, attrs.mode & 0o7777);
      stats.chmods.push({ path: remote, mode: attrs.mode & 0o7777 });
      // Windows keeps only a read-only flag (a read-only file could not be cleaned up by the tests): the overlay answers there.
      if (process.platform !== 'win32') chmodSync(path, attrs.mode & 0o7777);
    }
    if (typeof attrs.mtime === 'number') utimesSync(path, attrs.atime ?? attrs.mtime, attrs.mtime);
    sftp.status(reqId, SFTP_STATUS.OK);
  };
  sftp.on('SETSTAT', (reqId, path, attrs) => run(reqId, 'SETSTAT', () => setstat(reqId, real(path), attrs, remoteNormalize(path, home))));
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
  const sftpStats: SftpServerStats = { delayMs: 0, openWrites: 0, maxOpenWrites: 0, ops: [], failWritesAfter: null, written: 0, renameFail: null, chmods: [], modes: new Map(), execs: [], envs: [], sudoEarlyInput: 0, opens: [], owners: new Map() };
  const sftpExt = { posixRename: opts.sftpPosixRename === true, lsetstat: opts.sftpLsetstat === true };
  const forwards: TestServer['forwards'] = [];

  const server = new Server({ hostKeys: [host.private], ...(opts.banner ? { banner: opts.banner } : {}) }, (conn) => {
    conns.add(conn);
    const shellHome = remoteNormalize(opts.shellHome ?? '/', '/');
    const shellState: FakeShellState = { cwd: shellHome, program: false };
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
    conn.on('tcpip', (accept, reject, info) => {
      const local = info.destIP === '127.0.0.1' || info.destIP === 'localhost';
      const allowed = opts.tcpForwarding !== false && local;
      forwards.push({ host: info.destIP, port: info.destPort, accepted: allowed });
      if (!allowed) { reject(); return; }
      const sock = netConnect({ host: '127.0.0.1', port: info.destPort });
      sock.once('error', () => { reject(); });
      sock.once('connect', () => {
        const channel = accept();
        sock.removeAllListeners('error');
        sock.on('error', () => { try { channel.close(); } catch { /* gone */ } });
        channel.on('error', () => sock.destroy());
        channel.on('close', () => sock.destroy());
        sock.on('close', () => { try { channel.close(); } catch { /* gone */ } });
        sock.pipe(channel).pipe(sock);
      });
    });
    conn.on('ready', () => conn.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (acceptSftp, reject) => {
        if (!opts.sftpRoot) { reject(); return; }
        serveSftp(acceptSftp(), opts.sftpRoot, remoteNormalize(opts.sftpHome ?? '/', '/'), sftpStats, sftpExt);
      });
      const env: Record<string, string> = {};
      session.on('env', (acceptEnv, rejectEnv, info) => {
        if (opts.sftpSudo?.ignoreEnv) { rejectEnv?.(); return; }
        env[info.key] = info.val;
        sftpStats.envs.push(`${info.key}=${info.val}`);
        acceptEnv?.();
      });
      session.on('exec', (acceptExec, rejectExec, info) => {
        if (opts.shellRoot && info.command === 'exec sh -s') {
          const stream = acceptExec();
          sftpStats.execs.push(info.command);
          let script = '';
          stream.on('data', (chunk: Buffer) => { script += chunk.toString('utf8'); });
          stream.on('end', () => {
            stream.write(answerListing(script, opts.shellRoot!, shellHome, shellState));
            stream.exit(0);
            stream.end();
          });
          return;
        }
        const sudo = opts.sftpSudo;
        if (!opts.sftpRoot || !sudo) { rejectExec?.(); return; }
        const stream = acceptExec();
        sftpStats.execs.push(info.command);
        // sudo speaks English with LC_ALL=C, else the server's language.
        const lang = env.LC_ALL === 'C' ? 'en' : sudo.locale ?? 'en';
        const say = (en: string, pl: string) => (lang === 'en' ? en : lang === 'pl' ? pl : 'sudo: ффф фф\n');
        const fail = (message: string, code = 1) => { stream.stderr.write(message); stream.exit(code); stream.end(); };
        if (sudo.missing && info.command.startsWith('sudo ')) { fail('sh: 1: sudo: not found\n', 127); return; }
        const m = /^sudo (-n|-S -p '([^']*)') (\S+)$/.exec(info.command);
        if (!m) { fail(`sh: 1: ${info.command.split(' ')[0]}: not found\n`, 127); return; }
        const [, mode, prompt, path] = m;
        if (path !== (sudo.serverPath ?? '/usr/lib/openssh/sftp-server')) { fail(say(`sudo: ${path}: command not found\n`, `sudo: ${path}: nie znaleziono polecenia\n`)); return; }
        if (sudo.denied) { fail(say(`Sorry, user alice is not allowed to execute '${path}' as root on test-server.\n`, `Niestety, użytkownik alice nie ma uprawnień do uruchamiania '${path}' jako root na test-server.\n`)); return; }
        if (sudo.requiretty) { fail(say('sudo: sorry, you must have a tty to run sudo\n', 'sudo: niestety, aby uruchomić sudo, musisz mieć terminal\n')); return; }
        const serve = (rest: Buffer) => {
          const sftp = sftpOnExec(stream);
          serveSftp(sftp, opts.sftpRoot!, remoteNormalize(opts.sftpHome ?? '/', '/'), sftpStats, sftpExt);
          if (rest.length) sftp.push(rest);
        };
        if (sudo.password === undefined) { serve(Buffer.alloc(0)); return; }
        if (mode === '-n') { fail(say('sudo: a password is required\n', 'sudo: wymagane jest hasło\n')); return; }
        if (sudo.noPromptForS) { serve(Buffer.alloc(0)); return; }
        // sudo -S prints its prompt (-p) and reads the password line by line from stdin; the SFTP stream follows the right one.
        let buf = Buffer.alloc(0);
        let tries = 0;
        let asked = false;
        const ask = () => { asked = true; if (prompt) stream.stderr.write(prompt); };
        const onData = (chunk: Buffer) => {
          if (!asked) { sftpStats.sudoEarlyInput += chunk.length; }
          buf = Buffer.concat([buf, chunk]);
          if (!asked) return;
          for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
            const line = buf.subarray(0, nl).toString('utf8');
            buf = buf.subarray(nl + 1);
            if (line === sudo.password) { stream.off('data', onData); serve(buf); return; }
            if (++tries >= 3) { stream.off('data', onData); fail(say('sudo: 3 incorrect password attempts\n', 'sudo: 3 nieprawidłowe próby wprowadzenia hasła\n')); return; }
            stream.stderr.write(say('Sorry, try again.\n', 'Niestety, spróbuj ponownie.\n'));
            if (prompt) stream.stderr.write(prompt);
          }
        };
        stream.on('data', onData);
        if (sudo.promptDelayMs) setTimeout(() => { ask(); onData(Buffer.alloc(0)); }, sudo.promptDelayMs); else ask();
      });
      session.on('pty', (ok, _no, info) => { ptys.push({ term: info.term, cols: info.cols, rows: info.rows }); ok?.(); });
      session.on('window-change', (ok, _no, info) => { windowChanges.push({ cols: info.cols, rows: info.rows }); ok?.(); });
      session.on('shell', (ok) => {
        const stream = ok();
        shells.push(stream);
        if (opts.shellRoot) { runFakeShell(stream, opts.shellRoot, opts.shellOsc7 === true, shellState, input); return; }
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
            // "cd /some/dir" reports the folder like a shell with OSC 7 integration (fish, vte.sh): file://host/percent-encoded path.
            if (command.startsWith('cd /')) {
              const dir = command.slice(3).trim();
              stream.write(`\r\n\u001b]7;file://test-server${dir.split('/').map(encodeURIComponent).join('/')}\u0007$ `);
              continue;
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
    forwards,
    close: () => new Promise<void>((resolve) => { for (const c of conns) c.end(); server.close(() => resolve()); }),
  };
}
