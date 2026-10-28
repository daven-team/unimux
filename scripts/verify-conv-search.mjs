// Real-app check of the 1.0.9 conversation search (npm run build first). The app runs with a scratch home whose ~/.claude
// and ~/.codex hold generated transcripts (never the real ones), and no real Claude or Codex can start (PATH is cut down).
// Checks: the shortcut opens the search; an empty query lists every conversation; a folded query (no diacritics) finds the
// Polish text with marks; the agent filter; the transcript preview; Enter resumes in a new cell of the conversation's
// project; a conversation of a folder no project holds adds that project; Ctrl+Enter resumes in the free focused cell;
// copy id. Screenshots go to a temporary folder (printed at the end).
// Usage: npm run build && node scripts/verify-conv-search.mjs [--many 2000]
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

const argv = process.argv.slice(2);
const many = Number(argv[argv.indexOf('--many') + 1] || 0) || 0;
const shots = mkdtempSync(join(tmpdir(), 'unimux-convsearch-shots-'));
const root = scratchRoot('convsearch');
const project = join(root, 'project');
const other = join(root, 'other-folder');
mkdirSync(other, { recursive: true });
const home = join(root, 'home');
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const ids = { fix: randomUUID(), theme: randomUUID(), other: randomUUID(), codex: randomUUID() };

function claudeFile(cwd, id, title, turns, day) {
  const dir = join(home, '.claude', 'projects', enc(cwd));
  mkdirSync(dir, { recursive: true });
  const lines = [];
  let t = Date.parse(`2026-10-${String(day).padStart(2, '0')}T09:00:00Z`);
  for (const [role, text] of turns) {
    t += 30000;
    const ts = new Date(t).toISOString();
    if (role === 'user') lines.push({ type: 'user', isSidechain: false, message: { role: 'user', content: text }, uuid: randomUUID(), timestamp: ts, cwd, sessionId: id });
    else {
      lines.push({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }] }, uuid: randomUUID(), timestamp: ts, cwd, sessionId: id });
      lines.push({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] }, uuid: randomUUID(), timestamp: ts, cwd, sessionId: id });
      lines.push({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'tool output that is never indexed '.repeat(50) }] }, uuid: randomUUID(), timestamp: ts, cwd, sessionId: id });
    }
  }
  if (title) lines.push({ type: 'ai-title', aiTitle: title, sessionId: id });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function codexFile(cwd, id, turns) {
  const dir = join(home, '.codex', 'sessions', '2026', '10', '21');
  mkdirSync(dir, { recursive: true });
  const lines = [{ timestamp: '2026-10-21T10:00:00Z', type: 'session_meta', payload: { id, timestamp: '2026-10-21T10:00:00Z', cwd } },
    { timestamp: '2026-10-21T10:00:00Z', type: 'turn_context', payload: { cwd, model: 'gpt-6.1-sol' } }];
  for (const [role, text] of turns) lines.push({ timestamp: '2026-10-21T10:00:05Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  writeFileSync(join(dir, `rollout-2026-10-21T10-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

claudeFile(project, ids.fix, 'Fix the lost tabs after a restart', [
  ['user', 'Napraw zapis stanu: plik state.json gubi zakładki po restarcie aplikacji. Zażółć gęślą jaźń.'],
  ['assistant', 'Sprawdziłem atomicWrite: rename nie był wywoływany po zapisie pliku tymczasowego, więc zakładki znikały. Poprawione i dodany test.'],
  ['user', 'Dzięki, uruchom jeszcze testy.'],
  ['assistant', 'Wszystkie testy przechodzą (npm test).'],
], 24);
claudeFile(project, ids.theme, 'Dark theme toggle', [
  ['user', 'Add a dark theme toggle to the settings page'],
  ['assistant', 'I added the toggle in SettingsPage.tsx and stored the theme in the settings.'],
], 22);
claudeFile(other, ids.other, 'Release notes for the pool migration', [
  ['user', 'Write release notes for the Redis pool migration'],
  ['assistant', 'Here are the release notes: the Redis client now borrows connections from a pool.'],
], 20);
codexFile(project, ids.codex, [
  ['user', 'Migrate the Redis client to the new pool API'],
  ['assistant', 'The pool now comes from createPool() and every command borrows a connection.'],
]);
for (let i = 0; i < many; i++) {
  claudeFile(join(root, `bulk-${i % 40}`), randomUUID(), null, [
    ['user', `Bulk conversation ${i}: refactor module ${i % 97} and keep the API`],
    ['assistant', `Refactored module ${i % 97}. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}`],
  ], 1 + (i % 19));
}

const cellId = randomUUID();
const tabId = randomUUID();
const projectId = randomUUID();
writeState(root, {
  version: 1, settings: { language: 'pl' }, activeProjectId: projectId,
  profiles: [
    { id: 'sh', name: 'Shell', cli: 'shell', args: '', color: '#8b5cf6' },
    { id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' },
    { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
  ],
  projects: [{ id: projectId, name: 'Projekt X', path: project, color: '#3b82f6', archive: [], activeTabId: tabId, tabs: [
    { id: tabId, name: 'Main', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }, cells: [{ id: cellId, profileId: 'sh' }] },
  ] }],
});

let app;
const ok = (name) => console.log(`OK ${name}`);
const shot = async (name) => {
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
};
const key = async (code, k, modifiers) => {
  for (const type of ['keyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: { KeyD: 68, Enter: 13, ArrowDown: 40 }[code] ?? 0, modifiers });
};
/** The option of the open list box whose whole text is `text`. */
const pick = (text) => app.evaluate(`(() => { const o = [...document.querySelectorAll('[role=option]')].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!o) throw new Error('option ' + ${JSON.stringify(text)}); o.click(); return true; })()`);
const snapshot = () => app.evaluate(`window.mc.loadSnapshot().then((s) => s.state)`);
const hitTitles = () => app.evaluate(`[...document.querySelectorAll('.conv-hit .conv-title')].map((e) => e.textContent)`);
const openSearch = async () => {
  await app.evaluate(`document.activeElement?.blur?.(), true`);
  await key('KeyD', 'D', 2 | 8);
  await app.until(`!!document.querySelector('.modal.conv-search')`, 'search opened by Ctrl+Shift+D');
};
const query = async (text) => {
  await app.setValue('.conv-search .conv-query', text);
  await sleep(500);
  await app.until(`!/Indeksowanie/.test(document.querySelector('.conv-status')?.textContent ?? '')`, 'index complete', 60000);
  await sleep(300);
};

try {
  const path = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';');
  app = await launchApp(root, { PATH: path, Path: null, CLAUDE_CONFIG_DIR: null, CODEX_HOME: null });
  await sleep(1000);
  const opened = Date.now();
  await openSearch();
  await app.until(`document.querySelectorAll('.conv-hit').length >= 4`, 'every conversation listed', 60000);
  await app.until(`!/Indeksowanie/.test(document.querySelector('.conv-status')?.textContent ?? '')`, 'index complete', 120000);
  const ready = Date.now() - opened;
  const status = await app.evaluate(`document.querySelector('.conv-status').textContent`);
  ok(`empty query lists the conversations (${status}; ${ready} ms from the shortcut to a complete index)`);

  await query('zazolc restart');
  let titles = await hitTitles();
  if (titles.length !== 1 || titles[0] !== 'Fix the lost tabs after a restart') throw new Error(`folded query: ${JSON.stringify(titles)}`);
  const marks = await app.evaluate(`[...document.querySelectorAll('.conv-hit.on mark')].map((m) => m.textContent)`);
  if (!marks.includes('Zażółć') || !marks.some((m) => /restart/i.test(m))) throw new Error(`marks: ${JSON.stringify(marks)}`);
  await app.until(`document.querySelectorAll('.conv-transcript .conv-msg').length === 4`, 'transcript preview');
  const target = await app.evaluate(`document.querySelector('.conv-msg.target')?.textContent ?? ''`);
  if (!target.includes('gubi zakładki')) throw new Error(`preview target: ${target}`);
  await shot('conv-search-query.png');
  ok(`a query without diacritics finds the Polish text and marks it (${JSON.stringify(marks)}), preview shows 4 messages`);

  await query('pool');
  titles = await hitTitles();
  if (titles.length !== 2) throw new Error(`pool: ${JSON.stringify(titles)}`);
  await app.click('.conv-toolbar .select', 'Claude i Codex');
  await pick('Codex');
  await sleep(600);
  titles = await hitTitles();
  if (titles.length !== 1 || !titles[0].startsWith('Migrate the Redis client')) throw new Error(`codex filter: ${JSON.stringify(titles)}`);
  await shot('conv-search-codex.png');
  ok('the agent filter keeps only the Codex conversation');
  await app.click('.conv-toolbar .select', 'Codex');
  await pick('Claude i Codex');
  await sleep(400);

  // Copy id.
  await query('dark theme');
  await app.click('.conv-actions .btn', 'Kopiuj ID');
  await sleep(300);
  const clip = await app.evaluate(`window.mc.clipboardRead ? window.mc.clipboardRead() : null`).catch(() => null);
  if (clip !== null && clip !== ids.theme) throw new Error(`clipboard: ${clip}`);
  ok(`copy id${clip === null ? ' (toast only, no clipboard reader in the preload)' : ` copied ${clip}`}`);

  // Ctrl+Enter: the focused shell cell is free and in the project folder, so it takes the conversation.
  await app.evaluate(`document.querySelector('.conv-search .conv-query').focus(), true`);
  await app.until(`!document.querySelector('.conv-actions .btn:nth-child(2)')?.disabled`, 'focused-cell button enabled', 5000).catch(async () => {
    const reason = await app.evaluate(`document.querySelector('.conv-actions .btn:nth-child(2)')?.title`);
    throw new Error(`the focused cell is not free: ${reason}`);
  });
  await key('Enter', 'Enter', 2);
  await app.until(`!document.querySelector('.modal.conv-search')`, 'modal closed after Ctrl+Enter');
  await sleep(800);
  let st = await snapshot();
  let cells = st.projects.find((p) => p.id === projectId).tabs[0].cells;
  if (cells.length !== 1 || cells[0].session?.id !== ids.theme || cells[0].profileId !== 'claude') throw new Error(`Ctrl+Enter: ${JSON.stringify(cells)}`);
  ok('Ctrl+Enter resumes in the free focused cell (profile claude, session set)');
  await shot('conv-search-resumed-focused.png');

  // Enter: a new cell of the same grid for the Codex conversation.
  await openSearch();
  await query('createPool');
  await key('Enter', 'Enter', 0);
  await app.until(`!document.querySelector('.modal.conv-search')`, 'modal closed after Enter');
  await sleep(800);
  st = await snapshot();
  cells = st.projects.find((p) => p.id === projectId).tabs[0].cells;
  const codexCell = cells.find((c) => c.session?.id === ids.codex);
  if (cells.length !== 2 || !codexCell || codexCell.profileId !== 'codex') throw new Error(`Enter: ${JSON.stringify(cells)}`);
  ok('Enter resumes the Codex conversation in a new cell of the grid');

  // An already open conversation: the button shows the open cell instead of a second copy.
  await openSearch();
  await query('createPool');
  const label = await app.evaluate(`document.querySelector('.conv-actions .btn.primary')?.textContent`);
  if (label !== 'Pokaż otwartą komórkę') throw new Error(`open conversation button: ${label}`);
  ok('a conversation that is already open offers its cell');

  // A conversation of a folder no project holds: the folder becomes a project and the conversation resumes there.
  await query('release notes');
  await shot('conv-search-other-folder.png');
  await key('Enter', 'Enter', 0);
  await app.until(`!document.querySelector('.modal.conv-search')`, 'modal closed (other folder)');
  await sleep(1000);
  st = await snapshot();
  const added = st.projects.find((p) => p.path.toLowerCase() === other.toLowerCase());
  const addedCell = added?.tabs.flatMap((t) => t.cells).find((c) => c.session?.id === ids.other);
  if (!added || !addedCell || st.activeProjectId !== added.id) throw new Error(`other folder: ${JSON.stringify(st.projects.map((p) => ({ path: p.path, tabs: p.tabs })))}`);
  ok('a conversation of an unknown folder adds the project and resumes in it');

  if (many) {
    await openSearch();
    const t0 = Date.now();
    await query('module 42');
    const s2 = await app.evaluate(`document.querySelector('.conv-status').textContent`);
    ok(`with ${many} extra conversations: "module 42" -> ${s2} (${Date.now() - t0} ms incl. 500 ms wait)`);
    await shot('conv-search-many.png');
  }
  console.log(`screenshots: ${shots}`);
} finally {
  await app?.close();
  removeScratch(root);
}
