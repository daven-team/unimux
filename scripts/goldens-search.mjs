// The project search part of the golden corpus (1.2.0, PLAN G7), used by scripts/dump-goldens.mjs. Every answer comes from the
// real TS code of 1.1.4 (src/shared/search.ts and src/main/search.ts) under V8:
//
//   test/golden/search-pattern.jsonl  {options} -> buildPattern (the compiled source and flags, or the error message) and, on
//                                      the shared sample text, searchText's matches (UTF-16 lines, columns, previews) and
//                                      replaceInText with a token-heavy replacement (all matches, then only the second one)
//   test/golden/search-compile.jsonl  first row {text}; then 4000 seeded random patterns -> the compiled flags or V8's error and
//                                      the [line, column, text] of the first 20 matches in `text`
//   test/golden/search-glob.jsonl     {spec} -> compileGlobs(spec) over a fixed list of paths (null = no filter)
//   test/golden/search-project.jsonl  first row {layout}: the scratch project; then {options} -> searchProject over it
//   test/golden/search-replace.jsonl  first row {layout}; then {request} -> replaceInProject on a fresh copy of it, the files
//                                      whose bytes changed afterwards and the names of every file left
//
// Strings in the answers are made well-formed (`toWellFormed`: a lone surrogate becomes U+FFFD, one UTF-16 unit for one): a
// preview cut through a surrogate pair holds a lone half in 1.1.4, which a Rust string (and JSON over the Tauri bridge) cannot.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rng } from './goldens-normalize.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const utf16 = (text, be = false) => {
  const out = Buffer.from('\ufeff' + text, 'utf16le');
  return be ? out.swap16() : out;
};
const utf8 = (text, bom = false) => Buffer.from((bom ? '\ufeff' : '') + text, 'utf8');

/** A copy of `value` with every string well-formed (see the header). */
const wellFormed = (value) => {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wellFormed(v)]));
  return value;
};

// ── the shared sample text ──────────────────────────────────────────────────
const EMOJI_CUT = `${'😀'.repeat(40)}needle${'👍🏽'.repeat(60)}`;
export const SAMPLE_TEXT = [
  'Zażółć gęślą jaźń',
  'ZAŻÓŁĆ GĘŚLĄ JAŹŃ\tżółw żółwik mały-żółw żółw_x',
  'emoji 😀 and 👍🏽 here 😀😀 🙂.🙂 a😀c',
  'id=12 id=7 ID=٣ id=１２ x1y22z333',
  'ann@home bob@work ąę@łódź',
  'σίσυφος ΣΊΣΥΦΟΣ ς σ Σ ß SS ẞ K k \u212a ſ s S İ i ı I',
  'cost $5, cost $6 $$ $& a.b A.B axb [x] (y) {z} \\ / ^ | * + ? -',
  'tab\there\u00a0nbsp\u2028ls\ufeffbom  end\u000bvt\u000cff',
  'combining e\u0301 é cafe\u0301 café',
  'cat concat cat_ cat cats Cat CAT',
  'foo.bar foo-bar foo_bar FOO foo123 123foo',
  'name: ann\tname: bob',
  '',
  `${'x'.repeat(200)}needle${'y'.repeat(400)}`,
  EMOJI_CUT,
  'a'.repeat(5001),
  'aaa abab abba xyzzy',
  'ﬁle ﬀ ﬁ ßẞ',
  'Łódź łódź ŁÓDŹ lodz',
  'end without newline',
].reduce((text, line, i) => text + (i ? ['\n', '\r\n', '\r'][i % 3] : '') + line, '');

// ── patterns ────────────────────────────────────────────────────────────────
const LITERALS = [
  'a', 'żółw', 'ŻÓŁW', 'Zażółć', 'a.b', 'cost $5', '$&', '$$', '[x]', '(y)', '{z}', '\\', '/', '^', '|', '*', '+', '?', '-', '😀', '👍🏽',
  'needle', 'cat', 'Cat', 'ς', 'σ', 'Σ', 'ß', 'SS', 'ẞ', 'k', 'K', '\u212a', 'ſ', 's', 'İ', 'i', 'ı', 'I', 'é', 'e\u0301', 'ﬁ',
  'name: ', '  ', '\t', 'łódź', 'ŁÓDŹ', 'lodz', 'foo', 'foo_bar', '123', '١٢', 'aa', 'ab', 'x', 'y', 'nbsp', '\u00a0', 'a😀c', 'ąę@łódź',
];

const REGEXES = [
  'id=(\\d+)', '(\\w+)@(?<host>\\w+)', '^\\s*\\w', '$', '^', 'a|', '(?<=\\$)\\d+', '(?<!a)b', '\\bfoo\\b', '\\Bfoo', '.', '..', '[^a]', '\\u{1F600}',
  '\\p{Lu}', '\\P{L}+', '\\p{L}+', '\\p{Script=Greek}+', '\\p{Emoji_Presentation}', '\\p{Lu', '[ąćęłńóśźż]+', 'ż+', 'Ż', '(a)\\1', '\\1(a)', '(?<n>a)\\k<n>',
  '\\k<n>', '(?<n>a)\\k<m>', '(?<n>a)\\k', 'x{2,3}', 'x{3,2}', 'x{,3}', 'x{2,}', 'x{2}', '(', ')', '[', ']', '{', '}', '*', '+a', 'a**', 'a{1}{2}', '\\',
  '[b-a]', '(?<a>x)(?<a>y)', '(?<a>x)|(?<a>y)', '(?<1a>x)', '(?:', '(?=a)*', '(?<=a)*', '(?!a)+', '\\c', '\\cA', '[\\c]', '\\0', '\\07', '\\8', '\\08',
  '[\\d-z]', '[a-\\d]', '\\x4', '\\x41', '\\u00e', '\\u0105', '\\u{105}', '🙂', '.🙂', '^.$', '[😀]', '[😀]+', '\\S+', '\\s', '\\s+', 'a.c', '(?i)', '(?i:a)b',
  '(?-i:a)', '(?i-i:a)', '(?ii:a)', '(?x:a)', '(?m:^a)', '(?s:.)', '[[a]]', '\\$', '\\$\\d', 'a{2}', '\\w+', '\\W+', '\\d+', '\\D+', '[\\w-]+', '\\-',
  '[\\-]', '\\/', '\\a', '\\e', '\\_', '\\ą', '(a)|b', '(a)?b', '(?:a|b)+', 'a+?', 'a*?b', '(a*)*b', '(?=(a+))a*b\\1', '(?<year>\\d{4})-(?<m>\\d\\d)',
  'name: (\\w+)', '(\\w+)\\t(\\w+)', '\\p{N}+', '[\\p{L}--\\p{Ll}]', '\\p{ASCII}+', '[^\\x00-\\x7f]+', '\\uD83D\\uDE00', '\\uD83D', '\\uDE00', '[\\uD83D\\uDE00]',
  '\\p{Lowercase_Letter}', '\\p{gc=Lu}', '\\p{sc=Latn}+', '\\p{Unknown}', '[\\s\\S]', '[^]', '[]', 'a{', 'a{1', 'a{1,', 'a{1,2', '{1}', 'x{99999999999}',
  '(?<𝒜>x)', '(?<ż>x)\\k<ż>', '(?<$>x)', '(?<a-b>x)', '(?<=(a))b', '(?<!(?<x>a))b', 'ab|cd|', '|', '||', 'ς', 'Σ+', 'ß', '\\u212a', 'k', 'ſ', 'S', 'İ', 'ı',
  '[k]', '[a-z]+', '[A-Z]+', '[\\u0100-\\u017f]+', '[^\\s]+', '\\cJ', '\\c1', '[\\c1]', '[\\c_]', '\\ca', '\\k', '\\p', '\\P', '\\u', '\\x', '\\]', '\\}', '\\{',
  'a(?=b)', 'a(?!b)', '(?=a)', '(?:)', '()', '(|a)', 'a(?<x>b)?c', '(?<x>a)|b', '$1', '\\b', '\\B', '^$', '\\n', '\\r', '\\t', '\\v', '\\f', '[\\b]', '[\\B]',
  '\\d{2}', '\\d{1,2}(?!\\d)', '(\\d)(\\d)?', '(.)(.)(.)(.)(.)(.)(.)(.)(.)(.)(.)', 'é', 'e\\u0301', '\\p{M}', '[\\p{L}\\p{M}]+', '(?:x', '(?<x', '(?<x>', '(?<>x)',
  '\\-😀', '[😀]{', '😀{', '😀+{', '[^😀]{', '.{', '(?<😀>x)', '\\-[😀-😁]', '\\-ż.', 'ſ{', '[ſk]{', '\\w{', 'ı{', '[ı]{', '\\-ſ',
  // Negated class escapes inside a class (the `i` closure must not bring back k, s, U+017F, U+212A), astral group names in
  // the non-`u` fallback (`{` fails with `u`) and deep nesting.
  '[\\W]', '[\\W\\d]', '[^\\W]', '[\\Ws]', '[\\W_]', '[^\\W\\d]', '[\\Wx]', '[\\D]', '[^\\D]', '[\\S]', '[^\\S]', '[\\W]{', '[^\\W]{',
  '(?<𝓐>a){', '(?<𝓐>a)\\k<𝓐>{', '(?<a\u{E0100}>a){', '(?<\\u{1D4D0}>a){', '(?<\\uD835\\uDCD0>a){', '(?<𝓐>a)', '(?<a😀>a){',
  `${'('.repeat(300)}a${')'.repeat(300)}`, `${'('.repeat(300)}a${')'.repeat(300)}{`, `${'(?:'.repeat(1000)}k${')'.repeat(1000)}`,
];

/** Random patterns from regex pieces: what V8 accepts (with or without `u`), what it refuses and with which message. */
function randomPatterns(count) {
  const pieces = ['a', 'b', 'ż', 'Ż', '😀', '.', '*', '+', '?', '{2}', '{1,3}', '{', '}', '(', ')', '(?:', '(?=', '(?!', '(?<=', '(?<!', '(?<n>', '[', ']',
    '[^', '-', '^', '$', '|', '\\', '\\d', '\\w', '\\s', '\\b', '\\B', '\\1', '\\2', '\\k<n>', '\\p{L}', '\\u0041', '\\u{41}', '\\x41', '\\c', '\\-', '\\.',
    '/', ',', '0', '1', 'i:', '(?i:', 'ς', 'ſ', 'K'];
  const r = rng(7007);
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = 1 + Math.floor(r() * 6);
    out.push(Array.from({ length: n }, () => pieces[Math.floor(r() * pieces.length)]).join(''));
  }
  return out;
}

/** Pieces of the compile fuzz: every group, escape, class and quantifier form V8 treats specially in either mode. */
const FUZZ_PIECES = [
  'a', 'b', 'Ż', '😀', '.', '*', '+', '?', '*?', '{2}', '{2,1}', '{1,}', '{,2}', '{1,', '{', '}', '(', ')', '(?:', '(?=', '(?!', '(?<=', '(?<!',
  '(?<a>', '(?<b>', '(?<1>', '(?<ż>', '(?<', '(?', '(?i:', '(?-i:', '(?ii:', '(?i-i:', '(?-:', '(?m-s:', '(?i)', '(?x:', '(?--i:', '[', ']', '[^', '[]',
  '-', '^', '$', '|', '\\', '\\d', '\\D', '\\w', '\\s', '\\b', '\\B', '\\0', '\\1', '\\2', '\\9', '\\07', '\\k', '\\k<a>', '\\k<z>', '\\k<', '\\p{L}',
  '\\p{Lu', '\\P{Nope}', '\\p', '\\u0041', '\\u{41}', '\\u{', '\\uD83D', '\\uDE00', '\\x41', '\\x4', '\\c', '\\cA', '\\c1', '\\c_', '\\-', '\\.', '\\/', '\\a',
  '\\ą', '/', ',', '0', '9', 'z-a', 'a-z', 'i', ':', '>', '<', '=', '!', '\\]', '\\}', '\\{', '\\(', '\\)', '\\|',
];

function compileRows({ buildPattern, searchText, MAX_LINE_LENGTH }, fixed) {
  const r = rng(9091);
  const text = 'aŻż😀b-1 ,/K\nAB ab_ ż\u212a k a{2} ]}\r\n😀😀x ſsSıiI';
  const rows = [{ text }];
  for (let i = 0; i < 4000; i++) {
    const n = 1 + Math.floor(r() * 5);
    const query = Array.from({ length: n }, () => FUZZ_PIECES[Math.floor(r() * FUZZ_PIECES.length)]).join('');
    const options = { query, regex: true, caseSensitive: i % 3 === 0, wholeWord: i % 5 === 0 };
    const built = buildPattern(options);
    if ('error' in built) { rows.push(wellFormed({ options, error: built.error })); continue; }
    const hang = hangs(built.regex, text, MAX_LINE_LENGTH);
    const found = (hang ? fixed.searchText : searchText)(text, built.regex, 20);
    rows.push(wellFormed({ options, flags: built.regex.flags, matches: found.matches.map((m) => [m.line, m.column, m.text]) }));
  }
  return rows;
}

function patternOptions() {
  const rows = [];
  for (const query of LITERALS) {
    rows.push({ query });
    rows.push({ query, caseSensitive: true });
    rows.push({ query, wholeWord: true });
    rows.push({ query, wholeWord: true, caseSensitive: true });
  }
  for (const query of REGEXES) {
    rows.push({ query, regex: true });
    rows.push({ query, regex: true, caseSensitive: true });
    rows.push({ query, regex: true, wholeWord: true });
  }
  for (const query of randomPatterns(400)) rows.push({ query, regex: true, caseSensitive: query.length % 2 === 0 });
  rows.push({ query: '' }, { query: '', regex: true }, { query: 'a', regex: 1, caseSensitive: 'yes', wholeWord: 0 });
  // A query that is no string: a regex search gave it to `new RegExp` (String(value)); only escapeRegExp threw.
  rows.push({ query: 5, regex: true }, { query: 1.5e21, regex: true, wholeWord: true }, { query: [], regex: true },
    { query: ['k', null, 2], regex: true }, { query: true, regex: true }, { query: {}, regex: true });
  return rows;
}

const REPLACEMENT = '<$&|$1|$2|$<n>|$<host>|$$|$0|$01|$9|$10|$99|$x|$>';

/**
 * Whether 1.1.4's loops never end on `text`: with the `u` flag, an empty match right before an astral character is skipped
 * with `lastIndex++`, which lands inside the surrogate pair, and V8 steps back to the pair's start, so the same empty match
 * comes again forever (a frozen main process). Exact: some exec answers an empty match at a lead surrogate exactly when a
 * sticky exec there does.
 */
function hangs(regex, text, maxLine) {
  if (!regex.unicode) return false;
  const sticky = new RegExp(regex.source, `${regex.flags}y`);
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.length > maxLine) continue;
    for (let i = 0; i < line.length - 1; i++) {
      const c = line.charCodeAt(i);
      if (c < 0xd800 || c > 0xdbff) continue;
      sticky.lastIndex = i;
      const m = sticky.exec(line);
      if (m && m[0] === '') return true;
    }
  }
  return false;
}

/**
 * 1.1.4's searchText and replaceInText with the one change 1.2.0 makes (see `hangs`): an empty match is skipped by a whole
 * code point when the pattern has the `u` flag. Used only for the rows on which 1.1.4 itself never returns.
 */
function fixedEngine({ expandReplacement, MAX_LINE_LENGTH }) {
  const skip = (regex, line) => {
    const at = regex.lastIndex;
    const c = line.charCodeAt(at);
    const d = line.charCodeAt(at + 1);
    regex.lastIndex = at + (regex.unicode && c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff ? 2 : 1);
  };
  const searchText = (text, regex, limit) => {
    const matches = [];
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > MAX_LINE_LENGTH) continue;
      regex.lastIndex = 0;
      for (let m = regex.exec(line); m; m = regex.exec(line)) {
        if (!m[0]) { skip(regex, line); continue; }
        if (matches.length >= limit) return { matches, truncated: true };
        const from = Math.max(0, m.index - 60);
        const to = Math.min(line.length, m.index + m[0].length + 160);
        matches.push({
          line: i + 1, column: m.index, text: m[0],
          preview: (from > 0 ? '…' : '') + line.slice(from, to) + (to < line.length ? '…' : ''),
          matchStart: m.index - from + (from > 0 ? 1 : 0), matchLength: m[0].length,
        });
      }
    }
    return { matches, truncated: false };
  };
  const replaceInText = (text, { regex, replacement, expand, only }) => {
    const parts = text.split(/(\r\n|\r|\n)/);
    let count = 0;
    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i];
      const lineNumber = i / 2 + 1;
      if (line.length > MAX_LINE_LENGTH || (only && only.line !== lineNumber)) continue;
      let out = '';
      let last = 0;
      regex.lastIndex = 0;
      for (let m = regex.exec(line); m; m = regex.exec(line)) {
        if (!m[0]) { skip(regex, line); continue; }
        if (only && (m.index !== only.column || m[0] !== only.text)) continue;
        out += line.slice(last, m.index) + (expand ? expandReplacement(replacement, m) : replacement);
        last = m.index + m[0].length;
        count++;
      }
      if (last > 0 || out) parts[i] = out + line.slice(last);
    }
    return { text: parts.join(''), count };
  };
  return { searchText, replaceInText };
}

const SAMPLE_PARTS = SAMPLE_TEXT.split(/(\r\n|\r|\n)/);

/** The parts of a replaced sample text that differ from SAMPLE_TEXT (lines at even, line breaks at odd indexes). */
function changedLines(text) {
  const parts = text.split(/(\r\n|\r|\n)/);
  if (parts.length !== SAMPLE_PARTS.length) throw new Error('a replacement changed the line structure of the sample');
  return Object.fromEntries(parts.map((part, i) => [i, part]).filter(([i, part]) => part !== SAMPLE_PARTS[i]));
}

function patterns(shared) {
  const { buildPattern, MAX_LINE_LENGTH } = shared;
  const fixed = fixedEngine(shared);
  const rows = [{ text: SAMPLE_TEXT, replacement: REPLACEMENT }];
  for (const options of patternOptions()) {
    const built = buildPattern(options);
    if ('error' in built) {
      rows.push(wellFormed({ options, error: built.error }));
      continue;
    }
    const { regex } = built;
    const hang = hangs(regex, SAMPLE_TEXT, MAX_LINE_LENGTH);
    const { searchText, replaceInText } = hang ? fixed : shared;
    const found = searchText(SAMPLE_TEXT, regex, 40);
    const all = replaceInText(SAMPLE_TEXT, { regex, replacement: REPLACEMENT, expand: !!options.regex });
    const second = found.matches[1];
    const one = second
      ? replaceInText(SAMPLE_TEXT, { regex, replacement: REPLACEMENT, expand: !!options.regex, only: { line: second.line, column: second.column, text: second.text } })
      : null;
    rows.push(wellFormed({
      options, source: regex.source, flags: regex.flags, ...(hang ? { hangs: true } : {}), matches: found.matches, truncated: found.truncated,
      replaceAll: { count: all.count, lines: changedLines(all.text) },
      replaceOne: one && { count: one.count, lines: changedLines(one.text) },
    }));
  }
  return rows;
}

// ── globs ───────────────────────────────────────────────────────────────────
const GLOB_PATHS = [
  'a.ts', 'src/a.ts', 'src/deep/b.TS', 'src/deep/readme.md', 'docs/readme.md', 'docs/a/b.md', 'src/sub/x.js', 'src/x.js', 'README', 'readme.md',
  'node_modules/', 'node_modules/pkg/index.js', 'out/', 'src/', 'a/b/c.ts', '.env', 'x.test.ts', 'Łódź/żółw.txt', 'ŁÓDŹ/ŻÓŁW.TXT', 'k.txt', '\u212a.txt',
  'ſ.txt', 'S.txt', 'dir.with.dots/f', 'a+b.txt', 'a(1).txt', '[x].txt', 'a$b', 'a^b', 'a{b}', 'a|b', 'q?.md', 'ab.md', 'a\\b.md', 'a/b.md', '😀.md',
];
const GLOB_SPECS = [
  '', '  ', ',', '*.ts', '*.ts, src/**', 'src/**', 'docs/', 'src/*.js', '**/*.md', '*.md,*.ts', 'readme*', 'README', 'node_modules/', 'node_modules',
  '*', '**', '?.txt', '??.md', 'a?b.md', 'src/deep/', 'src\\deep\\', 'Łódź/*', 'łódź/**', '*.TXT', 'k.txt', 'K.TXT', 's.txt', 'a+b.txt', 'a(1).txt',
  '[x].txt', 'a$b', 'a^b', 'a{b}', 'a|b', 'q?.md', '*.test.ts', '.*', 'dir.with.dots/*', '/src/a.ts', 'src//a.ts', ' *.ts , , *.md ', '😀*', '*/', '**/',
  'out/', 'src/a.ts/', '\u0000.ts', 'a\\b.md', 'a/b.md',
];

function globs({ compileGlobs }) {
  return GLOB_SPECS.map((spec) => {
    const match = compileGlobs(spec);
    return { spec, paths: GLOB_PATHS, out: match ? GLOB_PATHS.map((p) => match(p)) : null };
  });
}

// ── project folders ─────────────────────────────────────────────────────────
const PREVIEW_BYTES = 256 * 1024;

/** A project layout: `{path, bytes}` (base64) or `{path, pad, tail}` (`pad` bytes of 'a' then `tail`) or `{dir}`. */
function layout() {
  const files = [];
  const add = (path, data) => files.push({ path, bytes: b64(data) });
  add('src/a.ts', utf8('const TOKEN = 1;\nconsole.log(TOKEN);\n'));
  add('src/deep/b.ts', utf8('token here\r\nand token there\r\n'));
  add('notes.md', utf8('Token in notes'));
  add('node_modules/pkg/index.js', utf8('token inside dependencies'));
  add('.git/config', utf8('token in git'));
  add('dist/out.js', utf8('token in dist'));
  add('image.bin', [0x74, 0x6f, 0x6b, 0x65, 0x6e, 0x00, 0x01]);
  add('Żółw/plik.txt', utf8('żółw token Żółw'));
  add('ąb/c.txt', utf8('token ą'));
  add('ab/c.txt', utf8('token a'));
  add('f10.txt', utf8('token 10'));
  add('f2.txt', utf8('token 2'));
  add('F1.txt', utf8('TOKEN 1'));
  add('u16le.txt', utf16('token w UTF-16 LE\r\nżółw 😀 token'));
  add('u16be.txt', utf16('token w UTF-16 BE', true));
  add('bom.txt', utf8('name: ann\ntoken\n', true));
  add('control.txt', utf8('token\u0001'));
  add('invalid.txt', [0x74, 0x6f, 0x6b, 0x65, 0x6e, 0xc3, 0x28]);
  add('empty.txt', []);
  add('emoji/😀.md', utf8('😀 token 👍🏽 token\rtoken'));
  add('cr.txt', utf8('one token\rtwo token\rthree'));
  add('docs/readme.md', utf8('# token\n'));
  add('docs/a/b.md', utf8('nested token\n'));
  add('target/x.rs', utf8('token in target'));
  add('Token.TXT', utf8('upper token'));
  add('long.txt', utf8(`${'x'.repeat(6000)}token\ntoken`));
  files.push({ path: 'big.txt', pad: PREVIEW_BYTES - 4, tail: b64(utf8('token')) });
  files.push({ path: 'fits.txt', pad: PREVIEW_BYTES - 5, tail: b64(utf8('token')) });
  files.push({ dir: 'emptydir' });
  return files;
}

function build(dir, files) {
  for (const file of files) {
    if (file.dir) { mkdirSync(join(dir, file.dir), { recursive: true }); continue; }
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    const data = file.pad !== undefined ? Buffer.concat([Buffer.alloc(file.pad, 0x61), Buffer.from(file.tail, 'base64')]) : Buffer.from(file.bytes, 'base64');
    writeFileSync(join(dir, file.path), data);
  }
}

/** Every file under `dir` (relative path -> base64 bytes, or `{size}` past 4 KiB). */
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const item of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path);
      else {
        const size = statSync(join(dir, path)).size;
        out[path] = size > 4096 ? { size } : b64(readFileSync(join(dir, path)));
      }
    }
  };
  walk('');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const SEARCHES = [
  { query: 'token' }, { query: 'token', caseSensitive: true }, { query: 'TOKEN', caseSensitive: true }, { query: 'token', wholeWord: true },
  { query: 'tok', wholeWord: true }, { query: 'token', includeIgnored: true }, { query: 'token', include: '*.ts' },
  { query: 'token', include: '*.ts', exclude: 'src/deep/' }, { query: 'token', include: '*.md, *.txt' }, { query: 'token', exclude: 'docs/' },
  { query: 'token', exclude: '*.txt' }, { query: 'token', include: 'docs/**' }, { query: 'token', exclude: 'node_modules/', includeIgnored: true },
  { query: 'żółw' }, { query: 'ŻÓŁW', caseSensitive: true }, { query: '😀' }, { query: '.', regex: true, include: 'emoji/*' },
  { query: 't(o)(?<k>k)en', regex: true }, { query: '(', regex: true }, { query: '' }, { query: 'nothing at all' }, { query: 'x', include: 'long.txt' },
  { query: 'a', include: 'fits.txt' }, { query: 'token', include: 'Token.txt' }, { query: '^token$', regex: true },
];

const REPLACES = [
  { options: { query: 'token' }, replacement: 'key', scope: { kind: 'all' } },
  { options: { query: 'token' }, replacement: '$&-$1', scope: { kind: 'all' } },
  { options: { query: 't(ok)en', regex: true }, replacement: '[$1|$&|$$|$2]', scope: { kind: 'all' } },
  { options: { query: 't(?<k>ok)en', regex: true }, replacement: '<$<k>>', scope: { kind: 'file', path: 'u16le.txt' } },
  { options: { query: 'token' }, replacement: 'żółw 😀', scope: { kind: 'file', path: 'u16be.txt' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'src/deep/b.ts' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'cr.txt' } },
  { options: { query: 'name: (\\w+)', regex: true }, replacement: 'user=$1', scope: { kind: 'file', path: 'bom.txt' } },
  { options: { query: 'token' }, replacement: 'key', scope: { kind: 'match', path: 'src/a.ts', line: 2, column: 12, text: 'TOKEN' } },
  { options: { query: 'token' }, replacement: 'key', scope: { kind: 'match', path: 'src/a.ts', line: 1, column: 99, text: 'TOKEN' } },
  { options: { query: 'token' }, replacement: 'key', scope: { kind: 'match', path: 'emoji/😀.md', line: 1, column: 3, text: 'token' } },
  { options: { query: 'token' }, replacement: 'key', scope: { kind: 'match', path: 'emoji/😀.md', line: 1, column: 2, text: 'token' } },
  { options: { query: 'token' }, replacement: 'key', scope: { kind: 'match', path: 'src/a.ts', line: '2', column: 12, text: 'TOKEN' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'image.bin' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'big.txt' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'fits.txt' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'missing.txt' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: '../outside.txt' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'emptydir' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'node_modules/pkg/index.js' } },
  { options: { query: 'nothing' }, replacement: 'k', scope: { kind: 'file', path: 'notes.md' } },
  { options: { query: '' }, replacement: 'k', scope: { kind: 'all' } },
  { options: { query: '(', regex: true }, replacement: 'k', scope: { kind: 'all' } },
  { options: { query: 'token' }, replacement: 5, scope: { kind: 'all' } },
  { options: { query: 'token', include: '*.md' }, replacement: 'k', scope: { kind: 'all' } },
  { options: { query: '😀' }, replacement: '🙂', scope: { kind: 'all' } },
  { options: { query: '.', regex: true }, replacement: 'X', scope: { kind: 'file', path: 'emoji/😀.md' } },
  { options: { query: '\\uD83D', regex: true }, replacement: 'X', scope: { kind: 'file', path: 'emoji/😀.md' } },
  { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'invalid.txt' } },
  { options: { query: 'x' }, replacement: 'y', scope: { kind: 'file', path: 'long.txt' } },
];

async function projects({ searchProject }) {
  const files = layout();
  const dir = mkdtempSync(join(tmpdir(), 'mc-goldens-search-'));
  const rows = [{ layout: files }];
  try {
    build(dir, files);
    for (const options of SEARCHES) rows.push(wellFormed({ options, out: await searchProject(dir, options) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}

async function replaces({ replaceInProject }) {
  const files = layout();
  const rows = [{ layout: files }];
  const before = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-goldens-replace-'));
    try { build(dir, files); return snapshot(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  })();
  for (const request of REPLACES) {
    const parent = mkdtempSync(join(tmpdir(), 'mc-goldens-replace-'));
    const dir = join(parent, 'p');
    try {
      mkdirSync(dir);
      build(dir, files);
      const out = await replaceInProject(dir, request);
      const after = snapshot(dir);
      const changed = Object.fromEntries(Object.entries(after).filter(([path, data]) => JSON.stringify(before[path]) !== JSON.stringify(data)));
      rows.push(wellFormed({ request, out, changed, names: Object.keys(after) }));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
  return rows;
}

export async function searchGoldens(load) {
  const [shared, main] = await Promise.all([load('src/shared/search.ts'), load('src/main/search.ts')]);
  return {
    'search-pattern.jsonl': patterns(shared),
    'search-compile.jsonl': compileRows(shared, fixedEngine(shared)),
    'search-glob.jsonl': globs(shared),
    'search-project.jsonl': await projects(main),
    'search-replace.jsonl': await replaces(main),
  };
}
