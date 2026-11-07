// The window.mc bridge of the Tauri build (1.2.0, PLAN F4): the shared method table (src/preload/mcApi.ts) keeps the argument
// shaping of the Electron preload, and the Tauri transport keeps ipcRenderer's semantics (send order, sync unsubscribe,
// typed not-yet errors, optional event arguments, edits that survive a reload).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createMcApi, type McTransport } from '../src/preload/mcApi';
import { createPortPoster, createTauriTransport, McNotYetError, type TauriDeps } from '../src/renderer/src/bridge/transport';
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
    pathsForFiles: async (files) => files.map(() => ''),
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
    invoke: async (command, args) => { invocations.push({ command, args: args as Record<string, unknown> }); return null; },
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
    const { deps, logs } = fakeDeps({ invoke: async (_command, args) => { const cmd = (args as Record<string, unknown>).cmd; throw { code: 'MC_NOT_YET', message: `${String(cmd)} is not available yet in this build`, command: cmd }; } });
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
    const { deps, invocations } = fakeDeps({ invoke: async (command, args) => { invocations.push({ command, args: args as Record<string, unknown> }); return new Uint8Array([1, 2]).buffer; } });
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

  it('replaces lone surrogates (values and keys) before the call, so serde_json does not refuse a whole state:edit', async () => {
    const { deps, invocations } = fakeDeps();
    const ok = { name: 'fine 😀', list: ['a'] };
    await createTauriTransport(boot, deps).invoke('state:edit', { id: 'e', next: { name: 'Proj \ud83d', ['\udc00k']: ['x\ude00', ok] } }, ok);
    const args = invocations[0].args as { args: unknown[] };
    const r = String.fromCharCode(0xfffd);
    expect(JSON.stringify(args.args[0])).toBe(JSON.stringify({ id: 'e', next: { name: `Proj ${r}`, [`${r}k`]: [`x${r}`, ok] } }));
    expect(args.args[1]).toBe(ok); // nothing to repair: not copied
    expect(invocations[0].command).toBe('mc_invoke');
  });

  it('sends a save whose new text has a lone surrogate to Rust with a marker, so 1.1.4 order of checks holds (conflict first)', async () => {
    const conflict = { ok: false, code: 'conflict', error: 'x' };
    const { deps, invocations } = fakeDeps();
    const record = deps.invoke;
    deps.invoke = async (command, args, options) => { await record(command, args, options); return conflict; };
    const api = createMcApi(createTauriTransport(boot, deps));
    const r = String.fromCharCode(0xfffd);
    // Rust decides (here: a conflict, which 1.1.4 also reported before looking at the text).
    expect(await api.writeProjectFile('p', 'a.txt', 'half \ud83d', 'old')).toEqual(conflict);
    expect(await api.localFs.writeFile('C:\\a.txt', '\ude00x', 'old')).toEqual(conflict);
    expect((invocations[0].args as { args: unknown[] }).args).toEqual(['p', 'a.txt', `half ${r}`, 'old', true]);
    expect((invocations[1].args as { args: unknown[] }).args).toEqual(['C:\\a.txt', `${r}x`, 'old', true]);
    // A whole emoji is fine (no marker), and a broken expected text goes as it is (it can only be a conflict there).
    await api.writeProjectFile('p', 'a.txt', 'ok 😀', 'old \ud83d');
    expect((invocations[2].args as { args: unknown[] }).args).toEqual(['p', 'a.txt', 'ok 😀', `old ${r}`]);
    expect(invocations.map((i) => (i.args as { cmd: string }).cmd)).toEqual(['fs:writeProjectFile', 'local:writeFile', 'fs:writeProjectFile']);
  });

  it('turns the raw bytes of an image preview into the data: URL the page had in 1.1.4', async () => {
    const header = new TextEncoder().encode(JSON.stringify({ value: { kind: 'image', mime: 'image/png', dataUrl: { $mcBytes: 0 }, size: 4 }, parts: [4] }));
    const frame = new Uint8Array(8 + header.length + 4);
    frame.set([0x4d, 0x43, 0x42, 0x31]);
    new DataView(frame.buffer).setUint32(4, header.length, true);
    frame.set(header, 8);
    frame.set([0x89, 0x50, 0x4e, 0x47], 8 + header.length);
    const { deps } = fakeDeps({ invoke: async () => frame.buffer });
    const api = createMcApi(createTauriTransport(boot, deps));
    const expected = { kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw==', size: 4 };
    expect(await api.readProjectFile('p', 'pic.png', true)).toEqual(expected);
    expect(await api.localFs.readFile('C:\\pic.png')).toEqual(expected);
    // Text previews and the Electron preload's string data URLs pass unchanged.
    const text = { kind: 'text', text: 'x', size: 1, truncated: false };
    expect(await createMcApi({ ...createTauriTransport(boot, fakeDeps().deps), invoke: async () => text }).readProjectFile('p', 'a.txt')).toBe(text);
    // Bigger than one btoa chunk.
    const { withImageDataUrl } = await import('../src/preload/mcApi');
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    const out = await withImageDataUrl(Promise.resolve({ kind: 'image', mime: 'image/gif', dataUrl: big, size: big.length }));
    expect(out.dataUrl).toBe(`data:image/gif;base64,${Buffer.from(big).toString('base64')}`);
  });

  it('sends a Uint8Array argument as the raw body of mc_invoke_raw with the other arguments in ASCII headers', async () => {
    const calls: Array<{ command: string; args: unknown; options?: { headers: Record<string, string> } }> = [];
    const { deps } = fakeDeps({ invoke: async (command, args, options) => { calls.push({ command, args, options }); return null; } });
    const api = createMcApi(createTauriTransport(boot, deps));
    const png = new Uint8Array([137, 80, 78, 71]);
    await api.notes.saveImage(png, 'image/png ąę');
    expect(calls[0].command).toBe('mc_invoke_raw');
    expect(calls[0].args).toBe(png);
    expect(calls[0].options?.headers).toEqual({ 'mc-cmd': 'notes:image:save', 'mc-args': '[null,"image/png \\u0105\\u0119"]', 'mc-raw-index': '0' });
    expect(JSON.parse(calls[0].options!.headers['mc-args'])).toEqual([null, 'image/png ąę']);
  });

  it('decodes framed binary answers, bytes nested in objects included (unimux_ipc::binary)', async () => {
    // encode(json!({"data": part(0), "name": "done.wav", "more": [part(1), null]}), [[1,2,3], []]) of the Rust tests.
    const header = new TextEncoder().encode(JSON.stringify({ value: { data: { $mcBytes: 0 }, name: 'done.wav', more: [{ $mcBytes: 1 }, null] }, parts: [3, 0] }));
    const frame = new Uint8Array(8 + header.length + 3);
    frame.set([0x4d, 0x43, 0x42, 0x31]);
    new DataView(frame.buffer).setUint32(4, header.length, true);
    frame.set(header, 8);
    frame.set([1, 2, 3], 8 + header.length);
    const { deps } = fakeDeps({ invoke: async () => frame.buffer });
    const result = await createTauriTransport(boot, deps).invoke('sound:load', 'done') as { data: Uint8Array; name: string; more: unknown[] };
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect([...result.data]).toEqual([1, 2, 3]);
    expect(result.name).toBe('done.wav');
    expect(result.more[0]).toBeInstanceOf(Uint8Array);
    expect(result.more[1]).toBeNull();
  });

  it('drops every subscription of the page on dispose (pagehide), the late ones too', async () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps } = fakeDeps({ listen: async () => { await gate; const stop = vi.fn(); stops.push(stop); return stop; } });
    const t = createTauriTransport(boot, deps);
    const off = t.on('cli:changed', () => {});
    t.on('cell:hook', () => {});
    t.on('state:changed', () => {});
    off();
    expect(t.subscriptionCount()).toBe(2);
    t.dispose();
    expect(t.subscriptionCount()).toBe(0);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(stops).toHaveLength(3);
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });

  it('batches port messages per task and numbers the batches in order', async () => {
    const posts: Array<{ session: string; seq: number; kind: string; messages: unknown[] }> = [];
    const tasks: Array<() => void> = [];
    const post = createPortPoster('pty', 's1', async (a) => { posts.push(a); }, (f) => tasks.push(f));
    post({ t: 'write', d: 'a' });
    post({ t: 'write', d: 'b' });
    tasks.shift()!();
    post({ t: 'resize', c: 80 });
    tasks.shift()!();
    expect(posts).toEqual([
      { session: 's1', seq: 1, kind: 'pty', messages: [{ t: 'write', d: 'a' }, { t: 'write', d: 'b' }] },
      { session: 's1', seq: 2, kind: 'pty', messages: [{ t: 'resize', c: 80 }] },
    ]);
  });

  it('keeps a state:edit sent right before a reload and replays it on the next page', async () => {
    // First page: the edit goes out, the page unloads before the answer.
    const pending: Array<() => void> = [];
    const first = fakeDeps({ invoke: (command, args) => new Promise((r) => { first.invocations.push({ command, args: args as Record<string, unknown> }); pending.push(() => r({ revision: 1 })); }) });
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
