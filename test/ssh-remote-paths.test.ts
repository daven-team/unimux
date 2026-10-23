// Remote path completion of the SSH autocomplete (1.0.6, shared/remotePaths.ts) and the restore data of SSH cells.
import { describe, expect, it } from 'vitest';
import { popupKey, type KeyLike } from '../src/shared/commandSuggest';
import {
  changesFolder, commonStart, completeLine, cycleIndex, listScript, matchEntries, parseListing, pathToken, RemoteDirCache,
  REMOTE_LIST_LIMIT, restoreCwdInput, type RemoteEntry, type RemoteListResult,
} from '../src/shared/remotePaths';
import { normalizeSshCellRef, reconnectAtStartCells, restoresAtStart, resumeForPhase, type SshHost } from '../src/shared/ssh';
import { defaultState, findCell, normalizeState, patchSshCell, unlessRestoring } from '../src/shared/state';
import type { AppState } from '../src/shared/types';

const entries = (...names: string[]): RemoteEntry[] => names.map((n) => (n.endsWith('/') ? { name: n.slice(0, -1), dir: true } : { name: n, dir: false }));

describe('pathToken', () => {
  it('takes arguments of file commands and words with a slash', () => {
    expect(pathToken('cd /sr')).toMatchObject({ start: 3, value: '/sr', dir: '/', prefix: 'sr', dirsOnly: true, quote: null });
    expect(pathToken('vim TEST')).toMatchObject({ start: 4, dir: '', prefix: 'TEST', dirsOnly: false });
    expect(pathToken('cd ./')).toMatchObject({ dir: './', prefix: '' });
    expect(pathToken('cat ~/do')).toMatchObject({ dir: '~/', prefix: 'do' });
    expect(pathToken('git add src/ma')).toMatchObject({ dir: 'src/', prefix: 'ma' });
    expect(pathToken('sudo nano /etc/ng')).toMatchObject({ dir: '/etc/', prefix: 'ng' });
    expect(pathToken('ls -la && less READ')).toMatchObject({ prefix: 'READ' });
    expect(pathToken('echo hi > out')).toMatchObject({ prefix: 'out' });
    expect(pathToken('./scr')).toMatchObject({ dir: './', prefix: 'scr' });
    expect(pathToken('  vim ../x')).toMatchObject({ start: 6, dir: '../', prefix: 'x' });
  });

  it('leaves commands, options, variables, globs and other commands\' arguments alone', () => {
    expect(pathToken('vim')).toBeNull();
    expect(pathToken('vim ')).toBeNull();
    expect(pathToken('git checkout ma')).toBeNull();
    expect(pathToken('ls -l')).toBeNull();
    expect(pathToken('cat $HOME/x')).toBeNull();
    expect(pathToken('ls *.lo')).toBeNull();
    expect(pathToken('cd ~')).toBeNull();
    expect(pathToken('cd ~root/')).toBeNull();
    expect(pathToken('vim a\\')).toBeNull();
    expect(pathToken('cd /srv\u0007')).toBeNull();
  });

  it('reads quotes and backslashes like a shell', () => {
    expect(pathToken("vim 'my fi")).toMatchObject({ value: 'my fi', prefix: 'my fi', quote: "'" });
    expect(pathToken('vim "a b/c')).toMatchObject({ dir: 'a b/', prefix: 'c', quote: '"' });
    expect(pathToken('vim my\\ fi')).toMatchObject({ prefix: 'my fi', quote: null, start: 4 });
  });
});

describe('the listing script and its answer', () => {
  it('quotes what it is given and never trusts a relative cwd', () => {
    const script = listScript({ dir: "it's/", cwd: '/home/u' });
    expect(script).toContain(`d='it'\\''s/'`);
    expect(script).toContain(`c='/home/u'`);
    expect(script).toContain(`head -n ${REMOTE_LIST_LIMIT + 1}`);
    expect(listScript({ dir: '~/src/', cwd: 'relative' })).toContain(`c=''\nd="$HOME"/'src/'`);
    expect(listScript({ dir: '', cwd: null, cwdOnly: true })).not.toContain('ls -1ApL');
  });

  it('reads the folder, entries and markers, skipping what a .bashrc printed', () => {
    const out = 'Welcome!\n@cwd /home/u\n@dir /srv\nftp/\nwww/\nnotes.txt\n../\n';
    expect(parseListing(out)).toEqual({ ok: true, cwd: '/home/u', truncated: false, entries: entries('ftp/', 'www/', 'notes.txt') });
    expect(parseListing('@busy\n')).toEqual({ ok: false, reason: 'busy' });
    expect(parseListing('@cwd /x\n@nodir\n')).toEqual({ ok: false, reason: 'nodir' });
    expect(parseListing('sh: not found')).toEqual({ ok: false, reason: 'failed' });
    expect(parseListing('@cwd /root\n', true)).toEqual({ ok: true, cwd: '/root', entries: [], truncated: false });
    const many = `@cwd /\n@dir /\n${Array.from({ length: REMOTE_LIST_LIMIT + 1 }, (_, i) => `f${i}`).join('\n')}\n`;
    const r = parseListing(many) as Extract<RemoteListResult, { ok: true }>;
    expect(r.entries).toHaveLength(REMOTE_LIST_LIMIT);
    expect(r.truncated).toBe(true);
  });
});

describe('matching and completing', () => {
  const list = entries('TEST10', 'TEST2', 'TEST1', 'tests/', '.hidden', 'srv/', 'my file.txt', "it's");

  it('lists folders first, in natural order, hidden ones only for a dot', () => {
    expect(matchEntries(pathToken('vim TEST')!, list).map((e) => e.name)).toEqual(['TEST1', 'TEST2', 'TEST10']);
    expect(matchEntries(pathToken('vim t')!, list).map((e) => e.name)).toEqual(['tests']);
    expect(matchEntries(pathToken('vim .h')!, list).map((e) => e.name)).toEqual(['.hidden']);
    expect(matchEntries(pathToken('cd t')!, entries('test', 'tmp/')).map((e) => e.name)).toEqual(['tmp']);
    // Nothing with the exact case: any case.
    expect(matchEntries(pathToken('vim test1')!, list).map((e) => e.name)).toEqual(['TEST1', 'TEST10']);
    // The name typed in full is no suggestion; a folder still is (its '/' is missing).
    expect(matchEntries(pathToken('vim TEST10')!, list)).toEqual([]);
    expect(matchEntries(pathToken('cd srv')!, list).map((e) => e.name)).toEqual(['srv']);
  });

  it('writes the completed word like a shell would', () => {
    const t = pathToken('cd /sr')!;
    expect(completeLine('cd /sr', t, 'srv', 'dir')).toBe('cd /srv/');
    expect(completeLine('vim my', pathToken('vim my')!, 'my file.txt', 'file')).toBe('vim my\\ file.txt');
    expect(completeLine("vim 'my", pathToken("vim 'my")!, 'my file.txt', 'file')).toBe("vim 'my file.txt'");
    expect(completeLine("vim 'i", pathToken("vim 'i")!, "it's", 'file')).toBe("vim 'it'\\''s'");
    expect(completeLine('vim "a', pathToken('vim "a')!, 'a$b', 'dir')).toBe('vim "a\\$b/');
    expect(completeLine('cat ~/d', pathToken('cat ~/d')!, 'docs', 'dir')).toBe('cat ~/docs/');
    expect(completeLine('vim TE', pathToken('vim TE')!, 'TEST', 'partial')).toBe('vim TEST');
  });

  it('finds the common start and cycles with wrap-around', () => {
    expect(commonStart(['TEST1', 'TEST2', 'TEST10'])).toBe('TEST');
    expect(commonStart(['abc'])).toBe('abc');
    expect(commonStart([])).toBe('');
    expect(cycleIndex(-1, 3, 1)).toBe(0);
    expect(cycleIndex(-1, 3, -1)).toBe(2);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
  });

  it('cycles with Tab and Shift+Tab only over path entries', () => {
    const k = (shiftKey = false): KeyLike => ({ key: 'Tab', ctrlKey: false, altKey: false, metaKey: false, shiftKey });
    expect(popupKey(k(), { selected: -1, count: 3, ghost: false, paths: true })).toEqual({ kind: 'cycle', step: 1 });
    expect(popupKey(k(true), { selected: 0, count: 3, ghost: false, paths: true })).toEqual({ kind: 'cycle', step: -1 });
    expect(popupKey(k(), { selected: -1, count: 3, ghost: false })).toEqual({ kind: 'pass', hide: true });
  });

  it('knows which commands may change the folder and types the restore cd safely', () => {
    expect(changesFolder('cd /srv')).toBe(true);
    expect(changesFolder('ls && cd ..')).toBe(true);
    expect(changesFolder('popd')).toBe(true);
    expect(changesFolder('echo cdrom')).toBe(false);
    expect(restoreCwdInput('/srv/ftp')).toBe(" cd '/srv/ftp'\r");
    expect(restoreCwdInput("/srv/it's")).toBe(" cd '/srv/it'\\''s'\r");
    expect(restoreCwdInput('relative')).toBeNull();
    expect(restoreCwdInput('/a\nrm -rf ~')).toBeNull();
    expect(restoreCwdInput(42)).toBeNull();
  });
});

describe('RemoteDirCache', () => {
  function setup() {
    let clock = 0;
    const calls: Array<{ dir: string; cwd: string | null; resolve: (r: RemoteListResult) => void }> = [];
    let changed = 0;
    const cache = new RemoteDirCache((dir, cwd) => new Promise((resolve) => calls.push({ dir, cwd, resolve })), () => { changed++; }, () => clock, 1000);
    return { cache, calls, changed: () => changed, advance: (ms: number) => { clock += ms; } };
  }
  const ok = (...names: string[]): RemoteListResult => ({ ok: true, cwd: '/', entries: entries(...names), truncated: false });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('asks once, keeps the newest wanted folder while one runs and reuses fresh listings', async () => {
    const t = setup();
    expect(t.cache.get('/', null)).toBeUndefined();
    expect(t.cache.get('/', null)).toBeUndefined();
    t.cache.get('/s', null);
    t.cache.get('/sr', null);
    expect(t.calls).toHaveLength(1);
    t.calls[0].resolve(ok('srv/'));
    await flush();
    expect(t.changed()).toBe(1);
    expect(t.cache.get('/', null)).toEqual({ entries: entries('srv/') });
    // Only the newest folder asked meanwhile runs next.
    expect(t.calls.map((c) => c.dir)).toEqual(['/', '/sr']);
    t.calls[1].resolve(ok());
    await flush();
    // Stale: shown while it is asked again.
    t.advance(1500);
    expect(t.cache.get('/', null)).toEqual({ entries: entries('srv/') });
    expect(t.calls).toHaveLength(3);
  });

  it('forgets everything after a command and gives up on a server that refuses', async () => {
    const t = setup();
    t.cache.get('/', null);
    t.cache.clear();
    t.calls[0].resolve(ok('old'));
    await flush();
    expect(t.changed()).toBe(0);
    expect(t.cache.get('/', null)).toBeUndefined();
    for (let i = 1; i <= 3; i++) {
      t.calls[i].resolve({ ok: false, reason: 'unsupported' });
      await flush();
      t.advance(2000);
      if (i < 3) t.cache.get('/', null);
    }
    expect(t.cache.disabled).toBe(true);
    expect(t.cache.get('/x', null)).toBeNull();
  });

  it('keys listings by the shell folder too', async () => {
    const t = setup();
    t.cache.get('', '/a');
    t.calls[0].resolve(ok('x'));
    await flush();
    expect(t.cache.get('', '/b')).toBeUndefined();
    expect(t.calls[1]).toMatchObject({ dir: '', cwd: '/b' });
  });
});

describe('the restore data of SSH cells', () => {
  const hostId = '11111111-1111-4111-8111-111111111111';
  const host = { id: hostId, label: 'h', address: 'h', port: 22, username: 'u', createdAt: 0, updatedAt: 0 } as SshHost;
  function withCell(ssh: Record<string, unknown>, restore?: boolean): AppState {
    const d = defaultState();
    const raw = {
      ...d, settings: { ...d.settings, language: 'pl', ...(restore ? { sshRestoreSessions: true } : {}) }, sshHosts: [host],
      projects: [{ id: 'p', name: 'p', path: 'C:\\p', color: '#fff', archive: [], activeTabId: 't',
        tabs: [{ id: 't', name: 't', color: '#fff', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }, cells: [{ id: 'c', profileId: 'shell', ssh }] }] }],
    };
    return normalizeState(JSON.parse(JSON.stringify(raw)))!;
  }

  it('keeps only a sane folder and the resume mark', () => {
    expect(normalizeSshCellRef({ hostId, cwd: '/srv/ftp', resume: true, extra: 1 })).toEqual({ hostId, cwd: '/srv/ftp', resume: true });
    expect(normalizeSshCellRef({ hostId, cwd: 'srv', resume: 'yes' })).toEqual({ hostId });
    expect(normalizeSshCellRef({ hostId, cwd: '/a\nb' })).toEqual({ hostId });
    expect(findCell(withCell({ hostId, cwd: '/srv', resume: true }, true), 'c')!.cell.ssh).toEqual({ hostId, cwd: '/srv', resume: true });
  });

  it('patches the cell only when something changes', () => {
    const s = withCell({ hostId });
    expect(patchSshCell(s, 'c', { resume: false })).toBe(s);
    const on = patchSshCell(s, 'c', { resume: true, cwd: '/srv' });
    expect(findCell(on, 'c')!.cell.ssh).toEqual({ hostId, cwd: '/srv', resume: true });
    expect(patchSshCell(on, 'c', { cwd: '/srv' })).toBe(on);
    expect(findCell(patchSshCell(on, 'c', { resume: false }), 'c')!.cell.ssh).toEqual({ hostId, cwd: '/srv' });
    expect(patchSshCell(on, 'nope', { resume: false })).toBe(on);
  });

  it('follows the session phases', () => {
    expect(resumeForPhase('connected')).toBe(true);
    expect(resumeForPhase('closed')).toBe(false);
    expect(resumeForPhase('error')).toBe(false);
    expect(resumeForPhase('connecting')).toBeNull();
    expect(resumeForPhase('authenticating')).toBeNull();
  });

  it('restores marked cells only with the setting on; the host option still always reconnects', () => {
    const marked = withCell({ hostId, resume: true }, true);
    expect(reconnectAtStartCells(marked.projects, marked.sshHosts, true)).toEqual(['c']);
    expect(reconnectAtStartCells(marked.projects, marked.sshHosts, false)).toEqual([]);
    expect(restoresAtStart({ hostId }, [host], true)).toBe(false);
    expect(restoresAtStart({ hostId }, [{ ...host, reconnectOnStart: true }], false)).toBe(true);
  });

  it('drops last run\'s marks at load when the setting is off', () => {
    const on = withCell({ hostId, cwd: '/srv', resume: true }, true);
    expect(unlessRestoring(on)).toBe(on);
    const off = withCell({ hostId, cwd: '/srv', resume: true });
    expect(findCell(unlessRestoring(off), 'c')!.cell.ssh).toEqual({ hostId, cwd: '/srv' });
    const none = withCell({ hostId });
    expect(unlessRestoring(none)).toBe(none);
  });
});
