import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIpcGuard, OPEN_IPC_CHANNELS, type IpcSenderEvent } from '../src/main/ipcGuard';
import { GIT_CHANNELS, GIT_MUTATING_CHANNELS, GIT_READ_CHANNELS } from '../src/main/gitHandler';

const APP = { sender: 'app-window' };
const FOREIGN = { sender: 'other-window' };

function setup() {
  const invokes = new Map<string, (event: IpcSenderEvent, ...args: unknown[]) => unknown>();
  const sends = new Map<string, (event: IpcSenderEvent, ...args: unknown[]) => void>();
  const ipc = {
    handle: (channel: string, fn: (event: IpcSenderEvent, ...args: unknown[]) => unknown) => { invokes.set(channel, fn); },
    on: (channel: string, fn: (event: IpcSenderEvent, ...args: unknown[]) => void) => { sends.set(channel, fn); },
  };
  const guard = createIpcGuard(ipc as never, (event) => event.sender === APP.sender);
  return { guard, invokes, sends };
}

describe('guardedHandle / guardedOn (0.9.6 sender check)', () => {
  it('runs the handler for the app window and passes the arguments through', async () => {
    const { guard, invokes } = setup();
    const calls: unknown[][] = [];
    guard.guardedHandle('x:write', (_e, a: string, b: number) => { calls.push([a, b]); return { ok: true }; }, () => ({ ok: false }));
    expect(await invokes.get('x:write')!(APP, 'a', 2)).toEqual({ ok: true });
    expect(calls).toEqual([['a', 2]]);
  });

  it('answers a foreign sender with the fallback and never runs the handler', async () => {
    const { guard, invokes } = setup();
    let ran = false;
    guard.guardedHandle('x:write', () => { ran = true; return { ok: true }; }, (...args) => ({ ok: false, args }));
    expect(await invokes.get('x:write')!(FOREIGN, 'p')).toEqual({ ok: false, args: ['p'] });
    expect(ran).toBe(false);
  });

  it('a fallback may reject like the handler itself would', async () => {
    const { guard, invokes } = setup();
    guard.guardedHandle('x:edit', () => 1, () => Promise.reject(new Error('Refused.')));
    await expect(invokes.get('x:edit')!(FOREIGN)).rejects.toThrow('Refused.');
  });

  it('ignores a foreign send and delivers the app window\'s one', () => {
    const { guard, sends } = setup();
    const got: unknown[] = [];
    guard.guardedOn('x:kill', (_e, id: string) => { got.push(id); });
    sends.get('x:kill')!(FOREIGN, 'cell-1');
    expect(got).toEqual([]);
    sends.get('x:kill')!(APP, 'cell-2');
    expect(got).toEqual(['cell-2']);
  });
});

// The registry check: every `ipcMain.handle(` / `ipcMain.on(` in src/main bypasses the sender check, so its channel must be on
// OPEN_IPC_CHANNELS (read-only, with a reason). Everything else has to use guardedHandle / guardedOn. Channels registered through
// a module's own `ipc` parameter (accountsIpc.ts, sshIpc.ts) are checked by their own tests.
const files: string[] = [];
const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
walk(join(__dirname, '../src/main'));
const sources = files.map((file) => ({ file: relative(join(__dirname, '..'), file), text: readFileSync(file, 'utf8') }));
// The first argument as written: the text of a string literal, otherwise the expression itself (a variable channel name then
// has to be listed literally, so it cannot slip through).
const registrations = (pattern: RegExp) => sources.flatMap(({ file, text }) => [...text.matchAll(pattern)].map((m) => ({ file, channel: m[1].trim().replace(/^(['"`])(.*)\1$/s, '$2') })));

describe('IPC channel registry', () => {
  it('no channel outside OPEN_IPC_CHANNELS is registered without the sender check', () => {
    const open = registrations(/ipcMain\.(?:handle|on|once|handleOnce|addListener|prependListener)\(\s*([^,)]+)[,)]/g);
    expect(open.length).toBeGreaterThan(10);
    expect(open.filter(({ channel }) => !Object.hasOwn(OPEN_IPC_CHANNELS, channel))).toEqual([]);
    // The one dynamic open entry is the read loop of gitIpc.ts: accepted there only, and only once.
    const dynamic = open.filter(({ channel }) => channel === 'git:${channel}');
    expect(dynamic.map(({ file }) => file.replace(/\\/g, '/'))).toEqual(['src/main/gitIpc.ts']);
  });

  it('nothing registers channels around the scan (aliases of ipcMain, an injected ipc outside the modules with own tests)', () => {
    // Limitation: the scan sees `ipcMain.<method>(` and `guarded*(` only. ipcGuard.ts is the wrapper itself; modules that receive the IPC object as a parameter
    // (accountsIpc.ts, ssh/ipc.ts) check their senders themselves and are covered by accounts-ipc and ssh-ipc tests; any other
    // file doing so, or aliasing ipcMain, fails here and has to be reviewed (and added to this list with its own test).
    const ownTests = ['src/main/ipcGuard.ts', 'src/main/accountsIpc.ts', 'src/main/ssh/ipc.ts'];
    const injected = sources.filter(({ file, text }) => !ownTests.includes(file.replace(/\\/g, '/')) && /\bipc\.(?:handle|on|once|handleOnce|addListener|prependListener)\(/.test(text));
    expect(injected.map(({ file }) => file)).toEqual([]);
    const aliased = sources.filter(({ text }) => /(?:=|:)\s*ipcMain\s*[;,)}\n]|\{[^}]*\}\s*=\s*ipcMain\b/.test(text));
    expect(aliased.map(({ file }) => file)).toEqual([]);
  });

  it('every channel the app changes something through is registered with guardedHandle / guardedOn', () => {
    const guarded = new Set(registrations(/guarded(?:Handle|On)\(\s*([^,)]+)[,)]/g).map((r) => r.channel));
    const mutating = [
      'state:edit', 'cell:spawn', 'cell:kill', 'cell:killAndWait', 'cell:runtime', 'codex:bind', 'automation:execute', 'mcp:retry',
      'cli:recheck', 'cli:openDocs', 'install:start', 'install:cancel', 'dialog:pickFolder', 'sound:pick', 'sound:beep', 'notify',
      'fs:writeProjectFile', 'fs:replaceInProject', 'fs:renameEntry', 'fs:createEntry', 'fs:deleteEntries', 'fs:transfer', 'fs:cancelOp',
      'git:init', 'git:installGit', 'git:createWorktree', 'git:removeWorktree', 'git:${channel}',
      'shell:openExternal', 'shell:openPath', 'shell:revealPath', 'shell:openInEditor',
      'clipboard:read', 'clipboard:write', 'clipboard:writeSecret', 'app:reportError', 'app:startupMark',
      'update:check', 'update:install', 'update:open', 'changelog:get', 'update-splash:init', 'update-splash:close', 'update-splash:open',
      'sftp:connect', 'sftp:disconnect', 'sftp:prompt:answer', 'sftp:mkdir', 'sftp:rename', 'sftp:delete', 'sftp:enqueue', 'sftp:cancel',
      'sftp:answerConflict', 'sftp:retry', 'sftp:clearFinished', 'sftp:viewOpened', 'sftp:viewClosed',
      'sftp:list', 'sftp:stat', 'sftp:realpath', 'sftp:deleteCount', 'sftp:sessions',
      'local:list', 'local:roots', 'local:mkdir', 'local:rename', 'local:trash', 'local:reveal',
      'db:connections:save', 'db:connections:delete', 'db:connections:duplicate', 'db:connections:test', 'db:vault:info',
      'db:connect', 'db:disconnect', 'db:sessions', 'db:prompt:answer', 'db:pg', 'db:pin',
      'db:pickCaFile', 'db:export',
    ];
    expect(mutating.filter((channel) => !guarded.has(channel))).toEqual([]);
    // A channel is either guarded or open, never both.
    expect([...guarded].filter((channel) => channel !== 'git:${channel}' && Object.hasOwn(OPEN_IPC_CHANNELS, channel))).toEqual([]);
  });

  it('only the read-only git channels are open; every other one is guarded', () => {
    expect([...GIT_READ_CHANNELS].sort()).toEqual(['branches', 'diff', 'log', 'show', 'status', 'trust']);
    expect([...GIT_MUTATING_CHANNELS].sort()).toEqual(['checkout', 'commit', 'fetch', 'pull', 'push', 'stage', 'trustGrant', 'trustRevoke', 'unstage']);
    expect([...GIT_READ_CHANNELS, ...GIT_MUTATING_CHANNELS].sort()).toEqual([...GIT_CHANNELS].sort());
    const gitIpc = sources.find((s) => s.file.replace(/\\/g, '/').endsWith('src/main/gitIpc.ts'))!.text;
    expect(gitIpc).toMatch(/for \(const channel of GIT_READ_CHANNELS\) \{\s*ipcMain\.handle\(`git:\$\{channel\}`/);
    expect(gitIpc).toMatch(/for \(const channel of GIT_MUTATING_CHANNELS\) \{\s*guardedHandle\(`git:\$\{channel\}`/);
  });

  it('every channel the main preload uses is registered somewhere in src/main', () => {
    const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
    const used = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]);
    const all = sources.map((s) => s.text).join('\n');
    const registered = (channel: string) => {
      const [prefix, name] = channel.split(':');
      if (prefix === 'git' && (GIT_CHANNELS as readonly string[]).includes(name)) return true;
      return all.includes(`'${channel}'`);
    };
    expect(used.filter((channel) => !registered(channel))).toEqual([]);
  });
});
