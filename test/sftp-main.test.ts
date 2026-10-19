// Main side of SFTP: the service (session states with the start folder, idle disconnect, crash), the IPC validation and the
// local pane's file channels.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalFiles } from '../src/main/localFiles';
import { createSftpHandlers } from '../src/main/sftp/ipc';
import { SftpService, type SftpServiceDeps } from '../src/main/sftp/service';
import type { SftpResult, SftpSessionState } from '../src/shared/sftp';
import type { MainToSftpHost, SftpOp } from '../src/shared/sftpHostIpc';
import type { SshPrompt, SshSessionState } from '../src/shared/ssh';

const HOST = '00000000-0000-4000-8000-000000000001';
const flush = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const sent: MainToSftpHost[] = [];
  const requests: Array<{ id: string; op: SftpOp }> = [];
  const states: SftpSessionState[] = [];
  const prompts: Array<[string, SshPrompt | null]> = [];
  const ended: string[] = [];
  let crashed = 0;
  const deferred: Array<() => void> = [];
  const connects: string[] = [];
  const forwarded: string[] = [];
  let connected: ((s: SshSessionState) => void) | null = null;
  const realpaths: Record<string, string> = { '.': '/home/alice', '/srv/www': '/srv/www' };
  const deps: SftpServiceDeps = {
    coordinator: {
      connectSession: async (req) => { connects.push(req.sessionId); connected?.({ cellId: req.sessionId, hostId: req.hostId, phase: 'connecting', since: 1 }); return { ok: true }; },
      endSession: (id) => { ended.push(id); },
      answer: () => ({ ok: true }),
      sessionSnapshot: () => ({ sessions: [], prompts: [] }),
      onHostMessage: (m) => { forwarded.push(m.t === 'sshStatus' ? m.id : ''); return true; },
      sessionHostCrashed: () => undefined,
    },
    host: {
      ensure: () => true, running: () => true,
      send: (m) => { sent.push(m); return true; },
      request: async (id, op): Promise<SftpResult<unknown>> => {
        requests.push({ id, op });
        if (op.op === 'realpath') return op.path in realpaths ? { ok: true, value: realpaths[op.path] } : { ok: false, error: 'notFound' };
        if (op.op === 'stat') return { ok: true, value: { kind: 'dir' } };
        return { ok: true, value: true };
      },
    },
    hostExists: (id) => id === HOST,
    events: { session: (s) => states.push(s), prompt: (id, p) => prompts.push([id, p]), hostCrashed: () => { crashed++; } },
    now: () => 5,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    defer: (fn) => { deferred.push(fn); },
  };
  const service = new SftpService(deps);
  connected = (s) => service.onCoordinatorSession(s);
  const live = () => timers.filter((t) => !t.cleared);
  const runDeferred = async () => { while (deferred.length) deferred.shift()!(); await flush(); };
  return { service, runDeferred, connects, forwarded, sent, requests, states, prompts, ended, timers, live, crashed: () => crashed };
}

describe('SftpService', () => {
  it('announces "connected" with the asked folder, or the login folder when it does not exist', async () => {
    const f = setup();
    const r = await f.service.connect(HOST, '/srv/www');
    expect(r.ok).toBe(true);
    const id = r.ok ? r.sessionId : '';
    // The id is answered before the login starts: no event names an id the view does not have yet.
    expect(f.connects).toEqual([]);
    expect(f.states).toEqual([]);
    await f.runDeferred();
    expect(f.connects).toEqual([id]);
    expect(id).toMatch(/^sftp:[0-9a-f-]{36}$/);
    f.service.onCoordinatorSession({ cellId: id, hostId: HOST, phase: 'connected', since: 2 });
    await flush();
    expect(f.states.at(-1)).toMatchObject({ id, state: 'connected', path: '/srv/www' });
    const r2 = await f.service.connect(HOST, '/gone');
    const id2 = r2.ok ? r2.sessionId : '';
    await f.runDeferred();
    f.service.onCoordinatorSession({ cellId: id2, hostId: HOST, phase: 'connected', since: 2 });
    await flush();
    expect(f.states.at(-1)).toMatchObject({ id: id2, state: 'connected', path: '/home/alice' });
    expect(await f.service.connect('00000000-0000-4000-8000-00000000ffff')).toEqual({ ok: false, error: 'hostMissing' });
  });

  it('disconnects 2 minutes after the view closed, only once the queue is empty', async () => {
    const f = setup();
    f.service.viewOpened();
    const r = await f.service.connect(HOST);
    const id = r.ok ? r.sessionId : '';
    f.service.onCoordinatorSession({ cellId: id, hostId: HOST, phase: 'connected', since: 2 });
    await flush();
    expect(f.live()).toEqual([]);
    f.service.onHostMessage({ t: 'sftpQueue', id, active: true });
    f.service.viewClosed();
    expect(f.live()).toEqual([]); // transfers run: it stays
    f.service.onHostMessage({ t: 'sftpQueue', id, active: false });
    expect(f.live().map((t) => t.ms)).toEqual([120_000]);
    f.service.viewOpened();
    expect(f.live()).toEqual([]);
    f.service.viewClosed();
    f.live()[0].fn();
    expect(f.sent).toEqual([{ t: 'sftpDisconnect', id }]);
    expect(f.ended).toContain(id);
    expect(f.service.ids()).toEqual([]);
  });

  it('forgets a session that failed and tells the renderer when the SFTP host restarted', async () => {
    const f = setup();
    const r = await f.service.connect(HOST);
    const id = r.ok ? r.sessionId : '';
    f.service.onCoordinatorSession({ cellId: id, hostId: HOST, phase: 'error', since: 3, error: 'hostKeyChanged' });
    expect(f.states.at(-1)).toMatchObject({ id, state: 'error', error: 'hostKeyChanged' });
    expect(f.service.ids()).toEqual([]);
    expect(await f.service.op(id, { op: 'list', path: '/' })).toEqual({ ok: false, error: 'noSession' });
    await f.service.connect(HOST);
    f.service.hostCrashed();
    expect(f.crashed()).toBe(1);
    expect(f.service.ids()).toEqual([]);
  });
});

describe('SftpService routing', () => {
  it('passes login messages of the SFTP Host on only for its own sftp: sessions (never a cell id)', async () => {
    const f = setup();
    const r = await f.service.connect(HOST);
    const id = r.ok ? r.sessionId : '';
    f.service.onHostMessage({ t: 'sshStatus', id: '00000000-0000-4000-8000-0000000000c1', phase: 'error', error: 'reset' });
    f.service.onHostMessage({ t: 'sshStatus', id: 'sftp:00000000-0000-4000-8000-0000000000c2', phase: 'error', error: 'reset' });
    f.service.onHostMessage({ t: 'sshStatus', id, phase: 'authenticating' });
    expect(f.forwarded).toEqual([id]);
  });

  it('a login refused up front still ends with an error event for the id connect returned', async () => {
    const f = setup();
    const svc = new SftpService({ ...(f.service as unknown as { deps: SftpServiceDeps }).deps, coordinator: { ...(f.service as unknown as { deps: SftpServiceDeps }).deps.coordinator, connectSession: async () => ({ ok: false, error: 'hostMissing' }) } });
    const r = await svc.connect(HOST);
    await f.runDeferred();
    expect(f.states.at(-1)).toMatchObject({ id: r.ok ? r.sessionId : '', state: 'error', error: 'hostMissing' });
    expect(svc.ids()).toEqual([]);
  });
});

describe('SFTP IPC validation', () => {
  it('refuses relative or Windows remote paths, foreign ids and a local copy on a session', async () => {
    const f = setup();
    const h = createSftpHandlers(f.service);
    const r = await f.service.connect(HOST);
    const id = r.ok ? r.sessionId : '';
    expect(await h.list(id, 'etc')).toEqual({ ok: false, error: 'invalid' });
    expect(await h.list(id, 'C:\\x')).toEqual({ ok: false, error: 'invalid' });
    expect(await h.list('not-a-session', '/')).toEqual({ ok: false, error: 'invalid' });
    expect(await h.list(id, '/etc')).toEqual({ ok: true, value: true });
    expect(await h.delete(id, ['/a'], { files: -1, dirs: 0 })).toEqual({ ok: false, error: 'invalid' });
    const local = join(tmpdir(), 'x.txt');
    expect(await h.enqueue(id, { direction: 'local-copy', sources: [local], targetDir: tmpdir() })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.enqueue(null, { direction: 'upload', sources: [local], targetDir: '/home' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.enqueue(id, { direction: 'download', sources: ['/home/x'], targetDir: 'relative' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.enqueue(id, { direction: 'upload', sources: [local], targetDir: '/home', extra: 1 })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.enqueue(id, { direction: 'upload', sources: [local], targetDir: '/home' })).toEqual({ ok: true, value: true });
    expect(await h.connect('nope', undefined)).toEqual({ ok: false, error: 'unknown' });
    expect(await h.answer({ sessionId: id, promptId: '00000000-0000-4000-8000-000000000009', cancel: true })).toEqual({ ok: true });
    expect(await h.answer({ cellId: id, promptId: '00000000-0000-4000-8000-000000000009', cancel: true })).toEqual({ ok: false });
  });
});

describe('local files of the SFTP view', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-local-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const trashed: string[] = [];
  const files = () => createLocalFiles({ platform: process.platform, trash: async (p) => { trashed.push(p); rmSync(p, { recursive: true }); }, openFolder: async () => undefined, showFile: () => undefined, home: () => dir });

  it('lists any folder with size, time and kind; makes, renames (never over a file) and trashes', async () => {
    const lf = files();
    writeFileSync(join(dir, 'a.txt'), 'abc');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, '.hidden'), '');
    const r = await lf.list(dir);
    expect(r.ok).toBe(true);
    const entries = r.ok ? Object.fromEntries(r.value.entries.map((e) => [e.name, e])) : {};
    expect(entries['a.txt']).toMatchObject({ kind: 'file', size: 3, hidden: false, path: join(dir, 'a.txt') });
    expect(entries.sub).toMatchObject({ kind: 'dir', size: 0 });
    expect(entries['.hidden'].hidden).toBe(true);
    expect(entries['a.txt'].mtime).toBeGreaterThan(0);
    expect(await lf.list('relative')).toEqual({ ok: false, error: 'invalid' });
    expect(await lf.list(join(dir, 'a.txt'))).toEqual({ ok: false, error: 'notADirectory' });
    expect(await lf.mkdir(join(dir, 'new'))).toEqual({ ok: true, value: null });
    expect(await lf.mkdir(join(dir, 'new'))).toEqual({ ok: false, error: 'exists' });
    expect(await lf.mkdir(join(dir, 'x y'))).toEqual({ ok: false, error: 'invalid' });
    expect(await lf.rename(join(dir, 'a.txt'), join(dir, 'sub'))).toEqual({ ok: false, error: 'exists' });
    expect(await lf.rename(join(dir, 'a.txt'), join(dir, 'sub', 'moved.txt'))).toEqual({ ok: false, error: 'invalid' });
    expect(await lf.rename(join(dir, 'a.txt'), join(dir, 'b.txt'))).toEqual({ ok: true, value: null });
    expect(await lf.trash([join(dir, 'b.txt')])).toEqual({ ok: true, value: null });
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(await lf.trash([dir])).toEqual({ ok: false, error: 'invalid' }); // the home folder
    const roots = await lf.roots();
    expect(roots.home).toBe(dir);
    if (process.platform === 'win32') expect(roots.drives.length).toBeGreaterThan(0); else expect(roots.drives).toEqual([]);
  });
});
