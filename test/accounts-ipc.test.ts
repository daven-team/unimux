import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountRefusal, GUARDED_ACCOUNT_CHANNELS, GUARDED_ACCOUNT_SENDS, OPEN_ACCOUNT_CHANNELS, registerAccountIpc, type AccountIpcHandlers } from '../src/main/accountsIpc';
import { isFromWindow } from '../src/main/safeWindow';

const APP = { sender: 'app-window' };
const FOREIGN = { sender: 'login-window' };

function setup(ready?: Promise<unknown>, stopped?: () => boolean) {
  const calls: string[] = [];
  const usage = { claude: [], codex: [] };
  const handlers = Object.fromEntries((['getUsage', 'refreshUsage', 'startLogin', 'cancelLogin', 'removeAccount', 'makeMain', 'adoptCopy', 'swapPending', 'clearSwapPending', 'dismissNotice'] as const)
    .map((name) => [name, (payload?: unknown) => { calls.push(`${name}:${String(payload)}`); return name === 'getUsage' ? usage : { ok: true }; }])) as unknown as AccountIpcHandlers;
  const invokes = new Map<string, (event: { sender: unknown }, payload?: unknown) => unknown>();
  const sends = new Map<string, (event: { sender: unknown }, payload?: unknown) => void>();
  const ipc = {
    handle: (channel: string, fn: (event: { sender: unknown }, payload?: unknown) => unknown) => { invokes.set(channel, fn); },
    on: (channel: string, fn: (event: { sender: unknown }, payload?: unknown) => void) => { sends.set(channel, fn); },
  };
  registerAccountIpc(ipc as never, handlers, (event) => event.sender === APP.sender, ready, stopped);
  return { calls, usage, invokes, sends };
}

describe('accounts, auth and usage IPC sender check (0.9.3)', () => {
  it('registers exactly the guarded and the open channels', () => {
    const { invokes, sends } = setup();
    expect([...invokes.keys()].sort()).toEqual([...Object.keys(GUARDED_ACCOUNT_CHANNELS), ...Object.keys(OPEN_ACCOUNT_CHANNELS)].sort());
    expect([...sends.keys()]).toEqual(Object.keys(GUARDED_ACCOUNT_SENDS));
    // Only getters stay open.
    expect(Object.keys(OPEN_ACCOUNT_CHANNELS).sort()).toEqual(['accounts:swapPending', 'usage:get']);
  });

  it('refuses a foreign sender on every guarded channel with the handler\'s own refusal, without running it', async () => {
    const { calls, usage, invokes, sends } = setup();
    for (const channel of Object.keys(GUARDED_ACCOUNT_CHANNELS) as Array<keyof typeof GUARDED_ACCOUNT_CHANNELS>) {
      expect(await invokes.get(channel)!(FOREIGN, 'acc-1'), channel).toEqual(accountRefusal(channel, { getUsage: () => usage }));
    }
    sends.get('auth:cancel')!(FOREIGN, 'login-1');
    // usage:refresh answers with the current state (nothing refreshed); reading it is the only call.
    expect(calls.filter((c) => !c.startsWith('getUsage'))).toEqual([]);
  });

  it('gives the expected refusal shapes for a representative set', async () => {
    const { usage, invokes } = setup();
    expect(await invokes.get('accounts:remove')!(FOREIGN, 'acc-1')).toEqual({ ok: false });
    expect(await invokes.get('accounts:makeMain')!(FOREIGN, 'acc-1')).toEqual({ ok: false, error: 'invalid' });
    expect(await invokes.get('accounts:adoptCopy')!(FOREIGN, 'acc-1')).toEqual({ ok: false, error: 'invalid' });
    expect(await invokes.get('auth:start')!(FOREIGN, {})).toEqual({ ok: false, error: 'invalid request' });
    expect(await invokes.get('accounts:clearSwapPending')!(FOREIGN)).toEqual({ ok: false });
    expect(await invokes.get('accounts:dismissNotice')!(FOREIGN, 'n')).toBeUndefined();
    expect(await invokes.get('usage:refresh')!(FOREIGN)).toBe(usage);
  });

  it('passes the app window through to the handler', async () => {
    const { calls, invokes, sends } = setup();
    expect(await invokes.get('accounts:remove')!(APP, 'acc-1')).toEqual({ ok: true });
    sends.get('auth:cancel')!(APP, 'login-1');
    await Promise.resolve();
    await invokes.get('usage:get')!(FOREIGN);
    expect(calls).toEqual(['removeAccount:acc-1', 'cancelLogin:login-1', 'getUsage:undefined']);
  });

  it('serves nothing that can start a swap, a login or a removal before the startup recovery finished (0.9.4)', async () => {
    let finish!: () => void;
    const { calls, usage, invokes, sends } = setup(new Promise<void>((resolve) => { finish = resolve; }));
    const answers = (Object.keys(GUARDED_ACCOUNT_CHANNELS) as string[]).map((channel) => invokes.get(channel)!(APP, 'acc-1'));
    const pending = invokes.get('accounts:swapPending')!(APP);
    sends.get('auth:cancel')!(APP, 'login-1');
    // The usage snapshot stays open; a foreign sender is still refused at once.
    expect(await invokes.get('usage:get')!(FOREIGN)).toBe(usage);
    expect(await invokes.get('accounts:makeMain')!(FOREIGN, 'acc-1')).toEqual({ ok: false, error: 'invalid' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(['getUsage:undefined']);
    finish();
    await Promise.all([...answers, pending]);
    expect(calls).toEqual(expect.arrayContaining(['makeMain:acc-1', 'startLogin:acc-1', 'removeAccount:acc-1', 'swapPending:undefined', 'cancelLogin:login-1']));
  });

  it('starts no new account work once the app quits, also for a call still waiting for the recovery (0.9.6)', async () => {
    let finish!: () => void;
    let quitting = false;
    const { calls, usage, invokes, sends } = setup(new Promise<void>((resolve) => { finish = resolve; }), () => quitting);
    const waiting = invokes.get('accounts:makeMain')!(APP, 'acc-1');
    quitting = true;
    finish();
    expect(await waiting).toEqual({ ok: false, error: 'invalid' });
    for (const channel of Object.keys(GUARDED_ACCOUNT_CHANNELS) as Array<keyof typeof GUARDED_ACCOUNT_CHANNELS>) {
      expect(await invokes.get(channel)!(APP, 'acc-1'), channel).toEqual(accountRefusal(channel, { getUsage: () => usage }));
    }
    // A cancel only stops work: it still runs.
    sends.get('auth:cancel')!(APP, 'login-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((c) => !c.startsWith('getUsage'))).toEqual(['cancelLogin:login-1']);
  });

  it('a failed recovery still lets the handlers run (they apply their own guards)', async () => {
    const { calls, invokes } = setup(Promise.reject(new Error('recovery failed')));
    expect(await invokes.get('accounts:remove')!(APP, 'acc-1')).toEqual({ ok: true });
    expect(calls).toEqual(['removeAccount:acc-1']);
  });

  it('every accounts:, auth: and usage: channel of the preload is registered through registerAccountIpc', () => {
    const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
    const used = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('((?:accounts|auth|usage):[^']+)'/g)].map((m) => m[1]);
    const known = [...Object.keys(GUARDED_ACCOUNT_CHANNELS), ...Object.keys(GUARDED_ACCOUNT_SENDS), ...Object.keys(OPEN_ACCOUNT_CHANNELS)];
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((c) => !known.includes(c))).toEqual([]);
  });

  it('no file in src/main registers an accounts:, auth: or usage: channel directly', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(join(__dirname, '../src/main'));
    const direct = files.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\.(?:handle|on|handleOnce|once)\(\s*['"`]((?:accounts|auth|usage):[^'"`]+)/g)].map((m) => `${file}: ${m[1]}`));
    expect(direct).toEqual([]);
  });
});

describe('isFromWindow', () => {
  const contents = { isDestroyed: () => false };
  const win = { isDestroyed: () => false, webContents: contents };
  it('accepts only the live app window', () => {
    expect(isFromWindow(win, { sender: contents })).toBe(true);
    expect(isFromWindow(win, { sender: { isDestroyed: () => false } })).toBe(false);
    expect(isFromWindow(null, { sender: contents })).toBe(false);
    expect(isFromWindow({ isDestroyed: () => true, webContents: contents }, { sender: contents })).toBe(false);
    const frame = {};
    const framed = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: frame } };
    expect(isFromWindow(framed, { sender: framed.webContents, senderFrame: frame })).toBe(true);
    expect(isFromWindow(framed, { sender: framed.webContents, senderFrame: {} })).toBe(false);
  });

  it('accepts any top-level frame of the app window (a reload swapping the main frame), never a subframe (0.9.6)', () => {
    const frame = { parent: null };
    const framed = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: frame } };
    // The previous document's main frame, still sending its last edit after the new one committed.
    expect(isFromWindow(framed, { sender: framed.webContents, senderFrame: { parent: null } })).toBe(true);
    // Electron reports a frame that is already gone as null.
    expect(isFromWindow(framed, { sender: framed.webContents, senderFrame: null })).toBe(true);
    // An iframe of the app window.
    expect(isFromWindow(framed, { sender: framed.webContents, senderFrame: { parent: frame } })).toBe(false);
    // A top-level frame of another webContents.
    expect(isFromWindow(framed, { sender: { isDestroyed: () => false }, senderFrame: { parent: null } })).toBe(false);
  });
});
