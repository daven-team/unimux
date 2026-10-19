// Files outside projects in editor tabs (0.9.9): the shared source helpers (ids = draft keys, open decisions by size and
// kind, stamps, encodings), main's local file channels, the SFTP IPC of the editor and the idle disconnect that keeps the
// sessions of hosts with unsaved remote tabs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanStamp, decodeText, EDITOR_IMAGE_BYTES, EDITOR_TEXT_BYTES, encodeText, isFileLike, needsHashCheck, localRelativePath, remoteOpenPlan, restoreLineEndings, sameStamp,
  sourceDocumentId, sourceTitle, validEditorSave, validEditorText, validSource,
  FILE_GONE, movedPath, movedSource, POSIX_PATHS, retargetSourceDocuments, sourceUnder, type FileSource,
} from '../src/shared/editorSource';
import { finishedMoves, type TransferItem } from '../src/shared/sftp';
import { createLocalFiles, isUncOrDevicePath } from '../src/main/localFiles';
import { createSftpHandlers } from '../src/main/sftp/ipc';
import { SftpService, type SftpServiceDeps } from '../src/main/sftp/service';
import type { SftpResult, SftpSessionState } from '../src/shared/sftp';
import type { MainToSftpHost, SftpOp } from '../src/shared/sftpHostIpc';

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

  it('opens text up to the editor limit and images up to theirs; bigger files offer a download', () => {
    expect(remoteOpenPlan('a.txt', EDITOR_TEXT_BYTES)).toEqual({ kind: 'text' });
    expect(remoteOpenPlan('a.txt', EDITOR_TEXT_BYTES + 1)).toEqual({ kind: 'tooLarge' });
    expect(remoteOpenPlan('Makefile', 10)).toEqual({ kind: 'text' });
    expect(remoteOpenPlan('photo.JPG', EDITOR_IMAGE_BYTES)).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(remoteOpenPlan('photo.png', EDITOR_IMAGE_BYTES + 1)).toEqual({ kind: 'tooLarge' });
    expect(remoteOpenPlan('disk.iso', 4 * 1024 ** 3)).toEqual({ kind: 'tooLarge' });
    expect(isFileLike({ kind: 'file' })).toBe(true);
    expect(isFileLike({ kind: 'symlink', target: 'file' })).toBe(true);
    expect(isFileLike({ kind: 'symlink', target: 'dir' })).toBe(false);
    expect(isFileLike({ kind: 'dir' })).toBe(false);
    expect(isFileLike({ kind: 'other' })).toBe(false);
    expect(isFileLike({ kind: 'file', unsafeName: true })).toBe(false);
  });

  it('tells text from binary and keeps the encoding, BOM and line endings on the way back', () => {
    expect(decodeText(new Uint8Array([0x61, 0, 0x62]))).toBeNull();
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull(); // invalid UTF-8
    expect(decodeText(new TextEncoder().encode('a\x01b'))).toBeNull();
    expect(decodeText(new TextEncoder().encode('zażółć\r\n'))).toEqual({ text: 'zażółć\r\n', encoding: 'utf-8' });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('x')]);
    expect(decodeText(bom)).toEqual({ text: 'x', encoding: 'utf-8-bom' });
    expect(encodeText('y', 'x', 'utf-8-bom')).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, 0x79]));
    const le = encodeText('hi\n', 'a\r\n', 'utf-16le');
    expect(Array.from(le)).toEqual([0xff, 0xfe, 0x68, 0, 0x69, 0, 0x0d, 0, 0x0a, 0]);
    expect(decodeText(le)).toEqual({ text: 'hi\r\n', encoding: 'utf-16le' });
    const be = encodeText('ą', '', 'utf-16be');
    expect(decodeText(be)).toEqual({ text: 'ą', encoding: 'utf-16be' });
    expect(restoreLineEndings('a\nb\nc\n', 'x\r\ny\nz')).toBe('a\r\nb\nc\r\n');
    expect(restoreLineEndings('a\nb', '')).toBe('a\nb');
    expect(validEditorText('ok\ttext\n')).toBe(true);
    expect(validEditorText('bad\x00')).toBe(false);
    expect(validEditorText('lone \ud800')).toBe(false);
  });

  it('compares stamps exactly (size and time) and validates a save request', () => {
    expect(sameStamp({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 2 })).toBe(true);
    expect(sameStamp({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 3 })).toBe(false);
    expect(sameStamp({ size: 2, mtimeMs: 2 }, { size: 1, mtimeMs: 2 })).toBe(false);
    expect(sameStamp(undefined, { size: 1, mtimeMs: 2 })).toBe(false);
    const hash = 'a'.repeat(64);
    // Within 2 s of the read (or a small file) the content hash decides; without a hash only the stamp can.
    expect(needsHashCheck({ size: 10_000_000, mtimeMs: 10_000, readAt: 11_500, hash })).toBe(true);
    expect(needsHashCheck({ size: 10_000_000, mtimeMs: 10_000, readAt: 60_000, hash })).toBe(false);
    expect(needsHashCheck({ size: 100, mtimeMs: 10_000, readAt: 60_000, hash })).toBe(true);
    expect(needsHashCheck({ size: 100, mtimeMs: 10_000, readAt: 10_000 })).toBe(false);
    expect(cleanStamp({ size: 1, mtimeMs: 2, hash, readAt: 3, sessionId: 'sftp:x' })).toEqual({ size: 1, mtimeMs: 2, hash, readAt: 3 });
    expect(cleanStamp({ size: 1, mtimeMs: 2, hash: 'not-hex' })).toBeNull();
    expect(validEditorSave({ text: 'a', baseline: 'b', encoding: 'utf-8', expected: { size: 1, mtimeMs: 2, hash }, allowOwnerChange: true })).toBe(true);
    expect(validEditorSave({ text: 'a', baseline: 'b', encoding: 'utf-8', expected: null, allowOwnerChange: 'yes' })).toBe(false);
    expect(validEditorSave({ text: 'a', baseline: 'b', encoding: 'utf-8', expected: null })).toBe(true);
    expect(validEditorSave({ text: 'a', baseline: 'b', encoding: 'utf-8', expected: { size: 1, mtimeMs: 2 } })).toBe(true);
    expect(validEditorSave({ text: 'a', baseline: 'b', encoding: 'latin1', expected: null })).toBe(false);
    expect(validEditorSave({ text: 'a', baseline: 'b', encoding: 'utf-8', expected: { size: 'x', mtimeMs: 2 } })).toBe(false);
    expect(validEditorSave({ text: 'a'.repeat(EDITOR_TEXT_BYTES + 1), baseline: '', encoding: 'utf-8', expected: null })).toBe(false);
  });

  it('a local file inside a project opens as that project file', () => {
    expect(localRelativePath('C:\\Work\\app', 'c:\\work\\app\\src\\a.ts', true)).toBe('src/a.ts');
    expect(localRelativePath('C:\\Work\\app', 'C:\\Work\\app2\\a.ts', true)).toBeNull();
    expect(localRelativePath('/home/a/app', '/home/a/App/x', false)).toBeNull();
    expect(localRelativePath('/home/a/app/', '/home/a/app/x/y', false)).toBe('x/y');
    expect(localRelativePath('/home/a/app', '/home/a/app', false)).toBeNull();
  });
});

describe('local files outside the projects', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-edit-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const files = () => createLocalFiles({ platform: process.platform, trash: async () => undefined, openFolder: async () => undefined, showFile: () => undefined });

  it('reads, stats and saves like a project file (refuses when the file changed, keeps line endings)', async () => {
    const path = join(dir, 'notes.txt');
    writeFileSync(path, 'one\r\ntwo\r\n');
    const f = files();
    expect(await f.readFile(path)).toEqual({ kind: 'text', text: 'one\r\ntwo\r\n', size: 10, truncated: false });
    expect(await f.statFile(path)).toMatchObject({ size: 10 });
    expect(await f.writeFile(path, 'one\nTWO\n', 'one\r\ntwo\r\n')).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toBe('one\r\nTWO\r\n');
    expect(await f.writeFile(path, 'mine', 'one\r\ntwo\r\n')).toMatchObject({ ok: false, code: 'conflict' });
    expect(readFileSync(path, 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('refuses relative paths and non-strings', async () => {
    const f = files();
    expect(await f.readFile('notes.txt')).toMatchObject({ kind: 'error' });
    expect(await f.readFile(42)).toMatchObject({ kind: 'error' });
    expect(await f.statFile('rel')).toBeNull();
    expect(await f.writeFile('rel.txt', 'a', 'b')).toMatchObject({ ok: false });
    expect(await f.writeFile(join(dir, 'x.txt'), 1, 'b')).toMatchObject({ ok: false });
  });

  it('writes only a file this window read first; a reload forgets them (a restored draft reads again)', async () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'a');
    const f = files();
    expect(await f.writeFile(path, 'b', 'a')).toEqual({ ok: false, error: 'Ten plik nie został otwarty w edytorze.' });
    expect(readFileSync(path, 'utf8')).toBe('a');
    await f.readFile(path);
    expect(await f.writeFile(path, 'b', 'a')).toEqual({ ok: true });
    f.rendererGone();
    expect(await f.writeFile(path, 'c', 'b')).toMatchObject({ ok: false, error: 'Ten plik nie został otwarty w edytorze.' });
    expect(readFileSync(path, 'utf8')).toBe('b');
  });

  it('never reads or writes the app data dir or the install dir, nor UNC and device paths', async () => {
    const data = join(dir, 'data');
    mkdirSync(data);
    const state = join(data, 'state.json');
    writeFileSync(state, '{}');
    const f = createLocalFiles({ platform: process.platform, trash: async () => undefined, openFolder: async () => undefined, showFile: () => undefined, forbidden: [data] });
    expect(await f.readFile(state)).toEqual({ kind: 'error', message: 'Tego miejsca nie można edytować w aplikacji.' });
    expect(await f.statFile(state)).toBeNull();
    expect(await f.writeFile(state, 'x', '{}')).toEqual({ ok: false, error: 'Tego miejsca nie można edytować w aplikacji.' });
    expect(readFileSync(state, 'utf8')).toBe('{}');
    // The same folder spelled through "..".
    expect(await f.readFile(join(dir, 'x', '..', 'data', 'state.json'))).toMatchObject({ kind: 'error' });
    expect(isUncOrDevicePath('\\\\server\\share\\a.txt')).toBe(true);
    expect(isUncOrDevicePath('\\\\?\\C:\\a.txt')).toBe(true);
    expect(isUncOrDevicePath('\\\\.\\PhysicalDrive0')).toBe(true);
    expect(isUncOrDevicePath('//server/share')).toBe(true);
    expect(isUncOrDevicePath('C:\\a.txt')).toBe(false);
    const win = createLocalFiles({ platform: 'win32', trash: async () => undefined, openFolder: async () => undefined, showFile: () => undefined });
    expect(await win.readFile('\\\\server\\share\\a.txt')).toEqual({ kind: 'error', message: 'Tego miejsca nie można edytować w aplikacji.' });
  });
});

function service(sudoHosts: string[] = []) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const connects: Array<{ sessionId: string; hostId: string; sudo?: boolean }> = [];
  const states: SftpSessionState[] = [];
  const sent: MainToSftpHost[] = [];
  const requests: Array<{ id: string; op: SftpOp }> = [];
  const deps: SftpServiceDeps = {
    coordinator: {
      connectSession: async (req) => { connects.push(req); return { ok: true }; },
      endSession: () => undefined,
      answer: () => ({ ok: true }),
      sessionSnapshot: () => ({ sessions: [], prompts: [] }),
      onHostMessage: () => true,
      sessionHostCrashed: () => undefined,
    },
    host: {
      ensure: () => true, running: () => true,
      send: (m) => { sent.push(m); return true; },
      request: async (id, op): Promise<SftpResult<unknown>> => {
        requests.push({ id, op });
        if (op.op === 'realpath') return { ok: true, value: '/home/alice' };
        if (op.op === 'stat') return { ok: true, value: { kind: 'dir' } };
        return { ok: true, value: 'done' };
      },
    },
    hostExists: (id) => id === HOST || id === OTHER,
    hostSudo: (id) => sudoHosts.includes(id),
    events: { session: (st) => { states.push(st); }, prompt: () => undefined, hostCrashed: () => undefined },
    now: () => 5,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    defer: (fn) => fn(),
  };
  const svc = new SftpService(deps);
  const live = () => timers.filter((t) => !t.cleared);
  const connect = async (hostId: string, opts: { plain?: boolean } = {}) => {
    const r = await svc.connect(hostId, undefined, opts);
    const id = r.ok ? r.sessionId : '';
    svc.onCoordinatorSession({ cellId: id, hostId, phase: 'connected', since: 2 });
    await new Promise((r2) => setTimeout(r2, 5));
    return id;
  };
  return { svc, live, sent, requests, connect, connects, states };
}

describe('SFTP sessions of remote editor tabs', () => {
  it('a host with unsaved remote tabs keeps its session while the view is closed; others still disconnect', async () => {
    const f = service();
    f.svc.viewOpened();
    const a = await f.connect(HOST);
    const b = await f.connect(OTHER);
    f.svc.pinHosts([HOST]);
    f.svc.viewClosed();
    expect(f.live()).toHaveLength(1);
    f.live()[0].fn();
    expect(f.sent).toEqual([{ t: 'sftpDisconnect', id: b }]);
    expect(f.svc.ids()).toEqual([a]);
    // Saved (no unsaved tab left): the idle disconnect comes back.
    f.svc.pinHosts([]);
    expect(f.live()).toHaveLength(1);
    f.live()[0].fn();
    expect(f.svc.ids()).toEqual([]);
  });

  it('a reloaded renderer reports its unsaved tabs again (pins are dropped until then)', async () => {
    const f = service();
    const a = await f.connect(HOST);
    f.svc.pinHosts([HOST]);
    expect(f.live()).toHaveLength(0);
    f.svc.rendererGone();
    expect(f.live()).toHaveLength(1);
    f.svc.pinHosts([HOST]);
    expect(f.live()).toHaveLength(0);
    expect(f.svc.ids()).toEqual([a]);
  });

  it('a sudo session is never kept by a pin: it goes idle while the host has unsaved tabs (0.9.9 final review)', async () => {
    const f = service([HOST]);
    const root = await f.connect(HOST);
    const plain = await f.connect(HOST, { plain: true });
    f.svc.pinHosts([HOST]);
    expect(f.live()).toHaveLength(1);
    f.live()[0].fn();
    expect(f.sent).toEqual([{ t: 'sftpDisconnect', id: root }]);
    expect(f.svc.ids()).toEqual([plain]);
  });

  it('while the view is open only the session it shows is exempt from the idle disconnect', async () => {
    const f = service();
    const a = await f.connect(HOST);
    const b = await f.connect(OTHER);
    f.svc.viewOpened(b);
    expect(f.live()).toHaveLength(1);
    f.live()[0].fn();
    expect(f.svc.ids()).toEqual([b]);
    // The view switches to another session: the old one starts counting down.
    const c = await f.connect(HOST);
    f.svc.viewOpened(c);
    expect(f.live()).toHaveLength(1);
    f.live()[0].fn();
    expect(f.svc.ids()).toEqual([c]);
    expect(a).not.toBe(c);
  });

  it('decides sudo once and hands the coordinator an explicit flag; editor sessions are marked plain', async () => {
    const f = service([HOST]);
    const root = await f.connect(HOST);
    const plain = await f.connect(HOST, { plain: true });
    const other = await f.connect(OTHER);
    expect(f.connects).toEqual([{ sessionId: root, hostId: HOST, sudo: true }, { sessionId: plain, hostId: HOST, sudo: false }, { sessionId: other, hostId: OTHER, sudo: false }]);
    const last = (id: string) => f.states.filter((x) => x.id === id).at(-1);
    expect(last(root)).toMatchObject({ state: 'connected', sudo: true });
    expect(last(root)?.plain).toBeUndefined();
    expect(last(plain)).toMatchObject({ state: 'connected', plain: true });
    expect(last(plain)?.sudo).toBeUndefined();
    expect(f.svc.snapshot().sessions.find((x) => x.id === plain)?.plain).toBe(true);
  });

  it('validates the editor channels: absolute remote paths, a well formed save, host ids only', async () => {
    const f = service();
    const h = createSftpHandlers(f.svc);
    const id = await f.connect(HOST);
    const save = { text: 'a', baseline: 'b', encoding: 'utf-8', expected: { size: 1, mtimeMs: 2 } };
    expect(await h.readFile(id, 'etc/x')).toEqual({ ok: false, error: 'invalid' });
    expect(await h.readFile('nope', '/etc/x')).toEqual({ ok: false, error: 'invalid' });
    expect(await h.readFile(id, '/etc/x')).toEqual({ ok: true, value: 'done' });
    expect(await h.writeFile(id, '/etc/x', { ...save, encoding: 'cp1250' })).toEqual({ ok: false, error: 'invalid' });
    expect(await h.writeFile(id, 'C:\\x', save)).toEqual({ ok: false, error: 'invalid' });
    expect(await h.writeFile(id, '/etc/x', { ...save, extra: 'dropped' })).toEqual({ ok: true, value: 'done' });
    expect(f.requests.at(-1)).toEqual({ id, op: { op: 'writeFile', path: '/etc/x', save } });
    h.pinHosts(['not-a-uuid']);
    f.svc.viewClosed();
    expect(f.live()).toHaveLength(1); // the bad pin list was ignored
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

  it('a local file that is gone has its own text, not "cannot be edited here"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unimux-gone-'));
    try {
      const files = createLocalFiles({ platform: process.platform, trash: async () => undefined, openFolder: async () => undefined, showFile: () => undefined });
      const path = join(dir, 'moved.txt');
      expect(await files.readFile(path)).toEqual({ kind: 'error', message: FILE_GONE });
      expect(await files.statFile(path)).toBe('gone');
      expect(await files.writeFile(path, 'x', '')).toEqual({ ok: false, error: FILE_GONE });
      writeFileSync(path, 'hi');
      expect(await files.statFile(path)).toMatchObject({ size: 2 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
