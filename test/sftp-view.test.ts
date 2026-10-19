import { describe, expect, it } from 'vitest';
import { parseOsc7, parseOsc99 } from '../src/shared/remoteCwd';
import type { TransferItem } from '../src/shared/sftp';
import {
  canRetry, clickSelect, deleteNames, DRIVES, dropRequest, EMPTY_HISTORY, EMPTY_SELECTION, filterEntries, forgetRemotePlace, formatBytes, goBack, goForward,
  kindLabel, liveSelection, localBasename, localCrumbs, localJoin, localParent, MAX_REMOTE_PLACES, mergeSnapshot, moveSelect, normalizeSftpPlaces,
  parseSftpDrag, percentOf, pushHistory, reenqueueRequest, rememberLocalPath, rememberRemotePath, remoteCrumbs, selectAll, sortEntries, toggleSort,
  validLocalPath, type PaneEntry,
} from '../src/shared/sftpView';
import { addSshHost, defaultState, normalizeState, removeSshHost } from '../src/shared/state';

const E = (name: string, kind: PaneEntry['kind'] = 'file', patch: Partial<PaneEntry> = {}): PaneEntry => ({ name, path: `/d/${name}`, kind, size: 0, mtime: 0, permissions: '', ...patch });

describe('OSC 7 and OSC 9;9 remote folders', () => {
  it('reads file://host/path with percent escapes, ignoring the host', () => {
    expect(parseOsc7('file://vps/home/alice/site')).toBe('/home/alice/site');
    expect(parseOsc7('file:///var/www')).toBe('/var/www');
    expect(parseOsc7('file://vps/home/alice/My%20Files/%C5%BC%C3%B3%C5%82w')).toBe('/home/alice/My Files/żółw');
    expect(parseOsc7('FILE://vps/tmp/')).toBe('/tmp');
    expect(parseOsc7('file://vps/a/./b/../c')).toBe('/a/c');
    expect(parseOsc7('file://vps/a?x=1#f')).toBe('/a');
  });

  it('refuses anything that is not an absolute POSIX folder', () => {
    for (const bad of ['', 'file://vps', 'http://vps/a', '/home/alice', 'file://vps/a%ZZ', 'file://vps/a%0Ab', 'file://vps/a%00', 'file://vps/a\\b', 'file://h/' + 'x'.repeat(9000)]) {
      expect(parseOsc7(bad), bad).toBeNull();
    }
  });

  it('takes POSIX paths from OSC 9;9 (quoted or not) and refuses Windows ones', () => {
    expect(parseOsc99('/home/alice')).toBe('/home/alice');
    expect(parseOsc99('"/srv/my app"')).toBe('/srv/my app');
    expect(parseOsc99('C:\\Users\\alice')).toBeNull();
    expect(parseOsc99('relative/dir')).toBeNull();
    expect(parseOsc99('/a\u0007b')).toBeNull();
  });
});

describe('sorting, filtering and kinds', () => {
  const list = [E('b.txt', 'file', { size: 30, mtime: 3 }), E('A', 'dir', { mtime: 9 }), E('a10.txt', 'file', { size: 10, mtime: 1 }), E('a2.txt', 'file', { size: 20, mtime: 2 }), E('link', 'symlink', { target: 'dir' })];
  it('lists folders (and links to folders) first in every order, names in natural order', () => {
    expect(sortEntries(list, { key: 'name', desc: false }).map((e) => e.name)).toEqual(['A', 'link', 'a2.txt', 'a10.txt', 'b.txt']);
    expect(sortEntries(list, { key: 'name', desc: true }).map((e) => e.name)).toEqual(['link', 'A', 'b.txt', 'a10.txt', 'a2.txt']);
    expect(sortEntries(list, { key: 'size', desc: true }).map((e) => e.name).slice(2)).toEqual(['b.txt', 'a2.txt', 'a10.txt']);
    expect(sortEntries(list, { key: 'mtime', desc: false }).map((e) => e.name).slice(2)).toEqual(['a10.txt', 'a2.txt', 'b.txt']);
  });
  it('toggles the direction on the same column and starts ascending on another', () => {
    expect(toggleSort({ key: 'name', desc: false }, 'name')).toEqual({ key: 'name', desc: true });
    expect(toggleSort({ key: 'name', desc: true }, 'size')).toEqual({ key: 'size', desc: false });
  });
  it('filters by a case-insensitive part of the name', () => {
    expect(filterEntries(list, ' A1 ').map((e) => e.name)).toEqual(['a10.txt']);
    expect(filterEntries(list, '')).toHaveLength(5);
  });
  it('names the kind', () => {
    expect(kindLabel(E('x', 'dir'))).toEqual({ key: 'Folder' });
    expect(kindLabel(E('x', 'symlink', { target: 'dir' }))).toEqual({ key: 'Dowiązanie do folderu' });
    expect(kindLabel(E('photo.JPG'))).toEqual({ key: 'Plik {ext}', params: { ext: 'JPG' } });
    expect(kindLabel(E('Makefile'))).toEqual({ key: 'Plik' });
    expect(kindLabel(E('.bashrc'))).toEqual({ key: 'Plik' });
  });
  it('formats sizes', () => {
    expect(formatBytes(12, 'en')).toBe('12 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024 * 1024, 'en')).toBe('5 GB');
    expect(formatBytes(-1, 'en')).toBe('0 B');
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('selects one row, toggles with Ctrl and spans with Shift from the anchor', () => {
    let s = clickSelect(EMPTY_SELECTION, order, 'b');
    expect(s.paths).toEqual(['b']);
    s = clickSelect(s, order, 'd', { shift: true });
    expect(s.paths).toEqual(['b', 'c', 'd']);
    s = clickSelect(s, order, 'c', { toggle: true });
    expect(s.paths).toEqual(['b', 'd']);
    s = clickSelect(s, order, 'e', { shift: true, toggle: true });
    expect(s.paths).toEqual(['b', 'd', 'c', 'e']);
  });
  it('moves the focus with the keyboard, extending with Shift', () => {
    let s = moveSelect(EMPTY_SELECTION, order, 1);
    expect(s).toEqual({ paths: ['a'], anchor: 'a', focus: 'a' });
    s = moveSelect(s, order, 2, true);
    expect(s.paths).toEqual(['a', 'b', 'c']);
    s = moveSelect(s, order, 'end');
    expect(s.paths).toEqual(['e']);
    expect(moveSelect(s, order, 10).focus).toBe('e');
    expect(moveSelect(EMPTY_SELECTION, [], 1)).toEqual(EMPTY_SELECTION);
    expect(selectAll(order).paths).toEqual(order);
  });
  it('keeps only rows still shown', () => {
    const s = liveSelection({ paths: ['a', 'x'], anchor: 'x', focus: 'a' }, order);
    expect(s).toEqual({ paths: ['a'], anchor: null, focus: 'a' });
    const same = { paths: ['a'], anchor: 'a', focus: 'a' };
    expect(liveSelection(same, order)).toBe(same);
  });
});

describe('history', () => {
  it('goes back and forward, a new folder drops the forward list', () => {
    let h = pushHistory(EMPTY_HISTORY, '/a', '/b');
    h = pushHistory(h, '/b', '/c');
    const back = goBack(h, '/c')!;
    expect(back.path).toBe('/b');
    const fwd = goForward(back.history, '/b')!;
    expect(fwd.path).toBe('/c');
    expect(pushHistory(back.history, '/b', '/x').forward).toEqual([]);
    expect(goBack(EMPTY_HISTORY, '/a')).toBeNull();
    expect(pushHistory(EMPTY_HISTORY, null, '/a')).toBe(EMPTY_HISTORY);
  });
});

describe('local paths', () => {
  it('goes up on Windows to the drive root, then to the drive list', () => {
    expect(localParent('C:\\Users\\alice', 'win32')).toBe('C:\\Users');
    expect(localParent('C:\\Users', 'win32')).toBe('C:\\');
    expect(localParent('C:\\', 'win32')).toBe(DRIVES);
    expect(localParent(DRIVES, 'win32')).toBeNull();
    expect(localParent('\\\\nas\\share\\x', 'win32')).toBe('\\\\nas\\share');
    expect(localParent('\\\\nas\\share', 'win32')).toBe(DRIVES);
  });
  it('goes up on macOS to "/" and no further', () => {
    expect(localParent('/Users/alice', 'posix')).toBe('/Users');
    expect(localParent('/', 'posix')).toBeNull();
  });
  it('joins names and builds the crumbs', () => {
    expect(localJoin('C:\\', 'a', 'win32')).toBe('C:\\a');
    expect(localJoin('C:\\a', 'b', 'win32')).toBe('C:\\a\\b');
    expect(localJoin('/Users', 'b', 'posix')).toBe('/Users/b');
    expect(localBasename('C:\\a\\b\\', 'win32')).toBe('b');
    expect(localCrumbs('C:\\Users\\alice', 'win32')).toEqual([{ label: 'C:', path: 'C:\\' }, { label: 'Users', path: 'C:\\Users' }, { label: 'alice', path: 'C:\\Users\\alice' }]);
    expect(localCrumbs(DRIVES, 'win32')).toEqual([]);
    expect(remoteCrumbs('/var/www')).toEqual([{ label: '/', path: '/' }, { label: 'var', path: '/var' }, { label: 'www', path: '/var/www' }]);
  });
  it('accepts only absolute local paths without control characters', () => {
    for (const ok of ['C:\\x', '/Users/a', '\\\\nas\\share']) expect(validLocalPath(ok), ok).toBe(true);
    for (const bad of ['', 'x', 'C:', 'C:\\a\nb', 42, null]) expect(validLocalPath(bad), String(bad)).toBe(false);
  });
});

describe('drag between the panes', () => {
  it('parses a valid payload and refuses junk', () => {
    expect(parseSftpDrag(JSON.stringify({ side: 'remote', paths: ['/a', '/b'] }))).toEqual({ side: 'remote', paths: ['/a', '/b'] });
    expect(parseSftpDrag(JSON.stringify({ side: 'local', paths: ['C:\\a'] }))).toEqual({ side: 'local', paths: ['C:\\a'] });
    for (const bad of ['', '{', JSON.stringify({ side: 'x', paths: ['/a'] }), JSON.stringify({ side: 'remote', paths: [] }), JSON.stringify({ side: 'remote', paths: ['a'] }), JSON.stringify({ side: 'remote', paths: ['/a\\b'] }), JSON.stringify({ side: 'local', paths: ['relative'] })]) {
      expect(parseSftpDrag(bad), bad).toBeNull();
    }
  });
  it('uploads onto the remote pane, downloads onto the local one, nothing onto its own pane', () => {
    expect(dropRequest({ side: 'local', paths: ['C:\\a'] }, 'remote', '/srv')).toEqual({ direction: 'upload', sources: ['C:\\a'], targetDir: '/srv' });
    expect(dropRequest({ side: 'remote', paths: ['/a'] }, 'local', 'C:\\x')).toEqual({ direction: 'download', sources: ['/a'], targetDir: 'C:\\x' });
    expect(dropRequest({ side: 'remote', paths: ['/a'] }, 'remote', '/b')).toBeNull();
  });
});

describe('transfers', () => {
  const item = (id: string, patch: Partial<TransferItem> = {}): TransferItem => ({ id, batchId: 'b', sessionId: 'local', direction: 'upload', source: 'C:\\a.txt', target: '/srv/a.txt', name: 'a.txt', bytesDone: 0, bytesTotal: 100, speed: 0, state: 'queued', ...patch });
  it('computes the percent', () => {
    expect(percentOf(item('1', { bytesDone: 50 }))).toBe(50);
    expect(percentOf(item('1', { bytesTotal: 0, state: 'done' }))).toBe(100);
    expect(percentOf(item('1', { bytesTotal: 0 }))).toBe(0);
  });
  it('keeps items failed by an SFTP Host crash when the new host sends an empty snapshot', () => {
    const crashed = item('1', { state: 'failed', error: 'sftpHostCrashed' });
    const merged = mergeSnapshot([crashed, item('2', { state: 'running' })], [item('3')]);
    expect(merged.map((i) => i.id)).toEqual(['1', '3']);
  });
  it('re-enqueues a crashed item into the folder of its target', () => {
    expect(reenqueueRequest(item('1'), 'win32')).toEqual({ direction: 'upload', sources: ['C:\\a.txt'], targetDir: '/srv' });
    expect(reenqueueRequest(item('1', { direction: 'download', source: '/srv/a.txt', target: 'C:\\x\\a.txt' }), 'win32')).toEqual({ direction: 'download', sources: ['/srv/a.txt'], targetDir: 'C:\\x' });
  });
  it('offers Retry for failed and cancelled items, never for unsafe names', () => {
    expect(canRetry(item('1', { state: 'failed', error: 'permission' }))).toBe(true);
    expect(canRetry(item('1', { state: 'cancelled' }))).toBe(true);
    expect(canRetry(item('1', { state: 'failed', error: 'invalidName' }))).toBe(false);
    expect(canRetry(item('1', { state: 'done' }))).toBe(false);
  });
  it('lists at most five names in the delete question', () => {
    expect(deleteNames(['a', 'b'])).toEqual({ shown: ['a', 'b'], more: 0 });
    expect(deleteNames(['1', '2', '3', '4', '5', '6', '7'])).toEqual({ shown: ['1', '2', '3', '4', '5'], more: 2 });
  });
});

describe('remembered SFTP folders in the app state', () => {
  const HOST = '11111111-2222-4333-8444-555555555555';
  it('defaults to no folders and normalizes junk away', () => {
    expect(defaultState().sftp).toEqual({ remotePaths: {} });
    expect(normalizeSftpPlaces(null)).toEqual({ remotePaths: {} });
    const raw = JSON.parse(`{"localPath":"relative","remotePaths":{"${HOST}":"/srv//www/","bad":"relative","x y":"/a","__proto__":"/p"}}`);
    expect(normalizeSftpPlaces(raw)).toEqual({ remotePaths: { [HOST]: '/srv/www' } });
    expect(normalizeSftpPlaces({ localPath: 'C:\\Users\\a', remotePaths: [] })).toEqual({ localPath: 'C:\\Users\\a', remotePaths: {} });
  });
  it('survives a state round trip and an old state without it', () => {
    let s = defaultState();
    s = { ...s, sftp: rememberRemotePath(rememberLocalPath(s.sftp, 'C:\\work'), HOST, '/var/www') };
    const back = normalizeState(JSON.parse(JSON.stringify(s)))!;
    expect(back.sftp).toEqual({ localPath: 'C:\\work', remotePaths: { [HOST]: '/var/www' } });
    const { sftp: _gone, ...old } = defaultState();
    expect(normalizeState(old)!.sftp).toEqual({ remotePaths: {} });
  });
  it('keeps the newest hosts up to the cap and forgets a removed host', () => {
    let places = normalizeSftpPlaces({});
    for (let i = 0; i < MAX_REMOTE_PLACES + 5; i++) places = rememberRemotePath(places, `h${i}`, `/p${i}`);
    expect(Object.keys(places.remotePaths)).toHaveLength(MAX_REMOTE_PLACES);
    expect(places.remotePaths.h0).toBeUndefined();
    expect(rememberRemotePath(places, 'h1', 'relative')).toBe(places);
    expect(forgetRemotePlace(places, `h${MAX_REMOTE_PLACES + 4}`).remotePaths[`h${MAX_REMOTE_PLACES + 4}`]).toBeUndefined();
    let s = addSshHost(defaultState(), { id: HOST, label: 'vps', address: 'vps', port: 22, username: 'a', createdAt: 0, updatedAt: 0 });
    s = { ...s, sftp: rememberRemotePath(s.sftp, HOST, '/srv') };
    expect(removeSshHost(s, HOST).sftp.remotePaths).toEqual({});
  });
});
