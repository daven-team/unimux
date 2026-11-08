// Files outside projects in editor tabs (0.9.9): the shared source helpers (ids = draft keys, open decisions by size and
// kind, stamps, encodings), main's local file channels, the SFTP IPC of the editor and the idle disconnect that keeps the
// sessions of hosts with unsaved remote tabs.
import { describe, expect, it } from 'vitest';
import {
  localRelativePath, sourceDocumentId, sourceTitle, validSource,
  FILE_GONE, movedPath, movedSource, POSIX_PATHS, retargetSourceDocuments, sourceUnder, type FileSource,
} from '../src/shared/editorSource';
import { finishedMoves, type TransferItem } from '../src/shared/sftp';

const HOST = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

describe('editor sources', () => {
  it('one id per file: host + path for a remote file, the path for a local one (the draft key; no session in it)', () => {
    const a = sourceDocumentId({ kind: 'remote', hostId: HOST, path: '/etc/hosts' });
    expect(a).toBe(sourceDocumentId({ kind: 'remote', hostId: HOST, path: '/etc/hosts' }));
    expect(a).not.toBe(sourceDocumentId({ kind: 'remote', hostId: OTHER, path: '/etc/hosts' }));
    expect(a).not.toBe(sourceDocumentId({ kind: 'local', path: '/etc/hosts' }));
    expect(a).not.toContain('sftp:');
    expect(validSource({ kind: 'remote', hostId: HOST, path: '/a' })).toBe(true);
    expect(validSource({ kind: 'remote', hostId: HOST, path: 'a' })).toBe(false);
    expect(validSource({ kind: 'remote', hostId: '', path: '/a' })).toBe(false);
    expect(validSource({ kind: 'local', path: 'C:\\a.txt' })).toBe(true);
    expect(validSource({ kind: 'project', path: '/a' })).toBe(false);
    expect(sourceTitle({ kind: 'remote', hostId: HOST, path: '/srv/a.txt' }, 'web')).toBe('web:/srv/a.txt');
    expect(sourceTitle({ kind: 'local', path: 'D:\\x\\a.txt' })).toBe('D:\\x\\a.txt');
  });

  it('a local file inside a project opens as that project file', () => {
    expect(localRelativePath('C:\\Work\\app', 'c:\\work\\app\\src\\a.ts', true)).toBe('src/a.ts');
    expect(localRelativePath('C:\\Work\\app', 'C:\\Work\\app2\\a.ts', true)).toBeNull();
    expect(localRelativePath('/home/a/app', '/home/a/App/x', false)).toBeNull();
    expect(localRelativePath('/home/a/app/', '/home/a/app/x/y', false)).toBe('x/y');
    expect(localRelativePath('/home/a/app', '/home/a/app', false)).toBeNull();
  });
});

describe('editor tabs follow moves of the SFTP view (0.9.9 final review)', () => {
  const WIN = { caseInsensitive: true, backslash: true };
  it('moves a path that is the moved entry or lies under it', () => {
    expect(movedPath('/srv/a.txt', '/srv/a.txt', '/srv/b.txt', POSIX_PATHS)).toBe('/srv/b.txt');
    expect(movedPath('/srv/app/x/y.yml', '/srv/app', '/opt/app2', POSIX_PATHS)).toBe('/opt/app2/x/y.yml');
    expect(movedPath('/srv/apple/y.yml', '/srv/app', '/opt/app2', POSIX_PATHS)).toBeNull();
    expect(movedPath('/srv/App/y', '/srv/app', '/x', POSIX_PATHS)).toBeNull();
    expect(movedPath('C:\\Users\\A\\notes\\t.md', 'c:/users/a/notes', 'C:\\Users\\A\\old', WIN)).toBe('C:\\Users\\A\\old\\t.md');
  });

  it('touches only the same side and host', () => {
    const remote: FileSource = { kind: 'remote', hostId: 'h1', path: '/srv/a' };
    expect(movedSource(remote, { kind: 'remote', hostId: 'h2' }, '/srv/a', '/srv/b', POSIX_PATHS)).toBeNull();
    expect(movedSource(remote, { kind: 'local' }, '/srv/a', '/srv/b', POSIX_PATHS)).toBeNull();
    expect(movedSource(remote, { kind: 'remote', hostId: 'h1' }, '/srv/a', '/srv/b', POSIX_PATHS)).toEqual({ kind: 'remote', hostId: 'h1', path: '/srv/b' });
    expect(sourceUnder(remote, { kind: 'remote', hostId: 'h1' }, ['/srv'], POSIX_PATHS)).toBe(true);
    expect(sourceUnder(remote, { kind: 'remote', hostId: 'h1' }, ['/sr'], POSIX_PATHS)).toBe(false);
  });

  const docOf = (source: FileSource, text = 'same') => ({ id: sourceDocumentId(source), source, relativePath: source.path, name: source.path.split('/').pop()!, text, savedText: 'same' });
  const dirty = (d: { text: string; savedText: string }) => d.text !== d.savedText;
  const scope = { kind: 'remote' as const, hostId: 'h1' };
  const move = (from: string, to: string) => (s: FileSource) => movedSource(s, scope, from, to, POSIX_PATHS);

  it('retargets tabs (their unsaved text stays) and keeps the active tab', () => {
    const a = docOf({ kind: 'remote', hostId: 'h1', path: '/srv/app/a.yml' }, 'edited');
    const other = docOf({ kind: 'remote', hostId: 'h2', path: '/srv/app/a.yml' });
    const r = retargetSourceDocuments([a, other], a.id, move('/srv/app', '/srv/old'), dirty);
    const moved = r.documents[0];
    expect(moved).toMatchObject({ source: { path: '/srv/old/a.yml' }, relativePath: '/srv/old/a.yml', name: 'a.yml', text: 'edited' });
    expect(moved.id).toBe(sourceDocumentId({ kind: 'remote', hostId: 'h1', path: '/srv/old/a.yml' }));
    expect(r.documents[1]).toBe(other);
    expect(r.activeId).toBe(moved.id);
    expect(r.idMap.get(a.id)).toBe(moved.id);
  });

  it('a clean tab on the target is replaced; one with unsaved changes stays and the moved tab is marked gone', () => {
    const a = docOf({ kind: 'remote', hostId: 'h1', path: '/srv/a' });
    const cleanB = docOf({ kind: 'remote', hostId: 'h1', path: '/srv/b' });
    const r = retargetSourceDocuments([a, cleanB], cleanB.id, move('/srv/a', '/srv/b'), dirty);
    expect(r.closed).toEqual([cleanB.id]);
    expect(r.documents.map((d) => d.id)).toEqual([cleanB.id]);
    expect(r.documents[0].text).toBe('same');
    expect(r.activeId).toBe(cleanB.id);
    const dirtyB = docOf({ kind: 'remote', hostId: 'h1', path: '/srv/b' }, 'mine');
    const r2 = retargetSourceDocuments([a, dirtyB], a.id, move('/srv/a', '/srv/b'), dirty);
    expect(r2.gone).toEqual([a.id]);
    expect(r2.documents).toEqual([a, dirtyB]);
    expect(FILE_GONE).toBe('Plik został przeniesiony lub usunięty.');
  });

  it('reports a move once, when its item reaches done (never from a snapshot, never a skipped one)', () => {
    const item = (patch: Partial<TransferItem>): TransferItem => ({ id: 'i1', batchId: 'b', sessionId: 'sftp:x', direction: 'move', source: '/a', target: '/b', name: 'a', bytesDone: 0, bytesTotal: 0, speed: 0, state: 'running', ...patch });
    expect(finishedMoves([item({})], { t: 'items', items: [item({ state: 'done' })] })).toHaveLength(1);
    expect(finishedMoves([item({ state: 'done' })], { t: 'items', items: [item({ state: 'done' })] })).toHaveLength(0);
    expect(finishedMoves([], { t: 'snapshot', items: [item({ state: 'done' })] })).toHaveLength(0);
    expect(finishedMoves([item({})], { t: 'items', items: [item({ state: 'done', skipped: true })] })).toHaveLength(0);
    expect(finishedMoves([item({})], { t: 'items', items: [item({ state: 'done', direction: 'upload' })] })).toHaveLength(0);
    expect(finishedMoves([], { t: 'items', items: [item({ state: 'done', direction: 'local-move' })] })).toHaveLength(1);
  });
});
