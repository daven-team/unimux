// Remote files in editor tabs (0.9.9, renderer file store with a stubbed window): a tab is keyed by host + path, reads and
// saves go through a connected SFTP session (a save logs in again when the session is gone), a save is refused when the server
// file changed (size + time), the conflict choices work against the server, checks are throttled, drafts keep host + path + stamp.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceDocumentId } from '../src/shared/editorSource';

/** A path in a variable: the renderer modules are not part of the node typecheck project. */
const renderer = (name: string) => `../src/renderer/src/${name}`;
const HOST = '00000000-0000-4000-8000-0000000000aa';
const SESSION = 'sftp:00000000-0000-4000-8000-0000000000bb';
const SESSION2 = 'sftp:00000000-0000-4000-8000-0000000000cc';
const PATH = '/srv/app/config.yml';
const ID = sourceDocumentId({ kind: 'remote', hostId: HOST, path: PATH });

let files: any;
let sessions: any;
let server = { text: '', mtimeMs: 1000 };
const stampOf = () => ({ size: server.text.length, mtimeMs: server.mtimeMs });
let live = new Set<string>([SESSION]);
const calls: string[] = [];
const writes: Array<{ id: string; expected: unknown; text: string }> = [];
const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
const storage = new Map<string, string>();
const emit = (channel: string, ...args: unknown[]) => { for (const cb of listeners.get(channel) ?? []) cb(...args); };

beforeAll(async () => {
  // A draft of another run: restored with its host, path and stamp; a malformed one is dropped.
  storage.set('mc-file-drafts-v1', JSON.stringify([
    { id: sourceDocumentId({ kind: 'remote', hostId: HOST, path: '/etc/motd' }), projectId: '', relativePath: '/etc/motd', name: 'motd', source: { kind: 'remote', hostId: HOST, path: '/etc/motd' }, text: 'draft', savedText: 'x', diskText: 'x', diskStamp: { size: 1, mtimeMs: 5 }, encoding: 'utf-8-bom', status: 'ready', saving: false, error: null, wrap: false },
    { id: 'forged', projectId: '', relativePath: '/x', name: 'x', source: { kind: 'remote', hostId: HOST, path: '/x' }, text: 'a', savedText: 'b', diskText: 'b', status: 'ready', saving: false, error: null, wrap: false },
  ]));
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  vi.stubGlobal('navigator', { languages: ['en'] });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      on: (channel: string, cb: (...a: unknown[]) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), cb]); return () => undefined; },
      sftp: {
        sessions: async () => ({ sessions: [], prompts: [] }),
        connect: async (hostId: string) => {
          calls.push('connect');
          setTimeout(() => { live.add(SESSION2); emit('sftp:session', { id: SESSION2, hostId, state: 'connected', phase: 'connected', since: 1 }); }, 5);
          return { ok: true, sessionId: SESSION2 };
        },
        stat: async (id: string) => { calls.push(`stat:${id}`); return live.has(id) ? { ok: true, value: { kind: 'file', size: server.text.length, mtime: server.mtimeMs } } : { ok: false, error: 'noSession' }; },
        readFile: async (id: string) => {
          calls.push(`read:${id}`);
          if (!live.has(id)) return { ok: false, error: 'noSession' };
          return { ok: true, value: { kind: 'text', text: server.text, encoding: 'utf-8', size: server.text.length, stamp: stampOf() } };
        },
        writeFile: async (id: string, _path: string, save: { text: string; baseline: string; expected: { size: number; mtimeMs: number } | null }) => {
          calls.push(`write:${id}`);
          if (!live.has(id)) return { ok: false, error: 'noSession' };
          writes.push({ id, expected: save.expected, text: save.text });
          const now = stampOf();
          if (!save.expected || save.expected.size !== now.size || save.expected.mtimeMs !== now.mtimeMs) return { ok: false, error: 'changed' };
          server = { text: save.text, mtimeMs: server.mtimeMs + 1000 };
          return { ok: true, value: { stamp: stampOf() } };
        },
        pinHosts: () => undefined,
      },
    },
    setTimeout, clearTimeout,
  });
  files = await import(/* @vite-ignore */ renderer('files'));
  sessions = await import(/* @vite-ignore */ renderer('remoteSessions'));
  sessions.initRemoteSessions();
  emit('sftp:session', { id: SESSION, hostId: HOST, state: 'connected', phase: 'connected', since: 1 });
});

const get = () => files.useFileStore.getState().documents.find((d: { id: string }) => d.id === ID);
beforeEach(() => { calls.length = 0; writes.length = 0; });

describe('remote files in editor tabs', () => {
  it('restores remote drafts keyed by host + path with their stamp; a draft whose id does not match its file is dropped', () => {
    const docs = files.useFileStore.getState().documents;
    const motd = docs.find((d: { relativePath: string }) => d.relativePath === '/etc/motd');
    expect(motd).toMatchObject({ projectId: '', text: 'draft', diskStamp: { size: 1, mtimeMs: 5 }, encoding: 'utf-8-bom', source: { kind: 'remote', hostId: HOST } });
    expect(docs.some((d: { id: string }) => d.id === 'forged')).toBe(false);
  });

  it('opens a remote file once (the same file focuses its tab) with the stamp and encoding a save needs', async () => {
    server = { text: 'a: 1\n', mtimeMs: 1000 };
    expect(await files.openRemoteFile(HOST, PATH)).toBe('ready');
    expect(get()).toMatchObject({ projectId: '', relativePath: PATH, name: 'config.yml', text: 'a: 1\n', diskStamp: { size: 5, mtimeMs: 1000 }, encoding: 'utf-8' });
    expect(await files.openRemoteFile(HOST, PATH)).toBeNull();
    expect(files.useFileStore.getState().documents.filter((d: { id: string }) => d.id === ID)).toHaveLength(1);
  });

  it('saves with the stamp it was opened from and takes the new stamp', async () => {
    files.editFile(ID, 'a: 2\n');
    expect(await files.saveFile(ID)).toBe(true);
    expect(writes).toEqual([{ id: SESSION, expected: { size: 5, mtimeMs: 1000 }, text: 'a: 2\n' }]);
    expect(get()).toMatchObject({ savedText: 'a: 2\n', diskStamp: { size: 5, mtimeMs: 2000 } });
  });

  it('a change on the server refuses the save (conflict choices); Overwrite saves against the server text read now', async () => {
    files.editFile(ID, 'a: mine\n');
    server = { text: 'a: theirs\n', mtimeMs: 9000 };
    expect(await files.saveFile(ID)).toBe(false);
    expect(get()).toMatchObject({ diskConflict: 'save', text: 'a: mine\n' });
    expect(await files.loadDiskText(ID)).toBe('a: theirs\n');
    expect(await files.overwriteFileOnDisk(ID)).toBe(true);
    expect(server.text).toBe('a: mine\n');
    expect(get().diskConflict).toBeUndefined();
  });

  it('a clean tab reloads when the server file changed, at most once per few seconds (no polling over the network)', async () => {
    server = { text: 'b: 1\n', mtimeMs: 20_000 };
    await new Promise((r) => setTimeout(r, 3100)); // focusing the tab again in the open test checked it a moment ago
    await files.checkFileOnDisk(ID);
    expect(get()).toMatchObject({ text: 'b: 1\n', savedText: 'b: 1\n' });
    calls.length = 0;
    server = { text: 'b: 9\n', mtimeMs: 30_000 };
    await files.checkFileOnDisk(ID);
    expect(calls).toEqual([]);
    expect(get().text).toBe('b: 1\n');
  }, 10_000);

  it('a save after the session ended logs in again with the saved host and retries; a background check never logs in', async () => {
    live.delete(SESSION);
    emit('sftp:session', { id: SESSION, hostId: HOST, state: 'closed', phase: 'closed', since: 2 });
    expect(sessions.liveSession(HOST)).toBeNull();
    const doc = get();
    files.useFileStore.setState({ documents: files.useFileStore.getState().documents.map((d: { id: string }) => (d.id === ID ? { ...doc, diskStamp: undefined } : d)) });
    await new Promise((r) => setTimeout(r, 3100));
    await files.checkFileOnDisk(ID);
    expect(calls).not.toContain('connect');
    files.editFile(ID, 'b: 2\n');
    files.useFileStore.setState({ documents: files.useFileStore.getState().documents.map((d: { id: string }) => (d.id === ID ? { ...get(), diskStamp: stampOf() } : d)) });
    // A host that is no longer saved cannot be logged into: the save says so and keeps the draft.
    expect(await files.saveFile(ID)).toBe(false);
    expect(get().error).toBeTruthy();
    expect(calls).not.toContain('connect');
    const store = await import(/* @vite-ignore */ renderer('store'));
    store.useStore.setState((st: any) => ({ s: { ...st.s, sshHosts: [{ id: HOST, label: 'web', address: '127.0.0.1', port: 22, username: 'alice' }] } }));
    expect(await files.saveFile(ID)).toBe(true);
    expect(calls).toContain('connect');
    expect(writes.at(-1)).toMatchObject({ id: SESSION2, text: 'b: 2\n' });
    expect(server.text).toBe('b: 2\n');
  }, 10_000);

  it('unsaved remote drafts are stored with host, path and stamp, never a session', async () => {
    files.editFile(ID, 'draft\n');
    files.flushDrafts();
    await new Promise((r) => setTimeout(r, 800));
    const stored = JSON.parse(storage.get('mc-file-drafts-v1') ?? '[]');
    const mine = stored.find((d: { id: string }) => d.id === ID);
    expect(mine).toMatchObject({ source: { kind: 'remote', hostId: HOST, path: PATH }, text: 'draft\n', diskStamp: stampOf() });
    expect(JSON.stringify(stored)).not.toContain('sftp:');
  });
});
