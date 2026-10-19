// SFTP file management of 0.9.9 against the in-process test server (127.0.0.1 only): moves on the server and on the local
// disk (with the copy-and-delete path across volumes), permission changes (recursive with two masks, errors, cancel) and SFTP
// through sudo on an exec channel (NOPASSWD, a password, wrong passwords, requiretty, refusal, no server).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SftpHost } from '../src/sftphost/host';
import { LocalSide, SftpError, type FileSide } from '../src/sftphost/sides';
import { TransferQueue } from '../src/sftphost/queue';
import type { SshConnectRequest } from '../src/shared/ipc';
import {
  applyPortMessage, LOCAL_QUEUE_ID, sftpSessionId,
  type ChmodCount, type ChmodResult, type ConflictAnswer, type SftpPortMessage, type SftpResult, type TransferItem, type TransferRequest,
} from '../src/shared/sftp';
import type { SftpHostToMain, SftpOp } from '../src/shared/sftpHostIpc';
import { startTestServer, type TestServer } from './helpers/sshServer';

const SESSION = sftpSessionId('11111111-2222-4333-8444-555555555555');
let dir: string;
let remoteRoot: string;
let localRoot: string;
let servers: TestServer[] = [];
let hosts: SftpHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unimux-sftp-manage-'));
  remoteRoot = join(dir, 'remote');
  localRoot = join(dir, 'local');
  mkdirSync(join(remoteRoot, 'home', 'alice'), { recursive: true });
  mkdirSync(localRoot);
});
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.shutdown()));
  await Promise.all(servers.map((s) => s.close()));
  hosts = []; servers = [];
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function server(opts: Parameters<typeof startTestServer>[0] = {}) {
  const s = await startTestServer({ password: 'pw', sftpRoot: remoteRoot, sftpHome: '/home/alice', ...opts });
  servers.push(s);
  return s;
}

function harness(opts: { onMain?: (m: SftpHostToMain, host: SftpHost) => boolean } = {}) {
  const toMain: SftpHostToMain[] = [];
  const port: SftpPortMessage[] = [];
  let items: TransferItem[] = [];
  const results = new Map<number, SftpResult<unknown>>();
  let reqId = 0;
  const host: SftpHost = new SftpHost({
    toMain: (m) => {
      toMain.push(m);
      if (m.t === 'sftpResult') results.set(m.reqId, m.result);
      if (opts.onMain?.(m, host)) return;
      if (m.t === 'sshHostKey') void host.handle({ t: 'sshHostKeyAnswer', id: m.id, promptId: m.promptId, accept: true });
    },
    toRenderer: (m) => { port.push(m); items = applyPortMessage(items, m); },
  }, { killGraceMs: 300, sftpMs: 5000 });
  hosts.push(host);
  const start = (o: SftpOp, id = SESSION): Promise<SftpResult<unknown>> => {
    const n = ++reqId;
    void host.handle({ t: 'sftpOp', reqId: n, id, op: o });
    return waitFor(() => results.has(n), 20000).then(() => results.get(n)!);
  };
  const op = async <T>(o: SftpOp, id = SESSION): Promise<SftpResult<T>> => (await start(o, id)) as SftpResult<T>;
  const value = async <T>(o: SftpOp, id = SESSION): Promise<T> => {
    const r = await op<T>(o, id);
    if (!r.ok) throw new Error(`op ${o.op} failed: ${r.error}`);
    return r.value;
  };
  const statuses = () => toMain.flatMap((m) => (m.t === 'sshStatus' && m.id === SESSION ? [m] : []));
  const login = async (s: TestServer, extra: Partial<SshConnectRequest> = {}) => {
    await host.handle({ t: 'sshConnect', req: { id: SESSION, host: '127.0.0.1', port: s.port, username: 'alice', cols: 80, rows: 24, password: 'pw', allowPasswordPrompt: true, ...extra } });
    await waitFor(() => statuses().some((m) => m.phase === 'connected' || m.phase === 'error'), 20000);
    return statuses().at(-1)!;
  };
  const connect = async (s: TestServer, extra: Partial<SshConnectRequest> = {}) => { expect((await login(s, extra)).phase).toBe('connected'); };
  const enqueue = async (req: TransferRequest, id = SESSION) => (await value<{ batchId: string }>({ op: 'enqueue', req }, id)).batchId;
  const ofBatch = (batchId: string) => items.filter((i) => i.batchId === batchId);
  const settled = (batchId: string) => waitFor(() => { host.items(); return ofBatch(batchId).length > 0 && ofBatch(batchId).every((i) => ['done', 'failed', 'cancelled'].includes(i.state)); }, 20000);
  const answer = (itemId: string, a: ConflictAnswer, id = SESSION) => value<boolean>({ op: 'answerConflict', itemId, answer: a }, id);
  return { host, toMain, port, items: () => items, start, op, value, login, connect, enqueue, ofBatch, settled, answer, statuses };
}

const remote = (...p: string[]) => join(remoteRoot, 'home', 'alice', ...p);
const local = (...p: string[]) => join(localRoot, ...p);

describe('moves on the server', () => {
  it('moves files and folders with one rename each, and refuses a folder into itself', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    mkdirSync(remote('site', 'img'), { recursive: true });
    writeFileSync(remote('site', 'img', 'logo.txt'), 'logo');
    writeFileSync(remote('a.txt'), 'a');
    mkdirSync(remote('archive'));
    const b = await h.enqueue({ direction: 'move', sources: ['/home/alice/a.txt', '/home/alice/site'], targetDir: '/home/alice/archive' });
    await h.settled(b);
    expect(h.ofBatch(b).map((i) => [i.name, i.state, i.direction])).toEqual([['a.txt', 'done', 'move'], ['site', 'done', 'move']]);
    expect(readFileSync(remote('archive', 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(remote('archive', 'site', 'img', 'logo.txt'), 'utf8')).toBe('logo');
    expect(existsSync(remote('a.txt')) || existsSync(remote('site'))).toBe(false);
    // Back up with ".." semantics (the parent folder), and a folder into itself or its child is refused as a whole.
    expect(await h.op({ op: 'enqueue', req: { direction: 'move', sources: ['/home/alice/archive'], targetDir: '/home/alice/archive/site' } })).toEqual({ ok: false, error: 'intoItself' });
    expect(await h.op({ op: 'enqueue', req: { direction: 'move', sources: ['/home/alice/archive/site'], targetDir: '/home/alice/archive/site' } })).toEqual({ ok: false, error: 'intoItself' });
    // Entries already in the target folder have nothing to do.
    const none = await h.enqueue({ direction: 'move', sources: ['/home/alice/archive/a.txt'], targetDir: '/home/alice/archive' });
    expect(h.ofBatch(none)).toEqual([]);
    expect(s.sftp.ops.filter((o) => o === 'RENAME')).toHaveLength(2);
    // Moves never run in the local queue, local moves never in a session.
    expect(await h.op({ op: 'enqueue', req: { direction: 'move', sources: ['/x'], targetDir: '/y' } }, LOCAL_QUEUE_ID)).toEqual({ ok: false, error: 'invalid' });
  });

  it('asks on a name that exists: Keep both, Skip, Overwrite for files; a folder is never overwritten', async () => {
    const s = await server({ sftpPosixRename: true });
    const h = harness();
    await h.connect(s);
    mkdirSync(remote('t'));
    for (const n of ['x.txt', 'y.txt', 'z.txt']) { writeFileSync(remote(n), `new ${n}`); writeFileSync(remote('t', n), `old ${n}`); }
    mkdirSync(remote('d')); writeFileSync(remote('d', 'in.txt'), 'in');
    mkdirSync(remote('t', 'd'));
    const b = await h.enqueue({ direction: 'move', sources: ['/home/alice/x.txt', '/home/alice/y.txt', '/home/alice/z.txt', '/home/alice/d'], targetDir: '/home/alice/t' });
    await waitFor(() => h.ofBatch(b).filter((i) => i.state === 'conflict').length === 4);
    const byName = (n: string) => h.ofBatch(b).find((i) => i.name === n)!;
    expect(byName('d').conflict).toMatchObject({ existing: { kind: 'dir' }, incoming: { kind: 'dir' } });
    expect(byName('x.txt').conflict).toMatchObject({ existing: { kind: 'file' }, incoming: { kind: 'file' } });
    await h.answer(byName('x.txt').id, { choice: 'keepBoth', applyToRest: false });
    await h.answer(byName('y.txt').id, { choice: 'skip', applyToRest: false });
    await h.answer(byName('z.txt').id, { choice: 'overwrite', applyToRest: false });
    await h.answer(byName('d').id, { choice: 'overwrite', applyToRest: false });
    await h.settled(b);
    expect(readFileSync(remote('t', 'x (1).txt'), 'utf8')).toBe('new x.txt');
    expect(readFileSync(remote('t', 'x.txt'), 'utf8')).toBe('old x.txt');
    expect(byName('y.txt')).toMatchObject({ state: 'done', skipped: true });
    expect(readFileSync(remote('y.txt'), 'utf8')).toBe('new y.txt');
    expect(readFileSync(remote('t', 'z.txt'), 'utf8')).toBe('new z.txt');
    expect(existsSync(remote('z.txt'))).toBe(false);
    expect(byName('d')).toMatchObject({ state: 'failed', error: 'isADirectory' });
    expect(readFileSync(remote('d', 'in.txt'), 'utf8')).toBe('in');
    // A folder keeps both as "d (1)".
    const again = await h.enqueue({ direction: 'move', sources: ['/home/alice/d'], targetDir: '/home/alice/t', policy: 'keepBoth' });
    await h.settled(again);
    expect(readFileSync(remote('t', 'd (1)', 'in.txt'), 'utf8')).toBe('in');
  });

  it('a rename the server refuses (another file system) fails clearly and keeps the source', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    mkdirSync(remote('mnt'));
    writeFileSync(remote('big.iso'), 'iso');
    s.sftp.renameFail = (from) => from.endsWith('big.iso');
    const b = await h.enqueue({ direction: 'move', sources: ['/home/alice/big.iso'], targetDir: '/home/alice/mnt' });
    await h.settled(b);
    expect(h.ofBatch(b)[0]).toMatchObject({ state: 'failed', error: 'crossDevice' });
    expect(readFileSync(remote('big.iso'), 'utf8')).toBe('iso');
    expect(readdirSync(remote('mnt'))).toEqual([]);
  });
});

describe('moves on the local disk', () => {
  it('renames inside one volume through the local queue', async () => {
    const h = harness();
    mkdirSync(local('src', 'deep'), { recursive: true });
    writeFileSync(local('src', 'deep', 'f.txt'), 'f');
    mkdirSync(local('dst'));
    const b = await h.enqueue({ direction: 'local-move', sources: [local('src')], targetDir: local('dst') }, LOCAL_QUEUE_ID);
    await h.settled(b);
    expect(h.ofBatch(b)[0]).toMatchObject({ state: 'done', direction: 'local-move', sessionId: LOCAL_QUEUE_ID });
    expect(readFileSync(local('dst', 'src', 'deep', 'f.txt'), 'utf8')).toBe('f');
    expect(existsSync(local('src'))).toBe(false);
    expect(await h.op({ op: 'enqueue', req: { direction: 'local-move', sources: [local('dst')], targetDir: local('dst', 'src') } }, LOCAL_QUEUE_ID)).toEqual({ ok: false, error: 'intoItself' });
  });

  /** A local disk whose renames of real entries cross a volume (EXDEV); renames of part files work (same folder). */
  class OtherVolume extends LocalSide {
    failWrite: string | null = null;
    override async rename(from: string, to: string, overwrite: boolean): Promise<void> {
      if (!from.endsWith('.unimux-part')) throw new SftpError('crossDevice');
      return super.rename(from, to, overwrite);
    }
    override async openWrite(path: string) {
      if (this.failWrite && path.includes(this.failWrite)) throw new SftpError('noSpace');
      return super.openWrite(path);
    }
  }
  function queueOn(side: FileSide) {
    let items: TransferItem[] = [];
    const q = new TransferQueue(LOCAL_QUEUE_ID, () => ({ src: side, dst: side }), {
      changed: (item) => { items = items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item]; },
      removed: () => undefined, activeChanged: () => undefined,
    });
    return { q, items: () => items, settled: () => waitFor(() => items.length > 0 && items.every((i) => ['done', 'failed', 'cancelled'].includes(i.state))) };
  }

  it('across volumes copies through part files and deletes the source only after every copy', async () => {
    const side = new OtherVolume();
    const { q, items, settled } = queueOn(side);
    mkdirSync(local('src', 'sub'), { recursive: true });
    writeFileSync(local('src', 'a.txt'), 'A'.repeat(1000));
    writeFileSync(local('src', 'sub', 'b.txt'), 'B');
    mkdirSync(local('src', 'empty'));
    writeFileSync(local('one.txt'), 'one');
    mkdirSync(local('dst'));
    await q.enqueue({ direction: 'local-move', sources: [local('src'), local('one.txt')], targetDir: local('dst') });
    await settled();
    expect(items().map((i) => i.state)).toEqual(['done', 'done']);
    expect(items()[0].bytesTotal).toBe(1001);
    expect(readFileSync(local('dst', 'src', 'a.txt'), 'utf8')).toBe('A'.repeat(1000));
    expect(readFileSync(local('dst', 'src', 'sub', 'b.txt'), 'utf8')).toBe('B');
    expect(existsSync(local('dst', 'src', 'empty'))).toBe(true);
    expect(readFileSync(local('dst', 'one.txt'), 'utf8')).toBe('one');
    expect(existsSync(local('src')) || existsSync(local('one.txt'))).toBe(false);
    expect(readdirSync(local('dst', 'src')).some((n) => n.endsWith('.unimux-part'))).toBe(false);
  });

  it('a failed copy across volumes never loses the source', async () => {
    const side = new OtherVolume();
    side.failWrite = 'b.txt';
    const { q, items, settled } = queueOn(side);
    mkdirSync(local('src'), { recursive: true });
    writeFileSync(local('src', 'a.txt'), 'A');
    writeFileSync(local('src', 'b.txt'), 'B');
    mkdirSync(local('dst'));
    await q.enqueue({ direction: 'local-move', sources: [local('src')], targetDir: local('dst') });
    await settled();
    expect(items()[0]).toMatchObject({ state: 'failed', error: 'noSpace' });
    expect(readFileSync(local('src', 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(local('src', 'b.txt'), 'utf8')).toBe('B');
    expect(readdirSync(local('dst', 'src')).some((n) => n.endsWith('.unimux-part'))).toBe(false);
  });
});

describe('permission changes', () => {
  it('sets digits on one entry and keeps the bits that differ in a mixed selection', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    writeFileSync(remote('a.txt'), 'a');
    writeFileSync(remote('b.txt'), 'b');
    let r = await h.value<ChmodResult>({ op: 'chmod', req: { paths: ['/home/alice/a.txt'], set: { bits: 0o644, mask: 0o7777 }, recursive: null } });
    expect(r).toEqual({ changed: 1, errors: [] });
    await h.value({ op: 'chmod', req: { paths: ['/home/alice/b.txt'], set: { bits: 0o664, mask: 0o7777 }, recursive: null } });
    // Owner execute on, the differing group-write left out of the mask.
    s.sftp.chmods.length = 0;
    r = await h.value<ChmodResult>({ op: 'chmod', req: { paths: ['/home/alice/a.txt', '/home/alice/b.txt'], set: { bits: 0o744, mask: 0o7777 & ~0o020 }, recursive: null } });
    expect(r.changed).toBe(2);
    expect(s.sftp.chmods).toEqual([{ path: '/home/alice/a.txt', mode: 0o744 }, { path: '/home/alice/b.txt', mode: 0o764 }]);
    const listed = await h.value<{ entries: Array<{ name: string; permissions: string }> }>({ op: 'list', path: '/home/alice' });
    expect(listed.entries.find((e) => e.name === 'b.txt')!.permissions).toBe('-rwxrw-r--');
    // A path that is gone is listed as an error, the rest still changes.
    r = await h.value<ChmodResult>({ op: 'chmod', req: { paths: ['/home/alice/gone', '/home/alice/a.txt'], set: { bits: 0o600, mask: 0o7777 }, recursive: null } });
    expect(r).toEqual({ changed: 1, errors: [{ path: '/home/alice/gone', error: 'notFound' }] });
  });

  it('changes a tree with one value for folders and one for files, counted first; links are skipped', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    mkdirSync(remote('site', 'img'), { recursive: true });
    writeFileSync(remote('site', 'index.html'), 'x');
    writeFileSync(remote('site', 'img', 'logo.png'), 'x');
    writeFileSync(remote('outside.txt'), 'x');
    let link = false;
    try { symlinkSync(remote('outside.txt'), remote('site', 'link.txt'), 'file'); link = true; } catch { /* symlinks need developer mode on Windows */ }
    const count = await h.value<ChmodCount>({ op: 'chmodCount', paths: ['/home/alice/site'], recursive: true });
    expect(count).toEqual({ dirs: 2, files: 2, links: link ? 1 : 0 });
    expect(await h.value<ChmodCount>({ op: 'chmodCount', paths: ['/home/alice/site'], recursive: false })).toEqual({ dirs: 1, files: 0, links: 0 });
    const opId = '99999999-2222-4333-8444-555555555555';
    const r = await h.value<ChmodResult>({ op: 'chmod', req: { paths: ['/home/alice/site'], set: null, recursive: { dirMode: 0o750, fileMode: 0o640 }, opId } });
    expect(r).toEqual({ changed: 4, errors: [] });
    expect(Object.fromEntries(s.sftp.chmods.map((c) => [c.path, c.mode.toString(8)]))).toEqual({
      '/home/alice/site': '750', '/home/alice/site/img': '750', '/home/alice/site/index.html': '640', '/home/alice/site/img/logo.png': '640',
    });
    // The link target outside the folder was never touched.
    expect(s.sftp.chmods.some((c) => c.path.endsWith('outside.txt'))).toBe(false);
    expect(h.port.filter((m) => m.t === 'opProgress' && m.opId === opId).at(-1)).toEqual({ t: 'opProgress', opId, done: 4, total: 4 });
    // "/" itself is never changed recursively.
    expect(await h.op({ op: 'chmod', req: { paths: ['/'], set: null, recursive: { dirMode: 0o755, fileMode: 0o644 } } })).toEqual({ ok: false, error: 'invalid' });
  });

  it('stops when cancelled', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    for (let i = 0; i < 40; i++) { mkdirSync(remote('many', `d${i}`), { recursive: true }); writeFileSync(remote('many', `d${i}`, 'f.txt'), 'x'); }
    const opId = '88888888-2222-4333-8444-555555555555';
    const running = h.start({ op: 'chmod', req: { paths: ['/home/alice/many'], set: null, recursive: { dirMode: 0o700, fileMode: 0o600 }, opId } });
    // Cancelled once the first changes went out.
    await waitFor(() => s.sftp.chmods.length > 0);
    expect(await h.value<boolean>({ op: 'cancelOp', opId })).toBe(true);
    const r = await running;
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: ChmodResult }).value;
    expect(v.cancelled).toBe(true);
    expect(v.changed).toBeLessThan(81);
    expect(await h.value<boolean>({ op: 'cancelOp', opId })).toBe(false);
  });
});

describe('SFTP through sudo', () => {
  /** Answers the sudo password question with the next of `answers` (null cancels); counts the questions and their retry flags. */
  function sudoAnswers(answers: Array<string | null>) {
    const asked: boolean[] = [];
    const onMain = (m: SftpHostToMain, host: SftpHost) => {
      if (m.t !== 'sshAuthPrompt' || m.kind !== 'sudo') return false;
      asked.push(m.retry);
      const a = answers.shift();
      void host.handle({ t: 'sshAuthAnswer', id: m.id, promptId: m.promptId, values: a === null || a === undefined ? null : [a] });
      return true;
    };
    return { asked, onMain };
  }

  it('runs sftp-server with sudo -n on an exec channel (NOPASSWD), trying the next usual place', async () => {
    const s = await server({ sftpSudo: { serverPath: '/usr/libexec/openssh/sftp-server' } });
    const h = harness();
    await h.connect(s, { sftpSudo: {} });
    expect(s.sftp.execs).toEqual(['sudo -n /usr/lib/openssh/sftp-server', 'sudo -n /usr/libexec/openssh/sftp-server']);
    writeFileSync(remote('r.txt'), 'root');
    const listed = await h.value<{ entries: Array<{ name: string }> }>({ op: 'list', path: '/home/alice' });
    expect(listed.entries.map((e) => e.name)).toContain('r.txt');
    // Transfers and moves work over it too.
    writeFileSync(local('up.txt'), 'up');
    const b = await h.enqueue({ direction: 'upload', sources: [local('up.txt')], targetDir: '/home/alice' });
    await h.settled(b);
    expect(readFileSync(remote('up.txt'), 'utf8')).toBe('up');
  });

  it('a custom command runs as typed', async () => {
    const s = await server({ sftpSudo: { serverPath: '/opt/sftp-server' } });
    const h = harness();
    await h.connect(s, { sftpSudo: { command: 'sudo -n /opt/sftp-server' } });
    expect(s.sftp.execs).toEqual(['sudo -n /opt/sftp-server']);
  });

  it('asks for the sudo password, writes it first and retries a wrong one', async () => {
    const s = await server({ sftpSudo: { password: 'root-pw' } });
    const answers = sudoAnswers(['nope', 'root-pw']);
    const h = harness({ onMain: answers.onMain });
    await h.connect(s, { sftpSudo: {} });
    expect(answers.asked).toEqual([false, true]);
    expect(s.sftp.execs).toEqual(['sudo -n /usr/lib/openssh/sftp-server', "sudo -S -p '' /usr/lib/openssh/sftp-server", "sudo -S -p '' /usr/lib/openssh/sftp-server"]);
    expect((await h.value<string>({ op: 'realpath', path: '.' }))).toBe('/home/alice');
  });

  it('three wrong passwords, a cancel, requiretty, a refusal and no server end with clear errors instead of hanging', async () => {
    const cases: Array<[Parameters<typeof startTestServer>[0], Array<string | null>, string]> = [
      [{ sftpSudo: { password: 'root-pw' } }, ['a', 'b', 'c'], 'sudoPassword'],
      [{ sftpSudo: { password: 'root-pw' } }, [null], 'cancelled'],
      [{ sftpSudo: { requiretty: true } }, [], 'sudoTty'],
      [{ sftpSudo: { denied: true } }, [], 'sudoDenied'],
      [{ sftpSudo: { serverPath: '/nowhere/sftp-server' } }, [], 'sudoNoServer'],
    ];
    for (const [opts, replies, error] of cases) {
      const s = await server(opts);
      const answers = sudoAnswers(replies);
      const h = harness({ onMain: answers.onMain });
      const started = Date.now();
      const last = await h.login(s, { sftpSudo: {} });
      expect(last, error).toMatchObject({ phase: 'error', error });
      expect(Date.now() - started, error).toBeLessThan(4000);
      await h.host.shutdown();
    }
  });
});
