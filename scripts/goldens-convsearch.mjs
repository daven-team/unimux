// The conversation search part of the golden corpus (1.2.0, PLAN H5), used by scripts/dump-goldens.mjs. Every row is what the
// 1.1.4 TS code answers; src-tauri/crates/unimux-agents/tests/conv_golden.rs checks the Rust port against it.
//
//   test/golden/conv-fold.jsonl      {from, out}: fold() of every single UTF-16 code unit from..from+255
//   test/golden/conv-text.jsonl      {units} -> {lower (toLowerCase), fold, folder (normalizeFolder)} of mixed strings
//                                     (final sigma, U+0130, astral letters, lone surrogates), all as code unit arrays
//   test/golden/conv-terms.jsonl     {query} -> parseTerms
//   test/golden/conv-search.jsonl    {docs, query} -> searchDocs (snippets, marks and title marks in UTF-16 offsets)
//   test/golden/conv-date.jsonl      {text} -> Date.parse with TZ=UTC (null for NaN) and whether the zone changes it
//   test/golden/conv-read.jsonl      {cli, content (base64), split, limits} -> readInto from 0 over the first `split` bytes,
//                                     then from the returned offset over the whole file (the index document), and readExport
//   test/golden/conv-tool.jsonl      {name, input} -> toolDetail
//   test/golden/conv-sanitize.jsonl  {raw} -> sanitizeQuery and sanitizeExportSource
//
// Inputs come from a seeded PRNG, so the files are reproducible. Timestamps in transcripts are UTC or carry an offset (a
// local-time form would make the rows depend on the zone of the machine that writes them).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rng } from './goldens-normalize.mjs';

const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const WORDS = [
  'Napraw', 'zapis', 'stanu', 'zakładki', 'Zażółć', 'GĘŚLĄ', 'jaźń', 'ΣΟΦΙΑΣ', 'σοφός', 'ΟΔΟΣ', 'ΌΣΟΣ', 'İstanbul', 'İ', 'straße', 'Œuvre',
  'Ærø', 'Łódź', 'đường', 'Tiếng', 'Việt', 'Ḁḃ', '한국어', '日本語', 'emoji😀', '👍🏽', '𐐀𐐨', '𞤀', 'atomicWrite', 'state.json', 'NEEDLE',
  'redis', 'pool', 'Redis', 'résumé', 'naïve', 'Ǆemal', 'ǅ', 'ﬁle', 'K', 'Å', 'ı', 'ẞ', 'Ω', 'ǰ', 'ŉ', 'Ⅻ', 'Ⓐ', 'ꞵ', 'Ꭰ', 'ꭰ', 'x', 'a', 'ab',
  'test', 'TEST', 'Test-run', '"quoted"', '<tag>', 'C:\\work\\a', '/usr/bin', 'ﬀ', 'ŀ', 'ĳ', 'ǈ', 'ϴ', 'ᾈ', 'ῼ', 'Ⱥ', 'ȿ',
];
const SPACES = [' ', ' ', ' ', '  ', '\n', '\n\n', '\t', ' \r\n ', '\u00a0', '\u3000'];

function textGen(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  return (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += (i ? pick(SPACES) : '') + pick(WORDS);
    return s;
  };
}

/** fold of every code unit, 256 per row. */
export function foldRows(fold) {
  const rows = [];
  for (let from = 0; from < 0x10000; from += 256) {
    const out = [];
    for (let u = from; u < from + 256; u++) out.push(fold(String.fromCharCode(u)).charCodeAt(0));
    rows.push({ from, out });
  }
  return rows;
}

export function textRows({ fold, normalizeFolder }) {
  const r = rng(0xc0f1);
  const gen = textGen(r);
  const rows = [];
  const fixed = [
    'ΣΑΣ ΣΟΦΟΣ Σ ΑΣ.', 'aΣ', 'Σa', 'AΣ\u0301 b', 'ΑΣ\ud800', 'İx ΣΑΣ', 'İ', 'ﬀİ', '\ud801\udc00Σ', 'Σ\ud801\udc00', '\udc00\ud800',
    'C:\\Users\\ΣΟΦΟΣ\\', 'D:/Work/Alpha//', 'ÀÉÎÕÜ àéîõü ÿŸ', 'Ǆǅǆ ǇǈǉǊǋǌ', 'ꞵꞴ', 'ᏸᏰ', 'ʰʲ', '\u0345\u0399', 'ΐΰ', 'ᾼᾳ', 'Ⅰⅰ',
  ];
  const inputs = [...fixed];
  for (let i = 0; i < 300; i++) {
    let s = gen(1 + Math.floor(r() * 12));
    // Cut at a random code unit (a lone surrogate now and then) and glue random pieces.
    if (r() < 0.3) s = s.slice(0, Math.floor(r() * s.length));
    if (r() < 0.2) s += String.fromCharCode(0xd800 + Math.floor(r() * 0x800));
    inputs.push(s);
  }
  for (const s of inputs) rows.push({ units: units(s), lower: units(s.toLowerCase()), fold: units(fold(s)), folder: units(normalizeFolder(s)) });
  return rows;
}

export function termRows({ parseTerms }) {
  const r = rng(0x7e2);
  const gen = textGen(r);
  const rows = [
    'Atomic  "write file"  atom', '"unterminated phrase', '   ', 'a b c d e f g h i j', '""', '"" x', 'ab"cd ef"', '"a  b"  "A B"',
    'Zażółć zazolc', 'ΣΟΦΟΣ σοφος', 'İ i', 'x\u3000y', 'a\u0000b', '"  spaced   phrase  "', 'redis redis Redis REDIS',
  ].map((query) => ({ query }));
  for (let i = 0; i < 200; i++) {
    let q = gen(1 + Math.floor(r() * 6));
    if (r() < 0.3) q = `"${gen(2)}" ${q}`;
    if (r() < 0.1) q += ' "';
    rows.push({ query: q });
  }
  for (const row of rows) row.terms = parseTerms(row.query);
  return rows;
}

/** A document the way docOf of the vitest file builds one (text joined with U+0000, folded as a whole). */
function makeDoc(fold, d) {
  const starts = [];
  let len = 0;
  for (const [, text] of d.messages) { starts.push(starts.length ? len + 1 : 0); len = starts[starts.length - 1] + text.length; }
  const text = d.messages.map((m) => m[1]).join('\u0000');
  const doc = {
    cli: d.cli, id: d.id, cwd: d.cwd, title: d.title, startedAt: d.startedAt, updatedAt: d.updatedAt, file: d.file, text,
    folded: fold(text), starts, roles: d.messages.map((m) => m[0]).join(''), times: d.messages.map((m) => m[2]), capped: false,
  };
  if (d.model) doc.model = d.model;
  return doc;
}

export function searchRows({ fold, searchDocs, normalizeFolder }) {
  const r = rng(0x5ea7c4);
  const gen = textGen(r);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const CWDS = ['D:\\work\\alpha', 'd:/work/alpha/', 'D:\\Work\\Alpha', 'D:\\work\\beta', '/Users/me/ΣΟΦΟΣ', '/Users/me/σοφος', '', 'C:\\İx'];
  const rows = [];
  for (let i = 0; i < 160; i++) {
    const docs = [];
    const n = 1 + Math.floor(r() * 8);
    for (let k = 0; k < n; k++) {
      const messages = [];
      const m = 1 + Math.floor(r() * 10);
      for (let j = 0; j < m; j++) {
        const long = r() < 0.15;
        messages.push([r() < 0.5 ? 'u' : 'a', gen(long ? 150 + Math.floor(r() * 300) : 1 + Math.floor(r() * 30)), r() < 0.3 ? 0 : 1_760_000_000_000 + Math.floor(r() * 1e9)]);
      }
      docs.push({
        cli: r() < 0.6 ? 'claude' : 'codex', id: pick(['s1', 's2', 's3', 'S1', 'ß', 'zz', 'a', `id-${k}`]), cwd: pick(CWDS),
        title: r() < 0.3 ? '' : gen(1 + Math.floor(r() * 6)).replace(/\s+/g, ' ').trim().slice(0, 160),
        startedAt: pick([1, 10, 100, 1000]), updatedAt: pick([10, 20, 20, 30, 1000.5, 1_760_000_000_123.25]),
        ...(r() < 0.5 ? { model: pick(['claude-opus-5-5', 'gpt-6.1-sol', '']) } : {}), file: `f${k}.jsonl`, messages,
      });
    }
    const query = { text: r() < 0.1 ? '' : r() < 0.3 ? `"${gen(2)}"` : gen(1 + Math.floor(r() * 3)) };
    if (r() < 0.2) query.cli = pick(['claude', 'codex', 'all']);
    if (r() < 0.2) query.role = pick(['user', 'assistant', 'all']);
    if (r() < 0.15) query.project = normalizeFolder(pick(CWDS));
    if (r() < 0.1) query.from = pick([15, 25]);
    if (r() < 0.1) query.to = pick([5, 50]);
    if (r() < 0.2) query.limit = pick([1, 2, 3]);
    // Every term somewhere: a word taken from a document (partly, folded or not).
    if (r() < 0.6 && query.text) {
      const doc = pick(docs);
      const msg = pick(doc.messages)[1];
      const at = Math.floor(r() * msg.length);
      query.text += ` ${msg.slice(at, at + 2 + Math.floor(r() * 8)).trim()}`;
    }
    rows.push({ docs, query, out: searchDocs(docs.map((d) => makeDoc(fold, d)), query) });
  }
  return rows;
}

export function dateRows() {
  const texts = [
    '2026-10-20T08:00:00.500Z', '2026-10-20T08:00:00Z', '2026-10-20T08:00Z', '2026-10-20', '2026-10', '2026', '+002026-10-20T08:00:00Z',
    '-000001-01-01T00:00:00Z', '-000000-01-01T00:00:00Z', '2026-10-20T10:00:00+02:00', '2026-10-20T10:00:00-0230', '2026-10-20T10:00:00+24:00',
    '2026-10-20t08:00:00z', '2026-10-20T08:00:00.5Z', '2026-10-20T08:00:00.12Z', '2026-10-20T08:00:00.123456789Z', '2026-10-20T08:00:00.Z',
    '2026-02-30', '2026-02-31T00:00:00Z', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-32', '2026-10-20T24:00:00Z', '2026-10-20T24:00:01Z',
    '2026-10-20T23:60:00Z', '2026-10-20T23:59:60Z', '2026-10-20T08:00:00Zx', '2026-10-20T08:00:00 Z', '2026-10-20T08', '2026-10-20T8:00:00Z',
    '2026-10-20 08:00:00Z', '2026-10-20 08:00:00.250Z', '2026-10-20 08:00:00+01:00', '2026-10-20  08:00:00Z', '275760-09-13T00:00:00Z',
    '+275760-09-13T00:00:00Z', '+275760-09-13T00:00:00.001Z', '-271821-04-20T00:00:00Z', '1970-01-01T00:00:00Z', '1969-12-31T23:59:59.999Z',
    '2026-10-20T08:00:00', '2026-10-20T08:00', '2026-10-20 08:00:00', '2026-10-20 08:00', '2026-03-29T02:30:00', '', 'yesterday', 'null',
    '0', '12', '2026/10/20', '20261020', '2026-1-2',
  ];
  const at = (tz) => { process.env.TZ = tz; return texts.map((t) => Date.parse(t)); };
  const before = process.env.TZ;
  const utc = at('UTC');
  const india = at('Asia/Kolkata');
  const ny = at('America/New_York');
  if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  return texts.map((text, i) => {
    const v = Number.isFinite(utc[i]) ? utc[i] : null;
    return { text, utc: v, local: v !== null && (india[i] !== utc[i] || ny[i] !== utc[i]) };
  });
}

function transcriptLines(r, cli) {
  const gen = textGen(r);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const ts = () => pick(['2026-10-20T08:00:00.500Z', '2026-10-20T09:00:00Z', '2026-10-19T23:00:00+02:00', '2026-10-21', 'bogus', '', 5, null,
    `2026-10-2${Math.floor(r() * 9)}T1${Math.floor(r() * 9)}:00:00.${Math.floor(r() * 1000)}Z`]);
  const sid = pick(['11111111-aaaa', 'sess-2', '']);
  const lines = [];
  const n = 2 + Math.floor(r() * 14);
  for (let i = 0; i < n; i++) {
    const text = () => gen(1 + Math.floor(r() * (r() < 0.1 ? 900 : 25)));
    const roll = r();
    let e;
    if (cli === 'claude') {
      if (roll < 0.3) {
        const content = r() < 0.4 ? pick([text(), `<command-name>/x</command-name>`, '  <x>', '[Request interrupted by user]', '# AGENTS.md x', ''])
          : [{ type: 'text', text: text() }, ...(r() < 0.3 ? [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] : []), ...(r() < 0.2 ? [{ type: 'tool_result', content: 'out' }] : []), ...(r() < 0.1 ? ['str', 5, null] : [])];
        e = { type: 'user', message: { role: 'user', content }, sessionId: sid, cwd: pick(['D:\\work\\alpha', '', 'C:\\x']), timestamp: ts() };
        if (r() < 0.1) e.isSidechain = pick([true, 1, 'x', 0, '', false]);
        if (r() < 0.05) e.isMeta = true;
      } else if (roll < 0.6) {
        const parts = [];
        if (r() < 0.7) parts.push({ type: 'text', text: text() });
        if (r() < 0.3) parts.push({ type: 'thinking', thinking: 'secret' });
        if (r() < 0.4) parts.push({ type: 'tool_use', name: pick(['Bash', 'Edit', 'Read', 'Grep']), input: pick([{ command: 'npm test' }, { file_path: 'src/a.ts' }, { pattern: 'TODO' }, {}, 'raw']) });
        if (r() < 0.2) parts.push({ type: 'text', text: '   ' });
        e = { type: 'assistant', message: { model: pick(['claude-opus-5-5', '<synthetic>', '', 'claude-x']), content: r() < 0.1 ? text() : parts }, sessionId: sid, timestamp: ts() };
        if (r() < 0.05) e.isApiErrorMessage = true;
        if (r() < 0.05) e.message = pick([null, 0, 'str']);
      } else if (roll < 0.7) {
        e = r() < 0.5 ? { type: 'custom-title', customTitle: pick([gen(3), '  ', 5]), sessionId: sid } : { type: 'ai-title', aiTitle: pick([gen(4), '']), sessionId: sid };
      } else if (roll < 0.8) {
        e = { type: 'queue-operation', content: text(), sessionId: sid, timestamp: ts() };
      } else if (roll < 0.9) {
        e = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text() }] }, sessionId: sid, timestamp: ts() };
      } else {
        lines.push(pick(['{"type":"user", broken', '', '   ', 'null', '[1,2]', '{"type":"user","message":{"content":"lone \\ud83d end"},"sessionId":"s","timestamp":"2026-10-20T08:00:00Z"}']));
        continue;
      }
    } else {
      if (roll < 0.15) {
        e = { type: 'session_meta', timestamp: ts(), payload: pick([{ id: pick(['0199aaaa', '', null]), session_id: 'sid-x', cwd: pick(['D:\\work\\beta', '']), timestamp: ts(), model: pick(['gpt-6.1-sol', '']) }, [], null, 'x']) };
      } else if (roll < 0.25) {
        e = { type: 'turn_context', timestamp: ts(), payload: { model: pick(['gpt-6.1-sol', 'gpt-x', '']), cwd: pick(['D:\\work\\beta', 'E:\\other']) } };
      } else if (roll < 0.6) {
        const role = pick(['user', 'assistant', 'developer', 'system', 'user']);
        const content = r() < 0.1 ? text() : [{ type: role === 'assistant' ? pick(['output_text', 'text']) : pick(['input_text', 'text']), text: text() }, ...(r() < 0.2 ? [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] : []), ...(r() < 0.1 ? [{ type: 'input_text', text: '# AGENTS.md\nrules' }] : [])];
        e = { type: 'response_item', timestamp: ts(), payload: { type: 'message', role, content } };
      } else if (roll < 0.8) {
        const type = pick(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'function_call_output', 'reasoning']);
        const payload = { type };
        if (type === 'function_call') Object.assign(payload, { name: pick(['shell', 'apply_patch', 'read']), arguments: pick(['{"command":["bash","-lc","npm test"]}', '{"command":["rg","x"]}', '{bad', '{"path":"a.ts"}']) });
        if (type === 'custom_tool_call') Object.assign(payload, { name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/redis.ts\n@@\n*** Add File: b.ts\n*** End Patch' });
        if (type === 'local_shell_call') payload.action = { command: ['pwsh', '-Command', 'Get-ChildItem'] };
        if (type === 'web_search_call') payload.action = { type: 'search', query: gen(2) };
        if (type === 'function_call_output') payload.output = 'secret output';
        e = { type: 'response_item', timestamp: ts(), payload };
      } else if (roll < 0.9) {
        e = { type: 'event_msg', timestamp: ts(), payload: { type: 'user_message', message: text() } };
      } else {
        lines.push(pick(['{"type":"response_item", broken', '', 'null']));
        continue;
      }
    }
    lines.push(JSON.stringify(e));
  }
  return lines;
}

export async function readRows({ readInto, readExport, newMeta, INDEX_LIMITS, clip }) {
  const r = rng(0x4ead);
  const dir = mkdtempSync(join(tmpdir(), 'unimux-goldens-conv-'));
  const rows = [];
  try {
    for (let i = 0; i < 220; i++) {
      const cli = r() < 0.55 ? 'claude' : 'codex';
      const lines = transcriptLines(r, cli);
      let buf = Buffer.from(lines.join(r() < 0.5 ? '\n' : '\r\n') + (r() < 0.7 ? '\n' : ''), 'utf8');
      // Now and then a byte that is not UTF-8 (the reader turns it into U+FFFD) or a huge line that is skipped.
      if (r() < 0.1) buf = Buffer.concat([buf, Buffer.from([0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x75, 0x73, 0x65, 0x72, 0x22, 0xff, 0xc3, 0x7d, 0x0a])]);
      const limits = r() < 0.4 ? { messageChars: 1 + Math.floor(r() * 60), docChars: 20 + Math.floor(r() * 600) } : INDEX_LIMITS;
      const split = Math.floor(r() * (buf.length + 1));
      const file = join(dir, `t${i}.jsonl`);
      writeFileSync(file, buf.subarray(0, split));
      const doc = { cli, file, id: '', cwd: '', title: '', startedAt: 0, updatedAt: 0, text: '', folded: '', starts: [], roles: '', times: [], capped: false, meta: newMeta(), len: 0, visible: false };
      const first = await readInto(file, 0, doc, limits, split);
      writeFileSync(file, buf);
      const offset = await readInto(file, first, doc, limits, buf.length);
      const exportLimits = r() < 0.3 ? { docChars: 30 + Math.floor(r() * 400), messageChars: 5 + Math.floor(r() * 80), items: 1 + Math.floor(r() * 12) } : undefined;
      const exported = await readExport(file, cli, exportLimits);
      const m = doc.meta;
      rows.push({
        cli, content: buf.toString('base64'), split, limits, first, offset,
        doc: { text: doc.text, folded: doc.folded, starts: doc.starts, roles: doc.roles, times: doc.times, capped: doc.capped, len: doc.len },
        meta: { id: m.id ?? null, cwd: m.cwd, firstTs: m.firstTs, lastTs: m.lastTs, model: m.model ?? null, custom: m.custom ?? null, ai: m.ai ?? null, prompt: m.prompt ?? null },
        title: clip(m.custom ?? m.ai ?? m.prompt ?? ''),
        exportLimits: exportLimits ?? null, export: exported,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}

export function toolRows({ toolDetail }) {
  const r = rng(0x7001);
  const gen = textGen(r);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const inputs = [
    { command: 'npm test\n  --run', description: 'x' }, { file_path: 'src/a.ts' }, { pattern: 'TODO', path: 'src' }, { url: 'https://x.dev', prompt: 'p' },
    { todos: [] }, '{"command":["pwsh","-Command","Get-ChildItem"]}', { command: ['rg', '-n', 'x'] }, { type: 'search', query: 'vitest docs' },
    { command: 'x'.repeat(500) }, { command: null, cmd: 'ls -la' }, { command: 5, cmd: 'ls' }, { command: ['bash', '-lc'] }, { command: ['BASH', '-LC', 'a', 'b'] },
    { command: ['C:\\Git\\bin\\bash.exe', '-c', 'x'] }, { command: ['cmd.exe', '/C', 'dir'] }, { command: ['powershell.EXE', '-command', 'gci'] },
    { command: ['sh', '-x', 'y'] }, { command: ['zsh', '-c', 'z'] }, { command: ['ſh', '-c', 'z'] }, { command: [1, 2] }, { command: [] },
    { input: '*** Update File: a.ts\n*** Add File: b.ts\r\n*** Delete File:  c.ts \n*** Move File: d.ts' }, '*** Add File: x.ts\n',
    'plain text', '  [1, 2]', ' {bad json', '[]', '{}', 5, true, null, undefined, [], ['a'], { query: 7, path: '   ', name: 'n' },
    { description: '😀'.repeat(100) }, { skill: 'pdf' }, { notebook_path: 'n.ipynb', file_path: '' }, { prompt: 'a\u2028b\tc' }, { cmd: ['git', 'status'] },
  ];
  const rows = [];
  for (const input of inputs) for (const name of ['Bash', 'apply_patch', 'shell']) rows.push({ name, input, out: toolDetail(name, input) });
  for (let i = 0; i < 80; i++) {
    const input = pick([{ command: gen(3) }, { [pick(['path', 'query', 'url', 'name', 'cmd', 'prompt'])]: gen(1 + Math.floor(r() * 60)) }, gen(5), JSON.stringify({ command: [pick(['bash', 'sh', 'pwsh']), pick(['-c', '-lc', '-Command']), gen(2)] })]);
    const name = pick(['Bash', 'apply_patch', 'shell', 'Read']);
    rows.push({ name, input, out: toolDetail(name, input) });
  }
  // `undefined` is not JSON: such rows carry no `input` key.
  return rows.map((row) => (row.input === undefined ? { name: row.name, out: row.out } : row));
}

export function sanitizeRows({ sanitizeQuery, sanitizeExportSource }) {
  const raws = [
    { text: 'x'.repeat(1000), cli: 'bash', role: 'user', from: 'yesterday', to: 5, limit: 99999, evil: 1 }, null, 5, 'str', [],
    { text: 'a', cli: 'claude', role: 'all', project: 'd:/x', from: 1.5, to: -2, limit: 0.5 }, { text: 7, cli: 'codex', role: 'assistant', limit: -3 },
    { text: '😀'.repeat(250), project: 'p'.repeat(3000), limit: 12.9 }, { project: '', from: Infinity, to: NaN },
    { file: 'D:\\a.jsonl', extra: 1 }, { file: '' }, { file: 'x'.repeat(4097) }, { file: 'x'.repeat(4096) }, { cli: 'claude', id: '..\\x' },
    { cli: 'shell', id: 'x' }, { cli: 'codex', id: '0199bbbb-cccc-7ddd-8eee-000000000020' }, { cli: 'claude', id: '_x' }, { cli: 'claude', id: 'a'.repeat(128) },
    { cli: 'claude', id: 'a'.repeat(129) }, { cli: 'claude', id: 'abc-1', file: 5 },
  ];
  return raws.map((raw) => ({ raw, query: sanitizeQuery(raw), source: sanitizeExportSource(raw) }));
}

export async function convGoldens(load) {
  const [{ fold, normalizeFolder, parseTerms, searchDocs, INDEX_LIMITS }, { newMeta }, { readInto }, { readExport }, { toolDetail }, { sanitizeQuery, sanitizeExportSource }] = await Promise.all([
    load('src/shared/convSearch.ts'), load('src/convsearch/parse.ts'), load('src/convsearch/indexer.ts'), load('src/convsearch/exporter.ts'),
    load('src/shared/convExport.ts'), load('src/main/convSearchClient.ts'),
  ]);
  const clip = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 160);
  return {
    'conv-fold.jsonl': foldRows(fold),
    'conv-text.jsonl': textRows({ fold, normalizeFolder }),
    'conv-terms.jsonl': termRows({ parseTerms }),
    'conv-search.jsonl': searchRows({ fold, searchDocs, normalizeFolder }),
    'conv-date.jsonl': dateRows(),
    'conv-read.jsonl': await readRows({ readInto, readExport, newMeta, INDEX_LIMITS, clip }),
    'conv-tool.jsonl': toolRows({ toolDetail }),
    'conv-sanitize.jsonl': sanitizeRows({ sanitizeQuery, sanitizeExportSource }),
  };
}
