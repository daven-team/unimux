// Real-app check of 1.1.1: the Markdown export of a conversation and Ctrl+Tab between recently used tabs (npm run build first).
// The app runs with a scratch home whose ~/.claude and ~/.codex hold generated transcripts (never the real ones); PATH is cut
// down so no real Claude or Codex starts. Exports go to a scratch folder (MC_NOTES_EXPORT_DIR) instead of the save dialog.
// Export: the cell menu opens the dialog, tool calls are off by default and one line each when on, save to a file, copy, save as
// a note, the palette entry, and the export of a search result going back to the search. Ctrl+Tab: a tap toggles between the
// last two tabs, held it walks further with the switcher shown, Ctrl+Shift+Tab walks back, Esc cancels, and the keys work with
// the focus in a terminal. Screenshots go to a temporary folder (printed at the end).
// Usage: npm run build && node scripts/verify-conv-export.mjs
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';
import { removeScratch } from './app-env.mjs';

const shots = mkdtempSync(join(tmpdir(), 'unimux-convexport-shots-'));
const root = scratchRoot('convexport');
const project = join(root, 'project');
const home = join(root, 'home');
const exportsDir = join(root, 'exports');
mkdirSync(exportsDir, { recursive: true });
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const ids = { claude: randomUUID(), codex: randomUUID() };

{
  const dir = join(home, '.claude', 'projects', enc(project));
  mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.parse('2026-10-24T09:00:00Z') + s * 1000).toISOString();
  const base = { isSidechain: false, cwd: project, sessionId: ids.claude };
  const lines = [
    { ...base, type: 'user', message: { role: 'user', content: 'Napraw zapis stanu: plik state.json gubi zakładki po restarcie.' }, uuid: 'u1', timestamp: at(0) },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET-THINKING' }] }, uuid: 'a0', timestamp: at(1) },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Sprawdzę atomicWrite i uruchomię testy.' }] }, uuid: 'a1', timestamp: at(2) },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] }, uuid: 'a2', timestamp: at(3) },
    { ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-TOOL-OUTPUT' }] }, uuid: 'u2', timestamp: at(4) },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/main/atomicWrite.ts', old_string: 'a', new_string: 'b' } }] }, uuid: 'a3', timestamp: at(5) },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Poprawione: rename po zapisie pliku tymczasowego. Testy przechodzą.' }] }, uuid: 'a4', timestamp: at(6) },
    { type: 'ai-title', aiTitle: 'Fix the lost tabs after a restart', sessionId: ids.claude },
  ];
  writeFileSync(join(dir, `${ids.claude}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
{
  const dir = join(home, '.codex', 'sessions', '2026', '10', '21');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { timestamp: '2026-10-21T10:00:00Z', type: 'session_meta', payload: { id: ids.codex, timestamp: '2026-10-21T10:00:00Z', cwd: project } },
    { timestamp: '2026-10-21T10:00:00Z', type: 'turn_context', payload: { cwd: project, model: 'gpt-6.1-sol' } },
    { timestamp: '2026-10-21T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Migrate the Redis client to the new pool API' }] } },
    { timestamp: '2026-10-21T10:00:06Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'rg createPool src'] }), call_id: 'c1' } },
    { timestamp: '2026-10-21T10:00:07Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The pool now comes from createPool().' }] } },
  ];
  writeFileSync(join(dir, `rollout-2026-10-21T10-00-00-${ids.codex}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const projectId = randomUUID();
const grid = (name, cells) => ({ id: randomUUID(), name, layout: { cols: cells.length, rows: 1, areas: cells.map((_, i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) }, cells });
const tabs = [
  grid('Alfa', [{ id: randomUUID(), profileId: 'claude', session: { cli: 'claude', id: ids.claude } }, { id: randomUUID(), profileId: 'sh' }]),
  grid('Beta', [{ id: randomUUID(), profileId: 'sh' }]),
  grid('Gamma', [{ id: randomUUID(), profileId: 'sh' }]),
  grid('Delta', [{ id: randomUUID(), profileId: 'sh' }]),
];
writeState(root, {
  version: 1, settings: { language: 'pl' }, activeProjectId: projectId,
  profiles: [
    { id: 'sh', name: 'Shell', cli: 'shell', args: '', color: '#8b5cf6' },
    { id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' },
    { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
  ],
  projects: [{ id: projectId, name: 'Projekt X', path: project, color: '#3b82f6', archive: [], activeTabId: tabs[0].id, tabs }],
});

let app;
const ok = (name) => console.log(`OK ${name}`);
const shot = async (name) => {
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
};
const snapshot = () => app.evaluate(`window.mc.loadSnapshot().then((s) => s.state)`);
const activeTab = () => app.evaluate(`document.querySelector('.workspace-tabs .tab.active .label')?.textContent ?? null`);
const preview = () => app.evaluate(`document.querySelector('.convx-preview')?.textContent ?? ''`);
const toastText = () => app.evaluate(`document.querySelector('.toast')?.textContent ?? ''`);
const ctrl = (type) => app.cdp('Input.dispatchKeyEvent', { type, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: type === 'keyUp' ? 0 : 2 });
const shift = (type) => app.cdp('Input.dispatchKeyEvent', { type, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: type === 'keyUp' ? 2 : 10 });
const tab = async (withShift = false) => {
  for (const type of ['rawKeyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: withShift ? 10 : 2 });
};
const clickTab = (name) => app.evaluate(`(() => { const t = [...document.querySelectorAll('.workspace-tabs .tab')].find((e) => e.querySelector('.label')?.textContent === ${JSON.stringify(name)}); if (!t) throw new Error('tab ' + ${JSON.stringify(name)}); t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); return true; })()`);
const expectTab = async (name, label) => {
  await app.until(`document.querySelector('.workspace-tabs .tab.active .label')?.textContent === ${JSON.stringify(name)}`, `${label}: ${name} in front`, 5000)
    .catch(async (e) => { throw new Error(`${e.message} (in front: ${await activeTab()})`); });
};
const openCellExport = async () => {
  await app.evaluate(`(() => { const b = document.querySelector('.cell [aria-label="Więcej akcji"]'); if (!b) throw new Error('no more button'); b.click(); return true; })()`);
  await app.click('.menu .menu-item', 'Eksportuj rozmowę do Markdown');
  await app.until(`document.querySelector('.convx-preview')?.textContent.includes('## Ty')`, 'export preview');
};

try {
  const path = ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';');
  app = await launchApp(root, { PATH: path, Path: null, CLAUDE_CONFIG_DIR: null, CODEX_HOME: null, MC_NOTES_EXPORT_DIR: exportsDir });
  await sleep(1500);

  // ── J. Export ──────────────────────────────────────────────────────────────
  await openCellExport();
  let md = await preview();
  if (!md.startsWith('# Fix the lost tabs after a restart') || !md.includes('- Agent: Claude Code (claude-opus-5-5)') || !md.includes(`- Folder projektu: \`${project}\``)) throw new Error(`header: ${md.slice(0, 400)}`);
  if (!md.includes('## Ty\n\nNapraw zapis stanu') || !md.includes('## Claude\n\nSprawdzę atomicWrite')) throw new Error(`sections: ${md}`);
  if (md.includes('Narzędzie') || md.includes('SECRET')) throw new Error(`tool calls or hidden content without the option: ${md}`);
  await shot('conv-export-dialog.png');
  ok('the cell menu opens the export: header, "## Ty" / "## Claude", no tool calls, no thinking or tool output');

  await app.click('.convx-tools input');
  await app.until(`document.querySelector('.convx-preview')?.textContent.includes('> Narzędzie: Bash \`npm test\`')`, 'tool lines');
  md = await preview();
  if (!md.includes('> Narzędzie: Edit `src/main/atomicWrite.ts`') || md.includes('SECRET')) throw new Error(`tool lines: ${md}`);
  await shot('conv-export-tools.png');
  ok('"Dołącz wywołania narzędzi" adds one line per call');

  await app.click('.convx-dialog .modal-foot .btn', 'Zapisz do pliku');
  await app.until(`!document.querySelector('.convx-dialog')`, 'dialog closed after saving');
  const saved = readdirSync(exportsDir);
  if (saved.length !== 1 || !/^Fix the lost tabs after a restart 2026-10-2\d\.md$/.test(saved[0])) throw new Error(`saved: ${JSON.stringify(saved)}`);
  const file = readFileSync(join(exportsDir, saved[0]), 'utf8');
  if (file !== md) throw new Error('the saved file differs from the preview');
  ok(`saved to a file: ${saved[0]} (${file.length} chars, same as the preview)`);

  await openCellExport();
  await app.click('.convx-dialog .modal-foot .btn', 'Kopiuj do schowka');
  await app.until(`/Skopiowano rozmowę jako Markdown/.test(document.querySelector('.toast')?.textContent ?? '')`, 'copy toast');
  ok(`copy: ${await toastText()}`);

  await app.click('.convx-dialog .modal-foot .btn', 'Zapisz jako notatkę');
  await app.until(`!document.querySelector('.convx-dialog')`, 'dialog closed after the note');
  await sleep(800);
  const st = await snapshot();
  const note = st.notes?.find((n) => n.name === 'Fix the lost tabs after a restart');
  if (!note || !note.text.includes('## Claude')) throw new Error(`note: ${JSON.stringify(st.notes)}`);
  await shot('conv-export-note.png');
  ok('saved as a note (open in the Notes panel)');
  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), true`);

  // The palette offers it for the focused cell.
  await app.evaluate(`document.querySelector('.cell .xterm')?.closest('.cell')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true`);
  await sleep(300);
  await app.evaluate(`document.activeElement?.blur?.(), true`);
  await app.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await app.until(`!!document.querySelector('.modal.palette')`, 'palette');
  await app.setValue('.modal.palette input', 'eksportuj rozmow');
  await sleep(300);
  const items = await app.evaluate(`[...document.querySelectorAll('.palette-item')].map((e) => e.textContent)`);
  if (!items.some((t) => t.includes('Komórka: eksportuj rozmowę do Markdown'))) throw new Error(`palette: ${JSON.stringify(items)}`);
  await app.press('Escape');
  ok('the palette offers "Komórka: eksportuj rozmowę do Markdown…" for the focused Claude cell');

  // From the conversation search: the export of a result, and Esc goes back to the search with the query kept.
  await app.evaluate(`document.activeElement?.blur?.(), true`);
  for (const type of ['rawKeyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 3 });
  await app.until(`!!document.querySelector('.modal.conv-search')`, 'search opened');
  await app.setValue('.conv-search .conv-query', 'createPool');
  await app.until(`document.querySelectorAll('.conv-hit').length === 1 && !/Indeksowanie/.test(document.querySelector('.conv-status')?.textContent ?? '')`, 'codex hit', 60000);
  await app.click('.conv-actions .btn', 'Eksportuj do Markdown');
  await app.until(`document.querySelector('.convx-preview')?.textContent.includes('## Codex')`, 'codex export');
  // The option is remembered from the cell's export.
  if (!(await app.evaluate(`document.querySelector('.convx-tools input').checked`))) throw new Error('the tool option was not remembered');
  await app.until(`document.querySelector('.convx-preview')?.textContent.includes('> Narzędzie: shell \`rg createPool src\`')`, 'codex tool line');
  await shot('conv-export-codex.png');
  await app.press('Escape');
  await app.until(`document.querySelector('.conv-search .conv-query')?.value === 'createPool' && document.querySelectorAll('.conv-hit').length === 1`, 'back in the search with the query');
  await shot('conv-export-back-to-search.png');
  await app.press('Escape');
  ok('a search result exports (Codex, shell line without the wrapper); Esc goes back to the search with the query kept');

  // ── K. Ctrl+Tab ─────────────────────────────────────────────────────────────
  await app.until(`!document.querySelector('.overlay')`, 'no modal');
  for (const name of ['Beta', 'Gamma', 'Delta', 'Alfa']) { await clickTab(name); await expectTab(name, 'click'); await sleep(150); }
  // Recently used now: Alfa, Delta, Gamma, Beta.
  await ctrl('rawKeyDown'); await tab(); await ctrl('keyUp');
  await expectTab('Delta', 'tap');
  const quiet = await app.evaluate(`!document.querySelector('.tabsw-panel')`);
  await ctrl('rawKeyDown'); await tab(); await ctrl('keyUp');
  await expectTab('Alfa', 'second tap');
  ok(`a quick Ctrl+Tab toggles between the last two tabs (Alfa -> Delta -> Alfa${quiet ? ', no switcher flashed' : ''})`);

  // Held: Tab, Tab goes two back (Gamma) and shows the switcher.
  await ctrl('rawKeyDown'); await tab(); await tab();
  await app.until(`!!document.querySelector('.tabsw-panel')`, 'switcher shown while held');
  const rows = await app.evaluate(`[...document.querySelectorAll('.tabsw-row')].map((e) => e.querySelector('.tabsw-name').textContent + (e.classList.contains('on') ? '*' : ''))`);
  if (JSON.stringify(rows) !== JSON.stringify(['Alfa', 'Delta', 'Gamma*', 'Beta'])) throw new Error(`switcher rows: ${JSON.stringify(rows)}`);
  await shot('tab-switcher.png');
  await ctrl('keyUp');
  await expectTab('Gamma', 'held twice');
  await app.until(`!document.querySelector('.tabsw-panel')`, 'switcher gone');
  ok(`held Ctrl walks further with the switcher shown (${rows.join(', ')}), releasing Ctrl switches`);

  // Ctrl+Shift+Tab from the front goes to the least recently used tab.
  await ctrl('rawKeyDown'); await shift('rawKeyDown'); await tab(true); await shift('keyUp'); await ctrl('keyUp');
  await expectTab('Beta', 'Ctrl+Shift+Tab');
  ok('Ctrl+Shift+Tab walks back (least recently used first)');

  // Esc cancels.
  await ctrl('rawKeyDown'); await tab();
  await app.press('Escape', 2);
  await ctrl('keyUp');
  await sleep(300);
  if (await activeTab() !== 'Beta') throw new Error(`Esc did not cancel: ${await activeTab()}`);
  ok('Esc while held cancels the switch');

  // With the keyboard in a terminal: the key never reaches it, the switch still happens.
  await app.evaluate(`(() => { const ta = [...document.querySelectorAll('.xterm-helper-textarea')].find((t) => t.offsetParent); if (!ta) throw new Error('no terminal'); ta.focus(); return document.activeElement === ta; })()`);
  await app.evaluate(`window.__tabSeen = 0; document.querySelectorAll('.xterm-helper-textarea').forEach((t) => t.addEventListener('keydown', (e) => { if (e.key === 'Tab') window.__tabSeen++; })); true`);
  await ctrl('rawKeyDown'); await tab(); await ctrl('keyUp');
  await expectTab('Gamma', 'Ctrl+Tab from a terminal');
  const seen = await app.evaluate(`window.__tabSeen`);
  if (seen !== 0) throw new Error(`the terminal received Tab ${seen} times`);
  ok('Ctrl+Tab with the focus in a terminal switches and the terminal never sees the key');

  console.log(`screenshots: ${shots}`);
} finally {
  await app?.close();
  if (existsSync(root)) removeScratch(root);
}
