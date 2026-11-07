// The dual-host helper itself (test/helpers/nodeHost.ts, PLAN B1): target selection and the JSON-lines client, driven by a
// tiny Node stand-in for unimux-hostd so it runs without a Rust build.
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { HostdClient, hostdPath, hostTargets } from './helpers/nodeHost';

describe('hostTargets', () => {
  it('runs node only unless a hostd binary is named', () => {
    expect(hostTargets({})).toEqual(['node']);
    expect(hostTargets({ UNIMUX_HOSTD: '/x/unimux-hostd' })).toEqual(['node', 'rust']);
  });

  it('takes an explicit list, deduplicated, and refuses unknown hosts', () => {
    expect(hostTargets({ UNIMUX_HOST_TARGETS: 'rust' })).toEqual(['rust']);
    expect(hostTargets({ UNIMUX_HOST_TARGETS: ' rust , node,rust' })).toEqual(['rust', 'node']);
    expect(() => hostTargets({ UNIMUX_HOST_TARGETS: 'node,python' })).toThrow(/unknown host python/);
  });

  it('finds the debug build in CARGO_TARGET_DIR or src-tauri/target', () => {
    const exe = process.platform === 'win32' ? 'unimux-hostd.exe' : 'unimux-hostd';
    const ct = resolve('scratch-target');
    expect(hostdPath({ CARGO_TARGET_DIR: ct })).toBe(join(ct, 'debug', exe));
    expect(hostdPath({ UNIMUX_HOSTD: 'x/hostd', CARGO_TARGET_DIR: ct })).toBe(resolve('x/hostd'));
    expect(hostdPath({}).endsWith(join('src-tauri', 'target', 'debug', exe))).toBe(true);
  });
});

// Answers ping, echoes args, emits an event before answering `emit`, answers `slow` after `fast`, never answers `hang`.
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const { id, op, args } = JSON.parse(line);
  if (op === 'ping') send({ id, ok: true, result: 'pong' });
  else if (op === 'echo') send({ id, ok: true, result: args });
  else if (op === 'emit') { send({ event: 'thing', args: { n: 1 } }); process.stdout.write('not json\\n'); send({ id, ok: true, result: null }); }
  else if (op === 'slow') setTimeout(() => send({ id, ok: true, result: 'slow' }), 50);
  else if (op === 'fast') send({ id, ok: true, result: 'fast' });
  else if (op === 'hang') {}
  else if (op === 'unreadable') send({ id: null, ok: false, error: 'bad request: no op' });
  else send({ id, ok: false, error: 'unknown op ' + op });
});
rl.on('close', () => process.exit(0));
`;

function fake(): HostdClient {
  return HostdClient.attach(spawn(process.execPath, ['-e', FAKE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }), 'fake');
}

describe('HostdClient', () => {
  it('matches answers to requests by id, in any order, and passes events', async () => {
    const h = fake();
    const events: unknown[] = [];
    const off = h.on('thing', (a) => events.push(a));
    expect(await h.request('ping')).toBe('pong');
    expect(await h.request('echo', { a: [1, 'ż'] })).toEqual({ a: [1, 'ż'] });
    const [slow, fast] = await Promise.all([h.request('slow'), h.request('fast')]);
    expect([slow, fast]).toEqual(['slow', 'fast']);
    await h.request('emit');
    expect(events).toEqual([{ n: 1 }]);
    off();
    await h.request('emit');
    expect(events).toHaveLength(1);
    await expect(h.request('nope')).rejects.toThrow('fake nope: unknown op nope');
    await h.close();
    expect(await h.exited).toBe(0);
  });

  it('fails pending and later requests once the host is gone', async () => {
    const h = fake();
    const hanging = h.request('hang');
    await h.close();
    await expect(hanging).rejects.toThrow(/fake exited/);
    await expect(h.request('ping')).rejects.toThrow(/fake exited/);
  });

  it('refuses requests once close() started instead of writing after the end of stdin', async () => {
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const h = fake();
      expect(await h.request('ping')).toBe('pong');
      const closing = h.close();
      await expect(h.request('ping')).rejects.toThrow(/fake ping: the host is closing/);
      await closing;
      await expect(h.request('ping')).rejects.toThrow(/fake exited/);
      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('fails the pending requests on an answer without an id, so none hangs', async () => {
    const h = fake();
    const hanging = h.request('hang');
    await expect(h.request('unreadable')).rejects.toThrow('fake: bad request: no op');
    await expect(hanging).rejects.toThrow('fake: bad request: no op');
    expect(await h.request('ping')).toBe('pong');
    await h.close();
  });

  it('says how to build the binary when it is missing', () => {
    expect(() => HostdClient.start({ path: join(process.cwd(), 'no-such-hostd') })).toThrow(/npm run test:hostd/);
  });
});
