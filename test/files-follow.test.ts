// Editor tabs follow moves and renames done in the SFTP view and say when their file is gone (0.9.9 final review). The
// renderer file store with a stubbed window: a server and a local disk as maps of path -> text.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_GONE, sourceDocumentId } from '../src/shared/editorSource';
import { documentId } from '../src/shared/fileOps';

const renderer = (name: string) => `../src/renderer/src/${name}`;
const HOST = '00000000-0000-4000-8000-0000000000aa';
const SESSION = 'sftp:00000000-0000-4000-8000-0000000000bb';
const remoteId = (path: string) => sourceDocumentId({ kind: 'remote', hostId: HOST, path });
const localId = (path: string) => sourceDocumentId({ kind: 'local', path });

let files: any;
let store: any;
const server = new Map<string, string>();
const disk = new Map<string, string>();
const storage = new Map<string, string>();
const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
const emit = (channel: string, ...args: unknown[]) => { for (const cb of listeners.get(channel) ?? []) cb(...args); };
const stamp = (text: string) => ({ size: text.length, mtimeMs: 1000 });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  vi.stubGlobal('navigator', { languages: ['en'] });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      on: (channel: string, cb: (...a: unknown[]) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), cb]); return () => undefined; },
      sftp: {
        sessions: async () => ({ sessions: [], prompts: [] }),
        connect: async () => ({ ok: false, error: 'hostMissing' }),
        statFile: async (_id: string, path: string) => (server.has(path) ? { ok: true, value: stamp(server.get(path)!) } : { ok: false, error: 'notFound' }),
        readFile: async (_id: string, path: string) => {
          const text = server.get(path);
          return text === undefined ? { ok: false, error: 'notFound' } : { ok: true, value: { kind: 'text', text, encoding: 'utf-8', size: text.length, stamp: stamp(text) } };
        },
        writeFile: async (_id: string, path: string) => (server.has(path) ? { ok: true, value: { kind: 'saved', stamp: null, warnings: [] } } : { ok: false, error: 'notFound' }),
        pinHosts: () => undefined,
      },
      localFs: {
        readFile: async (path: string) => { const text = disk.get(path); return text === undefined ? { kind: 'error', message: FILE_GONE } : { kind: 'text', text, size: text.length, truncated: false }; },
        statFile: async (path: string) => (disk.has(path) ? stamp(disk.get(path)!) : 'gone'),
        writeFile: async (path: string) => (disk.has(path) ? { ok: true } : { ok: false, error: FILE_GONE }),
      },
      readProjectFile: async (_p: string, path: string) => { const text = disk.get(`/home/me/proj/${path}`); return text === undefined ? { kind: 'error', message: 'x' } : { kind: 'text', text, size: text.length, truncated: false }; },
      statProjectFile: async (_p: string, path: string) => (disk.has(`/home/me/proj/${path}`) ? stamp(disk.get(`/home/me/proj/${path}`)!) : 'gone'),
    },
    setTimeout, clearTimeout,
  });
  files = await import(/* @vite-ignore */ renderer('files'));
  store = await import(/* @vite-ignore */ renderer('store'));
  const sessions = await import(/* @vite-ignore */ renderer('remoteSessions'));
  sessions.initRemoteSessions();
  emit('sftp:session', { id: SESSION, hostId: HOST, state: 'connected', phase: 'connected', since: 1 });
  store.useStore.setState((st: any) => ({ s: { ...st.s, activeProjectId: 'p1', projects: [{ id: 'p1', name: 'proj', path: '/home/me/proj' }] } }));
});

const doc = (id: string) => files.useFileStore.getState().documents.find((d: { id: string }) => d.id === id);
let tick = 0;
beforeEach(() => { tick += 10_000; vi.setSystemTime(tick); });

describe('editor tabs follow the SFTP view', () => {
  it('a remote tab follows a folder move with its unsaved text; the draft moves with it', async () => {
    server.set('/srv/app/config.yml', 'a: 1\n');
    expect(await files.openRemoteFile(HOST, '/srv/app/config.yml')).toBe('ready');
    files.editFile(remoteId('/srv/app/config.yml'), 'a: 2\n');
    server.set('/srv/old/config.yml', server.get('/srv/app/config.yml')!);
    server.delete('/srv/app/config.yml');
    files.followMoves({ kind: 'remote', hostId: HOST }, [{ from: '/srv/app', to: '/srv/old' }]);
    expect(doc(remoteId('/srv/app/config.yml'))).toBeUndefined();
    const moved = doc(remoteId('/srv/old/config.yml'));
    expect(moved).toMatchObject({ relativePath: '/srv/old/config.yml', source: { path: '/srv/old/config.yml' }, text: 'a: 2\n', error: null });
    expect(files.useFileStore.getState().activeFileId).toBe(moved.id);
    files.flushDrafts();
    const stored = JSON.parse(storage.get('mc-file-drafts-v1') ?? '[]');
    expect(stored.map((d: { id: string }) => d.id)).toEqual([moved.id]);
    // Its save goes to the new path.
    expect(await files.saveFile(moved.id)).toBe(true);
  });

  it('another host or a local move does not touch a remote tab', () => {
    const before = doc(remoteId('/srv/old/config.yml'));
    files.followMoves({ kind: 'remote', hostId: '00000000-0000-4000-8000-0000000000ff' }, [{ from: '/srv/old', to: '/x' }]);
    files.followMoves({ kind: 'local' }, [{ from: '/srv/old', to: '/x' }]);
    expect(doc(remoteId('/srv/old/config.yml'))).toBe(before);
  });

  it('a deleted remote file: the tab says it was moved or deleted (on a check and in the view)', async () => {
    server.delete('/srv/old/config.yml');
    await files.checkFileOnDisk(remoteId('/srv/old/config.yml'), true);
    expect(doc(remoteId('/srv/old/config.yml')).error).toBe(FILE_GONE);
    // Back again: the notice goes.
    server.set('/srv/old/config.yml', 'a: 2\n');
    await files.checkFileOnDisk(remoteId('/srv/old/config.yml'), true);
    expect(doc(remoteId('/srv/old/config.yml')).error).toBeNull();
    files.markDeleted({ kind: 'remote', hostId: HOST }, ['/srv']);
    expect(doc(remoteId('/srv/old/config.yml')).error).toBe(FILE_GONE);
  });

  it('a read of a file that is gone says so instead of "not found"', async () => {
    server.set('/srv/gone.txt', 'x');
    expect(await files.openRemoteFile(HOST, '/srv/gone.txt')).toBe('ready');
    server.delete('/srv/gone.txt');
    await files.retryFile(remoteId('/srv/gone.txt'));
    expect(doc(remoteId('/srv/gone.txt'))).toMatchObject({ status: 'error', error: FILE_GONE });
  });

  it('a local tab follows a rename; a project tab follows a move inside its project and is gone when moved out', async () => {
    disk.set('/data/notes.md', 'n');
    await files.openLocalFile('/data/notes.md');
    expect(doc(localId('/data/notes.md'))).toMatchObject({ status: 'ready', text: 'n' });
    files.followMoves({ kind: 'local' }, [{ from: '/data/notes.md', to: '/data/renamed.md' }]);
    expect(doc(localId('/data/renamed.md'))).toMatchObject({ name: 'renamed.md', text: 'n' });
    disk.set('/home/me/proj/src/a.ts', 'a');
    await files.openLocalFile('/home/me/proj/src/a.ts');
    expect(doc(documentId('p1', 'src/a.ts'))).toMatchObject({ status: 'ready', text: 'a' });
    files.followMoves({ kind: 'local' }, [{ from: '/home/me/proj/src', to: '/home/me/proj/lib' }]);
    expect(doc(documentId('p1', 'lib/a.ts'))).toMatchObject({ relativePath: 'lib/a.ts', text: 'a' });
    files.followMoves({ kind: 'local' }, [{ from: '/home/me/proj/lib/a.ts', to: '/tmp/a.ts' }]);
    expect(doc(documentId('p1', 'lib/a.ts')).error).toBe(FILE_GONE);
  });

  it('a local file deleted elsewhere: the check marks the tab gone', async () => {
    disk.delete('/data/renamed.md');
    await files.checkFileOnDisk(localId('/data/renamed.md'));
    expect(doc(localId('/data/renamed.md')).error).toBe(FILE_GONE);
  });
});
