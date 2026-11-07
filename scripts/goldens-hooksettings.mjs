// The Claude settings / Codex notify / hook fallback / cell file part of the golden corpus (1.2.0, PLAN H2), used by
// scripts/dump-goldens.mjs:
//
//   test/golden/hook-settings.jsonl  {fn, args, out} of src/main/hooks.ts (claudeHookForm, claudeExtendedHooks,
//                                    claudeHookCommand, claudeHookSettings as the JSON.stringify(_, null, 2) text,
//                                    bypassProxyForHooks with the key order of the result), src/shared/codexHooks.ts
//                                    (codexNotifyArgv, codexHookOverrides; `{error}` where they throw),
//                                    src/main/hookFallback.ts (globMatch, httpHookUrlAllowed, claudeSettingsFiles,
//                                    hookFallbackFile load / save on a scratch file) and src/main/cellFiles.ts (cellOfFile);
//                                    `writeClaudeSettings` rows hold the bytes the real HookServer wrote (file name and text,
//                                    with its random token and nonce replaced by <token> / <nonce>; the server is not started,
//                                    so the port is 0 on both sides).
//
// Checked by src-tauri/crates/unimux-agents/tests/settings_goldens.rs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { rng } from './goldens-normalize.mjs';

const VERSIONS = [
  undefined, '', 'garbage', '2', '2.1', '2.1.62', '2.1.63', '2.1.77', '2.1.78', '2.1.138', '2.1.139', '2.1.309-beta.1',
  '2.1.310 (Claude Code)', '  2.1.200\n', '\u00a02.1.100\u3000', '\ufeff2.1.90', '3.0.0', '1.9.999', '2.0.999', '02.01.063',
  '2.1.99999999999999999999', '99999999999999999999.0.0', 'v2.1.200', '2.1.x', '2.1.63.4', '\u0662.1.100', '2.1.-5',
];
const FORMS = ['shell', 'http', 'exec'];

function settingsRows(hooks) {
  const rows = [];
  for (const v of VERSIONS) {
    rows.push({ fn: 'claudeHookForm', args: [v ?? null], out: hooks.claudeHookForm(v) });
    rows.push({ fn: 'claudeExtendedHooks', args: [v ?? null], out: hooks.claudeExtendedHooks(v) });
  }
  for (const url of ['http://127.0.0.1:5000/h/abc/cell/stop/n0nce', 'http://127.0.0.1:1/h/t/a%20b/notify/n', '']) {
    for (const body of [true, false]) rows.push({ fn: 'claudeHookCommand', args: [url, body], out: hooks.claudeHookCommand(url, body) });
  }
  const targets = [
    { name: 'plain', cell: 'c9', token: '0123456789abcdef0123456789abcdef', port: 51234, nonce: '89abcdef01234567' },
    { name: 'encoded', cell: 'A_b-9', token: 't', port: 1, nonce: 'n' },
  ];
  for (const t of targets) {
    const url = (event) => `http://127.0.0.1:${t.port}/h/${t.token}/${encodeURIComponent(t.cell)}/${event}/${t.nonce}`;
    const headerUrl = (event) => url(event).replace(`/h/${t.token}/`, '/k/');
    const target = { url, headerUrl, token: t.token };
    for (const form of FORMS) {
      for (const extended of [false, true]) {
        rows.push({ fn: 'claudeHookSettings', args: [t, form, extended], out: JSON.stringify(hooks.claudeHookSettings(target, form, extended), null, 2) });
      }
    }
    // A bare URL function: the curl form, header URL = URL, no token.
    rows.push({ fn: 'claudeHookSettings', args: [{ ...t, bare: true }, 'shell', false], out: JSON.stringify(hooks.claudeHookSettings(url), null, 2) });
  }
  return rows;
}

function writeRows(hooks) {
  const rows = [];
  const dir = mkdtempSync(join(tmpdir(), 'unimux-golden-settings-'));
  try {
    const server = new hooks.HookServer();
    for (const cell of ['c9', 'cell-1', 'A_b-9']) {
      for (const v of ['2.1.62', '2.1.63', '2.1.78', '2.1.139', '2.1.310 (Claude Code)', undefined, 'garbage']) {
        for (const form of [undefined, ...FORMS]) {
          const path = form === undefined ? server.writeClaudeSettings(dir, cell, v) : server.writeClaudeSettings(dir, cell, v, form);
          const nonce = server.nonces.get(cell);
          const text = readFileSync(path, 'utf8').split(server.token).join('<token>').split(nonce).join('<nonce>');
          rows.push({ fn: 'writeClaudeSettings', args: [cell, v ?? null, form ?? null], out: { name: basename(path), text } });
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return rows;
}

function proxyRows(hooks) {
  const envs = [
    {}, { PATH: 'x' }, { HTTPS_PROXY: 'http://p:8080' }, { http_proxy: 'http://p' }, { HTTP_PROXY: 'http://p', no_proxy: 'corp.local, .internal' },
    { HTTP_PROXY: 'http://p', NO_PROXY: 'localhost,127.0.0.1' }, { ALL_PROXY: 'socks5://p', NO_PROXY: '*' }, { HTTP_PROXY: '  ' },
    { HTTP_PROXY: '\u00a0\ufeff' }, { HtTpS_PrOxY: 'x' }, { ALL_proxy: 'x', No_Proxy: '' }, { HTTP_PROXY: 'x', NO_PROXY: ' , ,' },
    { HTTP_PROXY: 'x', NO_PROXY: 'a', no_proxy: 'b,127.0.0.1' }, { HTTP_PROXY: 'x', NO_PROXY: ' * ' }, { HTTP_PROXY: 'x', NO_PROXY: '127.0.0.1:80' },
    { FTP_PROXY: 'x' }, { HTTPS_PROXY_X: 'x' }, { XHTTP_PROXY: 'x' }, { 'HTTP_PROXY ': 'x' }, { HTTP_PROXY: 'x', 'NO_PROXY ': 'a' },
    { PATH: 'p', HTTP_PROXY: 'x', TERM: 't' }, { HTTP_PROXY: 'x', NO_PROXY: '\u3000a\u3000,\tb\n' }, { HTTP_PROXY: 'x', NO_PROXY: 'a,,b' },
    { hTTp_pROXY: 'x', nO_pROXY: 'y' }, { '\u017fOCKS': 'x', HTTP_PROXY: 'x' }, { 'HTTP\u017fPROXY': 'x' },
  ];
  const rows = [];
  for (const env of envs) {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const out = hooks.bypassProxyForHooks({ ...env }, platform);
      rows.push({ fn: 'bypassProxyForHooks', args: [Object.entries(env), platform], out: Object.entries(out) });
    }
  }
  return rows;
}

function codexRows(codexHooks) {
  const T = '0123456789abcdef0123456789abcdef';
  const N = '89abcdef01234567';
  const urls = [
    `http://127.0.0.1:51234/h/${T}/cell-1/codex/${N}`, `http://127.0.0.1:1/h/abcdef01/c/codex/abcdef01`,
    `http://127.0.0.1:123456/h/${T}/c/codex/${N}`, `http://127.0.0.1:5/h/ABCDEF01/c/codex/${N}`, `http://127.0.0.1:5/h/${T}/a%20b/codex/${N}`,
    `http://127.0.0.1:5/h/${T}/${'x'.repeat(200)}/codex/${N}`, `http://127.0.0.1:5/h/${T}/${'x'.repeat(201)}/codex/${N}`,
    `http://127.0.0.1:5/h/${'a'.repeat(64)}/c/codex/${'b'.repeat(64)}`, `http://127.0.0.1:5/h/${'a'.repeat(65)}/c/codex/${N}`,
    `http://127.0.0.1:5/h/abcdef0/c/codex/${N}`, `http://127.0.0.1:5/h/${T}/c/stop/${N}`, `http://127.0.0.1:5/h/${T}/c/codex/${N}\n`,
    `http://127.0.0.1:5/h/${T}/c/codex/${N}'`, `http://127.0.0.1:5/h/${T}/c/codex/${N} --x`, `http://evil.example/h/${T}/c/codex/${N}`,
    "http://127.0.0.1:1/h/abc/x'],evil=['/codex/ab", '', `http://127.0.0.1:/h/${T}/c/codex/${N}`, `http://127.0.0.1:5/h/${T}/\u0661/codex/${N}`,
    `http://127.0.0.1:\u0665/h/${T}/c/codex/${N}`, `http://127x0.0.1:5/h/${T}/c/codex/${N}`, `https://127.0.0.1:5/h/${T}/c/codex/${N}`,
  ];
  const attempt = (f) => { try { return f(); } catch (e) { return { error: e.message }; } };
  const rows = [];
  for (const url of urls) {
    rows.push({ fn: 'codexNotifyArgv', args: [url], out: attempt(() => codexHooks.codexNotifyArgv(url)) });
    rows.push({ fn: 'codexHookOverrides', args: [url], out: attempt(() => codexHooks.codexHookOverrides(url)) });
  }
  return rows;
}

function globRows(fallback) {
  const rows = [];
  const fixed = [
    ['http://127.0.0.1:*', 'http://127.0.0.1:5123/k/a'], ['https://*.example.com/*', 'http://127.0.0.1:5123/k/a'], ['*', 'anything'],
    ['*', ''], ['', ''], ['', 'a'], ['a', ''], ['**', 'x'], ['a*', 'a'], ['*a', 'a'], ['a*b*c', 'axxbyyc'], ['a*b*c', 'axxbyy'],
    ['http://127.0.0.1:5123/k/a', 'http://127.0.0.1:5123/k/a'], ['http://127.0.0.1/*', 'http://127.0.0.1:5/k'], ['a?c', 'abc'],
    ['A*', 'a'], ['\u{1F600}*', '\u{1F600}x'], ['*\u{1F600}', 'x\u{1F600}'], ['*b', 'ab\u{1F600}b'], ['a*a*a*a*b', 'a'.repeat(30)],
  ];
  for (const [p, t] of fixed) rows.push({ fn: 'globMatch', args: [p, t], out: fallback.globMatch(p, t) });
  const r = rng(2026);
  const alphabet = ['a', 'b', '*', '.', ':', '/', '1'];
  const word = (n) => Array.from({ length: Math.floor(r() * n) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
  for (let i = 0; i < 400; i++) {
    const p = word(9);
    const t = word(12).replace(/\*/g, '');
    rows.push({ fn: 'globMatch', args: [p, t], out: fallback.globMatch(p, t) });
  }
  return rows;
}

function allowedRows(fallback) {
  const url = 'http://127.0.0.1:51234/k/cell-1/stop/0';
  const list = (patterns) => JSON.stringify({ allowedHttpHookUrls: patterns });
  const cases = [
    [], [null], ['{}'], ['not json'], [''], [null, '{}', 'not json'], [list(['http://127.0.0.1:*'])], [list(['http://127.0.0.1:*/*'])],
    [list(['http://127.0.0.1/*'])], [list(['http://localhost:*'])], [list(['https://example.com/*'])], [list([])],
    [list(['https://example.com/*']), list(['http://127.0.0.1:*'])], [list(['http://127x0x0x1:*'])], [list('http://127.0.0.1:*')],
    [list(null)], [list({ a: 'http://127.0.0.1:*' })], [list([5, null, 'http://127.0.0.1:*'])], [list([5, null])],
    [list([`http://127.0.0.1:${'*'.repeat(2041)}`])], [list([`http://127.0.0.1:${'*'.repeat(2030)}`])], [list(['*'])],
    ['null'], ['5'], ['"x"'], ['[]'], [JSON.stringify([{ allowedHttpHookUrls: [] }])], [`\ufeff${list([])}`], [` ${list([])} `],
    ['{"allowedHttpHookUrls":[],"allowedHttpHookUrls":null}'], ['{"allowedHttpHookUrls":null,"allowedHttpHookUrls":[]}'],
    [list([]), list(['*'])], [list(['*']), list([])], ['{"allowedHttpHookUrls":["http://127.0.0.1:*"]'],
    [`{"x":${'['.repeat(300)}${']'.repeat(300)},"allowedHttpHookUrls":[]}`], ['{"allowedHttpHookUrls":["\\ud800*"]}'],
    ['{"allowedHttpHookUrls":["http://127.0.0.1:*"],"n":1e400}'], [list(['HTTP://127.0.0.1:*'])],
  ];
  return cases.map((texts) => ({ fn: 'httpHookUrlAllowed', args: [texts, url], out: fallback.httpHookUrlAllowed(texts, url) }));
}

function settingsFileRows(fallback) {
  const cases = [
    ['win32', 'C:\\Users\\a', { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' }, 'D:\\p'],
    ['win32', 'C:\\Users\\a', {}, 'D:\\p'], ['win32', 'C:\\Users\\a', { ProgramFiles: '', ProgramData: '' }, ''],
    ['win32', 'C:\\Users\\a', { PROGRAMFILES: 'X:\\pf', programdata: 'Y:' }, 'D:\\p\\'], ['win32', 'C:\\Users\\a', { CLAUDE_CONFIG_DIR: '  ' }, 'D:\\p'],
    ['win32', 'C:\\Users\\a', { CLAUDE_CONFIG_DIR: ' E:\\cfg\t' }, 'D:\\p'], ['darwin', '/Users/a', { CLAUDE_CONFIG_DIR: '/cfg' }, '/p'],
    ['darwin', '/Users/a', {}, '/p'], ['linux', '/home/a', {}, '/p'], ['linux', '/home/a', { CLAUDE_CONFIG_DIR: '' }, '/'],
    ['freebsd', '/home/a', { ProgramFiles: 'x' }, '/p'], ['darwin', '/Users/a', { CLAUDE_CONFIG_DIR: '\u00a0/c\u00a0' }, '/p'],
  ];
  return cases.map(([platform, home, env, cwd]) => ({
    fn: 'claudeSettingsFiles', args: [platform, home, Object.entries(env), cwd], out: fallback.claudeSettingsFiles(platform, home, env, cwd),
  }));
}

function fallbackFileRows(fallback) {
  const rows = [];
  const dir = mkdtempSync(join(tmpdir(), 'unimux-golden-hookfb-'));
  try {
    const file = join(dir, 'claude-hook-fallback.json');
    const texts = [
      null, '', '{}', '{"claudeVersion":"2.1.200"}', '{"claudeVersion":5}', '{"claudeVersion":""}', 'null', '"x"', '[]', '5',
      '{"claudeVersion":"a","claudeVersion":"b"}', '\ufeff{"claudeVersion":"2.1.1"}', ' {"claudeVersion":"2.1.1"}\n', '{"claudeVersion":"\\ud83d\\ude00"}',
      '{"claudeVersion":"2.1.1"', '{"claudeVersion":["2.1.1"]}', '{"claudeVersion":"x","n":1e400}',
    ];
    for (const text of texts) {
      rmSync(file, { force: true });
      if (text !== null) writeFileSync(file, text);
      rows.push({ fn: 'hookFallbackFile.load', args: [text], out: fallback.hookFallbackFile(file).load() });
    }
    for (const version of ['2.1.200', '', '2.1.310 (Claude Code)', 'a"b\\c\n\u0001\u007f\u2028\u{1F600}']) {
      fallback.hookFallbackFile(file).save(version);
      rows.push({ fn: 'hookFallbackFile.save', args: [version], out: readFileSync(file, 'utf8') });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return rows;
}

function cellFileRows(cellFiles) {
  const names = [
    'claude-abc_1.json', 'claude-.json', 'claude-a.json.json', 'claude-a b.json', 'claude-a.JSON', 'Claude-a.json', 'claude-claude-a.json',
    'hook-debug.log', 'abc.json', '.json', 'a.b.json', 'abc.txt', 'abc-1z.txt', '..\\evil.txt', '../evil.txt', 'a\nb.txt', 'abc.txt.bak',
    `${'x'.repeat(64)}.txt`, `${'x'.repeat(65)}.txt`, `claude-${'x'.repeat(64)}.json`, 'claude-\u0105.json', '\u0105.json', 'claude-a.json\n',
    'notes.txt', 'abc', '', 'claude-a-b_C-9.json', 'a.txt.txt',
  ];
  const rows = [];
  for (const kind of ['hooks', 'mcp', 'prompts']) for (const name of names) rows.push({ fn: 'cellOfFile', args: [kind, name], out: cellFiles.cellOfFile(kind, name) });
  return rows;
}

/** Every row of test/golden/hook-settings.jsonl. */
export function hookSettingsRows({ hooks, codexHooks, hookFallback, cellFiles }) {
  return [
    ...settingsRows(hooks), ...writeRows(hooks), ...proxyRows(hooks), ...codexRows(codexHooks), ...globRows(hookFallback),
    ...allowedRows(hookFallback), ...settingsFileRows(hookFallback), ...fallbackFileRows(hookFallback), ...cellFileRows(cellFiles),
  ];
}
