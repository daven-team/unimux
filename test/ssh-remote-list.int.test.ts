// SshManager.list (1.0.6, SSH path completion) against the in-process test server's fake shell: the listing runs on an exec
// channel of the cell's own connection, with no second login, and knows the shell's folder and a running program.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SshManager, type SshEvents } from '../src/ptyhost/ssh';
import { startTestServer, type TestServer } from './helpers/sshServer';

let server: TestServer | null = null;
let manager: SshManager | null = null;
let root: string | null = null;
afterEach(async () => {
  await manager?.killAll();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  server = null; manager = null; root = null;
});

async function waitFor(cond: () => boolean, ms = 10000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function connected() {
  root = mkdtempSync(join(tmpdir(), 'unimux-list-'));
  mkdirSync(join(root, 'srv', 'ftp'), { recursive: true });
  mkdirSync(join(root, 'home', 'alice'), { recursive: true });
  for (let i = 1; i <= 10; i++) writeFileSync(join(root, 'home', 'alice', `TEST${i}`), '');
  server = await startTestServer({ password: 'pw', shellRoot: root, shellHome: '/home/alice' });
  let out = '';
  const keys: string[] = [];
  const phases: string[] = [];
  const events: SshEvents = {
    spawned: () => undefined, status: (_id, phase) => phases.push(phase),
    hostKey: (_id, promptId) => keys.push(promptId), authPrompt: () => undefined,
  };
  const m = (manager = new SshManager({ data: (_id, d) => { out += d; return true; }, exit: () => undefined }, events, { quietMs: 100, killGraceMs: 500 }));
  m.connect({ id: 'c1', host: '127.0.0.1', port: server.port, username: 'alice', cols: 100, rows: 30, allowPasswordPrompt: false, password: 'pw' });
  await waitFor(() => keys.length > 0);
  m.answerHostKey('c1', keys[0], true);
  await waitFor(() => phases.includes('connected') && out.includes('$ '));
  return { m, out: () => out, s: server };
}

describe('SshManager.list', () => {
  it('lists the shell\'s folder and absolute folders on the same connection', async () => {
    const { m, s } = await connected();
    const home = await m.list('c1', { dir: '', cwd: null });
    expect(home).toMatchObject({ ok: true, cwd: '/home/alice', truncated: false });
    expect(home.ok && home.entries.map((e) => e.name).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `TEST${i + 1}`).sort());
    expect(await m.list('c1', { dir: '/s', cwd: null })).toEqual({ ok: false, reason: 'nodir' });
    expect(await m.list('c1', { dir: '/srv/', cwd: null })).toMatchObject({ ok: true, entries: [{ name: 'ftp', dir: true }] });
    expect(await m.list('c1', { dir: '', cwd: '/srv', cwdOnly: true })).toEqual({ ok: true, cwd: '/srv', entries: [], truncated: false });
    expect(s.connections()).toBe(1);
  });

  it('follows the shell into a folder and says busy while a full-screen program runs', async () => {
    const { m, out } = await connected();
    m.write('c1', 'cd /srv\r');
    await waitFor(() => out().includes('alice@test-server:/srv$ '));
    expect(await m.list('c1', { dir: '', cwd: null, cwdOnly: true })).toMatchObject({ ok: true, cwd: '/srv' });
    m.write('c1', 'vim x\r');
    await waitFor(() => out().includes('fake vim'));
    expect(await m.list('c1', { dir: '', cwd: null })).toEqual({ ok: false, reason: 'busy' });
  });

  it('cancels a waiting request when a newer one comes and answers gone for an unknown cell', async () => {
    const { m } = await connected();
    const [a, b, c] = [m.list('c1', { dir: '/', cwd: null }), m.list('c1', { dir: '/srv/', cwd: null }), m.list('c1', { dir: '/home/', cwd: null })];
    expect((await a).ok).toBe(true);
    expect(await b).toEqual({ ok: false, reason: 'cancelled' });
    expect(await c).toMatchObject({ ok: true, entries: [{ name: 'alice', dir: true }] });
    expect(await m.list('nope', { dir: '/', cwd: null })).toEqual({ ok: false, reason: 'gone' });
  });
});
