// SshManager against a real in-process ssh2 server on 127.0.0.1 (no other network). Fake sink and events stand in for main and the renderer.
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ssh2 from 'ssh2';
import { SshManager, type SshEvents, type SshTimers } from '../src/ptyhost/ssh';
import type { SshConnectRequest } from '../src/shared/ipc';
import type { SshErrorCode, SshPhase } from '../src/shared/ssh';
import { startTestServer, type TestServer } from './helpers/sshServer';
import { readableKeyPair } from './helpers/sshKeys';

const FAST: Partial<SshTimers> = { quietMs: 100, startupMaxMs: 2000, killGraceMs: 500 };
let servers: TestServer[] = [];
let managers: SshManager[] = [];
afterEach(async () => {
  await Promise.all(managers.map((m) => m.killAll()));
  await Promise.all(servers.map((s) => s.close()));
  servers = []; managers = [];
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}) { const s = await startTestServer(opts); servers.push(s); return s; }

async function waitFor(cond: () => boolean, ms = 10000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function harness(timers: Partial<SshTimers> = {}, deliver = true) {
  const out = new Map<string, string>();
  const exits = new Map<string, number>();
  const statuses: Array<{ id: string; phase: SshPhase; error?: SshErrorCode; exitCode?: number; banner?: string }> = [];
  const hostKeys: Array<{ id: string; promptId: string; key: string }> = [];
  const prompts: Array<{ id: string; promptId: string; kind: string; retry: boolean; name?: string; fields: Array<{ text: string; echo: boolean }> }> = [];
  const events: SshEvents = {
    spawned: () => undefined,
    status: (id, phase, extra) => statuses.push({ id, phase, ...extra }),
    hostKey: (id, promptId, key) => hostKeys.push({ id, promptId, key }),
    authPrompt: (id, promptId, p) => prompts.push({ id, promptId, ...p }),
  };
  const m = new SshManager({ data: (id, d) => { out.set(id, (out.get(id) ?? '') + d); return deliver; }, exit: (id, code) => exits.set(id, code) }, events, { ...FAST, ...timers });
  managers.push(m);
  const trust = async (id = 'c1') => {
    await waitFor(() => hostKeys.some((k) => k.id === id));
    m.answerHostKey(id, hostKeys.find((k) => k.id === id)!.promptId, true);
  };
  const phases = (id = 'c1') => statuses.filter((s) => s.id === id && !s.banner).map((s) => s.phase);
  return { m, out, exits, statuses, hostKeys, prompts, trust, phases };
}

const req = (port: number, extra: Partial<SshConnectRequest> = {}): SshConnectRequest =>
  ({ id: 'c1', host: '127.0.0.1', port, username: 'alice', cols: 100, rows: 30, allowPasswordPrompt: true, ...extra });

describe('SshManager', () => {
  it('signs in with a saved password, sends the cell size and reports the phases', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    expect(h.hostKeys[0].key).toBe(s.hostKeyBlob.toString('base64'));
    await waitFor(() => (h.out.get('c1') ?? '').includes('Welcome'));
    expect(h.phases()).toEqual(['connecting', 'verifying', 'authenticating', 'connected']);
    expect(s.ptys).toEqual([{ term: 'xterm-256color', cols: 100, rows: 30 }]);
  });

  it('asks for a password three times, marks retries and fails with auth', async () => {
    const s = await server({ password: 'right' });
    const h = harness();
    h.m.connect(req(s.port));
    await h.trust();
    for (let i = 1; i <= 3; i++) {
      await waitFor(() => h.prompts.length === i);
      h.m.answerAuth('c1', h.prompts[i - 1].promptId, ['wrong']);
    }
    await waitFor(() => h.exits.has('c1'));
    expect(h.prompts.map((p) => [p.kind, p.retry])).toEqual([['password', false], ['password', true], ['password', true]]);
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'error', error: 'auth' });
    expect(h.exits.get('c1')).toBe(-1);
  });

  it('a cancelled password prompt ends with cancelled', async () => {
    const s = await server({ password: 'right' });
    const h = harness();
    h.m.connect(req(s.port));
    await h.trust();
    await waitFor(() => h.prompts.length === 1);
    h.m.answerAuth('c1', h.prompts[0].promptId, null);
    await waitFor(() => h.exits.has('c1'));
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'error', error: 'cancelled' });
  });

  it('signs in with a public key, also an encrypted one', async () => {
    const pair = readableKeyPair('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr', rounds: 16 });
    const s = await server({ publicKey: pair.public });
    const h = harness();
    h.m.connect(req(s.port, { privateKey: pair.private, passphrase: 'secret', allowPasswordPrompt: false }));
    await h.trust();
    await waitFor(() => h.phases().includes('connected'));
    expect(h.prompts).toEqual([]);
  });

  it('falls through to the saved password when the key cannot sign (W4)', async () => {
    const pair = readableKeyPair('ed25519');
    const s = await server({ publicKey: pair.public, password: 'pw' });
    const h = harness();
    const key = ssh2.utils.parseKey(pair.private);
    if (key instanceof Error || Array.isArray(key)) throw new Error('key');
    // ssh2 accepts an already parsed key; this one fails to sign like a refusing agent or an unsupported hash.
    (key as unknown as { sign: () => Error }).sign = () => new Error('agent refused');
    h.m.connect(req(s.port, { privateKey: key as unknown as string, password: 'pw', allowPasswordPrompt: false }));
    await h.trust();
    await waitFor(() => h.phases().includes('connected') || h.exits.has('c1'));
    expect(h.phases()).toEqual(['connecting', 'verifying', 'authenticating', 'connected']);
    expect(h.statuses.some((x) => x.phase === 'error')).toBe(false);
  });

  it('forwards keyboard-interactive prompts and signs in with the answer', async () => {
    const s = await server({ keyboardCode: '42' });
    const h = harness();
    h.m.connect(req(s.port));
    await h.trust();
    await waitFor(() => h.prompts.length === 1);
    expect(h.prompts[0]).toMatchObject({ kind: 'keyboard', name: 'Second factor', fields: [{ text: 'Code: ', echo: true }], retry: false });
    h.m.answerAuth('c1', h.prompts[0].promptId, ['42']);
    await waitFor(() => h.phases().includes('connected'));
  });

  it('a rejected host key ends with the code main chose', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await waitFor(() => h.hostKeys.length === 1);
    h.m.answerHostKey('c1', h.hostKeys[0].promptId, false, 'hostKeyChanged');
    await waitFor(() => h.exits.has('c1'));
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'error', error: 'hostKeyChanged' });
    expect(h.phases()).not.toContain('authenticating');
  });

  it('resizes the remote window', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => h.phases().includes('connected'));
    h.m.resize('c1', 120, 40);
    await waitFor(() => s.windowChanges.length === 1);
    expect(s.windowChanges[0]).toEqual({ cols: 120, rows: 40 });
  });

  // Task L (0.9.9): like OpenSSH's client for an interactive session, keystrokes are not held back by Nagle's algorithm.
  it('turns Nagle off on the session socket', async () => {
    const spy = vi.spyOn(ssh2.Client.prototype, 'setNoDelay');
    try {
      const s = await server({ password: 'pw' });
      const h = harness();
      h.m.connect(req(s.port, { password: 'pw' }));
      expect(spy).toHaveBeenCalledWith(true);
      const sock = (spy.mock.contexts[0] as unknown as { _sock: object })._sock;
      const flag = Object.getOwnPropertySymbols(sock).find((k) => k.description === 'kSetNoDelay');
      if (flag) expect((sock as Record<symbol, unknown>)[flag]).toBe(true);
      await h.trust();
      await waitFor(() => h.phases().includes('connected'));
    } finally { spy.mockRestore(); }
  });

  // Task L (0.9.9): an echo used to wait for the 4 ms coalescing timer, which Windows rounds up to its timer tick (15.6 ms).
  // With setTimeout frozen the echo must still arrive: it may only wait for the end of the event-loop turn.
  it('delivers the echo of a typed character without waiting for a coalescing timer', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('$ '));
    await new Promise((r) => setTimeout(r, 200));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const ch of 'abc') {
        const before = h.out.get('c1') ?? '';
        h.m.write('c1', ch);
        const t0 = Date.now();
        while ((h.out.get('c1') ?? '') === before && Date.now() - t0 < 2000) await new Promise((r) => setImmediate(r));
        expect((h.out.get('c1') ?? '').slice(before.length)).toBe(ch);
      }
    } finally { vi.useRealTimers(); }
  });

  // 1.0.1: ssh2 writes a packet to the socket in pieces (AES-GCM: length, payload, tag); with Nagle off each piece was a TCP
  // segment of its own, three per keystroke. Corked, a keystroke is one write.
  it('sends each keystroke to the socket as one write', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('$ '));
    await new Promise((r) => setTimeout(r, 200));
    const sock = (h.m as unknown as { sessions: Map<string, { client: { _sock: { _writeGeneric: (...a: unknown[]) => unknown } } }> }).sessions.get('c1')!.client._sock;
    const writes = vi.spyOn(sock, '_writeGeneric');
    for (const ch of 'xyz') {
      const before = h.out.get('c1') ?? '';
      h.m.write('c1', ch);
      await waitFor(() => (h.out.get('c1') ?? '') !== before);
    }
    expect(writes).toHaveBeenCalledTimes(3);
    expect(s.input.join('')).toBe('xyz');
  });

  it('types the startup command once, after the greeting and a quiet period', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw', startup: 'echo one\recho two\r' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('two\r\n$ '));
    await new Promise((r) => setTimeout(r, 400));
    expect(s.input.join('')).toBe('echo one\recho two\r');
    expect((h.out.get('c1') ?? '').indexOf('Welcome')).toBeLessThan((h.out.get('c1') ?? '').indexOf('one'));
  });

  it('decodes UTF-8 characters split across packets', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('$ '));
    const bytes = Buffer.from('zażółć 🙂', 'utf8');
    s.write(bytes.subarray(0, 3));
    await new Promise((r) => setTimeout(r, 30));
    s.write(bytes.subarray(3, 12));
    await new Promise((r) => setTimeout(r, 30));
    s.write(bytes.subarray(12));
    await waitFor(() => (h.out.get('c1') ?? '').includes('zażółć 🙂'));
    expect(h.out.get('c1')).not.toContain('�');
  });

  it('back-pressures the server while the renderer does not acknowledge, and delivers everything after acks', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.setFlowControl(true);
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('$ '));
    const base = (h.out.get('c1') ?? '').length;
    h.m.ack('c1', base);
    // ssh2 buffers about 2 MiB in the channel window, 2 MiB readable and 2 MiB on the server's writable side, so the flood
    // must be far larger than that to make the server block (preflight H3). Both waits stay below PAUSE_WATCHDOG_MS.
    const total = 24 * 1024 * 1024;
    const flood = s.flood(total);
    await new Promise((r) => setTimeout(r, 1000));
    const stalled = flood.sent();
    await new Promise((r) => setTimeout(r, 500));
    expect(flood.sent()).toBe(stalled);
    expect(stalled).toBeLessThan(total);
    let acked = base;
    const timer = setInterval(() => { const now = (h.out.get('c1') ?? '').length; h.m.ack('c1', now - acked); acked = now; }, 20);
    try {
      await flood.done;
      await waitFor(() => (h.out.get('c1') ?? '').length >= base + total, 20000);
    } finally { clearInterval(timer); }
    expect((h.out.get('c1') ?? '').length).toBe(base + total);
  });

  it('kill closes the server side and resolves', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => h.phases().includes('connected'));
    await h.m.kill('c1');
    expect(h.m.has('c1')).toBe(false);
    await waitFor(() => s.connections() === 0);
    expect(h.exits.has('c1')).toBe(false);
  });

  it('kill during the host key prompt leaves no session and no late events (Review Focus 1)', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await waitFor(() => h.hostKeys.length === 1);
    const before = h.statuses.length;
    const t0 = Date.now();
    await h.m.kill('c1');
    expect(Date.now() - t0).toBeLessThan(2000);
    h.m.answerHostKey('c1', h.hostKeys[0].promptId, true);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.statuses.slice(before)).toEqual([]);
    expect(h.m.has('c1')).toBe(false);
  });

  it('reports the remote exit status', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('$ '));
    h.m.write('c1', 'exit\r');
    await waitFor(() => h.exits.has('c1'));
    expect(h.exits.get('c1')).toBe(3);
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'closed', exitCode: 3 });
  });

  it('a remote exit stays a clean close when the server answers the disconnect with a reset (I3)', async () => {
    const s = await server({ password: 'pw', onExit: 'reset' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('$ '));
    h.m.write('c1', 'exit\r');
    await waitFor(() => h.exits.has('c1'));
    expect(h.exits.get('c1')).toBe(3);
    expect(h.statuses.at(-1)).toEqual({ id: 'c1', phase: 'closed', exitCode: 3 });
  });

  it('delivers the tail of back-pressured output when the server exits and hangs up (M2)', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.setFlowControl(true);
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => (h.out.get('c1') ?? '').includes('$ '));
    h.m.ack('c1', (h.out.get('c1') ?? '').length);
    // No acks from here on: the channel pauses after HIGH_WATER and the rest waits in ssh2's buffers when the server hangs up.
    h.m.write('c1', 'tail 1800000\r');
    await waitFor(() => h.exits.has('c1'));
    expect(h.out.get('c1') ?? '').toContain('TAIL-END');
    expect(h.statuses.at(-1)).toEqual({ id: 'c1', phase: 'closed', exitCode: 0 });
  });

  it('a dropped connection ends as reset with exit -1, never as a clean close (Review Focus 4)', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => h.phases().includes('connected'));
    s.dropConnections();
    await waitFor(() => h.exits.has('c1'));
    expect(h.exits.get('c1')).toBe(-1);
    expect(h.statuses.at(-1)).toMatchObject({ phase: 'error', error: 'reset' });
  });

  it('maps a refused port and an unknown host', async () => {
    const free = await new Promise<number>((resolve) => { const t = createServer().listen(0, '127.0.0.1', () => { const p = (t.address() as { port: number }).port; t.close(() => resolve(p)); }); });
    const h = harness();
    h.m.connect(req(free, { id: 'r' }));
    h.m.connect(req(22, { id: 'd', host: 'nohost.invalid' }));
    await waitFor(() => h.exits.has('r') && h.exits.has('d'), 15000);
    expect(h.statuses.filter((x) => x.id === 'r').at(-1)).toMatchObject({ phase: 'error', error: 'refused' });
    expect(h.statuses.filter((x) => x.id === 'd').at(-1)).toMatchObject({ phase: 'error', error: 'dns' });
  });

  it('times out a server that accepts TCP but never speaks SSH', async () => {
    // Reads and discards the client's ident (so it notices the close and mute.close() can finish) but never answers.
    const mute = createServer((socket) => { socket.on('error', () => undefined); socket.resume(); });
    await new Promise<void>((r) => mute.listen(0, '127.0.0.1', () => r()));
    try {
      const h = harness({ connectMs: 300 });
      h.m.connect(req((mute.address() as { port: number }).port));
      await waitFor(() => h.exits.has('c1'));
      expect(h.statuses.at(-1)).toMatchObject({ phase: 'error', error: 'timeout' });
    } finally { await new Promise((r) => mute.close(r)); }
  });

  it('sanitizes the pre-auth banner (Review Focus 5)', async () => {
    const s = await server({ password: 'pw', banner: `Hello\u001b[31m world\u0007 ${'x'.repeat(4000)}` });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    await h.trust();
    await waitFor(() => h.statuses.some((x) => x.banner));
    const banner = h.statuses.find((x) => x.banner)!.banner!;
    expect(banner.startsWith('Hello world ')).toBe(true);
    expect(banner).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(banner.length).toBeLessThanOrEqual(2048);
  });

  it('a second connect for the same id replaces the first session', async () => {
    const s = await server({ password: 'pw' });
    const h = harness();
    h.m.connect(req(s.port, { password: 'pw' }));
    h.m.connect(req(s.port, { password: 'pw' }));
    await waitFor(() => h.hostKeys.length >= 1);
    await h.trust();
    await waitFor(() => h.phases().includes('connected'));
    await waitFor(() => s.connections() === 1);
  });
});
