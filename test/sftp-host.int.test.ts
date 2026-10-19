// The SFTP host core against the in-process test server with its SFTP subsystem over a temp folder (127.0.0.1 only).
// The process wrapper (src/sftphost/index.ts) only forwards messages; everything here is the logic it runs.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshCoordinator } from '../src/main/ssh/coordinator';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { SshVault } from '../src/main/ssh/vault';
import { SftpHost } from '../src/sftphost/host';
import type { SshConnectRequest } from '../src/shared/ipc';
import { LOCAL_QUEUE_ID, applyPortMessage, sftpSessionId, type ConflictAnswer, type SftpPortMessage, type SftpResult, type TransferItem, type TransferRequest } from '../src/shared/sftp';
import type { MainToSftpHost, SftpHostToMain, SftpOp } from '../src/shared/sftpHostIpc';
import type { SshPrompt, SshSessionState } from '../src/shared/ssh';
import { addSshHost, defaultState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';
import { startTestServer, type TestServer } from './helpers/sshServer';
import { fakeCipher } from './helpers/sshKeys';

const SESSION = sftpSessionId('11111111-2222-4333-8444-555555555555');
let dir: string;
let remoteRoot: string;
let localRoot: string;
let servers: TestServer[] = [];
let hosts: SftpHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'unimux-sftp-'));
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

/** An SftpHost whose main side answers host keys itself (or hands messages to `onMain`). */
function harness(opts: { maxConcurrent?: number; onMain?: (m: SftpHostToMain, host: SftpHost) => boolean } = {}) {
  const toMain: SftpHostToMain[] = [];
  const port: SftpPortMessage[] = [];
  let items: TransferItem[] = [];
  const results = new Map<number, SftpResult<unknown>>();
  let reqId = 0;
  let maxRunning = 0;
  const host: SftpHost = new SftpHost({
    toMain: (m) => {
      toMain.push(m);
      if (m.t === 'sftpResult') results.set(m.reqId, m.result);
      if (opts.onMain?.(m, host)) return;
      if (m.t === 'sshHostKey') void host.handle({ t: 'sshHostKeyAnswer', id: m.id, promptId: m.promptId, accept: true });
    },
    toRenderer: (m) => {
      port.push(m);
      items = applyPortMessage(items, m);
      maxRunning = Math.max(maxRunning, items.filter((i) => i.state === 'running').length);
    },
  }, { killGraceMs: 300 }, { maxConcurrent: opts.maxConcurrent });
  hosts.push(host);
  const op = async <T>(op: SftpOp, id = SESSION): Promise<SftpResult<T>> => {
    const n = ++reqId;
    await host.handle({ t: 'sftpOp', reqId: n, id, op });
    await waitFor(() => results.has(n));
    return results.get(n) as SftpResult<T>;
  };
  const value = async <T>(o: SftpOp, id = SESSION): Promise<T> => {
    const r = await op<T>(o, id);
    if (!r.ok) throw new Error(`op ${o.op} failed: ${r.error}`);
    return r.value;
  };
  const phases = (id = SESSION) => toMain.flatMap((m) => (m.t === 'sshStatus' && m.id === id ? [m.phase] : []));
  const connect = async (s: TestServer, extra: Partial<SshConnectRequest> = {}) => {
    await host.handle({ t: 'sshConnect', req: { id: SESSION, host: '127.0.0.1', port: s.port, username: 'alice', cols: 80, rows: 24, password: 'pw', allowPasswordPrompt: true, ...extra } });
    await waitFor(() => phases().includes('connected') || phases().includes('error'));
    expect(phases().at(-1)).toBe('connected');
  };
  const enqueue = async (req: TransferRequest, id = SESSION) => (await value<{ batchId: string }>({ op: 'enqueue', req }, id)).batchId;
  const ofBatch = (batchId: string) => items.filter((i) => i.batchId === batchId);
  const settled = (batchId: string) => waitFor(() => { host.items(); return ofBatch(batchId).length > 0 && ofBatch(batchId).every((i) => ['done', 'failed', 'cancelled'].includes(i.state)); }, 20000);
  const answer = (itemId: string, a: ConflictAnswer, id = SESSION) => value<boolean>({ op: 'answerConflict', itemId, answer: a }, id);
  return { host, toMain, port, items: () => items, op, value, connect, enqueue, ofBatch, settled, answer, phases, maxRunning: () => maxRunning };
}

const remote = (...p: string[]) => join(remoteRoot, ...p);
const local = (...p: string[]) => join(localRoot, ...p);

describe('SftpHost: remote operations', () => {
  it('logs in, starts in the login folder and lists, makes, renames and deletes (recursively, only the confirmed count)', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    expect(await h.value({ op: 'realpath', path: '.' })).toBe('/home/alice');
    writeFileSync(remote('home', 'alice', 'a.txt'), 'hello');
    expect(await h.value({ op: 'mkdir', path: '/home/alice/docs' })).toBeNull();
    expect(await h.op({ op: 'mkdir', path: '/home/alice/docs' })).toEqual({ ok: false, error: 'exists' });
    const listed = await h.value<{ path: string; entries: Array<{ name: string; kind: string; size: number; permissions: string; owner?: string }> }>({ op: 'list', path: '/home/alice/./' });
    expect(listed.path).toBe('/home/alice');
    const byName = Object.fromEntries(listed.entries.map((e) => [e.name, e]));
    expect(byName['a.txt']).toMatchObject({ kind: 'file', size: 5, owner: 'alice' });
    expect(byName['a.txt'].permissions).toMatch(/^-[r-][w-]/);
    expect(byName.docs).toMatchObject({ kind: 'dir' });
    expect(byName.docs.permissions.startsWith('d')).toBe(true);
    expect(await h.value({ op: 'rename', from: '/home/alice/a.txt', to: '/home/alice/b.txt' })).toBeNull();
    writeFileSync(remote('home', 'alice', 'c.txt'), 'c');
    expect(await h.op({ op: 'rename', from: '/home/alice/b.txt', to: '/home/alice/c.txt' })).toEqual({ ok: false, error: 'exists' });
    expect(readFileSync(remote('home', 'alice', 'c.txt'), 'utf8')).toBe('c');
    mkdirSync(remote('home', 'alice', 'docs', 'deep', 'er'), { recursive: true });
    writeFileSync(remote('home', 'alice', 'docs', 'one'), '1');
    writeFileSync(remote('home', 'alice', 'docs', 'deep', 'two'), '2');
    const count = await h.value<{ files: number; dirs: number }>({ op: 'deleteCount', paths: ['/home/alice/docs', '/home/alice/b.txt'] });
    expect(count).toEqual({ files: 3, dirs: 3 });
    writeFileSync(remote('home', 'alice', 'docs', 'three'), '3');
    expect(await h.op({ op: 'delete', paths: ['/home/alice/docs', '/home/alice/b.txt'], confirmed: count })).toEqual({ ok: false, error: 'changed' });
    expect(existsSync(remote('home', 'alice', 'docs', 'one'))).toBe(true);
    expect(await h.op({ op: 'delete', paths: ['/home/alice/docs', '/home/alice/b.txt'], confirmed: { files: 4, dirs: 3 } })).toEqual({ ok: true, value: null });
    expect(readdirSync(remote('home', 'alice')).sort()).toEqual(['c.txt']);
    expect(await h.op({ op: 'deleteCount', paths: ['/'] })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.op({ op: 'list', path: '/nope' })).toEqual({ ok: false, error: 'notFound' });
  });

  it('refuses operations of a session that does not exist or is not connected yet', async () => {
    const h = harness();
    expect(await h.op({ op: 'list', path: '/' })).toEqual({ ok: false, error: 'noSession' });
    expect(await h.op({ op: 'enqueue', req: { direction: 'upload', sources: [local('x')], targetDir: '/' } })).toEqual({ ok: false, error: 'noSession' });
    // A local copy belongs on the local queue only, and that queue takes nothing else.
    expect(await h.op({ op: 'enqueue', req: { direction: 'upload', sources: [local('x')], targetDir: '/' } }, LOCAL_QUEUE_ID)).toEqual({ ok: false, error: 'invalid' });
  });

  it('a server without the sftp subsystem ends the session with sftpDenied', async () => {
    const s = await startTestServer({ password: 'pw' });
    servers.push(s);
    const h = harness();
    await h.host.handle({ t: 'sshConnect', req: { id: SESSION, host: '127.0.0.1', port: s.port, username: 'alice', cols: 80, rows: 24, password: 'pw', allowPasswordPrompt: true } });
    await waitFor(() => h.phases().includes('error'));
    expect(h.toMain.filter((m) => m.t === 'sshStatus').at(-1)).toMatchObject({ phase: 'error', error: 'sftpDenied' });
  });
});

describe('SftpHost: transfers', () => {
  it('uploads and downloads a file and a folder (recursively, empty folders too)', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    const big = Buffer.alloc(700_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
    writeFileSync(local('big.bin'), big);
    mkdirSync(local('site', 'css'), { recursive: true });
    mkdirSync(local('site', 'empty'));
    writeFileSync(local('site', 'index.html'), '<h1>hi</h1>');
    writeFileSync(local('site', 'css', 'a.css'), 'body{}');
    const up = await h.enqueue({ direction: 'upload', sources: [local('big.bin'), local('site')], targetDir: '/home/alice' });
    await h.settled(up);
    expect(h.ofBatch(up).map((i) => [i.name, i.state])).toEqual([['big.bin', 'done'], ['site/css/a.css', 'done'], ['site/index.html', 'done']]);
    expect(readFileSync(remote('home', 'alice', 'big.bin')).equals(big)).toBe(true);
    expect(readFileSync(remote('home', 'alice', 'site', 'css', 'a.css'), 'utf8')).toBe('body{}');
    expect(existsSync(remote('home', 'alice', 'site', 'empty'))).toBe(true);
    const bigItem = h.ofBatch(up)[0];
    expect(bigItem).toMatchObject({ bytesDone: big.length, bytesTotal: big.length, target: '/home/alice/big.bin', direction: 'upload' });

    mkdirSync(local('down'));
    const down = await h.enqueue({ direction: 'download', sources: ['/home/alice/big.bin', '/home/alice/site'], targetDir: local('down') });
    await h.settled(down);
    expect(h.ofBatch(down).every((i) => i.state === 'done')).toBe(true);
    expect(readFileSync(local('down', 'big.bin')).equals(big)).toBe(true);
    expect(readFileSync(local('down', 'site', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(existsSync(local('down', 'site', 'empty'))).toBe(true);
    // No part file anywhere.
    const all = (root: string): string[] => readdirSync(root, { recursive: true }).map(String);
    expect([...all(remoteRoot), ...all(localRoot)].filter((n) => n.includes('.unimux-part'))).toEqual([]);
  });

  it('writes to "<name>.unimux-part": the final name appears only complete (upload and download)', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    s.sftp.delayMs = 15;
    writeFileSync(local('slow.bin'), Buffer.alloc(400_000, 7));
    const up = await h.enqueue({ direction: 'upload', sources: [local('slow.bin')], targetDir: '/home/alice' });
    await waitFor(() => h.ofBatch(up)[0]?.bytesDone > 0 || existsSync(remote('home', 'alice', 'slow.bin.unimux-part')));
    expect(existsSync(remote('home', 'alice', 'slow.bin.unimux-part'))).toBe(true);
    expect(existsSync(remote('home', 'alice', 'slow.bin'))).toBe(false);
    await h.settled(up);
    expect(readFileSync(remote('home', 'alice', 'slow.bin')).length).toBe(400_000);
    expect(existsSync(remote('home', 'alice', 'slow.bin.unimux-part'))).toBe(false);

    mkdirSync(local('dl'));
    const down = await h.enqueue({ direction: 'download', sources: ['/home/alice/slow.bin'], targetDir: local('dl') });
    await waitFor(() => existsSync(local('dl', 'slow.bin.unimux-part')) || h.ofBatch(down)[0]?.state === 'done');
    expect(h.ofBatch(down)[0].state).not.toBe('done');
    expect(existsSync(local('dl', 'slow.bin'))).toBe(false);
    await h.settled(down);
    expect(h.ofBatch(down)[0]).toMatchObject({ state: 'done' });
    expect(readdirSync(local('dl'))).toEqual(['slow.bin']);
  });

  it('cancel stops a running upload and leaves neither a part file nor the final name', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    s.sftp.delayMs = 20;
    writeFileSync(local('huge.bin'), Buffer.alloc(3_000_000, 1));
    const up = await h.enqueue({ direction: 'upload', sources: [local('huge.bin')], targetDir: '/home/alice' });
    await waitFor(() => (h.ofBatch(up)[0]?.bytesDone ?? 0) > 100_000);
    expect(await h.value({ op: 'cancel', itemIds: [h.ofBatch(up)[0].id] })).toBe(true);
    await h.settled(up);
    expect(h.ofBatch(up)[0].state).toBe('cancelled');
    await waitFor(() => !existsSync(remote('home', 'alice', 'huge.bin.unimux-part')));
    expect(existsSync(remote('home', 'alice', 'huge.bin'))).toBe(false);
    // Retry runs it again to the end.
    s.sftp.delayMs = 0;
    expect(await h.value({ op: 'retry', itemIds: [h.ofBatch(up)[0].id] })).toBe(true);
    await waitFor(() => h.ofBatch(up)[0].state === 'done', 20000);
    expect(readFileSync(remote('home', 'alice', 'huge.bin')).length).toBe(3_000_000);
  });

  it('a failing write fails the item with a code and removes the part file', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    s.sftp.failWritesAfter = 100_000;
    writeFileSync(local('full.bin'), Buffer.alloc(500_000, 3));
    const up = await h.enqueue({ direction: 'upload', sources: [local('full.bin')], targetDir: '/home/alice' });
    await h.settled(up);
    expect(h.ofBatch(up)[0]).toMatchObject({ state: 'failed', error: 'failed' });
    await waitFor(() => !existsSync(remote('home', 'alice', 'full.bin.unimux-part')));
    expect(existsSync(remote('home', 'alice', 'full.bin'))).toBe(false);
  });

  it('pauses on an existing target and applies each answer (overwrite, skip, keep both)', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    for (const n of ['o.txt', 's.txt', 'k.txt']) { writeFileSync(local(n), `new ${n}`); writeFileSync(remote('home', 'alice', n), 'old'); }
    writeFileSync(remote('home', 'alice', 'k (1).txt'), 'taken');
    const b = await h.enqueue({ direction: 'upload', sources: [local('o.txt'), local('s.txt'), local('k.txt')], targetDir: '/home/alice' });
    await waitFor(() => h.ofBatch(b).filter((i) => i.state === 'conflict').length === 3);
    const [o, sk, k] = h.ofBatch(b);
    expect(o.conflict).toMatchObject({ target: '/home/alice/o.txt', existing: { kind: 'file', size: 3 }, incoming: { size: 9 } });
    await h.answer(o.id, { choice: 'overwrite', applyToRest: false });
    await h.answer(sk.id, { choice: 'skip', applyToRest: false });
    await h.answer(k.id, { choice: 'keepBoth', applyToRest: false });
    await h.settled(b);
    expect(readFileSync(remote('home', 'alice', 'o.txt'), 'utf8')).toBe('new o.txt');
    expect(readFileSync(remote('home', 'alice', 's.txt'), 'utf8')).toBe('old');
    expect(h.ofBatch(b)[1]).toMatchObject({ state: 'done', skipped: true });
    expect(readFileSync(remote('home', 'alice', 'k.txt'), 'utf8')).toBe('old');
    expect(readFileSync(remote('home', 'alice', 'k (2).txt'), 'utf8')).toBe('new k.txt');
    expect(h.ofBatch(b)[2].target).toBe('/home/alice/k (2).txt');
  });

  it('"apply to rest" answers the waiting conflicts of the batch and the later ones', async () => {
    const s = await server();
    const h = harness({ maxConcurrent: 1 });
    await h.connect(s);
    for (let i = 0; i < 4; i++) { writeFileSync(local(`f${i}`), `new${i}`); writeFileSync(remote('home', 'alice', `f${i}`), 'old'); }
    const b = await h.enqueue({ direction: 'upload', sources: [0, 1, 2, 3].map((i) => local(`f${i}`)), targetDir: '/home/alice' });
    await waitFor(() => h.ofBatch(b).some((i) => i.state === 'conflict'));
    const first = h.ofBatch(b).find((i) => i.state === 'conflict')!;
    await h.answer(first.id, { choice: 'skip', applyToRest: true });
    await h.settled(b);
    expect(h.ofBatch(b).map((i) => [i.state, i.skipped])).toEqual([['done', true], ['done', true], ['done', true], ['done', true]]);
    for (let i = 0; i < 4; i++) expect(readFileSync(remote('home', 'alice', `f${i}`), 'utf8')).toBe('old');
    // A batch policy answers up front, no question.
    const b2 = await h.enqueue({ direction: 'upload', sources: [local('f0')], targetDir: '/home/alice', policy: 'overwrite' });
    await h.settled(b2);
    expect(h.ofBatch(b2)[0].state).toBe('done');
    expect(readFileSync(remote('home', 'alice', 'f0'), 'utf8')).toBe('new0');
  });

  it('moves at most three files at the same time per session', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    s.sftp.delayMs = 10;
    const names = Array.from({ length: 8 }, (_, i) => `n${i}.bin`);
    for (const n of names) writeFileSync(local(n), Buffer.alloc(120_000, 2));
    const b = await h.enqueue({ direction: 'upload', sources: names.map((n) => local(n)), targetDir: '/home/alice' });
    await h.settled(b);
    expect(h.ofBatch(b).every((i) => i.state === 'done')).toBe(true);
    expect(h.maxRunning()).toBe(3);
    expect(s.sftp.maxOpenWrites).toBeLessThanOrEqual(3);
    expect(s.sftp.maxOpenWrites).toBeGreaterThanOrEqual(2);
  });

  it('a conflict does not hold a slot, and the answered item waits for one (the cap holds)', async () => {
    const s = await server();
    const h = harness({ maxConcurrent: 1 });
    await h.connect(s);
    s.sftp.delayMs = 10;
    writeFileSync(local('c.bin'), 'x');
    writeFileSync(remote('home', 'alice', 'c.bin'), 'old');
    writeFileSync(local('d.bin'), Buffer.alloc(200_000, 1));
    const b = await h.enqueue({ direction: 'upload', sources: [local('c.bin'), local('d.bin')], targetDir: '/home/alice' });
    await waitFor(() => h.ofBatch(b)[0]?.state === 'conflict' && h.ofBatch(b)[1]?.state === 'running');
    await h.answer(h.ofBatch(b)[0].id, { choice: 'overwrite', applyToRest: false });
    await h.settled(b);
    expect(h.maxRunning()).toBe(1);
    expect(readFileSync(remote('home', 'alice', 'c.bin'), 'utf8')).toBe('x');
  });

  it('copies OS drops into a local folder on the local queue (part file, keep both, never into itself)', async () => {
    const h = harness();
    mkdirSync(local('src', 'sub'), { recursive: true });
    writeFileSync(local('src', 'a.txt'), 'A');
    writeFileSync(local('src', 'sub', 'b.txt'), 'B');
    mkdirSync(local('dst'));
    writeFileSync(local('dst', 'a.txt'), 'old');
    const b = await h.enqueue({ direction: 'local-copy', sources: [local('src', 'a.txt'), local('src', 'sub')], targetDir: local('dst'), policy: 'keepBoth' }, LOCAL_QUEUE_ID);
    await h.settled(b);
    expect(readFileSync(local('dst', 'a (1).txt'), 'utf8')).toBe('A');
    expect(readFileSync(local('dst', 'sub', 'b.txt'), 'utf8')).toBe('B');
    expect(h.ofBatch(b).every((i) => i.sessionId === LOCAL_QUEUE_ID)).toBe(true);
    expect(await h.op({ op: 'enqueue', req: { direction: 'local-copy', sources: [local('src')], targetDir: local('src', 'sub') } }, LOCAL_QUEUE_ID)).toEqual({ ok: false, error: 'invalid' });
    expect(await h.value({ op: 'clearFinished' }, LOCAL_QUEUE_ID)).toBe(2);
    expect(h.items().filter((i) => i.batchId === b)).toEqual([]);
  });

  it('a lost connection fails what was not finished with connectionLost', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    s.sftp.delayMs = 30;
    writeFileSync(local('l.bin'), Buffer.alloc(2_000_000, 1));
    const b = await h.enqueue({ direction: 'upload', sources: [local('l.bin')], targetDir: '/home/alice' });
    await waitFor(() => (h.ofBatch(b)[0]?.bytesDone ?? 0) > 0);
    s.dropConnections();
    await h.settled(b);
    expect(h.ofBatch(b)[0]).toMatchObject({ state: 'failed', error: 'connectionLost' });
    await waitFor(() => h.phases().includes('error'));
    expect(h.host.has(SESSION)).toBe(false);
  });
});

describe('SftpHost behind the SSH coordinator', () => {
  const HOST_ID = '00000000-0000-4000-8000-0000000000aa';
  function chain(s: TestServer, opts: { savedPassword?: string; knownKey?: Buffer } = {}) {
    const vault = new SshVault(join(dir, 'vault.json'), fakeCipher());
    const knownHosts = new KnownHostsStore(join(dir, 'known_hosts.json'));
    if (opts.knownKey) knownHosts.trust('127.0.0.1', s.port, opts.knownKey, 'save');
    let state: AppState = addSshHost(defaultState(), { id: HOST_ID, label: 'test', address: '127.0.0.1', port: s.port, username: 'alice', createdAt: 0, updatedAt: 0 });
    if (opts.savedPassword) vault.setPassword(HOST_ID, opts.savedPassword);
    const sessions: SshSessionState[] = [];
    const prompts: Array<{ id: string; prompt: SshPrompt | null }> = [];
    let host!: SftpHost;
    const coordinator = new SshCoordinator({
      state: () => state, vault, knownHosts,
      host: (m) => { void host.handle(m as MainToSftpHost); return true; },
      events: { session: (st) => sessions.push(st), prompt: (id, prompt) => prompts.push({ id, prompt }), vaultChanged: () => undefined },
    });
    host = new SftpHost({ toMain: (m) => { coordinator.onHostMessage(m as never); }, toRenderer: () => undefined }, { killGraceMs: 300 });
    hosts.push(host);
    const open = () => [...prompts].reverse().find((p) => p.id === SESSION)?.prompt ?? null;
    const last = () => sessions.filter((x) => x.cellId === SESSION).at(-1);
    return { coordinator, vault, knownHosts, sessions, prompts, open, last, host, setState: (st: AppState) => { state = st; } };
  }

  it('asks for the password through the coordinator, logs in and remembers it only after the login', async () => {
    const s = await server();
    const c = chain(s, { knownKey: undefined });
    expect(await c.coordinator.connectSession({ sessionId: SESSION, hostId: HOST_ID })).toEqual({ ok: true });
    await waitFor(() => c.open()?.kind === 'hostKey');
    const hk = c.open()!;
    expect(hk).toMatchObject({ kind: 'hostKey', reason: 'unknown' });
    expect(c.coordinator.answer({ cellId: SESSION, promptId: hk.id, hostKey: 'save' })).toEqual({ ok: true });
    await waitFor(() => c.open()?.kind === 'password');
    const pw = c.open()!;
    expect(pw).toMatchObject({ kind: 'password', user: 'alice', retry: false });
    // The SFTP prompts are the session's own; the cell snapshot does not list them.
    expect(c.coordinator.sessions().prompts).toEqual([]);
    expect(c.coordinator.sessionSnapshot().prompts.map((p) => p.cellId)).toEqual([SESSION]);
    expect(c.coordinator.answer({ cellId: SESSION, promptId: pw.id, values: ['wrong'] })).toEqual({ ok: true });
    await waitFor(() => c.open()?.kind === 'password' && c.open()!.id !== pw.id);
    expect(c.open()).toMatchObject({ retry: true });
    expect(c.coordinator.answer({ cellId: SESSION, promptId: c.open()!.id, values: ['pw'], remember: true })).toEqual({ ok: true });
    await waitFor(() => c.last()?.phase === 'connected');
    expect(c.host.has(SESSION)).toBe(true);
    const saved = c.vault.password(HOST_ID);
    expect(saved.ok && saved.password).toBe('pw');
    expect(c.knownHosts.list()).toHaveLength(1);
    c.coordinator.endSession(SESSION);
    expect(c.last()?.phase).toBe('closed');
    expect(c.coordinator.sessionSnapshot().sessions).toEqual([]);
  });

  it('refuses a host whose key changed, like a cell (only "replace" may accept it)', async () => {
    const s = await server();
    const other = Buffer.from(s.hostKeyBlob);
    other[other.length - 1] ^= 0xff;
    const c = chain(s, { knownKey: other, savedPassword: 'pw' });
    await c.coordinator.connectSession({ sessionId: SESSION, hostId: HOST_ID });
    await waitFor(() => c.open()?.kind === 'hostKey');
    const hk = c.open()!;
    expect(hk).toMatchObject({ kind: 'hostKey', reason: 'changed' });
    expect(c.coordinator.answer({ cellId: SESSION, promptId: hk.id, hostKey: 'once' })).toEqual({ ok: false });
    expect(c.coordinator.answer({ cellId: SESSION, promptId: hk.id, cancel: true })).toEqual({ ok: true });
    await waitFor(() => c.last()?.phase === 'error');
    expect(c.last()).toMatchObject({ phase: 'error', error: 'hostKeyChanged' });
    expect(c.host.has(SESSION)).toBe(false);
  });

  it('a known host and a saved password connect without any question; a restart of the SFTP host ends only SFTP sessions', async () => {
    const s = await server();
    const c = chain(s, { knownKey: s.hostKeyBlob, savedPassword: 'pw' });
    await c.coordinator.connectSession({ sessionId: SESSION, hostId: HOST_ID });
    await waitFor(() => c.last()?.phase === 'connected');
    expect(c.prompts.filter((p) => p.prompt)).toEqual([]);
    c.coordinator.hostCrashed(); // the Pty Host: not this session's process
    expect(c.last()?.phase).toBe('connected');
    c.coordinator.sessionHostCrashed();
    expect(c.last()).toMatchObject({ phase: 'error', error: 'sftpHostCrashed' });
  });
});

describe('SftpHost: overwrite, cancel and links (fix round 1)', () => {
  it('overwrites with posix-rename when the server offers it', async () => {
    const s = await server({ sftpPosixRename: true });
    const h = harness();
    await h.connect(s);
    writeFileSync(local('o.txt'), 'new content');
    writeFileSync(remote('home', 'alice', 'o.txt'), 'old');
    const b = await h.enqueue({ direction: 'upload', sources: [local('o.txt')], targetDir: '/home/alice', policy: 'overwrite' });
    await h.settled(b);
    expect(h.ofBatch(b)[0].state).toBe('done');
    expect(s.sftp.ops).toContain('POSIX_RENAME');
    expect(readFileSync(remote('home', 'alice', 'o.txt'), 'utf8')).toBe('new content');
    expect(readdirSync(remote('home', 'alice'))).toEqual(['o.txt']);
  });

  it('without posix-rename the old file moves aside and comes back when the new one cannot be renamed in', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    writeFileSync(local('o.txt'), 'new content');
    writeFileSync(remote('home', 'alice', 'o.txt'), 'old');
    s.sftp.renameFail = (from) => from.endsWith('.unimux-part');
    const b = await h.enqueue({ direction: 'upload', sources: [local('o.txt')], targetDir: '/home/alice', policy: 'overwrite' });
    await h.settled(b);
    expect(h.ofBatch(b)[0]).toMatchObject({ state: 'failed', error: 'failed' });
    expect(readFileSync(remote('home', 'alice', 'o.txt'), 'utf8')).toBe('old');
    await waitFor(() => readdirSync(remote('home', 'alice')).length === 1);
    expect(readdirSync(remote('home', 'alice'))).toEqual(['o.txt']);
    // And the plain path works: aside, in, aside copy removed.
    s.sftp.renameFail = null;
    expect(await h.value({ op: 'retry', itemIds: [h.ofBatch(b)[0].id] })).toBe(true);
    await waitFor(() => h.ofBatch(b)[0].state === 'done');
    expect(readFileSync(remote('home', 'alice', 'o.txt'), 'utf8')).toBe('new content');
    expect(readdirSync(remote('home', 'alice'))).toEqual(['o.txt']);
  });

  it('when the old file cannot be put back either, neither copy is deleted', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    writeFileSync(local('o.txt'), 'new content');
    writeFileSync(remote('home', 'alice', 'o.txt'), 'old');
    s.sftp.renameFail = (from) => from.endsWith('.unimux-part') || from.includes('.unimux-old');
    const b = await h.enqueue({ direction: 'upload', sources: [local('o.txt')], targetDir: '/home/alice', policy: 'overwrite' });
    await h.settled(b);
    expect(h.ofBatch(b)[0].state).toBe('failed');
    expect(readFileSync(remote('home', 'alice', 'o.txt.unimux-old'), 'utf8')).toBe('old');
    expect(readFileSync(remote('home', 'alice', 'o.txt.unimux-part'), 'utf8')).toBe('new content');
  });

  it('cancelling a download removes the local part file', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    writeFileSync(remote('home', 'alice', 'big.bin'), Buffer.alloc(3_000_000, 4));
    s.sftp.delayMs = 20;
    mkdirSync(local('dl'));
    const b = await h.enqueue({ direction: 'download', sources: ['/home/alice/big.bin'], targetDir: local('dl') });
    await waitFor(() => (h.ofBatch(b)[0]?.bytesDone ?? 0) > 100_000);
    await h.value({ op: 'cancel', batchId: b });
    await h.settled(b);
    expect(h.ofBatch(b)[0].state).toBe('cancelled');
    await waitFor(() => readdirSync(local('dl')).length === 0);
  });

  it('a Disconnect while files move marks them cancelled, not failed', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    s.sftp.delayMs = 20;
    writeFileSync(local('l.bin'), Buffer.alloc(2_000_000, 1));
    writeFileSync(local('q.bin'), 'q');
    const b = await h.enqueue({ direction: 'upload', sources: [local('l.bin'), local('q.bin')], targetDir: '/home/alice' });
    await waitFor(() => (h.ofBatch(b)[0]?.bytesDone ?? 0) > 0);
    await h.host.handle({ t: 'sftpDisconnect', id: SESSION });
    await h.settled(b);
    expect(h.ofBatch(b).map((i) => i.state)).toEqual(['cancelled', expect.stringMatching(/cancelled|done/)]);
    expect(existsSync(remote('home', 'alice', 'l.bin.unimux-part'))).toBe(false);
  });

  it('counts and deletes overlapping or repeated paths once', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    mkdirSync(remote('home', 'alice', 'a', 'b'), { recursive: true });
    writeFileSync(remote('home', 'alice', 'a', 'b', 'x'), 'x');
    const paths = ['/home/alice/a', '/home/alice/a/b', '/home/alice/a/', '/home/alice/a/b/x'];
    const count = await h.value<{ files: number; dirs: number }>({ op: 'deleteCount', paths });
    expect(count).toEqual({ files: 1, dirs: 2 });
    expect(await h.op({ op: 'delete', paths, confirmed: count })).toEqual({ ok: true, value: null });
    expect(existsSync(remote('home', 'alice', 'a'))).toBe(false);
  });

  it('a remote link loop does not loop: download fails that item, delete removes the link and never follows it', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    mkdirSync(remote('home', 'alice', 'loop'));
    writeFileSync(remote('home', 'alice', 'loop', 'f.txt'), 'f');
    try { symlinkSync(remote('home', 'alice', 'loop'), remote('home', 'alice', 'loop', 'again'), 'junction'); } catch { return; } // no links here
    mkdirSync(local('dl'));
    const b = await h.enqueue({ direction: 'download', sources: ['/home/alice/loop'], targetDir: local('dl') });
    const byName = Object.fromEntries((await (async () => { await h.settled(b); return h.ofBatch(b); })()).map((i) => [i.name, i]));
    expect(byName['loop/f.txt'].state).toBe('done');
    expect(byName['loop/again']).toMatchObject({ state: 'failed', error: 'linkFolder' });
    const count = await h.value<{ files: number; dirs: number }>({ op: 'deleteCount', paths: ['/home/alice/loop'] });
    expect(count).toEqual({ files: 2, dirs: 1 });
    expect(await h.op({ op: 'delete', paths: ['/home/alice/loop'], confirmed: count })).toEqual({ ok: true, value: null });
    expect(existsSync(remote('home', 'alice', 'loop'))).toBe(false);
  });

  it('an upload of a folder with a link to a file outside it does not send that file', async () => {
    const s = await server();
    const h = harness();
    await h.connect(s);
    mkdirSync(local('pick'));
    writeFileSync(local('secret.txt'), 'SECRET');
    writeFileSync(local('pick', 'ok.txt'), 'ok');
    try { symlinkSync(local('secret.txt'), local('pick', 'link.txt'), 'file'); } catch { return; } // symlinks need developer mode on Windows
    const b = await h.enqueue({ direction: 'upload', sources: [local('pick')], targetDir: '/home/alice' });
    await h.settled(b);
    const byName = Object.fromEntries(h.ofBatch(b).map((i) => [i.name, i]));
    expect(byName['pick/link.txt']).toMatchObject({ state: 'failed', error: 'linkOutside' });
    expect(readdirSync(remote('home', 'alice', 'pick'))).toEqual(['ok.txt']);
  });
});
