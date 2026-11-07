// The context meter and session listing part of the golden corpus (1.2.0, PLAN H4), used by scripts/dump-goldens.mjs. Every
// row is what the 1.1.4 TS code answers; src-tauri/crates/unimux-agents/tests/sessions_golden.rs checks the Rust port.
//
//   test/golden/sessions-paths.jsonl    {fn: 'dirName' | 'normalize', path} -> claudeProjectDirName / normalizeProjectPath
//                                        (non-BMP characters, combining marks, mixed separators, drive and UNC forms);
//                                        {fn: 'matcher', project, known, cwd} -> worktreeMatcher(project, known)(normPath(cwd))
//   test/golden/context-scan.jsonl      {cli, lines, hint} -> scanLines from emptyScan and contextUsage (null when unknown)
//   test/golden/context-backward.jsonl  {cli, recipe} -> scanBackwards over the file the recipe expands to ({scan, offset})
//   test/golden/sessions-list.jsonl     {scenario} -> listSessionsAsync (or findRecentCodexSession) over a scratch home the
//                                        scenario describes; paths under the scratch root read `${ROOT}`, a start time taken
//                                        from the file's birth time reads "birth", an error is {error: true}
//
// Inputs are hand-picked plus seeded random ones, so the files are reproducible. File times are whole seconds (Node's utimes
// and Rust's set_modified store them exactly).
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rng } from './goldens-normalize.mjs';

const pickFrom = (r) => (xs) => xs[Math.floor(r() * xs.length)];

// ── paths ───────────────────────────────────────────────────────────────────

const PATH_PARTS = [
  'C:', 'D:', 'c:', '\\\\srv', '//srv', '\\', '/', '\\\\', '//', 'Projekty', 'bot-discord', 'a.b c', '.claude', 'worktrees', 'x_1',
  'żółw', 'Łódź', 'İstanbul', 'ΣΟΦΟΣ', 'straße', 'e\u0301', '日本語', '😀', '👍🏽', '𐐀𐐨', '𠀀', '\u00a0', ' ', '-wt-', 'app', 'app-wt-1',
  'App', 'APP', '.', '..', '~', '$HOME', 'é', 'Ⅻ', 'ﬁ', '\t',
];

function pathRows() {
  const r = rng(0x5e55);
  const pick = pickFrom(r);
  const fixed = [
    '', 'C:\\Users\\x\\a.b c', 'D:\\Projekty\\bot\\.claude\\worktrees\\x_1', '/Users/a/proj/.worktrees/feat', 'D:\\Projekty\\żółw😀',
    'C:\\😀\\𐐀', 'D:\\Projekty\\Bot\\\\', '\\\\Srv\\Share\\', '//Srv/Share', '/Users/A/', 'C:\\İ', 'C:', 'C:/', 'c:\\', 'C:x\\y',
    'D:\\ΣΟΦΟΣ\\ΣΑΣ', 'D:\\e\u0301\\', '/', '\\', '///', 'a\\b/c\\\\', '\u{1F600}', '\u{10FFFF}x', 'ß\\ẞ',
  ];
  const paths = [...fixed];
  for (let i = 0; i < 300; i++) {
    let s = '';
    const n = 1 + Math.floor(r() * 8);
    for (let k = 0; k < n; k++) s += pick(PATH_PARTS);
    paths.push(s);
  }
  return paths;
}

function matcherRows(worktreeMatcher, normalizeProjectPath) {
  const r = rng(0x3a7c);
  const pick = pickFrom(r);
  const projects = ['D:\\Projekty\\app', 'D:\\Projekty\\app\\', 'd:/projekty/App', '/Users/a/app', '/Users/a/app/', 'app', 'C:\\😀\\proj😀', '\\\\srv\\share\\app'];
  const rows = [];
  for (const project of projects) {
    for (let i = 0; i < 30; i++) {
      const base = project.replace(/[\\/]+$/, '');
      const variants = [
        `${base}-wt-x`, `${base}-wt-`, `${base}-wt-x\\y`, `${base}-wt-x/`, `${base.toUpperCase()}-WT-x`, `${base}-wt-${pick(PATH_PARTS)}`,
        `${base}x-wt-1`, base, `${base}\\`, `${base}/sub`, 'D:\\Other\\app-wt-1', `${base}-wt-ż😀`,
      ];
      const cwd = pick(variants);
      const known = r() < 0.5 ? [] : [{ path: pick(variants), branch: 'b' }];
      rows.push({ fn: 'matcher', project, known, cwd, out: worktreeMatcher(project, known)(normalizeProjectPath(cwd)) });
    }
  }
  return rows;
}

export function sessionPathRows({ claudeProjectDirName, normalizeProjectPath, worktreeMatcher }) {
  const rows = [];
  for (const path of pathRows()) {
    rows.push({ fn: 'dirName', path, out: claudeProjectDirName(path) });
    rows.push({ fn: 'normalize', path, out: normalizeProjectPath(path) });
  }
  return [...rows, ...matcherRows(worktreeMatcher, normalizeProjectPath)];
}

// ── context lines ───────────────────────────────────────────────────────────

const CLAUDE_MODELS = [
  'claude-opus-5-5', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-haiku-5', 'claude-fable-5-1',
  'claude-mythos-1', 'CLAUDE-OPUS-4-6', 'claude-opus-4-123', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'proxy-large',
  'gpt-x[1m]', 'claude-sonnet-4-5-1m', '<synthetic>', 'has space', 'x'.repeat(100), 'x'.repeat(101), 'ż-model', '', null, 5, ['m'],
];
const NUMBERS = [0, 1, 7, 10, 999, 30_000, 62_808, 150_000, 200_000, 450_000, 1_200_000, -5, 0.5, 12.25, '100', null, true, 1e21];

function claudeLine(r) {
  const pick = pickFrom(r);
  const n = () => pick(NUMBERS);
  const kind = Math.floor(r() * 12);
  const usage = () => {
    const u = {};
    for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) if (r() < 0.8) u[k] = n();
    return u;
  };
  switch (kind) {
    case 0: case 1: case 2: case 3:
      return JSON.stringify({ type: 'assistant', isSidechain: r() < 0.15 ? pick([true, 'true', 1]) : false, message: { model: pick(CLAUDE_MODELS), usage: usage(), content: [{ type: 'text', text: 'a "usage" text' }] } });
    case 4:
      return JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: r() < 0.3 ? pick([null, 5, 'x', []]) : { preTokens: 1000, ...(r() < 0.6 ? { postTokens: n() } : {}) } });
    case 5:
      return JSON.stringify({ type: 'user', message: { content: 'the "usage" word and compact_boundary in a prompt' } });
    case 6:
      return pick(['not json "usage"', '{"type":"assistant","message":{"usage":{"input_tok', '', '   ', '"usage"', '[1,"usage"]', 'null', '5 "usage"']);
    case 7: // numbers beyond f64, JS escapes and lone surrogates
      return pick([
        '{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":1e400,"output_tokens":3}}}',
        '{"type":"assistant","message":{"model":"claude-opus-4-6","content":"\\ud800 cut","usage":{"input_tokens":5,"output_tokens":3}}}',
        '{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":5}},"type":"user"}',
        '{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":5,"output_tokens":3}}}\r',
        `{"type":"assistant","deep":${'['.repeat(300)}${']'.repeat(300)},"message":{"model":"claude-sonnet-4-6","usage":{"cache_read_input_tokens":77}}}`,
      ]);
    case 8:
      return JSON.stringify({ type: 'assistant', message: pick(['x', null, { usage: pick([null, [], 'x', 5, { input_tokens: n() }]) }]) });
    case 9:
      return JSON.stringify({ type: pick(['assistant', 'Assistant', 'system', null]), subtype: pick(['compact_boundary', 'other']), message: { model: pick(CLAUDE_MODELS), usage: usage() } });
    default:
      return JSON.stringify({ type: 'assistant', message: { model: pick(CLAUDE_MODELS), usage: usage() } });
  }
}

const CODEX_MODELS = ['gpt-6.1-sol', 'gpt-5-codex', 'o4', '', null, 'has space', 'x'.repeat(101), 7];

function codexLine(r) {
  const pick = pickFrom(r);
  const n = () => pick(NUMBERS);
  const kind = Math.floor(r() * 10);
  switch (kind) {
    case 0: case 1:
      return JSON.stringify({ type: 'turn_context', payload: r() < 0.1 ? pick([null, 'x']) : { model: pick(CODEX_MODELS) } });
    case 2: case 3: case 4: {
      const last = {};
      for (const k of ['input_tokens', 'output_tokens', 'total_tokens']) if (r() < 0.7) last[k] = n();
      const info = r() < 0.1 ? pick([null, [], 'x', 5]) : { last_token_usage: r() < 0.1 ? pick([null, 'x', [1]]) : last, ...(r() < 0.7 ? { model_context_window: pick([0, 128_000, 272_000, 475_000, -1, null, '475000', 400_000]) } : {}) };
      return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info, rate_limits: {} } });
    }
    case 5:
      return JSON.stringify({ type: 'compacted', payload: { message: '' } });
    case 6:
      return JSON.stringify({ type: 'event_msg', payload: { type: pick(['agent_message', 'token_count_x', 'user_message']), message: 'token_count "turn_context" "compacted"' } });
    case 7:
      return pick(['garbage token_count', '{"type":"compacted"', '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":1e400,"input_tokens":4,"output_tokens":5},"model_context_window":1000}}}', '"turn_context"']);
    case 8:
      return JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ text: '"turn_context"' }] } });
    default:
      return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: n() }, model_context_window: 400_000 } } });
  }
}

export function contextScanRows({ scanLines, emptyScan, contextUsage }) {
  const r = rng(0xc0de);
  const pick = pickFrom(r);
  const rows = [];
  for (let i = 0; i < 800; i++) {
    const cli = i % 2 ? 'codex' : 'claude';
    const lines = Array.from({ length: 1 + Math.floor(r() * 10) }, () => (cli === 'claude' ? claudeLine(r) : codexLine(r)));
    const hint = pick([undefined, undefined, 'sonnet[1m]', 'opus', 'x-1m', '', 'claude-sonnet-4-5[1M]']);
    const scan = scanLines(cli, emptyScan(), lines.join('\n') + (r() < 0.8 ? '\n' : ''));
    rows.push({ cli, lines, ...(hint !== undefined ? { hint } : {}), scan, usage: contextUsage(cli, scan, hint) });
  }
  return rows;
}

// ── backward reads ──────────────────────────────────────────────────────────

/** `${REPEAT:<n>:<text>}` in a golden input stands for <text> repeated n times (keeps the corpus small). */
export const expandRepeat = (s) => s.replace(/\$\{REPEAT:(\d+):([^}]*)\}/g, (_, n, text) => text.repeat(Number(n)));

/** The file a recipe stands for: [line, times] pairs joined with newlines, then `tail` (no newline after it). */
export function expandRecipe(recipe) {
  return recipe.lines.map(([line, times]) => `${expandRepeat(line)}\n`.repeat(times)).join('') + expandRepeat(recipe.tail ?? '');
}

function backwardRecipes() {
  const usage = (n, model = 'claude-opus-4-6') => JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: n, output_tokens: 1 } } });
  const filler = (w) => JSON.stringify({ type: 'user', message: { content: `${'${'}REPEAT:${w}:x}` } });
  const turn = (m) => JSON.stringify({ type: 'turn_context', payload: { model: m } });
  const count = (t) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: t }, model_context_window: 400_000 } } });
  const compact = (p) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: p ? { postTokens: p } : {} });
  return [
    { cli: 'claude', lines: [[usage(10), 1], [filler(2000), 400], [usage(20_000), 1], [compact(5000), 1], [filler(2000), 400]], tail: '{"partial":' },
    { cli: 'claude', lines: [[usage(10), 1], [filler(2000), 400]] },
    { cli: 'claude', lines: [[filler(100), 3]] },
    { cli: 'claude', lines: [], tail: '' },
    { cli: 'claude', lines: [], tail: usage(5) },
    { cli: 'claude', lines: [[usage(7), 1]], tail: '${REPEAT:300000:x}' },
    // One line longer than the first chunks: the chunk doubles until it holds a line end.
    { cli: 'claude', lines: [[usage(31), 1], [filler(700_000), 1], [filler(10), 2]] },
    { cli: 'claude', lines: [[usage(41, 'claude-sonnet-4-5'), 1], [filler(3_000_000), 1], [usage(42, 'claude-haiku-5'), 1], [filler(600_000), 1]] },
    { cli: 'claude', lines: [[compact(), 1], [filler(1000), 300]] },
    // Codex: the model sits in a turn context before the usage line, further back than the first chunk.
    { cli: 'codex', lines: [[turn('gpt-old'), 1], [filler(1000), 50], [turn('gpt-6.1-sol'), 1], [filler(2000), 300], [count(47_500), 1], [filler(2000), 200]] },
    { cli: 'codex', lines: [[count(1000), 1], [filler(2000), 200]] },
    { cli: 'codex', lines: [[filler(2000), 200], [turn('gpt-late'), 1]] },
    { cli: 'codex', lines: [[turn('gpt-a'), 1], [count(5), 1], [turn('gpt-b'), 1], [count(6), 1]], tail: turn('gpt-c') },
    // Lines split inside a multi-byte character at a chunk start.
    { cli: 'claude', lines: [[usage(55), 1], [JSON.stringify({ type: 'user', message: { content: '${REPEAT:40000:ż😀}' } }), 4]] },
    // The limits: an unfinished last line longer than MAX_CHUNK (16 MiB) stops the read with nothing found and offset 0; no
    // new chunk starts past MAX_BACKWARD (64 MiB; the last one started before it ends near 80 MiB), so a usage line 90 MB
    // back is never found while one 60 MB back is. (A complete line of 16 MiB or more made 1.1.4 read the same chunk
    // forever, so it has no golden; the Rust read stops there, see tracker.rs.)
    { cli: 'claude', lines: [[usage(61), 1]], tail: '${REPEAT:17000000:x}' },
    { cli: 'claude', lines: [[usage(63), 1], [filler(1_000_000), 90]] },
    { cli: 'claude', lines: [[usage(64), 1], [filler(1_000_000), 60]] },
  ];
}

export async function backwardRows({ scanBackwards }) {
  const dir = mkdtempSync(join(tmpdir(), 'unimux-goldens-backward-'));
  const rows = [];
  try {
    for (const [i, recipe] of backwardRecipes().entries()) {
      const file = join(dir, `${i}.jsonl`);
      writeFileSync(file, expandRecipe(recipe));
      const fh = await open(file, 'r');
      try {
        const size = (await fh.stat()).size;
        rows.push({ recipe, size, out: await scanBackwards(fh, size, recipe.cli) });
      } finally { await fh.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return rows;
}

// ── session listings ────────────────────────────────────────────────────────

const BASE = 1_700_000_000_000;
const DAY = 86_400_000;

/** Lines of a scenario file: JSON values (with `${ROOT}` in strings), raw strings, or {fill, width, id} filler runs. */
export function expandLines(lines, root, rootJson) {
  const sub = (v) => (typeof v === 'string' ? expandRepeat(v).split('${ROOT}').join(root)
    : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
  let out = '';
  for (const line of lines) {
    if (typeof line === 'string') out += `${expandRepeat(line).split('${ROOT}').join(rootJson)}\n`;
    else if (line && typeof line === 'object' && 'fill' in line) {
      for (let i = 0; i < line.fill; i++) out += `${JSON.stringify({ type: 'assistant', sessionId: line.id, message: { content: 'x'.repeat(line.width) + i } })}\n`;
    } else if (line && typeof line === 'object' && 'partial' in line) out += line.partial;
    else out += `${JSON.stringify(sub(line))}\n`;
  }
  return out;
}

const cu = (cwd, id, text, ts = '2025-10-01T10:00:00Z', extra = {}) => ({ type: 'user', message: { content: text }, sessionId: id, cwd, timestamp: ts, ...extra });
const meta = (id, cwd, extra = {}) => ({ type: 'session_meta', payload: { id, cwd, timestamp: '2025-10-06T10:00:00Z', ...extra } });
const xu = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const xe = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } });

function scenarios() {
  const P = '${ROOT}/bot-discord';
  let t = 0;
  const m = () => BASE + (t += 7) * 1000;
  const list = [];
  // The fake home of test/sessions.test.ts.
  list.push({ name: 'basic', project: P, files: [
    { claude: P, name: 'aaa.jsonl', mtime: m(), lines: [{ type: 'mode', sessionId: 'aaa' }, 'this is not json',
      { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta stuff' }] }, sessionId: 'aaa', cwd: P, timestamp: '2025-10-01T10:00:00Z' },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' }, sessionId: 'aaa' }, { type: 'user', message: { content: 'napraw   logowanie\nw bocie' }, sessionId: 'aaa' }] },
    { claude: P, name: 'bbb.jsonl', mtime: m(), lines: [cu(P, 'bbb', 'pierwszy prompt', '2025-10-02T10:00:00Z'), { type: 'ai-title', aiTitle: 'Refaktor sidebaru', sessionId: 'bbb' }] },
    { claude: P, name: 'empty.jsonl', mtime: m(), lines: [{ type: 'mode', sessionId: 'empty' }] },
    { codex: '2025/10/06', name: 'rollout-2025-10-06T10-00-00-c1.jsonl', mtime: m(), lines: [meta('c1', P, { base_instructions: { text: '${REPEAT:90000:x}' } }), xu('# AGENTS.md instructions'), xu('<environment_context>'), xu('dodaj testy')] },
    { codex: '2025/10/06', name: 'rollout-2025-10-06T11-00-00-c2.jsonl', mtime: m(), lines: [meta('c2', 'D:\\Other'), xu('inny projekt')] },
  ] });
  // Titles: /rename and generated titles in the head and the tail, an id only in the tail, prompts made of parts.
  const big = { fill: 300, width: 900, id: 'big' };
  list.push({ name: 'titles', project: P, files: [
    { claude: P, name: 'big.jsonl', mtime: m(), lines: [cu(P, 'big', 'prompt'), { type: 'custom-title', customTitle: 'z glowy', sessionId: 'big' }, big, { type: 'ai-title', aiTitle: 'z ogona' }, { type: 'ai-title', aiTitle: '' }] },
    { claude: P, name: 'big2.jsonl', mtime: m(), lines: [cu(P, 'big2', 'prompt'), { type: 'ai-title', aiTitle: 'ai z glowy' }, big, { type: 'custom-title', customTitle: 'custom z ogona' }, { type: 'custom-title', customTitle: 5 }] },
    { claude: P, name: 'noid.jsonl', mtime: m(), lines: [{ type: 'user', message: { content: 'bez id w glowie' }, cwd: P }, { fill: 300, width: 900 }, { type: 'x', sessionId: 'tail-id' }, { type: 'x', sessionId: 'later-id' }] },
    { claude: P, name: 'parts.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'parts', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 5 }, { type: 'text' }, { type: 'text', text: null }, { type: 'text', text: { o: 1 } }, { type: 'image', text: 'no' }, { type: 'text', text: [1, [2, null]] }, { type: 'text', text: true }, { type: 'text', text: 1.5e-7 }] } }] },
    { claude: P, name: 'space.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'space', isSidechain: 1, message: { content: 'sidechain' } }, { type: 'user', sessionId: 'space', isMeta: 'yes', message: { content: 'meta' } }, { type: 'user', sessionId: 'space', isMeta: 0, message: { content: ' \u00a0\u3000 <injected' } }, { type: 'user', sessionId: 'space', isMeta: '', message: { content: '\u3000 zadanie\u00a0\u00a0z\tspacjami\u2028i\ufeffwięcej \n' } }] },
    { claude: P, name: 'long.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'long', message: { content: `${'a'.repeat(139)}😀 dalej` } }] },
    { claude: P, name: 'long2.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'long2', message: { content: `${'ą'.repeat(138)}😀` } }] },
    { claude: P, name: 'nots.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'nots', message: { content: 'bez czasu' } }, { cwd: '' }, { cwd: 0 }, { timestamp: 'zly czas', cwd: 7 }] },
    { claude: P, name: 'badts.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'badts', timestamp: '2025-13-45T99:00:00Z', message: { content: 'zla data' } }] },
    { claude: P, name: 'offset.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'offset', timestamp: '2025-10-01T12:00:00.123+02:00', cwd: { o: 1 }, message: { content: 'cwd obiekt' } }] },
    { claude: P, name: 'notitle.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'notitle', message: { content: [{ type: 'image' }] } }, { type: 'assistant', sessionId: 'notitle' }] },
    { claude: P, name: 'crlf.jsonl', mtime: m(), lines: [`${JSON.stringify({ type: 'user', sessionId: 'crlf', message: { content: 'windows' } })}\r`, ' \r', '\ufeff{"x":1}'] },
    { claude: P, name: 'Upper.JSONL', mtime: m(), lines: [cu(P, 'upper', 'ignored extension case')] },
    { claude: P, name: 'partial.jsonl', mtime: m(), lines: [cu(P, 'partial', 'ostatnia linia w trakcie'), { partial: '{"type":"custom-title","customTitle":"nie' }] },
  ] });
  // Codex heads: long first lines, the UTF-16 length quirk, odd ids and cwds, titles from user messages.
  const D = '2025/10/07';
  list.push({ name: 'codex', project: '${ROOT}/bot-discord/', files: [
    { codex: D, name: 'rollout-a.jsonl', mtime: m(), lines: [meta('a-300k', P, { base_instructions: { text: '${REPEAT:300000:x}' } }), xe('ponad 256 KB')] },
    { codex: D, name: 'rollout-b.jsonl', mtime: m(), lines: [meta('b-1m', P, { base_instructions: { text: '${REPEAT:1100000:x}' } }), xe('ponad 1 MB')] },
    { codex: D, name: 'rollout-c.jsonl', mtime: m(), lines: [meta('c-utf16', P, { base_instructions: { text: '${REPEAT:40000:ż}' } }), xe('dlugosc w UTF-16')] },
    { codex: D, name: 'rollout-d.jsonl', mtime: m(), lines: [{ type: 'session_meta', payload: { session_id: 'd-sid', cwd: P } }, xe('session_id')] },
    { codex: D, name: 'rollout-e.jsonl', mtime: m(), lines: [{ type: 'session_meta', payload: { id: null, session_id: 'e-null', cwd: P, timestamp: '' } }, xe('')] },
    { codex: D, name: 'rollout-f.jsonl', mtime: m(), lines: [{ type: 'session_meta', payload: { id: 0, cwd: P } }, xe('zero id')] },
    { codex: D, name: 'rollout-g.jsonl', mtime: m(), lines: [{ type: 'session_meta', payload: { id: 'g', cwd: null } }, xe('cwd null')] },
    { codex: D, name: 'rollout-h.jsonl', mtime: m(), lines: [{ type: 'event_msg' }, xe('not meta first')] },
    { codex: D, name: 'rollout-i.jsonl', mtime: m(), lines: [{ type: 'session_meta' }, xe('no payload')] },
    { codex: D, name: 'rollout-j.jsonl', mtime: m(), lines: [meta('j', `${P}/`), xe('<injected>'), xe('  # AGENTS.md'), { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 5 }, { text: '' }, { text: '<x>' }, { text: 'z response_item' }] } }] },
    { codex: D, name: 'rollout-k.jsonl', mtime: m(), lines: [meta('k', P), xe(5), { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'assistant' }] } }] },
    { codex: D, name: 'rollout-l.jsonl', mtime: m(), lines: [meta(7, P), xe('numeric id')] },
    { codex: D, name: 'rollout-m.jsonl', mtime: m(), lines: [meta('m', P, { timestamp: '2025-10-06 10:00:00Z' }), xe('date with a space')] },
    { codex: D, name: 'rollout-n.jsonl', mtime: m(), lines: ['{"type":"session_meta","payload":{"id":"n","cwd":"${ROOT}/bot-discord"', xe('broken first line')] },
    { codex: D, name: 'rollout-o.jsonl', mtime: m(), lines: [meta('o', `${P}\\\\`), xe('backslashes')] },
    { codex: D, name: 'readme.txt', mtime: m(), lines: [meta('txt', P), xe('not jsonl')] },
  ] });
  list.push({ name: 'trailing-separator', project: `${P}\\`, files: [
    { claude: P, name: 'ts.jsonl', mtime: m(), lines: [cu(P, 'ts', 'another folder name')] },
    { claude: `${P}\\`, name: 'ts2.jsonl', mtime: m(), lines: [cu(`${P}\\`, 'ts2', 'the folder of this spelling')] },
  ] });
  list.push({ name: 'codex-cwd-number', project: P, files: [
    { codex: D, name: 'rollout-x.jsonl', mtime: m(), lines: [{ type: 'session_meta', payload: { id: 'x', cwd: 5 } }, xe('cwd number')] },
  ] });
  // Worktrees (test/sessions.test.ts) plus a non-BMP project name and edge hints.
  const A = '${ROOT}/app';
  list.push({ name: 'worktrees', project: A, dirs: ['app', 'app-wt-grid-1', 'app-wt-left', 'app-wt-file'], worktrees: [{ path: '${ROOT}/app-wt-grid-1', branch: 'mc/grid-1' }, { path: '${ROOT}\\app-wt-empty', branch: '' }, { path: '${ROOT}/app-wt-file/', branch: 'second' }],
    branches: { '${ROOT}/app-wt-left': 'mc/left', '${ROOT}/app-wt-empty': 'never asked' },
    files: [
      { claude: A, name: 'main.jsonl', mtime: m(), lines: [cu(A, 'main', 'main project')] },
      { claude: '${ROOT}/app-wt-grid-1', name: 'live.jsonl', mtime: m(), lines: [cu('${ROOT}/app-wt-grid-1', 'live', 'in the live worktree')] },
      { claude: '${ROOT}/app-wt-old', name: 'gone.jsonl', mtime: m(), lines: [cu('${ROOT}/app-wt-old', 'gone', 'in a removed worktree')] },
      { claude: '${ROOT}/app-wt-old', name: 'gone2.jsonl', mtime: m(), lines: [cu('${ROOT}\\app-wt-old\\', 'gone2', 'same folder, other separators')] },
      { claude: '${ROOT}/app-wt-x/nested', name: 'nested.jsonl', mtime: m(), lines: [cu('${ROOT}/app-wt-x/nested', 'nested', 'nested folder')] },
      { claude: '${ROOT}/apple-wt-1', name: 'apple.jsonl', mtime: m(), lines: [cu('${ROOT}/apple-wt-1', 'apple', 'other project')] },
      { claude: '${ROOT}/app-wt-empty', name: 'empty.jsonl', mtime: m(), lines: [cu('${ROOT}/app-wt-empty', 'emptyb', 'hint with an empty branch')] },
      { claude: '${ROOT}/app-wt-file', name: 'file.jsonl', mtime: m(), lines: [cu('${ROOT}/app-wt-file', 'file', 'second hint')] },
      { claude: '${ROOT}/app wt left', name: 'lossy.jsonl', mtime: m(), lines: [cu('${ROOT}/app-wt-left', 'lossy', 'encoded like another folder')] },
      { claudeDir: 'unrelated-folder', name: 'u.jsonl', mtime: m(), lines: [cu('${ROOT}/app-wt-left', 'unrelated', 'folder name does not match')] },
      { codex: '2025/10/06', name: 'rollout-cx-loose.jsonl', mtime: m(), lines: [meta('cx-loose', '${ROOT}/app-wt-left'), xu('codex in the loose worktree')] },
      { codex: '2025/10/06', name: 'rollout-cx-other.jsonl', mtime: m(), lines: [meta('cx-other', '${ROOT}/apple-wt-1'), xu('codex elsewhere')] },
      { codex: '2025/10/06', name: 'rollout-cx-main.jsonl', mtime: m(), lines: [meta('cx-main', '${ROOT}\\app\\'), xu('codex in the project')] },
    ] });
  list.push({ name: 'worktree-cwd-number', project: A, files: [
    { claude: '${ROOT}/app-wt-n', name: 'n.jsonl', mtime: m(), lines: [{ type: 'user', sessionId: 'n', cwd: 5, message: { content: 'cwd number' } }] },
  ] });
  const E = '${ROOT}/proj😀ż';
  list.push({ name: 'non-bmp', project: E, dirs: ['proj😀ż', 'proj😀ż-wt-a'], files: [
    { claude: E, name: 'e.jsonl', mtime: m(), lines: [cu(E, 'e', 'projekt z emoji')] },
    { claude: `${E}-wt-a`, name: 'ea.jsonl', mtime: m(), lines: [cu(`${E}-wt-a`, 'ea', 'worktree z emoji')] },
    { claude: '${ROOT}/proj😀z-wt-b', name: 'other.jsonl', mtime: m(), lines: [cu('${ROOT}/proj😀z-wt-b', 'ez', 'same encoding, other project')] },
    { claude: '${ROOT}/projXYZ', name: 'collide.jsonl', mtime: m(), lines: [cu('${ROOT}/projXYZ', 'collide', 'never matches')] },
    { codex: '2025/10/08', name: 'rollout-e.jsonl', mtime: m(), lines: [meta('cx-e', `${E}\\`), xu('codex z emoji')] },
  ] });
  // Empty session ids: `head.id ?? tail.id` then a falsy check, so an empty head id hides the session even with a real id
  // in the tail, and without a head id an empty first id in the tail hides it too.
  list.push({ name: 'empty-ids', project: P, files: [
    { claude: P, name: 'emptyhead.jsonl', mtime: m(), lines: [cu(P, '', 'pusty identyfikator')] },
    { claude: P, name: 'emptyhead-tailid.jsonl', mtime: m(), lines: [cu(P, '', 'pusty w glowie'), { fill: 300, width: 900 }, { type: 'x', sessionId: 'real-tail' }] },
    { claude: P, name: 'emptytail.jsonl', mtime: m(), lines: [{ type: 'user', message: { content: 'bez id w glowie' }, cwd: P }, { fill: 300, width: 900 }, { type: 'x', sessionId: '' }, { type: 'x', sessionId: 'later-id' }] },
    { claude: P, name: 'notail.jsonl', mtime: m(), lines: [{ type: 'user', message: { content: 'bez id w glowie' }, cwd: P }, { fill: 300, width: 900 }, { type: 'x', sessionId: 5 }, { type: 'x', sessionId: 'tail-ok' }] },
    { claude: P, name: 'ok.jsonl', mtime: m(), lines: [cu(P, 'ok', 'zwykla sesja')] },
  ] });
  // More than 600 rollout files: the oldest are never listed.
  const many = [];
  for (let d = 1; d <= 7; d++) for (let i = 0; i < 90; i++) {
    const id = `d${d}-${String(i).padStart(2, '0')}`;
    many.push({ codex: `2024/0${d}/0${1 + (i % 3)}`, name: `rollout-${id}.jsonl`, mtime: BASE - (d * 100 + i) * 1000, lines: [meta(id, P, { timestamp: undefined }), xe(`zadanie ${id}`)] });
  }
  list.push({ name: 'many-codex', project: P, files: many });
  return list;
}

function recentScenarios() {
  const P = '${ROOT}/bot-discord';
  const files = [
    { codex: '2026/10/06', name: 'rollout-1.jsonl', ago: 5, lines: [meta('fresh', P), xu('x')] },
    { codex: '2026/10/06', name: 'rollout-2.jsonl', ago: 2, lines: [meta('fresher', `${P}\\`), xu('x')] },
    { codex: '2026/10/06', name: 'rollout-3.jsonl', ago: 120, lines: [meta('old', P), xu('x')] },
    { codex: '2026/10/06', name: 'rollout-4.jsonl', ago: 1, lines: [meta('elsewhere', '${ROOT}/other'), xu('x')] },
    { codex: '2026/10/05', name: 'rollout-5.jsonl', ago: 3, lines: [meta(42, P), xu('numeric id')] },
    { codex: '2026/10/05', name: 'rollout-6.jsonl', ago: 4, lines: [{ type: 'event_msg' }] },
  ];
  return [
    { name: 'recent', recent: { cwd: P, windowMs: 20_000, exclude: [] }, files },
    { name: 'recent-excluded', recent: { cwd: `${P}/`, windowMs: 20_000, exclude: ['fresher', 'fresh'] }, files },
    { name: 'recent-window', recent: { cwd: P, windowMs: 1_000_000, exclude: ['fresher', 'fresh', '42'] }, files },
    { name: 'recent-none', recent: { cwd: '${ROOT}/nowhere', windowMs: 20_000, exclude: [] }, files },
    { name: 'recent-cwd-number', recent: { cwd: P, windowMs: 20_000, exclude: [] }, files: [{ codex: '2026/10/06', name: 'rollout-n.jsonl', ago: 1, lines: [{ type: 'session_meta', payload: { id: 'n', cwd: 5 } }] }] },
  ];
}

/** Builds the scratch home of a scenario under `root`; returns the home. */
export function buildScenario(s, root, claudeProjectDirName) {
  const rootJson = JSON.stringify(root).slice(1, -1);
  const sub = (v) => v.split('${ROOT}').join(root);
  const home = join(root, 'home');
  for (const d of s.dirs ?? []) mkdirSync(join(root, d), { recursive: true });
  const now = Date.now();
  for (const f of s.files) {
    const dir = f.claude !== undefined ? join(home, '.claude', 'projects', claudeProjectDirName(sub(f.claude)))
      : f.claudeDir !== undefined ? join(home, '.claude', 'projects', f.claudeDir) : join(home, '.codex', 'sessions', ...f.codex.split('/'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, f.name);
    writeFileSync(file, expandLines(f.lines, root, rootJson));
    const ms = f.mtime ?? Math.floor((now - f.ago * 1000) / 1000) * 1000;
    utimesSync(file, ms / 1000, ms / 1000);
  }
  return home;
}

/** The answer as stored: `${ROOT}` for the scratch root and "birth" for a start time taken from the file's birth time. */
export function normalizeOut(out, root) {
  const now = Date.now();
  const text = JSON.stringify(out, (k, v) => (k === 'startedAt' && typeof v === 'number' && Math.abs(v - now) < 2 * DAY ? 'birth' : v));
  return JSON.parse(text.split(JSON.stringify(root).slice(1, -1)).join('${ROOT}'));
}

export async function sessionListRows({ sessions }) {
  const { claudeProjectDirName, clearClaudeCache, clearCodexCache, listSessionsAsync, findRecentCodexSession } = sessions;
  const rows = [];
  for (const s of [...scenarios(), ...recentScenarios()]) {
    const root = mkdtempSync(join(tmpdir(), 'unimux-goldens-sessions-'));
    try {
      clearClaudeCache();
      clearCodexCache();
      const home = buildScenario(s, root, claudeProjectDirName);
      const sub = (v) => v.split('${ROOT}').join(root);
      let out;
      try {
        if (s.recent) out = await findRecentCodexSession(home, sub(s.recent.cwd), s.recent.windowMs, new Set(s.recent.exclude));
        else {
          const branches = Object.fromEntries(Object.entries(s.branches ?? {}).map(([k, v]) => [sub(k), v]));
          const worktrees = (s.worktrees ?? []).map((w) => ({ path: sub(w.path), branch: w.branch }));
          out = await listSessionsAsync(home, sub(s.project), worktrees, async (path) => branches[path]);
        }
        out = normalizeOut(out ?? null, root);
      } catch { out = { error: true }; }
      rows.push({ scenario: s, out });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  return rows;
}
