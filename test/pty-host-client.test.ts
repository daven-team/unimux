// PtyHostClient across a Pty Host crash: messages sent while no host runs reach the new one (the renderer respawns its cells at once).
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  posted: unknown[] = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  postMessage(m: unknown) { this.posted.push(m); }
  kill() { this.killed = true; }
}
const forks = vi.hoisted(() => ({ children: [] as unknown[], options: [] as unknown[] }));
vi.mock('electron', () => ({
  utilityProcess: {
    fork: (_path: string, _args: string[], options: unknown) => { const child = new FakeChild(); forks.children.push(child); forks.options.push(options); return child; },
  },
  MessageChannelMain: class { port1 = { name: 'p1' }; port2 = { name: 'p2' }; },
}));

const { PtyHostClient, RESTART_QUEUE_LIMIT } = await import('../src/main/ptyHostClient');
const children = () => forks.children as FakeChild[];
const spawnReq = (id: string) => ({ id, cwd: '.', cols: 80, rows: 24, env: {}, shell: 'powershell' as const });
const renderer = () => ({ isDestroyed: () => false, postMessage: vi.fn() });

beforeEach(() => { vi.useFakeTimers(); forks.children.length = 0; forks.options.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('PtyHostClient stdio', () => {
  it('gives the host its own pipes instead of the parent stdout handle', () => {
    // With one stream piped, Electron on Windows hands the parent's other std handles to the child unchecked; an app started
    // from a shortcut or the installer has no stdout, and launching the host with that null handle kills the app (0x80000003).
    const client = new PtyHostClient();
    client.start();
    expect((forks.options[0] as { stdio: unknown }).stdio).toEqual(['ignore', 'pipe', 'pipe']);
    // The host's stdout is drained, so a host that prints a lot never blocks on a full pipe.
    expect(children()[0].stdout.listenerCount('data')).toBe(1);
  });
});

describe('PtyHostClient restart', () => {
  it('queues spawns sent between a crash and the restart and delivers them after the renderer port', () => {
    const client = new PtyHostClient();
    const crashed = vi.fn();
    client.on('crashed', crashed);
    client.start();
    const wc = renderer();
    client.connectRenderer(wc as never);
    children()[0].stderr.emit('data', 'native assertion remove_pty_baton');
    children()[0].emit('exit', 3);
    expect(crashed).toHaveBeenCalledWith(3, 'native assertion remove_pty_baton');
    // The renderer respawns its visible cells right away, before the new host exists.
    client.spawn(spawnReq('a'));
    client.kill('old');
    client.spawn(spawnReq('b'));
    expect(children()).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(children()).toHaveLength(2);
    expect(children()[1].posted.map((m) => (m as { t: string; req?: { id: string }; id?: string }))).toEqual([
      { t: 'port' },
      { t: 'spawn', req: spawnReq('a') },
      { t: 'kill', id: 'old' },
      { t: 'spawn', req: spawnReq('b') },
    ]);
    expect(wc.postMessage).toHaveBeenCalledTimes(2);
    // After the restart messages go straight to the new host.
    client.spawn(spawnReq('c'));
    expect(children()[1].posted.at(-1)).toEqual({ t: 'spawn', req: spawnReq('c') });
  });

  it('keeps at most RESTART_QUEUE_LIMIT messages', () => {
    const client = new PtyHostClient();
    client.on('crashed', () => {});
    client.start();
    children()[0].emit('exit', 1);
    for (let i = 0; i < RESTART_QUEUE_LIMIT + 10; i++) client.kill(`k${i}`);
    vi.advanceTimersByTime(500);
    expect(children()[1].posted).toHaveLength(RESTART_QUEUE_LIMIT);
  });

  it('queues nothing once fatal and starts again only when asked, with a fresh crash count', () => {
    const client = new PtyHostClient();
    const fatal = vi.fn();
    client.on('crashed', () => {});
    client.on('fatal', fatal);
    client.start();
    for (let n = 0; n < 6; n++) {
      children().at(-1)!.emit('exit', 1);
      vi.advanceTimersByTime(500 * 2 ** n);
    }
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(client.isFatal()).toBe(true);
    const count = children().length;
    client.spawn(spawnReq('x'));
    vi.advanceTimersByTime(120_000);
    expect(children()).toHaveLength(count);
    client.restartAfterFatal();
    expect(client.isFatal()).toBe(false);
    expect(children()).toHaveLength(count + 1);
    expect(children().at(-1)!.posted).toEqual([]);
    // One crash after the restart is an ordinary restart again.
    children().at(-1)!.emit('exit', 1);
    vi.advanceTimersByTime(500);
    expect(children()).toHaveLength(count + 2);
  });

  it('drops queued messages on shutdown', async () => {
    const client = new PtyHostClient();
    client.on('crashed', () => {});
    client.start();
    children()[0].emit('exit', 1);
    client.spawn(spawnReq('a'));
    await client.shutdown();
    vi.advanceTimersByTime(10_000);
    expect(children()).toHaveLength(1);
  });
});
