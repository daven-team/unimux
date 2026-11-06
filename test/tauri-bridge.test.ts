// The window.mc bridge of the Tauri build (1.2.0, PLAN F4): the shared method table (src/preload/mcApi.ts) keeps the argument
// shaping of the Electron preload, and the Tauri transport keeps ipcRenderer's semantics (send order, sync unsubscribe,
// typed not-yet errors, optional event arguments, edits that survive a reload).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createMcApi, type McTransport } from '../src/preload/mcApi';
import { createTauriTransport, McNotYetError, type TauriDeps } from '../src/renderer/src/bridge/transport';
// @ts-expect-error plain JS module without types
import { buildContract, contractText, contractTs } from '../scripts/gen-ipc-contract.mjs';

type Call = { kind: 'invoke' | 'send'; channel: string; args: unknown[] };

function recordingApi() {
  const calls: Call[] = [];
  const transport: McTransport = {
    invoke: async (channel, ...args) => { calls.push({ kind: 'invoke', channel, args }); return null; },
    send: (channel, ...args) => { calls.push({ kind: 'send', channel, args }); },
    on: () => () => {},
    platform: 'win32',
    windowsBuild: 26200,
    pathForFile: () => '',
  };
  return { api: createMcApi(transport), calls };
}

describe('window.mc argument shaping (shared with the Electron preload)', () => {
  it('cuts reportError to 24 / 4000 / 8000 characters and keeps an absent stack absent', () => {
    const { api, calls } = recordingApi();
    api.reportError('k'.repeat(30), 'm'.repeat(5000), 's'.repeat(9000));
    api.reportError('boot', 'x');
    expect(calls[0]).toEqual({ kind: 'send', channel: 'app:reportError', args: ['k'.repeat(24), 'm'.repeat(4000), 's'.repeat(8000)] });
    expect(calls[1].args).toEqual(['boot', 'x', undefined]);
  });

  it('fills defaults and wraps arguments like the preload', async () => {
    const { api, calls } = recordingApi();
    await api.listProjectDirectory('p1');
    await api.ssh.draftFromFile('C:/k');
    await api.db.history.clear('c1', 'yes' as unknown as boolean);
    await api.db.sqlite.create(undefined);
    await api.detach.attach([], 'yes' as unknown as boolean);
    await api.getChangelog();
    await api.switchToBest('claude');
    await api.switchToBest('codex', 'a@b.c');
    await api.db.pg.ddl('s1', 'public', 't', 'table');
    await api.db.pg.ddl('s1', 'public', 'f', 'function', '(int)');
    await api.db.redis.subscribe('s1', { channels: ['a'] } as never);
    expect(calls.map((c) => [c.channel, c.args])).toEqual([
      ['fs:listProjectDirectory', ['p1', '']],
      ['ssh:key:draftFromFile', [{ path: 'C:/k' }]],
      ['db:history:clear', ['c1', false]],
      ['db:sqlite:create', [null]],
      ['detach:attach', [[], false]],
      ['changelog:get', [false]],
      ['accounts:switchBest', [{ provider: 'claude' }]],
      ['accounts:switchBest', [{ provider: 'codex', to: 'a@b.c' }]],
      ['db:pg', ['s1', { op: 'ddl', schema: 'public', name: 't', kind: 'table' }]],
      ['db:pg', ['s1', { op: 'ddl', schema: 'public', name: 'f', kind: 'function', args: '(int)' }]],
      ['db:redis', ['s1', { kind: 'subscribe', channels: ['a'] }]],
    ]);
  });
});

function fakeDeps(over: Partial<TauriDeps> = {}) {
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
  const store = new Map<string, string>();
  const logs: string[] = [];
  const deps: TauriDeps = {
    invoke: async (command, args) => { invocations.push({ command, args }); return null; },
    listen: async () => () => {},
    log: (m) => logs.push(m),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    newSession: () => 'session-1',
    ...over,
  };
  return { deps, invocations, store, logs };
}

const boot = { platform: 'win32' as const, windowsBuild: 26200, label: 'main' };

describe('Tauri transport', () => {
  it('numbers 1,000 sends in call order within one page session', () => {
    const { deps, invocations } = fakeDeps();
    const t = createTauriTransport(boot, deps);
    for (let i = 0; i < 1000; i++) t.send(i % 2 ? 'cell:kill' : 'detach:focus', `id-${i}`);
    expect(invocations).toHaveLength(1000);
    expect(invocations.map((x) => x.args.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    expect(new Set(invocations.map((x) => x.args.session))).toEqual(new Set(['session-1']));
    expect(invocations[3]).toEqual({ command: 'mc_send', args: { session: 'session-1', seq: 4, cmd: 'cell:kill', args: ['id-3'] } });
  });

  it('rejects an unported invoke with McNotYetError and logs an unported send once', async () => {
    const { deps, logs } = fakeDeps({ invoke: async (command, args) => { throw { code: 'MC_NOT_YET', message: `${String(args.cmd)} is not available yet in this build`, command: args.cmd }; } });
    const t = createTauriTransport(boot, deps);
    const error = await t.invoke('git:probe', 'p1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McNotYetError);
    expect(error).toMatchObject({ code: 'MC_NOT_YET', command: 'git:probe', name: 'McNotYetError' });
    t.send('cell:kill', 'a');
    t.send('cell:kill', 'b');
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toEqual(['window.mc send cell:kill: not available yet']);
  });

  it('turns other Rust errors into plain errors with the message', async () => {
    const { deps } = fakeDeps({ invoke: async () => { throw { code: 'MC_FAILED', message: 'disk full', command: 'state:edit' }; } });
    const error = await createTauriTransport(boot, deps).invoke('state:edit', { id: 'e' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(McNotYetError);
    expect((error as Error).message).toBe('disk full');
  });

  it('sends undefined arguments as null (JSON) and gives Uint8Array answers back as bytes', async () => {
    const { deps, invocations } = fakeDeps({ invoke: async (command, args) => { invocations.push({ command, args }); return new Uint8Array([1, 2]).buffer; } });
    const result = await createTauriTransport(boot, deps).invoke('sound:load', 'done', undefined);
    expect(invocations[0]).toEqual({ command: 'mc_invoke', args: { cmd: 'sound:load', args: ['done', null] } });
    expect(result).toEqual(new Uint8Array([1, 2]));
  });

  it('unsubscribes synchronously, also before listen() resolved', async () => {
    let resolveListen!: (stop: () => void) => void;
    const stop = vi.fn();
    let deliver!: (payload: unknown) => void;
    const { deps } = fakeDeps({ listen: (_e, cb) => { deliver = cb; return new Promise((r) => { resolveListen = r; }); } });
    const cb = vi.fn();
    const off = createTauriTransport(boot, deps).on('cli:changed', cb);
    off();
    deliver([{}]);
    resolveListen(stop);
    await new Promise((r) => setTimeout(r, 0));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('spreads the positional arguments and turns null into undefined where api.d.ts marks them optional', async () => {
    let deliver!: (payload: unknown) => void;
    const { deps } = fakeDeps({ listen: async (_e, cb) => { deliver = cb; return () => {}; } });
    const cb = vi.fn();
    createTauriTransport(boot, deps).on('cell:hook', cb);
    await new Promise((r) => setTimeout(r, 0));
    deliver(['c1', 'stop', null]);
    deliver(['c1', 'notify', { text: 'x' }]);
    expect(cb.mock.calls).toEqual([['c1', 'stop', undefined], ['c1', 'notify', { text: 'x' }]]);
  });

  it('keeps a state:edit sent right before a reload and replays it on the next page', async () => {
    // First page: the edit goes out, the page unloads before the answer.
    const pending: Array<() => void> = [];
    const first = fakeDeps({ invoke: (command, args) => new Promise((r) => { first.invocations.push({ command, args }); pending.push(() => r({ revision: 1 })); }) });
    const t1 = createTauriTransport(boot, first.deps);
    void t1.invoke('state:edit', { id: 'edit-1', base: { a: 1 }, next: { a: 2 } });
    expect(JSON.parse(first.store.get('mc:journal')!)).toHaveProperty(['state:edit:edit-1']);
    // Second page (same sessionStorage): the edit is sent again; Rust acknowledges a known edit id without applying it twice.
    const second = fakeDeps({ storage: first.deps.storage, newSession: () => 'session-2' });
    await createTauriTransport(boot, second.deps).replayJournal();
    expect(second.invocations).toEqual([{ command: 'mc_invoke', args: { cmd: 'state:edit', args: [{ id: 'edit-1', base: { a: 1 }, next: { a: 2 } }] } }]);
    expect(first.store.get('mc:journal')).toBe('{}');
    // An answered edit leaves nothing behind.
    pending[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(first.store.get('mc:journal')).toBe('{}');
  });
});

describe('generated IPC contract', () => {
  it('has the size of the 1.1.4 api.d.ts and matches the committed files (drift check)', () => {
    const contract = buildContract();
    expect(contract.summary).toMatchObject({ methods: 248, invokeMethods: 207, sendMethods: 38, syncMembers: 3, channels: 215, invokeChannels: 177, sendChannels: 38, events: 44 });
    expect(readFileSync('src-tauri/gen/ipc-contract.json', 'utf8')).toBe(contractText(contract));
    expect(readFileSync('src/renderer/src/bridge/contract.gen.ts', 'utf8')).toBe(contractTs(contract));
  });

  it('a method removed by hand from the committed contract is detected', () => {
    const contract = buildContract();
    const edited = JSON.parse(contractText(contract));
    edited.methods = edited.methods.filter((m: { path: string }) => m.path !== 'git.status');
    expect(contractText(edited)).not.toBe(contractText(contract));
  });

  it('describes the multiplexed channels and the update splash contract', () => {
    const contract = buildContract();
    expect(contract.channels['db:pg'].methods).toHaveLength(14);
    expect(contract.channels['db:redis'].methods).toHaveLength(18);
    expect(contract.updateSplash.map((c: { channel: string }) => c.channel)).toEqual(['update-splash:init', 'update-splash:state', 'update-splash:close', 'update-splash:open']);
  });
});
