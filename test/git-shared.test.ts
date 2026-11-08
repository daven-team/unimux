import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DETAILS_FORMAT, LOG_FORMAT, isCommitHash, isSafeRef, isSafeRemote, layoutGraph, normalizeRepoPath, parseBranches, parseDetails, parseDiffTree,
  parseLog, parseRefs, parseStatusV2, parseUnifiedDiff, parseWorktrees, projectRelativePath, redactSecrets, trimGitText, validateGitRequest,
} from '../src/shared/git';
import { chipRefs, groupChanges } from '../src/shared/gitUi';
import { messages } from '../src/shared/messages';

const NUL = '\0';
const US = '\x1f';

describe('ref and path validation', () => {
  it('accepts ordinary branch, tag and remote names', () => {
    for (const ok of ['main', 'feature/login-form', 'release-1.2.3', 'mc/cell-2', 'v1.0+build.5', 'user@work/topic', 'origin/main']) expect(isSafeRef(ok), ok).toBe(true);
  });

  it('rejects anything that could act as an option or break the command line', () => {
    const bad = ['', '-x', '--upload-pack=calc', '--exec=calc', '-', 'a b', 'a\nb', 'a\tb', 'a\0b', '..', 'a..b', 'a@{1}', '@', '/a', 'a/', 'a//b', '.hidden', 'a/.b', 'a.lock', 'a/b.lock/c', 'a\\b', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[b', 'ref"quote', "ref'quote", 'a;b', 'a|b', 'a$b', 'a`b', 'x'.repeat(201), 'a.', '\u202ea', 'zażółć'];
    for (const value of bad) expect(isSafeRef(value), JSON.stringify(value)).toBe(false);
    for (const value of [undefined, null, 5, {}, [], true]) expect(isSafeRef(value)).toBe(false);
  });

  it('validates remotes and hashes', () => {
    expect(isSafeRemote('origin')).toBe(true);
    expect(isSafeRemote('my-fork.2')).toBe(true);
    for (const bad of ['', '-origin', '--receive-pack=x', 'a b', 'a/b', 'a..b', 'x'.repeat(101)]) expect(isSafeRemote(bad), bad).toBe(false);
    expect(isCommitHash('deadbeef')).toBe(true);
    expect(isCommitHash('a'.repeat(40))).toBe(true);
    for (const bad of ['', 'abc', 'HEAD', 'main', '--all', 'deadbeeg', 'a'.repeat(65), 'dead beef']) expect(isCommitHash(bad), bad).toBe(false);
  });

  it('keeps paths inside the repository', () => {
    expect(normalizeRepoPath('src/a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('zażółć gęślą/plik ✓.txt')).toBe('zażółć gęślą/plik ✓.txt');
    expect(normalizeRepoPath('folder/')).toBe('folder/');
    expect(normalizeRepoPath('-rf')).toBe('-rf'); // safe behind --literal-pathspecs and the pathspec file
    expect(normalizeRepoPath('src\\a.ts', true)).toBe('src/a.ts');
    for (const bad of ['', '/etc/passwd', 'C:/Windows', 'C:\\Windows', '../x', 'a/../b', 'a/./b', './a', '.git/config', 'a/.GIT/hooks', 'a//b', 'a\nb', 'a\0b', 'x'.repeat(1001), '..']) expect(normalizeRepoPath(bad, true), JSON.stringify(bad)).toBeNull();
    expect(normalizeRepoPath('src\\a.ts', false)).toBe('src\\a.ts');
    for (const value of [undefined, null, 5, {}]) expect(normalizeRepoPath(value)).toBeNull();
  });

  it('finds the project relative path of a repository file from the relation main worked out', () => {
    expect(projectRelativePath({ kind: 'inside-root', prefix: '' }, 'src/a.ts', true)).toBe('src/a.ts');
    expect(projectRelativePath({ kind: 'inside-root', prefix: 'app' }, 'app/src/a.ts', true)).toBe('src/a.ts');
    expect(projectRelativePath({ kind: 'inside-root', prefix: 'App' }, 'app/src/a.ts', true)).toBe('src/a.ts'); // Windows: letter case does not matter
    expect(projectRelativePath({ kind: 'inside-root', prefix: 'app' }, 'other/a.ts', true)).toBeNull();
    expect(projectRelativePath({ kind: 'inside-root', prefix: 'app' }, 'app', true)).toBeNull();
    expect(projectRelativePath({ kind: 'inside-root', prefix: '' }, 'dir/', true)).toBe('dir');
    expect(projectRelativePath({ kind: 'inside-root', prefix: 'pkg' }, 'pkg/a.ts')).toBe('a.ts');
    expect(projectRelativePath({ kind: 'inside-root', prefix: 'Pkg' }, 'pkg/a.ts')).toBeNull(); // case matters off Windows
    expect(projectRelativePath({ kind: 'contains-root', prefix: 'vendor/lib' }, 'src/a.ts')).toBe('vendor/lib/src/a.ts');
    expect(projectRelativePath(null, 'a.ts')).toBeNull();
  });
});

describe('request validation', () => {
  const rid = 'req-12345678';

  it('normalizes a good request and drops unknown fields', () => {
    expect(validateGitRequest('log', { skip: 50, count: 50, search: 'fix', extra: 'x', path: 'src/a.ts' })).toEqual({ ok: true, value: { skip: 50, count: 50, search: 'fix', path: 'src/a.ts' } });
    expect(validateGitRequest('log', {})).toEqual({ ok: true, value: { skip: 0, count: 50 } });
    expect(validateGitRequest('status', { worktree: 'D:\\wt' })).toEqual({ ok: true, value: { worktree: 'D:\\wt' } });
    expect(validateGitRequest('diff', { source: 'commit', hash: 'deadbeef', path: 'a.txt', oldPath: 'b.txt' })).toEqual({ ok: true, value: { source: 'commit', hash: 'deadbeef', path: 'a.txt', oldPath: 'b.txt' } });
    expect(validateGitRequest('stage', { requestId: rid, paths: [], all: true })).toEqual({ ok: true, value: { requestId: rid, paths: [], all: true } });
    expect(validateGitRequest('push', { requestId: rid, remote: 'origin', branch: 'main', urlId: 'abcdef0123456789' }).ok).toBe(true);
    expect(validateGitRequest('commit', { requestId: rid, message: 'Dodaj ✓\n\nbody' }).ok).toBe(true);
    expect(validateGitRequest('checkout', { requestId: rid, branch: 'origin/x', remote: true })).toEqual({ ok: true, value: { requestId: rid, branch: 'origin/x', remote: true } });
  });

  it('refuses malformed requests', () => {
    const cases: Array<[Parameters<typeof validateGitRequest>[0], unknown]> = [
      ['status', null], ['status', 'x'], ['status', []], ['status', { worktree: 5 }], ['status', { worktree: 'a\0b' }],
      ['log', { skip: -1 }], ['log', { skip: 1.5 }], ['log', { skip: 2_000_000 }], ['log', { count: 0 }], ['log', { count: 201 }],
      ['log', { search: 5 }], ['log', { search: 'x'.repeat(201) }], ['log', { author: 'a\0' }], ['log', { path: '../x' }], ['log', { all: 'yes' }],
      ['show', { hash: 'HEAD' }], ['show', { hash: '--stat' }], ['show', {}],
      ['diff', { source: 'other', path: 'a' }], ['diff', { source: 'working', path: '/abs' }], ['diff', { source: 'commit', path: 'a' }],
      ['diff', { source: 'working', path: 'a', oldPath: '../b' }],
      ['fetch', {}], ['fetch', { requestId: 'short' }], ['fetch', { requestId: 'has space 12345' }], ['pull', { requestId: 5 }],
      ['push', { requestId: rid, remote: '--receive-pack=x', branch: 'main' }], ['push', { requestId: rid, remote: 'origin', branch: '-f' }],
      ['push', { requestId: rid, remote: 'origin' }], ['push', { requestId: rid, remote: 'origin', branch: 'main' }],
      ['push', { requestId: rid, remote: 'origin', branch: 'main', urlId: 'xyz' }], ['push', { requestId: rid, remote: 'origin', branch: 'main', urlId: 'ABCDEF0123456789' }],
      ['stage', { requestId: rid, paths: [] }], ['stage', { requestId: rid, paths: ['../a'] }], ['stage', { requestId: rid, paths: 'a' }],
      ['stage', { requestId: rid, paths: [5] }], ['stage', { requestId: rid, paths: new Array(2001).fill('a') }],
      ['unstage', { requestId: rid, paths: ['a'], all: 'x' }],
      ['commit', { requestId: rid, message: '   ' }], ['commit', { requestId: rid, message: 'a'.repeat(20_001) }],
      ['commit', { requestId: rid, message: 'a\0b' }], ['commit', { message: 'x' }],
      ['checkout', { requestId: rid, branch: '--orphan' }], ['checkout', { requestId: rid, branch: 'a b' }], ['checkout', { requestId: rid, branch: 'a', remote: 'yes' }],
    ];
    for (const [channel, request] of cases) expect(validateGitRequest(channel, request).ok, `${channel} ${JSON.stringify(request)}`).toBe(false);
  });
});

describe('output text', () => {
  it('removes credentials and control sequences', () => {
    expect(redactSecrets('fatal: unable to access https://user:s3cr3t@example.com/repo.git/')).toBe('fatal: unable to access https://***@example.com/repo.git/');
    expect(redactSecrets('ssh://git:pw@host:22/x')).toBe('ssh://***@host:22/x');
    expect(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked')).toBe('token *** leaked');
    expect(trimGitText('\x1b[31mred\x1b[0m\r\n\n\n\nafter\n')).toBe('red\n\nafter');
    expect(trimGitText("hint: Diverging branches can't be fast-forwarded\nhint:\nfatal: Not possible to fast-forward, aborting.\n")).toBe('fatal: Not possible to fast-forward, aborting.');
    expect(trimGitText('hint: only advice')).toBe('hint: only advice');
    const long = trimGitText('x'.repeat(2000), 100);
    expect(long.length).toBeLessThanOrEqual(101);
    expect(long.startsWith('…')).toBe(true);
  });
});

describe('status parser', () => {
  it('reads branch headers and every kind of record', () => {
    const out = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaaa bbbb src/some file.ts',
      '1 A. N... 000000 100644 100644 0000 bbbb zażółć.txt',
      '2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.txt', 'old name.txt',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.txt',
      '? untracked ✓.txt', '? folder/',
      '',
    ].join(NUL);
    const parsed = parseStatusV2(out);
    expect(parsed).toMatchObject({ branch: 'main', detached: false, head: '0123456', initial: false, upstream: 'origin/main', ahead: 2, behind: 1, truncated: false });
    expect(parsed.files.map((f) => [f.path, f.x, f.y, f.staged, f.unstaged, f.untracked, f.conflict, f.origPath])).toEqual([
      ['src/some file.ts', ' ', 'M', false, true, false, false, undefined],
      ['zażółć.txt', 'A', ' ', true, false, false, false, undefined],
      ['new name.txt', 'R', ' ', true, false, false, false, 'old name.txt'],
      ['conflicted.txt', 'U', 'U', false, false, false, true, undefined],
      ['untracked ✓.txt', '?', '?', false, false, true, false, undefined],
      ['folder/', '?', '?', false, false, true, false, undefined],
    ]);
  });

  it('handles detached HEAD, initial commit and the file limit', () => {
    expect(parseStatusV2(['# branch.oid abcdef0123456789', '# branch.head (detached)', ''].join(NUL))).toMatchObject({ branch: null, detached: true, head: 'abcdef0' });
    expect(parseStatusV2(['# branch.oid (initial)', '# branch.head main', '? a', ''].join(NUL))).toMatchObject({ branch: 'main', initial: true, head: '' });
    const many = Array.from({ length: 10 }, (_, i) => `? f${i}`).join(NUL);
    const limited = parseStatusV2(many, 4);
    expect(limited.files).toHaveLength(4);
    expect(limited.truncated).toBe(true);
    expect(parseStatusV2('').files).toEqual([]);
    expect(parseStatusV2(['garbage', '9 something', '1 short', ''].join(NUL)).files).toEqual([]);
  });
});

describe('log and details parsers', () => {
  const hash = (c: string) => c.repeat(40);

  it('parses -z records with refs, parents and unicode', () => {
    const record = (h: string, parents: string, subject: string, refs = '') => [h, h.slice(0, 7), parents, 'Zażółć G.', '1767323045', refs, subject].join(US);
    const out = [
      record(hash('a'), `${hash('b')} ${hash('c')}`, 'Merge ✓ "x"', 'HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, refs/remotes/origin/HEAD'),
      record(hash('b'), hash('d'), 'subject with\u001funit separator'),
      record(hash('d'), '', 'root'),
      '',
    ].join(NUL);
    const commits = parseLog(out);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toMatchObject({ short: 'aaaaaaa', author: 'Zażółć G.', at: 1767323045, subject: 'Merge ✓ "x"' });
    expect(commits[0].parents).toEqual([hash('b'), hash('c')]);
    expect(commits[0].refs).toEqual([{ name: 'main', kind: 'branch', current: true }, { name: 'v1.0', kind: 'tag' }, { name: 'origin/main', kind: 'remote' }]);
    expect(commits[1].subject).toBe('subject with\u001funit separator');
    expect(commits[2].parents).toEqual([]);
    expect(parseLog('')).toEqual([]);
    expect(parseLog('not a commit' + NUL)).toEqual([]);
  });

  it('parses refs', () => {
    expect(parseRefs('HEAD')).toEqual([{ name: 'HEAD', kind: 'head', current: true }]);
    expect(parseRefs('HEAD -> refs/heads/feature/x, refs/stash')).toEqual([{ name: 'feature/x', kind: 'branch', current: true }]);
    expect(parseRefs('')).toEqual([]);
  });

  it('keeps the format strings in sync with the parsers', () => {
    expect(LOG_FORMAT.split('%x1f')).toHaveLength(7);
    expect(DETAILS_FORMAT.startsWith(LOG_FORMAT)).toBe(true);
    const info = [hash('a'), 'aaaaaaa', hash('b'), 'Ann', '1767323045', '', 'subject', 'ann@example.com', 'subject\n\nbody: with\u001fcontrol\r\nline\n\n'].join(US);
    const details = parseDetails(info)!;
    expect(details.email).toBe('ann@example.com');
    expect(details.message).toBe('subject\n\nbody: with\u001fcontrol\nline');
    expect(parseDetails('x')).toBeNull();
  });

  it('parses diff-tree output with renames, binary files and the file limit', () => {
    const out = [
      ':100644 100644 aaaa bbbb M', 'src/a.ts',
      ':000000 100644 0000 cccc A', 'new file.txt',
      ':100644 100644 dddd eeee R087', 'old.txt', 'new.txt',
      ':100644 000000 ffff 0000 D', 'gone.bin',
      '3\t1\tsrc/a.ts', '10\t0\tnew file.txt', '2\t2\t', 'old.txt', 'new.txt', '-\t-\tgone.bin', '',
    ].join(NUL);
    const { files, truncated } = parseDiffTree(out);
    expect(truncated).toBe(false);
    expect(files).toEqual([
      { status: 'M', path: 'src/a.ts', added: 3, deleted: 1 },
      { status: 'A', path: 'new file.txt', added: 10, deleted: 0 },
      { status: 'R', origPath: 'old.txt', path: 'new.txt', added: 2, deleted: 2 },
      { status: 'D', path: 'gone.bin', added: null, deleted: null },
    ]);
    expect(parseDiffTree(out, 2)).toMatchObject({ truncated: true });
    expect(parseDiffTree(out, 2).files).toHaveLength(2);
    expect(parseDiffTree('').files).toEqual([]);
  });

  it('parses branches and worktrees', () => {
    const f = (...cols: string[]) => cols.join(US);
    const branches = parseBranches([
      f('refs/heads/main', 'main', 'abc1234', 'origin/main', 'ahead 1', '*'),
      f('refs/heads/feature/x', 'feature/x', 'def5678', '', '', ' '),
      f('refs/remotes/origin/main', 'origin/main', 'abc1234', '', '', ' '),
      f('refs/remotes/origin/HEAD', 'origin/HEAD', 'abc1234', '', '', ' '),
      f('refs/remotes/origin/HEAD', 'origin', 'abc1234', '', '', ' '),
      f('refs/tags/v1', 'v1', 'abc1234', '', '', ' '),
      'garbage', '',
    ].join('\n'));
    expect(branches.map((b) => [b.name, b.remote, b.current, b.upstream, b.track])).toEqual([
      ['main', false, true, 'origin/main', 'ahead 1'], ['feature/x', false, false, null, ''], ['origin/main', true, false, null, ''],
    ]);
    const list = parseWorktrees(['worktree D:/p/app', 'HEAD 0123456789abcdef', 'branch refs/heads/main', '', 'worktree D:/p/app-wt-a', 'HEAD fedcba9876543210', 'detached', ''].join('\n'));
    expect(list).toEqual([
      { path: 'D:/p/app', branch: 'main', head: '0123456', main: true, detached: false, allowed: true, isProject: false, preferred: false },
      { path: 'D:/p/app-wt-a', branch: null, head: 'fedcba9', main: false, detached: true, allowed: true, isProject: false, preferred: false },
    ]);
  });
});

describe('unified diff parser', () => {
  it('numbers lines, folds the header and marks notes and binary files', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt', 'index 111..222 100644', '--- a/a.txt', '+++ b/a.txt',
      '@@ -1,3 +1,4 @@ function x()', ' one', '-two', '+TWO', '+three', ' four', '\\ No newline at end of file',
      '@@ -20 +21 @@', '-old\r', '+new\r', '',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.header).toEqual(['diff --git a/a.txt b/a.txt', 'index 111..222 100644', '--- a/a.txt', '+++ b/a.txt']);
    expect(parsed.lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo])).toEqual([
      ['hunk', '@@ -1,3 +1,4 @@ function x()', undefined, undefined],
      ['ctx', 'one', 1, 1], ['del', 'two', 2, undefined], ['add', 'TWO', undefined, 2], ['add', 'three', undefined, 3], ['ctx', 'four', 3, 4],
      ['note', 'No newline at end of file', undefined, undefined],
      ['hunk', '@@ -20 +21 @@', undefined, undefined], ['del', 'old', 20, undefined], ['add', 'new', undefined, 21],
    ]);
    expect(parseUnifiedDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n').binary).toBe(true);
    expect(parseUnifiedDiff('').lines).toEqual([]);
  });

  it('treats a line starting with "--- " inside a hunk as content and cuts very long diffs', () => {
    const inside = parseUnifiedDiff(['@@ -1,2 +1,2 @@', '--- not a header', '+++ not a header either'].join('\n'));
    expect(inside.lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add']);
    const lines = ['@@ -1,5000 +1,5000 @@', ...Array.from({ length: 5000 }, (_, i) => `+line ${i}`)].join('\n');
    const cut = parseUnifiedDiff(lines, 100);
    expect(cut.cut).toBe(true);
    expect(cut.lines).toHaveLength(100);
  });
});

describe('commit graph', () => {
  const c = (hash: string, ...parents: string[]) => ({ hash, parents });

  it('keeps a linear history in one lane', () => {
    const rows = layoutGraph([c('a', 'b'), c('b', 'c'), c('c')]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows[0].bottom).toEqual(['b']);
    expect(rows[2].bottom).toEqual([]);
  });

  it('opens a lane for a merge parent and closes it when both lines meet', () => {
    const rows = layoutGraph([c('m', 'a', 'b'), c('a', 'base'), c('b', 'base'), c('base')]);
    expect(rows[0]).toMatchObject({ col: 0, bottom: ['a', 'b'], fromDot: [0, 1] });
    expect(rows[1]).toMatchObject({ col: 0, top: ['a', 'b'], bottom: ['base', 'b'] });
    expect(rows[2]).toMatchObject({ col: 1, top: ['base', 'b'], bottom: ['base'], fromDot: [0] });
    expect(rows[3]).toMatchObject({ col: 0, toDot: [0], bottom: [] });
  });

  it('survives a cut-off page, unordered parents and a repeated parent', () => {
    expect(layoutGraph([c('a', 'missing')]).map((r) => r.bottom)).toEqual([['missing']]);
    expect(() => layoutGraph([c('x', 'y', 'y', 'z'), c('z'), c('y')])).not.toThrow();
    expect(layoutGraph([])).toEqual([]);
    const wide = Array.from({ length: 40 }, (_, i) => c(`h${i}`, `h${i + 1}`, `side${i}`));
    expect(layoutGraph(wide)).toHaveLength(40);
  });
});

describe('panel helpers', () => {
  it('groups changes: a file with staged and unstaged parts is in both', () => {
    const file = (path: string, x: string, y: string, extra = {}) => ({ path, x, y, staged: x !== ' ', unstaged: y !== ' ', untracked: false, conflict: false, ...extra });
    const groups = groupChanges([
      file('a', 'M', 'M'), file('b', ' ', 'D'), file('c', 'A', ' '),
      file('d', '?', '?', { untracked: true, staged: false, unstaged: false }), file('e', 'U', 'U', { conflict: true, staged: false, unstaged: false }),
    ]);
    expect(groups.staged.map((f) => f.path)).toEqual(['a', 'c']);
    expect(groups.unstaged.map((f) => f.path)).toEqual(['a', 'b']);
    expect(groups.untracked.map((f) => f.path)).toEqual(['d']);
    expect(groups.conflict.map((f) => f.path)).toEqual(['e']);
  });

  it('orders ref chips and counts the rest', () => {
    const refs = parseRefs('tag: refs/tags/v1, refs/remotes/origin/main, refs/heads/other, HEAD -> refs/heads/main');
    const { shown, more } = chipRefs(refs, 3);
    expect(shown.map((r) => r.name)).toEqual(['main', 'other', 'v1']);
    expect(more).toBe(1);
  });
});

describe('translations of the strings the git engine sends', () => {
  // The Polish failure texts of 1.1.4's git engine (src/main/git.ts, gitHandler.ts; taken over when R1 removed them): the
  // Rust engine (unimux-git) sends the same keys, and the renderer translates them.
  const ENGINE_MESSAGES = [
    'Nie znaleziono polecenia git. Zainstaluj Git (git-scm.com) i uruchom aplikację ponownie.',
    'To repozytorium ma w konfiguracji programy, które git może uruchomić. Zaufaj mu, aby użyć tej operacji.',
    'To nie jest repozytorium git.',
    'Wynik polecenia git jest zbyt duży.',
    'Git nie odpowiedział w wyznaczonym czasie.',
    'Folder już nie istnieje.',
    'To żądanie zostało już wykonane.',
    'To nie jest worktree tego repozytorium.',
    'Nie ma takiego commita.',
    'Nie udało się odczytać commita.',
    'To nie jest nieśledzony plik tego repozytorium.',
    'To repozytorium nadrzędne wobec projektu: zapisy są wyłączone.',
    'Inna operacja git w tym repozytorium jeszcze trwa.',
    'Folder docelowy nie jest pusty. Klonować można tylko do pustego folderu.',
    'Nie można odczytać folderu docelowego.',
    'Nie można utworzyć folderu docelowego.',
    'Push wymaga gałęzi z co najmniej jednym commitem.',
    'Brak zdalnego repozytorium, do którego można wypchnąć tę gałąź.',
    'Cel push zmienił się od ostatniego odświeżenia. Odśwież panel i spróbuj ponownie.',
    'Nieprawidłowe żądanie git.',
    'To repozytorium ma już zdalne repozytorium.',
    'Nic nie jest dodane do commita. Dodaj najpierw pliki.',
    'Masz niezatwierdzone zmiany. Zatwierdź je lub odłóż, zanim zmienisz gałąź.',
    'Nie ma takiej gałęzi.',
    'Projekt już nie istnieje.',
  ];

  it('has a translation for every Polish message of the git engine, and the Rust engine still sends each', () => {
    const dir = join('src-tauri', 'crates', 'unimux-git', 'src');
    const rust = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.rs')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    for (const literal of ENGINE_MESSAGES) {
      expect(Object.hasOwn(messages, literal), literal).toBe(true);
      expect(rust.includes(`"${literal}"`), `unimux-git: ${literal}`).toBe(true);
    }
  });
});
