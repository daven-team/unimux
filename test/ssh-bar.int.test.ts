// SshManager.stats (1.0.7, the SSH status bar) against the in-process test server: the script runs on an exec channel of the
// cell's own connection (no second login), one run at a time, and a server without sh answers nothing usable.
import { afterEach, describe, expect, it } from 'vitest';
import { SshManager, type SshEvents } from '../src/ptyhost/ssh';
import { advanceBar, parseBar } from '../src/shared/sshBar';
import { startTestServer, type TestServer } from './helpers/sshServer';

let server: TestServer | null = null;
let manager: SshManager | null = null;
afterEach(async () => {
  await manager?.killAll();
  await server?.close();
  server = null; manager = null;
});

async function waitFor(cond: () => boolean, ms = 10000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function connected(bar: 'debian' | 'windows') {
  server = await startTestServer({ password: 'pw', bar });
  const keys: string[] = [];
  const phases: string[] = [];
  const events: SshEvents = {
    spawned: () => undefined, status: (_id, phase) => phases.push(phase),
    hostKey: (_id, promptId) => keys.push(promptId), authPrompt: () => undefined,
  };
  const m = (manager = new SshManager({ data: () => true, exit: () => undefined }, events, { quietMs: 100, killGraceMs: 500 }));
  m.connect({ id: 'c1', host: '127.0.0.1', port: server.port, username: 'alice', cols: 100, rows: 30, allowPasswordPrompt: false, password: 'pw' });
  await waitFor(() => keys.length > 0);
  m.answerHostKey('c1', keys[0], true);
  await waitFor(() => phases.includes('connected'));
  return { m, s: server };
}

describe('SshManager.stats', () => {
  it('runs the bar script on the same connection and reports the round trip and bytes', async () => {
    const { m, s } = await connected('debian');
    const first = await m.stats('c1', true);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.partial).toBe(false);
    expect(first.bytes).toBe(Buffer.byteLength(first.text));
    expect(first.ms).toBeGreaterThanOrEqual(0);
    const a = parseBar(first.text)!;
    expect(a).toMatchObject({ host: 'srv36', os: { id: 'debian' }, user: 'root', complete: true });
    const second = await m.stats('c1', false);
    const b = parseBar(second.ok ? second.text : '')!;
    expect(b.os).toBeUndefined();
    const track = advanceBar(advanceBar(null, a, 0), b, 3000);
    expect(track.cpuPercent).toBeGreaterThan(0);
    expect(track.rx).toBeGreaterThan(0);
    expect(track.os).toEqual({ id: 'debian', name: 'Debian GNU/Linux 12 (bookworm)' });
    expect(s.connections()).toBe(1);
    expect(s.sftp.barRuns).toHaveLength(2);
  });

  it('answers busy while a run is on its way, gone for an unknown cell', async () => {
    const { m } = await connected('debian');
    const [a, b] = [m.stats('c1', true), m.stats('c1', false)];
    expect(await b).toEqual({ ok: false, reason: 'busy' });
    expect((await a).ok).toBe(true);
    expect(await m.stats('nope', false)).toEqual({ ok: false, reason: 'gone' });
  });

  it('gets nothing parseable from a server without sh', async () => {
    const { m } = await connected('windows');
    const run = await m.stats('c1', true);
    expect(run.ok && parseBar(run.text)).toBe(null);
  });
});
