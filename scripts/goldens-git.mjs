// The git part of the golden corpus (1.2.0, PLAN G2), used by scripts/dump-goldens.mjs:
//
//   test/golden/git-shared.jsonl  {fn, args, out}: what a function of src/shared/git.ts answers (validators, request and clone
//                                 checks, the output parsers, the unified diff, the commit graph, the panel paths)
//   test/golden/git-trust.jsonl   {fn, args, out}: the pure trust functions of src/shared/gitTrust.ts, the fingerprint hash of
//                                 scan() (sha256 of JSON.stringify(fingerprint.sort())) and GitTrustStore's file format
//                                 (`store`: the text of git-trust.json -> the entries it keeps, and the text it writes after
//                                 set / delete, run through 1.1.4's own class on a scratch file)
//
// Checked by src-tauri/crates/unimux-git/tests/golden_shared.rs. Inputs come from a seeded PRNG (mulberry32), so the files are
// reproducible. No lone surrogates in the inputs (a Rust string cannot hold one).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rng } from './goldens-normalize.mjs';

const pickFrom = (r) => (xs) => xs[Math.floor(r() * xs.length)];
const NUL = '\0';
const US = '\x1f';

/** A string of `n` pieces from `pool`. */
const compose = (r, pool, max) => {
  const pick = pickFrom(r);
  let s = '';
  for (let n = Math.floor(r() * max); n > 0; n--) s += pick(pool);
  return s;
};

const NOT_STRINGS = [undefined, null, 5, 0, -1, 1.5, true, false, {}, [], ['a'], { a: 1 }];

export function gitSharedRows(git) {
  const r = rng(1401);
  const pick = pickFrom(r);
  const rows = [];
  const row = (fn, args, out) => rows.push({ fn, args, out });

  // ---------- ref, remote, hash and request id checks ----------
  const refPieces = ['main', 'feature', '/', '.', '..', '-', '@', '{', '@{', 'lock', '.lock', '+', '_', 'v1', 'x', 'A', '9', ' ', '\t', '\n', '\0', '\\', ':', '~',
    '^', '?', '*', '[', '"', "'", ';', '|', '$', '`', 'ż', '✓', '😀', '\u202e', '//', 'origin', 'HEAD', 'deadbeef', 'f', '0'];
  const fixedRefs = ['main', 'feature/login-form', 'release-1.2.3', 'mc/cell-2', 'v1.0+build.5', 'user@work/topic', 'origin/main', '', '-x', '--upload-pack=calc',
    '-', 'a b', '..', 'a..b', 'a@{1}', '@', '/a', 'a/', 'a//b', '.hidden', 'a/.b', 'a.lock', 'a/b.lock/c', 'a\\b', 'a:b', 'a.', '\u202ea', 'zażółć', 'x'.repeat(200),
    'x'.repeat(201), 'my-fork.2', 'x'.repeat(100), 'x'.repeat(101), 'abc', 'abcd', 'ABCDEF12', 'a'.repeat(64), 'a'.repeat(65), 'req-12345678', 'req_1234', 'req-1234567',
    'r'.repeat(64), 'r'.repeat(65), 'dead beef', 'deadbeeg', 'lock', 'a/lock', '.lock', 'a.lock.b', 'a/.lock'];
  const refInputs = [...fixedRefs, ...Array.from({ length: 500 }, () => compose(r, refPieces, 7)), ...NOT_STRINGS];
  for (const value of refInputs) {
    row('isSafeRef', [value], git.isSafeRef(value));
    row('isSafeRemote', [value], git.isSafeRemote(value));
    row('isCommitHash', [value], git.isCommitHash(value));
    row('isRequestId', [value], git.isRequestId(value));
  }

  // ---------- repository paths ----------
  const pathPieces = ['a', 'src', '/', '//', '\\', '.', '..', '.git', '.GIT', '.Git', 'GIT~1', 'git~1', 'progra~1', '~', '~x', '.git.', '.git ', '.git. .', ' ', 'x.', 'x ',
    ':', 'a:b', 'C:', 'c:', 'zażółć gęślą', 'plik ✓.txt', '😀', '-rf', '\n', '\0', '\x7f', '\x1f', 'ǅ', 'İ', '.gİt', 'K', 'file.txt', 'dir/', 'x'.repeat(300)];
  const fixedPaths = ['src/a.ts', 'zażółć gęślą/plik ✓.txt', 'folder/', '-rf', 'src\\a.ts', '', '/etc/passwd', 'C:/Windows', 'C:\\Windows', '../x', 'a/../b', 'a/./b', './a',
    '.git/config', 'a/.GIT/hooks', 'a//b', 'a\nb', 'a\0b', 'x'.repeat(1000), 'x'.repeat(1001), '..', 'GIT~1/config', 'a/GIT~1', '.git./config', '.git /config', 'a/.GIT.',
    'file.txt:stream', 'a./b', 'a /b', 'dir/name ', 'docs/readme.md', '/', 'a/', 'a//', '\\', 'a\\', 'x~', 'x~a', '1:', 'ab:', 'a\\..\\b'];
  for (const value of [...fixedPaths, ...Array.from({ length: 500 }, () => compose(r, pathPieces, 6)), ...NOT_STRINGS]) {
    for (const windows of [false, true]) row('normalizeRepoPath', [value, windows], git.normalizeRepoPath(value, windows));
  }

  // ---------- requests ----------
  const channels = ['status', 'log', 'show', 'diff', 'branches', 'fetch', 'pull', 'push', 'stage', 'unstage', 'commit', 'checkout', 'trust', 'trustGrant', 'trustRevoke'];
  const values = {
    worktree: ['D:\\wt', '', 'a\0b', 'x'.repeat(1000), 'x'.repeat(1001), 5, null, true, '/home/u/wt-ż'],
    skip: [0, 50, -1, 1.5, 1_000_000, 1_000_001, 2_000_000, null, '5', -0, 1e300],
    count: [1, 50, 200, 201, 0, 1.5, null, '50', 100.0],
    search: ['fix', '', 'x'.repeat(200), 'x'.repeat(201), 'a\0', 5, null, 'żółć 😀'],
    author: ['Ann', '', 'x'.repeat(100), 'x'.repeat(101), 'a\0', 5, null],
    path: ['src/a.ts', '', '../x', '/abs', 'a\\b', 'GIT~1/x', 5, null, '.git', 'dir/'],
    oldPath: ['b.txt', '', '../b', 5, null, 'a\\c'],
    all: [true, false, 'yes', 1, null],
    cached: [true, false, 'x', null, 0],
    hash: ['deadbeef', 'HEAD', '--stat', 'a'.repeat(40), 'ABCD', 'abc', 5, null],
    source: ['working', 'staged', 'commit', 'untracked', 'other', 5, null],
    requestId: ['req-12345678', 'short', 'has space 12345', 5, null, 'r'.repeat(64), 'r'.repeat(65), 'req_ok_1234'],
    remote: ['origin', '--receive-pack=x', 'my-fork.2', 'a/b', 5, null, 'a..b'],
    branch: ['main', '-f', 'origin/x', 'a b', '--orphan', 5, null, 'feature/x'],
    urlId: ['abcdef0123456789', 'xyz', 'ABCDEF0123456789', 'abcdef012345678', 5, null],
    paths: [[], ['a'], ['../a'], 'a', [5], ['a', 'b/c', 'd\\e'], null, ['', 'a']],
    message: ['fix', '   ', 'Dodaj ✓\n\nbody', 'a\0b', 5, null, '\u3000\ufeff', '\u0085'],
    trusted: [true],
    extra: ['x'],
  };
  const fieldsOf = {
    status: ['worktree', 'trusted'], branches: ['worktree'], trust: ['worktree', 'cached', 'trusted'],
    log: ['worktree', 'skip', 'count', 'search', 'author', 'path', 'all', 'extra'], show: ['worktree', 'hash'],
    diff: ['worktree', 'source', 'path', 'oldPath', 'hash'], fetch: ['worktree', 'requestId'], pull: ['worktree', 'requestId'],
    push: ['worktree', 'requestId', 'remote', 'branch', 'urlId'], stage: ['worktree', 'requestId', 'paths', 'all'], unstage: ['worktree', 'requestId', 'paths', 'all'],
    commit: ['worktree', 'requestId', 'message', 'trusted'], checkout: ['worktree', 'requestId', 'branch', 'remote'],
    trustGrant: ['worktree', 'requestId', 'trusted', 'state'], trustRevoke: ['worktree', 'requestId'],
  };
  values.remote = [...values.remote, true, false, 'yes'];
  values.state = ['trusted'];
  const fixedRequests = [
    ['log', { skip: 50, count: 50, search: 'fix', extra: 'x', path: 'src/a.ts' }], ['log', {}], ['status', { worktree: 'D:\\wt' }],
    ['diff', { source: 'commit', hash: 'deadbeef', path: 'a.txt', oldPath: 'b.txt' }], ['stage', { requestId: 'req-12345678', paths: [], all: true }],
    ['stage', { requestId: 'req-12345678', all: true }], ['unstage', { requestId: 'req-12345678', all: false }],
    ['push', { requestId: 'req-12345678', remote: 'origin', branch: 'main', urlId: 'abcdef0123456789' }], ['commit', { requestId: 'req-12345678', message: 'Dodaj ✓\n\nbody' }],
    ['checkout', { requestId: 'req-12345678', branch: 'origin/x', remote: true }], ['status', null], ['status', 'x'], ['status', []], ['status', 5],
    ['trustGrant', { requestId: 'req-12345678', trusted: true, state: 'trusted' }], ['trust', { trusted: true }], ['trust', { cached: true }],
    ['stage', { requestId: 'req-12345678', paths: new Array(2000).fill('a') }], ['stage', { requestId: 'req-12345678', paths: new Array(2001).fill('a') }],
    ['commit', { requestId: 'req-12345678', message: 'a'.repeat(20_000) }], ['commit', { requestId: 'req-12345678', message: 'a'.repeat(20_001) }],
  ];
  for (const [channel, input] of fixedRequests) for (const windows of [false, true]) row('validateGitRequest', [channel, input, windows], git.validateGitRequest(channel, input, windows));
  for (let i = 0; i < 1500; i++) {
    const channel = pick(channels);
    const input = {};
    for (const field of fieldsOf[channel]) if (r() < 0.75) input[field] = pick(values[field]);
    // a well-formed core more often than not, so the accepting paths are covered too
    if (r() < 0.5) {
      if ('requestId' in input || ['fetch', 'pull', 'push', 'stage', 'unstage', 'commit', 'checkout', 'trustGrant', 'trustRevoke'].includes(channel)) input.requestId = 'req-12345678';
    }
    const windows = r() < 0.5;
    const value = git.validateGitRequest(channel, input, windows);
    row('validateGitRequest', [channel, input, windows], value);
  }

  // ---------- clone ----------
  const urls = ['https://github.com/a/b.git', 'https://github.com/a/b', 'ssh://git@github.com/a/b.git', 'ssh://git@host:22/x', 'git@github.com:a/b.git', 'git@host:-x',
    'git@host:a/../b', 'https://user:pw@h/x', 'https://user@h/x', 'https://h/', 'https://h', 'https://h/x?y', 'https://h/x?', 'https://h/x#y', 'https://h/x#',
    'ext::sh -c x', 'file:///etc', 'http://h/x', '-https://h/x', 'https://-h/x', 'ssh://-oProxy/x', 'ssh://-u@h/x', 'ssh://u:p@h/x', 'https://h/a b', 'https://h/a\tb',
    'https://zażółć.pl/r.git', 'https://xn--zaw-9na0b8b.pl/r', 'https://[1:2:3:4:5:6:7:8]/x', 'https://h:99999/x', 'https://h:8443/x', 'HTTPS://H/X', 'https://h/x/',
    'https:/h/x', 'https:h/x', 'https://h\\x\\y', 'ssh://h', 'ssh:///x', 'ssh://h/', 'ssh://h/x', 'ssh://h:/x', 'u@h:p', 'ab@h:x', 'git@h:C:\\x', 'git@h:x:y',
    'https://h/%2e%2e/x', 'https://h/../x', 'https://h/a/..', 'https://1.2.3.4/x', 'https://0x7f.1/x', 'https://h%41/x', 'ssh://h%41/x', 'https://h./x', 'https://h/😀',
    'https://ex ample/x', 'x'.repeat(7), 'https://h/' + 'a'.repeat(1990), 'https://h/' + 'a'.repeat(1991), 'https://h/x\u00a0', 'https://h/x\u3000', 'https://h/x\u0085'];
  const urlPieces = ['https://', 'ssh://', 'git@', 'user:', 'pw@', 'host', 'h.example', '-', ':22', ':', '/', 'a', 'b.git', '..', '?', '#', '::', 'ż', '[::1]', '%41', '\\', '.git',
    'x', 'ext::', 'file://', '@'];
  for (const value of [...urls, ...Array.from({ length: 500 }, () => compose(r, urlPieces, 8)), ...NOT_STRINGS]) row('isCloneUrl', [value], git.isCloneUrl(value));
  const names = ['https://github.com/a/b.git', 'git@h:a/b.GIT', 'https://h/x/?q=1', 'https://h/x#frag', 'https://h/con.git', 'https://h/COM1', 'https://h/lpt9.git', 'https://h/aux.x',
    'https://h/...', 'https://h/.hidden', 'https://h/-x', 'https://h/a:b', 'https://h/a<b>c', 'https://h/' + 'n'.repeat(150), 'https://h/x?\ny', 'https://h/x?y\u2028z', '', '/',
    'https://h/x. . ', 'https://h/ż.git', 'https://h/😀'.repeat(60), 'a\\b\\c', 'x:y:z', 'https://h/.git', 'https://h/x.git.git', 'https://h/nul', 'https://h/con1'];
  for (const value of [...names, ...Array.from({ length: 300 }, () => compose(r, [...urlPieces, 'con', 'nul', ' ', '.', '"', '*', '\n', '\u2028', '😀'], 7))]) {
    row('cloneFolderName', [value], git.cloneFolderName(value));
  }
  const folders = ['repo', 'my repo', '.', '..', 'a.', 'a ', '-a', 'con', 'CON', 'con.txt', 'con.', 'con.\u2028', 'con.\n', 'com1', 'com10', 'lpt1.x', 'auxx', 'a/b', 'a\\b',
    'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\x01b', '', 'n'.repeat(100), 'n'.repeat(101), 'zażółć', '😀'.repeat(50), '😀'.repeat(51), 'a.b', ' a', 'nul.tar.gz'];
  for (const value of [...folders, ...Array.from({ length: 300 }, () => compose(r, ['a', 'con', '.', ' ', '-', '/', ':', 'ż', '\u2028', '1', 'lpt', 'x'], 5)), ...NOT_STRINGS]) {
    row('isSafeFolderName', [value], git.isSafeFolderName(value));
  }
  const cloneInputs = [
    { url: 'https://github.com/a/b.git', projectId: 'p1' }, { url: 'https://github.com/a/b.git', projectId: '' }, { url: 'https://github.com/a/b.git', projectId: 'x'.repeat(201) },
    { url: 'bad', projectId: 'p1' }, { url: 'git@h:a/b', parent: 'D:\\Projekty', name: 'b' }, { url: 'git@h:a/b', parent: 'D:/x', name: 'con' },
    { url: 'git@h:a/b', parent: '/home/u', name: 'b' }, { url: 'git@h:a/b', parent: '\\\\server\\share', name: 'b' }, { url: 'git@h:a/b', parent: '\\\\\\x', name: 'b' },
    { url: 'git@h:a/b', parent: 'relative', name: 'b' }, { url: 'git@h:a/b', parent: 'D:', name: 'b' }, { url: 'git@h:a/b', parent: 'D:/a\x01b', name: 'b' },
    { url: 'git@h:a/b', parent: '', name: 'b' }, { url: 'git@h:a/b', parent: 5, name: 'b' }, { url: 'git@h:a/b', parent: '/x', name: '..' }, { url: 'git@h:a/b', parent: '/x' },
    { url: 'git@h:a/b', parent: '/' + 'x'.repeat(1000), name: 'b' }, { url: 'git@h:a/b', parent: '/' + 'x'.repeat(999), name: 'b' }, null, [], 'x', {},
    { url: 'git@h:a/b', projectId: 5, parent: '/x', name: 'b' }, { url: 'git@h:a/b', parent: '/x\u007f', name: 'b' }, { url: 5, projectId: 'p' },
  ];
  for (const input of cloneInputs) row('validateCloneRequest', [input], git.validateCloneRequest(input));

  // ---------- text parsers ----------
  const oid = () => Array.from({ length: 40 }, () => pick('0123456789abcdef'.split(''))).join('');
  const filePaths = ['src/a.ts', 'a b.txt', 'zażółć.txt', 'folder/', 'x', '😀.md', 'dir/sub/file name.js', 'é', ''];
  const xyPool = ['.M', 'M.', 'MM', 'A.', '.D', 'R.', 'C.', 'UU', 'AA', '..', 'M', '', 'ż.', '😀.', '...'];
  const statusRecord = () => {
    const roll = r();
    if (roll < 0.15) return pick([`# branch.oid ${oid()}`, '# branch.oid (initial)', '# branch.head main', '# branch.head (detached)', '# branch.head feature/ż x',
      '# branch.upstream origin/main', `# branch.ab +${Math.floor(r() * 9)} -${Math.floor(r() * 9)}`, '# branch.ab +1 -x', '# branch.ab +99999999999999999999 -0', '# stash 2',
      '# branch.oid', '#nospace', '# ']);
    if (roll < 0.45) return `1 ${pick(xyPool)} N... 100644 100644 100644 aaaa bbbb ${pick(filePaths)}`;
    if (roll < 0.6) return [`2 ${pick(xyPool)} N... 100644 100644 100644 aaaa aaaa R100 ${pick(filePaths)}`, pick(filePaths)].join(NUL);
    if (roll < 0.7) return `u ${pick(xyPool)} N... 100644 100644 100644 100644 aaaa bbbb cccc ${pick(filePaths)}`;
    if (roll < 0.85) return `? ${pick(filePaths)}`;
    return pick(['! ignored', 'garbage', '9 something', '1 short', '2 short', 'u short', '?', '?x', '?é', '1  .M N... 1 2 3 a b c', '', '😀 x', '1 .M N... 100644 100644 100644 aaaa bbbb ']);
  };
  for (let i = 0; i < 400; i++) {
    const out = Array.from({ length: Math.floor(r() * 12) }, statusRecord).join(NUL) + (r() < 0.8 ? NUL : '');
    const limit = pick([3000, 3000, 2, 0, 5]);
    row('parseStatusV2', [out, limit], git.parseStatusV2(out, limit));
  }

  const refsPieces = ['HEAD', 'HEAD -> refs/heads/main', 'tag: refs/tags/v1.0', 'refs/remotes/origin/main', 'refs/remotes/origin/HEAD', 'refs/heads/feature/x', 'refs/stash',
    'refs/notes/x', ' refs/heads/sp ', 'HEAD -> refs/remotes/o/x', 'tag: refs/tags/ż', 'refs/heads/', 'HEAD ->', '', '\u3000refs/heads/w\u3000', 'grafted'];
  const refsText = () => Array.from({ length: Math.floor(r() * 5) }, () => pick(refsPieces)).join(pick([', ', ', ', ',', ',  ']));
  for (let i = 0; i < 300; i++) {
    const value = refsText();
    row('parseRefs', [value], git.parseRefs(value));
  }

  const commitRecord = () => {
    const h = r() < 0.9 ? oid() : pick(['HEAD', 'abc', 'zzzz', '']);
    const fields = [h, h.slice(0, 7), Array.from({ length: Math.floor(r() * 3) }, oid).join(pick([' ', '  '])), pick(['Zażółć G.', 'Ann', '', '😀 x']),
      pick(['1767323045', '0', '', ' 12 ', '1e3', '0x10', 'abc', '-5', 'Infinity', '1.5']), refsText(), pick(['subject', 'Merge ✓ "x"', '', 'with\u001funit', 'a\nb'])];
    if (r() < 0.1) fields.length = Math.floor(r() * 7);
    return (r() < 0.2 ? '\n' : '') + fields.join(US);
  };
  for (let i = 0; i < 300; i++) {
    const out = Array.from({ length: Math.floor(r() * 5) }, commitRecord).join(NUL) + (r() < 0.8 ? NUL : '') + (r() < 0.1 ? '  \n' : '');
    row('parseLog', [out], git.parseLog(out));
  }
  for (let i = 0; i < 200; i++) {
    const info = [commitRecord(), pick(['ann@example.com', '', 'ż@x']), pick(['subject\n\nbody: with\u001fcontrol\r\nline\n\n', 'm\r\n\r\n', '', '\u3000 x \u3000', 'a\u001fb\u001fc', 'x\u0085'])]
      .join(US);
    const text = r() < 0.1 ? pick(['x', '', 'a\u001fb']) : info;
    row('parseDetails', [text], git.parseDetails(text));
  }

  const diffTreeTokens = () => {
    const tokens = [];
    const n = Math.floor(r() * 6);
    const files = [];
    for (let k = 0; k < n; k++) {
      const status = pick(['M', 'A', 'D', 'R087', 'C100', 'T', 'R', '', 'ż', '😀']);
      const raw = r() < 0.9 ? `:100644 100644 aaaa bbbb ${status}` : pick([':nospace', ':', ': ']);
      tokens.push(raw);
      if (status.startsWith('R') || status.startsWith('C')) { const a = pick(filePaths); const b = pick(filePaths); tokens.push(a, b); files.push(['', a, b]); } else { const p = pick(filePaths); tokens.push(p); files.push([p]); }
    }
    for (const f of files) {
      if (r() < 0.15) continue;
      const num = () => pick(['3', '0', '-', '10', '99999999999999999999', 'x']);
      if (f.length === 3) tokens.push(`${num()}\t${num()}\t`, f[1], f[2]);
      else tokens.push(`${num()}\t${num()}\t${f[0]}`);
    }
    if (r() < 0.2) tokens.push(pick(['garbage', '1\t2', '\t\t', '-\t-\tline\nbreak']));
    return tokens.join(NUL) + (r() < 0.8 ? NUL : '');
  };
  for (let i = 0; i < 300; i++) {
    const out = diffTreeTokens();
    const limit = pick([500, 500, 2, 0]);
    const value = git.parseDiffTree(out, limit);
    row('parseDiffTree', [out, limit], value);
  }

  const branchLine = () => {
    const kind = pick(['refs/heads/', 'refs/remotes/', 'refs/tags/', 'refs/heads/', 'other/']);
    const name = pick(['main', 'feature/x', 'origin/main', 'origin/HEAD', 'origin', 'ż', '']);
    const cols = [`${kind}${name}`, kind === 'refs/remotes/' ? pick([name, 'origin', 'origin/HEAD', `o/${name}`]) : name, 'abc1234', pick(['origin/main', '', 'u']),
      pick(['ahead 1', '', 'behind 2', 'ahead 1, behind 2', 'gone']), pick(['*', ' ', '', 'x'])];
    if (r() < 0.1) cols.length = Math.floor(r() * 6);
    return cols.join(US) + (r() < 0.2 ? '\r' : '');
  };
  for (let i = 0; i < 300; i++) {
    const out = Array.from({ length: Math.floor(r() * 6) }, branchLine).join('\n') + (r() < 0.5 ? '\n' : '');
    row('parseBranches', [out], git.parseBranches(out));
  }

  const worktreeLine = () => pick(['worktree D:/p/app', 'worktree D:/p/app-wt-a', 'worktree /home/ż/wt', 'worktree ', `HEAD ${oid()}`, 'HEAD 01', 'HEAD 😀abcdefgh', 'branch refs/heads/main',
    'branch feature', 'branch refs/heads/', 'detached', 'bare', 'locked reason', 'prunable', '', 'detached\r', 'worktree D:/x\r']);
  for (let i = 0; i < 300; i++) {
    const out = Array.from({ length: Math.floor(r() * 10) }, worktreeLine).join('\n');
    row('parseWorktrees', [out], git.parseWorktrees(out));
  }

  const diffLine = () => pick(['diff --git a/a.txt b/a.txt', 'index 111..222 100644', '--- a/a.txt', '+++ b/a.txt', '@@ -1,3 +1,4 @@ function x()', '@@ -20 +21 @@', '@@ bad @@',
    '@@ -99999999999999999999 +1 @@', ' one', '-two', '+TWO', '+three', ' four', '\\ No newline at end of file', '\\', '-old\r', '+new\r', 'Binary files a/x and b/x differ',
    'Binary files a/x\rand b differ', 'Binary files a/x\u2028 differ', 'GIT binary patch', 'new file mode 100644', 'deleted file mode', 'similarity index 90%', 'rename from a',
    'copy to b', 'dissimilarity index 1%', 'old mode 1', 'new mode 2', 'other text', '', 'żółw', '😀x', 'x😀', '\r', '--- not a header', '+++ not a header either']);
  for (let i = 0; i < 300; i++) {
    const text = Array.from({ length: Math.floor(r() * 25) }, diffLine).join('\n') + (r() < 0.5 ? '\n' : '');
    const max = pick([4000, 4000, 3, 0, 10]);
    row('parseUnifiedDiff', [text, max], git.parseUnifiedDiff(text, max));
  }

  // ---------- commit graph ----------
  for (let i = 0; i < 300; i++) {
    const n = Math.floor(r() * (i < 200 ? 12 : 40));
    const hashes = Array.from({ length: n }, (_, k) => `h${k}`);
    const commits = hashes.map((hash, k) => {
      const parents = [];
      for (let p = Math.floor(r() * (r() < 0.7 ? 2 : 4)); p > 0; p--) {
        const roll = r();
        parents.push(roll < 0.6 ? `h${k + 1 + Math.floor(r() * 3)}` : roll < 0.8 ? `missing${Math.floor(r() * 3)}` : roll < 0.9 ? `h${Math.floor(r() * n)}` : parents[0] ?? 'h0');
      }
      return { hash, parents };
    });
    if (r() < 0.1 && n > 1) commits.reverse();
    row('layoutGraph', [commits], git.layoutGraph(commits));
  }

  // ---------- panel paths ----------
  const prefixes = ['', 'app', 'App', 'pkg/sub', 'ż', 'İ', 'vendor/lib', 'ǅ'];
  const files = ['src/a.ts', 'app/src/a.ts', 'APP/x', 'app', 'app/', 'app//', 'other/a.ts', 'dir/', 'pkg/sub/x', 'Ż/x', 'ż/x', 'i̇/x', 'İ/x', 'ǆ/x', 'ǅ/y', ''];
  for (let i = 0; i < 300; i++) {
    const relation = r() < 0.1 ? null : { kind: pick(['inside-root', 'contains-root']), prefix: pick(prefixes) };
    const file = pick(files);
    const windows = r() < 0.5;
    row('projectRelativePath', [relation, file, windows], git.projectRelativePath(relation, file, windows));
  }
  const projects = ['D:\\Projekty\\app', 'D:/Projekty/app/', 'd:\\projekty\\APP\\\\', '/home/u/app', '/home/u/App', 'app', '', 'C:\\', '\\\\srv\\share\\App', '//srv/Share/x',
    'D:\\Projekty\\Żółw', 'x/', '/'];
  const worktrees = ['D:/Projekty/app', 'D:/Projekty/app/sub/wt', 'D:/Projekty/app-wt-fix-login', 'D:/Projekty/app-wt-fix-login/nested', 'D:/Projekty/other', 'D:/Projekty/app2',
    'C:/Users/me', 'D:/Elsewhere/wt', 'd:\\projekty\\APP-wt-x', '/home/u/app-wt-a', '/home/u/App-wt-a', 'ap/app-wt-x', 'ap/app-wt-x/y', 'app-wt-', '/app-wt-z', 'D:/Projekty/żółw-wt-a',
    'd:/projekty/Żółw-wt-a', '//srv/share/app-wt-q', 'x-wt-1', ''];
  for (let i = 0; i < 400; i++) {
    const project = pick(projects);
    const wt = pick(worktrees);
    const extra = r() < 0.3 ? [pick(worktrees), 'D:\\Elsewhere\\wt'] : [];
    row('worktreeAllowed', [project, wt, extra], git.worktreeAllowed(project, wt, extra));
  }
  return rows;
}

export function gitTrustRows(gitTrust, { GitTrustStore }) {
  const r = rng(1402);
  const pick = pickFrom(r);
  const rows = [];
  const row = (fn, args, out) => rows.push({ fn, args, out });

  const configPieces = ['core.bare', '\n', 'false', '\0', 'user.name', 'A B', 'core.noValue', 'a.b', 'line1\nline2', '', 'ż', '😀', '=', 'x'];
  for (const text of ['core.bare\nfalse\0user.name\nA B\0core.noValue\0', '', 'a.b\nline1\nline2\0', '\0\0', '\n', 'k\n\0', ...Array.from({ length: 200 }, () => compose(r, configPieces, 10))]) {
    row('parseConfigList', [text], gitTrust.parseConfigList(text));
  }

  const keys = ['filter.lfs.clean', 'filter.a.smudge', 'filter.a.process', 'filter..clean', 'filter.a.b.clean', 'Filter.X.Clean', 'filter.\n.clean', 'filter.\u2028.clean',
    'diff.a.textconv', 'diff.a.command', 'diff.external', 'diff.a.binary', 'merge.a.driver', 'merge.a.recursivedriver', 'core.fsmonitor', 'core.hooksPath', 'core.sshCommand',
    'core.pager', 'core.editor', 'core.askPass', 'core.gitProxy', 'core.worktree', 'core.autocrlf', 'core.bare', 'remote.origin.uploadpack', 'remote.origin.receivepack',
    'remote.origin.uploadarchive', 'remote.origin.proxy', 'remote.origin.vcs', 'remote.origin.url', 'remote.origin.fetch', 'credential.helper', 'credential.https://h.helper',
    'credential.useHttpPath', 'url.https://evil/.insteadOf', 'url.https://evil/.pushInsteadOf', 'url.https://user:s3cr3t@evil.example/.insteadOf', 'protocol.file.allow',
    'protocol.allow', 'include.path', 'includeIf.gitdir:/x/.path', 'includeif..path', 'gpg.program', 'gpg.ssh.program', 'gpg.x509.program', 'gpg.openpgp.program', 'gpg.foo.program',
    'pager.log', 'pager.', 'uploadpack.packObjectsHook', 'sequence.editor', 'interactive.diffFilter', 'submodule.s.update', 'alias.x', 'user.name', 'branch.main.remote',
    'FİLTER.x.clean', 'K.x', 'core.ſshcommand', 'CORE.SSHCOMMAND', 'credential.\n.helper', 'submodule..update', 'url.ghp_0123456789abcdefghijABCD.insteadOf'];
  const vals = ['x', '', ' ', 'false', 'FALSE', 'no', 'Off', '0', '00', 'true', '/bin/x', '!x', ' !x ', 'C:\\x\\y.exe', 'c:/x', '\\\\srv\\x', 'manager', 'checkout', '\u3000false\u3000',
    'ſalse', 'secret-command', '\u0085false', 'D:x'];
  const fixedEntries = [
    keys.map((key) => ({ key, value: 'x' })),
    [{ key: 'core.fsmonitor', value: '/bin/x' }, { key: 'core.fsmonitor', value: 'false' }],
    [{ key: 'url.https://user:s3cr3t@evil.example/.insteadOf', value: 'https://good/' }, { key: 'core.sshCommand', value: 'secret-command' }],
  ];
  for (const entries of [...fixedEntries, ...Array.from({ length: 400 }, () => Array.from({ length: Math.floor(r() * 6) }, () => ({ key: pick(keys), value: pick(vals) })))]) {
    row('dangerousConfigKeys', [entries], gitTrust.dangerousConfigKeys(entries));
  }

  const attrPieces = ['*.png', ' ', '\t', 'filter=lfs', 'diff=lfs', 'merge=lfs', '-text', 'text', '\n', '\r\n', '\r', '#', '# c', 'diff=hex', 'filter=', 'xfilter=a', 'diff=Ż',
    'merge=a=b', '\u3000', 'filter=ż\u00a0x', '\u0085diff=y', 'diff="q"', '😀'];
  const attrTexts = ['# c\n*.png filter=lfs diff=lfs merge=lfs -text\n*.md text\n\n*.dat   diff=hex\n', '', ...Array.from({ length: 300 }, () => compose(r, attrPieces, 12))];
  for (const text of attrTexts) row('attributeDrivers', [text], gitTrust.attributeDrivers(text));
  const driverKeys = ['filter.lfs.clean', 'diff.hex.textconv', 'diff.lfs.binary', 'merge.lfs.driver', 'filter.LFS.smudge', 'diff.ż.command', 'filter.x.process', 'merge.a=b.driver',
    'Filter.Lfs.Clean', 'diff.İ.textconv', 'diff.i̇.textconv'];
  for (let i = 0; i < 300; i++) {
    const attributes = gitTrust.attributeDrivers(pick(attrTexts));
    attributes.push(...Array.from({ length: Math.floor(r() * 3) }, () => ({ kind: pick(['filter', 'diff', 'merge']), name: pick(['lfs', 'LFS', 'hex', 'ż', 'Ż', 'x', 'İ', 'a=b']) })));
    const all = Array.from({ length: Math.floor(r() * 6) }, () => ({ key: pick(driverKeys), value: 'x' }));
    row('configuredAttributeDrivers', [attributes, all], gitTrust.configuredAttributeDrivers(attributes, all));
  }

  // the hash of a scan: exactly the expression of src/main/git.ts scan()
  const printPieces = ['config:core.sshcommand=', 'attr:.gitattributes: filter=lfs', 'hook:pre-commit:', 'a', 'B', 'ż', '😀', '\uffff', '\ue000', '"', '\\', '\n', '\u2028', '\x01',
    '\x7f', '\u00e9', 'e\u0301', ' ', '=', '/'];
  for (let i = 0; i < 300; i++) {
    const fingerprint = Array.from({ length: Math.floor(r() * 8) }, () => compose(r, printPieces, 6));
    const input = [...fingerprint];
    const hash = createHash('sha256').update(JSON.stringify(fingerprint.sort())).digest('hex');
    row('fingerprintHash', [input], { sorted: fingerprint, hash });
  }

  // GitTrustStore's file: what the constructor keeps and what save() writes (1.1.4's class on a scratch file)
  const dir = mkdtempSync(join(tmpdir(), 'mc-golden-trust-'));
  try {
    const file = join(dir, 'git-trust.json');
    const texts = ['', '{}', '[]', 'null', '"x"', '5', 'not json', '\ufeff{"d:/a":"h"}', '{"d:/a":"h1","d:/b":"h2"}', '{"d:/a":"h1","d:/a":"h2"}', '{"d:/a":5,"d:/b":"h"}',
      '["x",1,"y"]', '{"7":"i","d:/a":"h","1":"j"}', '{"__proto__":"p","a":"b"}', '{"a":{"b":"c"},"d":"e"}', '{"ż/😀":"h\\u0001"}', '{\n  "d:/a": "h"\n}\n', '{"a":"b"} x',
      '{"4294967295":"big","4294967294":"idx"}'];
    for (let i = 0; i < 60; i++) {
      const text = pick(texts);
      const ops = Array.from({ length: Math.floor(r() * 5) }, () => (r() < 0.65 ? ['set', pick(['d:/a', 'd:/b', '/home/x', '7', 'ż', '__proto__', '0']), pick(['h1', 'h2', 'ż'])] : ['delete', pick(['d:/a', 'd:/b', '7', 'none'])]));
      writeFileSync(file, text);
      const store = new GitTrustStore(file);
      const loaded = [...store.map.entries()];
      let saved = null;
      rmSync(file, { force: true });
      for (const [op, key, value] of ops) {
        // the canonical-path key is the caller's (here a ready key); the map and save() are 1.1.4's
        if (op === 'set') { store.map.set(key, value); store.save(); } else if (store.map.delete(key)) store.save();
      }
      if (existsSync(file)) saved = readFileSync(file, 'utf8');
      row('trustStore', [text, ops], { loaded, saved });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}
