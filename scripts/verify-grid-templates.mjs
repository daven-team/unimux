// Real-app check of 1.1.1 grid templates (npm run build first). No real Claude or Codex runs: PATH is cut to the Windows folders
// and MC_CLI_NO_REGISTRY keeps the registry PATH out,
// so the claude and codex cells show their install card; the cmd shell cells start for real.
// Checks: "Zapisz jako szablon…" in a grid tab's menu saves a 2x2 grid of mixed profiles (cmd shell with a folder, codex muted,
// claude with a folder, an SSH host) with its dragged sizes; the palette offers "Nowy grid z szablonu: <name>" and saving the grid;
// the "Dodaj" menu of another project opens a new grid from the template there: same layout and sizes, same profiles, names,
// colours, muted flag and SSH host, the folder that exists in that project resolved against its root and the missing one falling
// back to the root with a note; the grid dialog lists the template with the folder column filled in when loaded.
// Screenshots: <tmp>\unimux-grid-templates-shots\*.png (or GRID_TEMPLATE_SHOTS).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';

const SHOTS = process.env.GRID_TEMPLATE_SHOTS ?? join(tmpdir(), 'unimux-grid-templates-shots');
const P = { alpha: randomUUID(), beta: randomUUID() };
const T = { stack: randomUUID(), betaMain: randomUUID() };
const HOST = randomUUID();
const root = scratchRoot('templates');
const alphaPath = join(root, 'project');
const betaPath = join(root, 'beta');
for (const dir of [join(alphaPath, 'web'), join(alphaPath, 'api'), join(betaPath, 'web')]) mkdirSync(dir, { recursive: true });
const sized = {
  cols: 2, rows: 2, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }, { col: 0, row: 1, colSpan: 1, rowSpan: 1 }, { col: 1, row: 1, colSpan: 1, rowSpan: 1 }],
  rowSizes: [2, 1], rowColSizes: [[3, 1], null],
};
writeState(root, {
  version: 1, settings: { language: 'pl', backgroundLoad: 'visible', shell: 'cmd' }, activeProjectId: P.alpha,
  profiles: [
    { id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' },
    { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
    { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#8b5cf6' },
  ],
  sshHosts: [{ id: HOST, label: 'test-box', address: '127.0.0.1', port: 1, username: 'u', createdAt: 0, updatedAt: 0 }],
  projects: [
    { id: P.alpha, name: 'Alpha', path: alphaPath, color: '#3b82f6', archive: [], activeTabId: T.stack, tabs: [
      { id: T.stack, name: 'Stack', layout: sized, cells: [
        { id: randomUUID(), profileId: 'shell', name: 'Web', color: '#22c55e', dir: join(alphaPath, 'web') },
        { id: randomUUID(), profileId: 'codex', name: 'Review', muted: true, session: { cli: 'codex', id: 'never-copied' } },
        { id: randomUUID(), profileId: 'claude', name: 'Api', dir: join(alphaPath, 'api') },
        { id: randomUUID(), profileId: 'shell', ssh: { hostId: HOST, cwd: '/srv/never-copied' } },
      ] },
    ] },
    { id: P.beta, name: 'Beta', path: betaPath, color: '#22c55e', archive: [], activeTabId: T.betaMain, tabs: [
      { id: T.betaMain, name: 'Main', layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] }, cells: [{ id: randomUUID(), profileId: 'shell' }] },
    ] },
  ],
});

const env = { MC_CLI_NO_REGISTRY: '1', PATH: ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';'), Path: null };
const statePath = join(root, 'data', 'state.json');
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const results = [];
const ok = (name) => { results.push(name); console.log(`OK ${name}`); };
const fail = (message) => { throw new Error(message); };
let app;
try {
  mkdirSync(SHOTS, { recursive: true });
  app = await launchApp(root, env);
  const shot = async (name) => { const { data } = await app.cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64')); };
  const tabSel = (tabId) => `document.querySelector('.tab.grid-tab[data-workspace-id="grid:${tabId}"]')`;
  const menuClick = (label) => app.click('.menu [role="menuitem"]', label);
  const waitState = async (check, label, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { const s = readState(); if (check(s)) return s; } catch { /* being written */ } await sleep(200); }
    fail(`timeout: ${label}`);
  };
  await app.until(`document.querySelectorAll('.tab.grid-tab').length === 2`, 'two grid tabs');
  await sleep(1200);

  // 1. Save the grid from its tab's menu.
  await app.evaluate(`(() => { const r = ${tabSel(T.stack)}.getBoundingClientRect(); ${tabSel(T.stack)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.bottom - 4 })); return true; })()`);
  await app.until(`[...document.querySelectorAll('.menu [role="menuitem"]')].some((b) => b.textContent.includes('Zapisz jako szablon'))`, 'save as template item');
  await shot('01-tab-menu-save-as-template.png');
  await menuClick('Zapisz jako szablon');
  await app.until(`!!document.querySelector('.overlay .modal input')`, 'template name prompt');
  if (await app.evaluate(`document.querySelector('.overlay .modal input').value`) !== 'Stack') fail('the name prompt does not suggest the grid name');
  await app.setValue('.overlay .modal input', 'Pełny stack');
  await shot('02-template-name.png');
  await app.press('Enter');
  const saved = await waitState((s) => s.presets?.length === 1, 'template saved');
  const t = saved.presets[0];
  if (t.name !== 'Pełny stack' || t.projectId) fail(`template: ${JSON.stringify(t)}`);
  if (JSON.stringify(t.layout.rowSizes) !== '[2,1]' || JSON.stringify(t.layout.rowColSizes) !== '[[3,1],null]') fail(`sizes: ${JSON.stringify(t.layout)}`);
  const expectCells = [
    { profileId: 'shell', worktree: false, name: 'Web', color: '#22c55e', dir: 'web' },
    { profileId: 'codex', worktree: false, name: 'Review', muted: true },
    { profileId: 'claude', worktree: false, name: 'Api', dir: 'api' },
    { profileId: 'shell', worktree: false, sshHostId: HOST },
  ];
  for (const [i, want] of expectCells.entries()) for (const [k, v] of Object.entries(want)) if (t.cells[i][k] !== v) fail(`cell ${i} ${k}: ${JSON.stringify(t.cells[i])}`);
  if (JSON.stringify(t).match(/never-copied|session/)) fail('a session or a remote folder was saved');
  await app.until(`document.querySelector('.toast')?.textContent.includes('Pełny stack')`, 'saved toast');
  ok('a 2x2 grid of mixed profiles is saved as a global template with sizes, folders (relative), muted flag and SSH host, without sessions');

  // 2. The palette offers the template and saving the grid.
  await app.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await app.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await app.until(`!!document.querySelector('.modal.palette input')`, 'palette');
  await app.setValue('.modal.palette input', 'szablon');
  await app.until(`[...document.querySelectorAll('.palette-item .ptitle')].some((e) => e.textContent === 'Nowy grid z szablonu: Pełny stack')`, 'palette template entry');
  if (!(await app.evaluate(`[...document.querySelectorAll('.palette-item .ptitle')].some((e) => e.textContent.startsWith('Zapisz grid „Stack” jako szablon'))`))) fail('no save-as-template action in the palette');
  await shot('03-palette.png');
  await app.press('Escape');
  ok('the palette offers "Nowy grid z szablonu: Pełny stack" and "Zapisz grid „Stack” jako szablon…"');

  // 3. In project Beta, the Add menu opens a new grid from the template.
  await app.evaluate(`${tabSel(T.betaMain)}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId === 'grid:${T.betaMain}'`, 'beta in front');
  await app.click('.tb-add');
  await app.until(`[...document.querySelectorAll('.menu .menu-label')].some((e) => e.textContent === 'Nowy grid z szablonu')`, 'template section in the Add menu');
  await shot('04-add-menu.png');
  await menuClick('Pełny stack');
  const opened = await waitState((s) => s.projects.find((p) => p.id === P.beta).tabs.length === 2, 'grid opened in beta');
  const grid = opened.projects.find((p) => p.id === P.beta).tabs[1];
  if (grid.name !== 'Pełny stack') fail(`grid name: ${grid.name}`);
  if (JSON.stringify(grid.layout.rowSizes) !== '[2,1]' || JSON.stringify(grid.layout.rowColSizes) !== '[[3,1],null]' || grid.layout.areas.length !== 4) fail(`layout: ${JSON.stringify(grid.layout)}`);
  const c = grid.cells;
  if (c.map((x) => x.profileId).join() !== 'shell,codex,claude,shell') fail(`profiles: ${c.map((x) => x.profileId)}`);
  if (c[0].dir !== join(betaPath, 'web')) fail(`web folder: ${c[0].dir}`);
  if (c[2].dir !== undefined) fail(`missing folder did not fall back: ${c[2].dir}`);
  if (c[1].muted !== true || c[0].muted) fail('muted flags');
  if (c[3].ssh?.hostId !== HOST || c[3].ssh?.cwd) fail(`ssh: ${JSON.stringify(c[3].ssh)}`);
  if (c[0].name !== 'Web' || c[0].color !== '#22c55e' || c[1].name !== 'Review' || c[2].name !== 'Api') fail('names or colours');
  // A new agent cell gets a fresh session of its own when it starts; the template's never carries one over.
  if (JSON.stringify(c).includes('never-copied')) fail('a session or remote folder was copied');
  await app.until(`document.querySelector('.toast')?.textContent.includes('api')`, 'missing folder note');
  const note = await app.evaluate(`document.querySelector('.toast').textContent`);
  // The claude and codex cells must show the install card (no real agent may run in a check).
  await app.until(`document.querySelectorAll('.cli-missing').length >= 2`, 'install cards in the agent cells');
  await sleep(1500);
  await shot('05-new-grid-in-beta.png');
  ok(`the template opens in project Beta: 2x2 with sizes, profiles shell/codex/claude/ssh, web -> ${c[0].dir}, api missing -> project root (note: "${note}")`);

  // 4. The grid dialog lists the template; loading it fills the folder column.
  await app.evaluate(`[...document.querySelectorAll('.tb-btn')].find((b) => b.title.startsWith('Nowy grid')).click(), true`);
  await app.until(`!!document.querySelector('.grid-template-chip')`, 'template chip in the grid dialog');
  await app.click('.grid-template-chip', 'Pełny stack');
  await app.until(`[...document.querySelectorAll('.cell-table input.input')].some((e) => e.value === 'api')`, 'folder column filled');
  const folders = await app.evaluate(`[...document.querySelectorAll('.cell-table input[placeholder="katalog projektu"]')].map((e) => e.value)`);
  if (folders.join('|') !== 'web||api') fail(`folders in the dialog: ${JSON.stringify(folders)}`);
  await shot('06-grid-dialog-template.png');
  await app.evaluate(`(document.querySelector('.modal.wide .modal-body').scrollTop = 9999, true)`);
  // A taller window shows the whole dialog with its cell table and the folder column.
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1050, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await shot('06b-grid-dialog-folders.png');
  await app.cdp('Emulation.clearDeviceMetricsOverride');
  await app.evaluate(`(() => { const el = document.querySelector('.grid-template-chip'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 5, clientY: r.bottom })); return true; })()`);
  await app.until(`[...document.querySelectorAll('.menu [role="menuitem"]')].some((b) => b.textContent.includes('Zmień nazwę'))`, 'template menu');
  await shot('07-template-menu.png');
  ok('the grid dialog lists the template (rename / update / delete in its menu) and loading it fills the folder column');
  console.log(`ALL OK (${results.length}) - screenshots in ${SHOTS}`);
} finally {
  if (app) await app.close();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
