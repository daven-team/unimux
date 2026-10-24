// Real-app check of 1.0.0 "grid tabs across projects" (npm run build first). No real Claude or Codex runs: the grids hold shell
// cells whose profile is switched to "claude" in Settings after they started (the running shells stay shells), and the agent
// status is faked with the 'cell:hook' event main sends for a real hook (the technique of verify-agent-close.mjs). PATH is cut to
// the Windows folders, so even a restarted cell could not find a real CLI.
// The cells are cmd shells (cmd.exe is in the cut PATH), so they start and the screenshots show working terminals.
// Checks: the grids of two projects are tabs of one strip (project colour bar, project name in the tooltip, the project name as a
// prefix when two grids share a name); clicking a grid of the other project switches the project (sidebar and Files follow);
// Mod+Tab walks the whole strip across projects; a drag across projects reorders the strip and the order survives a restart
// (state.json); closing a grid with a working agent asks (Cancel keeps it); Mod+Shift+W with a file tab in front closes only
// the file tab, not the grid with the working agent behind it; "All tabs" groups by project.
// Screenshots: D:\Projekty\_shots\100-tabs-*.png
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, mainInspector, scratchRoot, sleep, writeState } from './ssh-ui-lib.mjs';

const P = { alpha: randomUUID(), beta: randomUUID() };
const T = { alphaMain: randomUUID(), alphaNotes: randomUUID(), betaBuild: randomUUID(), betaMain: randomUUID() };
const C = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID() };
const layout = (n) => ({ cols: n, rows: 1, areas: Array.from({ length: n }, (_, i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) });

const root = scratchRoot('gridtabs');
const alphaPath = join(root, 'project');
const betaPath = join(root, 'beta');
mkdirSync(betaPath, { recursive: true });
writeFileSync(join(alphaPath, 'notes.txt'), 'alpha notes\n');
writeFileSync(join(betaPath, 'beta-only.txt'), 'beta\n');
writeState(root, {
  version: 1, settings: { language: 'en', backgroundLoad: 'visible', shell: 'cmd' }, activeProjectId: P.alpha,
  profiles: [{ id: 'fake', name: 'Fake agent', cli: 'shell', args: '', color: '#8b5cf6' }],
  projects: [
    { id: P.alpha, name: 'Alpha', path: alphaPath, color: '#3b82f6', archive: [], activeTabId: T.alphaMain, tabs: [
      { id: T.alphaMain, name: 'Main', layout: layout(1), cells: [{ id: C.a, profileId: 'fake', name: 'Reviewer' }] },
      { id: T.alphaNotes, name: 'Notes', layout: layout(1), cells: [{ id: C.b, profileId: 'fake' }] },
    ] },
    { id: P.beta, name: 'Beta', path: betaPath, color: '#22c55e', archive: [], activeTabId: T.betaBuild, tabs: [
      { id: T.betaBuild, name: 'Build', layout: layout(1), cells: [{ id: C.c, profileId: 'fake', name: 'Builder' }] },
      { id: T.betaMain, name: 'Main', layout: layout(1), cells: [{ id: C.d, profileId: 'fake' }] },
    ] },
  ],
});

const inspectPort = 9300 + Math.floor(Math.random() * 500);
const env = { PATH: ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';'), Path: null };
let app;
let main;
const results = [];
const ok = (name) => { results.push(name); console.log(`OK ${name}`); };
const fail = (message) => { throw new Error(message); };
try {
  app = await launchApp(root, env, [`--inspect=${inspectPort}`]);
  main = await mainInspector(inspectPort);
  const tabSel = (tabId) => `document.querySelector('.tab.grid-tab[data-workspace-id="grid:${tabId}"]')`;
  const selectTab = (tabId) => app.evaluate(`${tabSel(tabId)}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  /** The strip as the user sees it: workspace ids left to right. */
  const strip = () => app.evaluate(`[...document.querySelectorAll('.workspace-tabs .tab')].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((el) => el.dataset.workspaceId)`);
  const activeKey = () => app.evaluate(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId ?? null`);
  // The rail tile of the open panel collapses it, so a panel is only clicked when it is not the shown one.
  const showPanel = async (id) => { if (!(await app.evaluate(`document.querySelector('#${id}-view')?.getAttribute('aria-selected') === 'true'`))) await app.click(`#${id}-view`); };
  const activeProject = async () => { await showPanel('projects'); return app.evaluate(`document.querySelector('.project.active .name')?.textContent ?? null`); };
  const projectIs = async (name, label) => { await showPanel('projects'); await app.until(`document.querySelector('.project.active .name')?.textContent === ${JSON.stringify(name)}`, label); };
  const filesShow = async (path, label) => { await showPanel('files'); await app.until(`!!document.querySelector('.file-entry[data-path=${JSON.stringify(path)}]')`, label); };
  const dialogText = () => app.evaluate(`document.querySelector('.overlay .modal')?.textContent ?? ''`);
  const key = async (code, keyName, vk, modifiers) => {
    for (const type of ['rawKeyDown', 'keyUp']) await app.cdp('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  };
  const CTRL = 2;
  const SHIFT = 8;

  // 1. Both projects' grids are tabs of the strip.
  await app.until(`document.querySelectorAll('.tab.grid-tab').length === 4`, 'four grid tabs');
  const tabs = await app.evaluate(`[...document.querySelectorAll('.tab.grid-tab')].map((t) => ({ id: t.dataset.workspaceId, project: t.dataset.projectId, label: t.querySelector('.label')?.textContent, title: t.title, bar: getComputedStyle(t.querySelector('.tab-project')).backgroundColor }))`);
  const byId = Object.fromEntries(tabs.map((t) => [t.id.slice(5), t]));
  if (byId[T.betaBuild].project !== P.beta || byId[T.alphaNotes].project !== P.alpha) fail(`project ids: ${JSON.stringify(tabs)}`);
  if (byId[T.alphaMain].label !== 'Alpha · Main' || byId[T.betaMain].label !== 'Beta · Main' || byId[T.betaBuild].label !== 'Build') fail(`labels: ${JSON.stringify(tabs)}`);
  if (!byId[T.betaBuild].title.includes('Project: Beta')) fail(`tooltip: ${byId[T.betaBuild].title}`);
  if (byId[T.alphaNotes].bar !== 'rgb(59, 130, 246)' || byId[T.betaBuild].bar !== 'rgb(34, 197, 94)') fail(`colour bars: ${JSON.stringify(tabs)}`);
  ok('the grids of both projects are tabs of one strip with the project colour, tooltip and a prefix for the shared name');

  // Every grid once so its shell starts (only shown cells start), ending on Alpha / Main.
  for (const id of [T.alphaNotes, T.betaMain, T.betaBuild, T.alphaMain]) { await selectTab(id); await sleep(1200); }
  await app.until(`document.querySelectorAll('.cell .xterm').length >= 1`, 'terminals');
  await app.screenshot('100-tabs-strip.png');

  // 2. A click on a grid of the other project switches the project (sidebar and Files follow) and the grid.
  await filesShow('notes.txt', 'Alpha files');
  await selectTab(T.betaBuild);
  await filesShow('beta-only.txt', 'Files follow to Beta');
  await projectIs('Beta', 'Beta active in the sidebar');
  if ((await activeKey()) !== `grid:${T.betaBuild}`) fail(`active tab after the click: ${await activeKey()}`);
  if ((await app.evaluate(`document.querySelectorAll('.tab.grid-tab').length`)) !== 4) fail('switching closed a grid');
  await app.screenshot('100-tabs-switch.png');
  ok('a click on a grid of the other project switches the project, the sidebar and Files');

  // 3. Mod+Tab walks the whole strip across projects.
  // The strip starts in the sidebar order (no saved order yet): Alpha / Main, Alpha / Notes, Beta / Build, Beta / Main.
  const initial = await strip();
  if (JSON.stringify(initial) !== JSON.stringify([T.alphaMain, T.alphaNotes, T.betaBuild, T.betaMain].map((id) => `grid:${id}`))) fail(`initial strip: ${JSON.stringify(initial)}`);
  await selectTab(T.alphaNotes);
  await projectIs('Alpha', 'Alpha / Notes in front');
  await app.evaluate(`(document.activeElement?.blur(), true)`);
  await key('Tab', 'Tab', 9, CTRL);
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId === ${JSON.stringify(`grid:${T.betaBuild}`)}`, 'Mod+Tab from Alpha / Notes to Beta / Build', 5000);
  await projectIs('Beta', 'Mod+Tab switched to Beta');
  await key('Tab', 'Tab', 9, CTRL | SHIFT);
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId === ${JSON.stringify(`grid:${T.alphaNotes}`)}`, 'Mod+Shift+Tab back to Alpha / Notes', 5000);
  await key('Tab', 'Tab', 9, CTRL | SHIFT);
  await key('Tab', 'Tab', 9, CTRL | SHIFT);
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId === ${JSON.stringify(`grid:${T.betaMain}`)}`, 'Mod+Shift+Tab wraps to the last tab', 5000);
  await selectTab(T.betaBuild);
  ok('Mod+Tab and Mod+Shift+Tab walk the whole strip across projects and wrap around');

  // 4. Drag Beta / Build before Alpha / Main (across projects); the order is saved in state.json.
  const dragCard = async (source, target, after) => {
    await app.evaluate(`window.cardTransfer = new DataTransfer(); document.querySelector('[data-workspace-id="${source}"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.cardTransfer })), true`);
    await app.until(`!!document.querySelector('[data-dragging]')`, 'drag started');
    const drop = (type) => `(() => { const el = document.querySelector('[data-workspace-id="${target}"]'); const b = el.getBoundingClientRect(); el.dispatchEvent(new DragEvent('${type}', { bubbles: true, cancelable: true, dataTransfer: window.cardTransfer, clientX: ${after} ? b.right - 2 : b.left + 2 })); return true; })()`;
    await app.evaluate(drop('dragover'));
    await app.until(`!!document.querySelector('[data-drop]')`, 'drop indicator');
    await app.evaluate(drop('drop'));
    await app.until(`!document.querySelector('[data-dragging], [data-drop]')`, 'drag cleanup');
  };
  await dragCard(`grid:${T.betaBuild}`, `grid:${T.alphaMain}`, false);
  const moved = await strip();
  if (moved.indexOf(`grid:${T.betaBuild}`) !== moved.indexOf(`grid:${T.alphaMain}`) - 1) fail(`order after the drag: ${JSON.stringify(moved)}`);
  await sleep(1500); // the state is written to disk with a short delay
  const saved = JSON.parse(readFileSync(join(root, 'data', 'state.json'), 'utf8')).workspaceOrder;
  const savedGrids = saved.filter((id) => id.startsWith('grid:'));
  const shownGrids = moved.filter((id) => id.startsWith('grid:'));
  if (JSON.stringify(savedGrids) !== JSON.stringify(shownGrids)) fail(`state.json order ${JSON.stringify(saved)} vs strip ${JSON.stringify(moved)}`);
  // Inside a project too, and the project's grid list (the sidebar and its "last 3") follows the strip.
  await dragCard(`grid:${T.alphaNotes}`, `grid:${T.alphaMain}`, false);
  await app.until(`(() => { const ids = [...document.querySelectorAll('.workspace-tabs .tab')].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((el) => el.dataset.workspaceId); return ids.indexOf('grid:${T.alphaNotes}') === ids.indexOf('grid:${T.alphaMain}') - 1; })()`, 'Notes before Main');
  await showPanel('projects');
  await app.until(`(() => { const names = [...document.querySelectorAll('.project')].find((p) => p.querySelector('.name')?.textContent === 'Alpha').parentElement.querySelectorAll('.tab-item .tname'); return [...names].map((n) => n.textContent).join(',') === 'Notes,Main'; })()`, 'sidebar follows the strip');
  await sleep(1500);
  const savedState = JSON.parse(readFileSync(join(root, 'data', 'state.json'), 'utf8'));
  const alphaTabs = savedState.projects.find((p) => p.id === P.alpha).tabs.map((t) => t.id);
  if (JSON.stringify(alphaTabs) !== JSON.stringify([T.alphaNotes, T.alphaMain])) fail(`Alpha grids in state.json: ${JSON.stringify(alphaTabs)}`);
  await app.screenshot('100-tabs-reordered.png');
  ok('a drag across projects reorders the strip and the order is in state.json; the sidebar list follows the strip');

  // 5. "All tabs" lists the entries grouped by project.
  await app.click('.tabs-all');
  await app.until(`!!document.querySelector('.ctx-menu, .context-menu, [role=menu]')`, 'all tabs menu');
  const menu = await app.evaluate(`(document.querySelector('.ctx-menu, .context-menu, [role=menu]')).innerText`);
  const lines = menu.split('\n').map((l) => l.trim()).filter(Boolean);
  const alphaAt = lines.indexOf('ALPHA'); // headers are upper case (CSS)
  const betaAt = lines.indexOf('BETA');
  if (alphaAt < 0 || betaAt < 0 || !lines.slice(alphaAt, alphaAt + 3).some((l) => l.startsWith('Notes')) || !lines.slice(betaAt).includes('Build') || betaAt < alphaAt) fail(`all tabs menu: ${JSON.stringify(lines)}`);
  await app.screenshot('100-tabs-all-menu.png');
  await app.press('Escape');
  await app.evaluate(`(document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true)`);
  ok(`"All tabs" groups the entries by project: ${JSON.stringify(lines)}`);

  // 6. The cells become "agents" (profile cli claude in Settings; the running shells stay shells).
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent === 'Agents')`, 'settings page');
  await app.click('.settings-nav [role=tab]', 'Agents');
  await app.until(`!!document.querySelector('#settings-profile-cli-fake')`, 'profile card');
  await app.click('#settings-profile-cli-fake');
  await app.click('[role=option]', 'claude');
  await sleep(300);
  // Settings is a tab of the strip: Mod+Tab leaves it (it used to be blocked there).
  if ((await activeKey()) !== 'settings') fail(`Settings not in front: ${await activeKey()}`);
  await app.evaluate(`(document.activeElement?.blur(), true)`);
  await key('Tab', 'Tab', 9, CTRL);
  await app.until(`!!document.querySelector('.workspace-tabs .tab.active') && document.querySelector('.workspace-tabs .tab.active').dataset.workspaceId !== 'settings'`, 'Mod+Tab leaves Settings', 5000);
  if (!(await app.evaluate(`!!document.querySelector('.settings-tab')`))) fail('Mod+Tab closed Settings');
  ok(`Mod+Tab leaves Settings (now ${await activeKey()})`);
  await app.click('.settings-tab');
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId === 'settings'`, 'Settings in front again');
  // Mod+Shift+W with Settings in front closes Settings only.
  await key('KeyW', 'W', 87, CTRL | SHIFT);
  await app.until(`!document.querySelector('.settings-tab')`, 'Settings closed by Mod+Shift+W');
  if ((await app.evaluate(`document.querySelectorAll('.tab.grid-tab').length`)) !== 4) fail('Mod+Shift+W in Settings closed a grid');

  // 7. Closing a grid of the other project with a working agent asks; Cancel keeps it.
  await selectTab(T.betaBuild);
  await projectIs('Beta', 'Beta again');
  await main.hook(C.a, 'prompt'); // Reviewer in Alpha / Main works
  await sleep(600);
  await app.evaluate(`${tabSel(T.alphaMain)}.querySelector('.x').click(), true`);
  await app.until(`!!document.querySelector('.overlay .modal')`, 'close question');
  const text = await dialogText();
  if (!text.includes('Close a tab where agents are working?') || !text.includes('Reviewer')) fail(`dialog: ${text}`);
  await app.screenshot('100-tabs-close-asks.png');
  await app.click('.overlay .modal .modal-foot .btn', 'Cancel');
  await sleep(400);
  if (!(await app.evaluate(`!!${tabSel(T.alphaMain)}`))) fail('Cancel closed the grid');
  ok('closing a grid with a working agent asks (also from another project); Cancel keeps it');

  // 8. Mod+Shift+W with a file tab in front closes only the file tab (no question, the grid with the working agent stays).
  await selectTab(T.alphaMain);
  await projectIs('Alpha', 'Alpha again');
  await filesShow('notes.txt', 'Alpha files again');
  await app.click('.file-entry[data-path="notes.txt"]');
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.classList.contains('file-tab')`, 'file tab in front');
  // The file tab of Alpha stays in the strip while Beta is on screen (with Alpha's colour); clicking it switches back to Alpha.
  const fileSel = `document.querySelector('.workspace-tabs .file-tab')`;
  await selectTab(T.betaBuild);
  await projectIs('Beta', 'Beta with the Alpha file open');
  const fileTab = await app.evaluate(`(() => { const t = ${fileSel}; return t && { project: t.dataset.projectId, bar: getComputedStyle(t.querySelector('.tab-project')).backgroundColor, title: t.title }; })()`);
  if (!fileTab || fileTab.project !== P.alpha || fileTab.bar !== 'rgb(59, 130, 246)' || !fileTab.title.includes('Project: Alpha')) fail(`Alpha file tab while Beta is shown: ${JSON.stringify(fileTab)}`);
  await app.screenshot('100-tabs-file-other-project.png');
  await app.evaluate(`${fileSel}.click(), true`);
  await projectIs('Alpha', 'the file tab switches to Alpha');
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.classList.contains('file-tab') && !!document.querySelector('.file-editor')`, 'file in front again');
  ok('a file tab of another project stays in the strip with its colour; clicking it switches the project');
  await app.screenshot('100-tabs-file-front.png');
  await app.evaluate(`(document.activeElement?.blur(), true)`);
  await key('KeyW', 'W', 87, CTRL | SHIFT);
  await app.until(`!document.querySelector('.file-tab')`, 'file tab closed', 5000);
  await sleep(600);
  if (await app.evaluate(`!!document.querySelector('.overlay .modal')`)) fail(`Mod+Shift+W asked about the grid: ${await dialogText()}`);
  if (!(await app.evaluate(`!!${tabSel(T.alphaMain)}`))) fail('Mod+Shift+W closed the grid behind the file');
  if ((await activeKey()) !== `grid:${T.alphaMain}`) fail(`after closing the file: ${await activeKey()}`);
  ok('Mod+Shift+W with a file tab in front closes only the file tab');
  await main.hook(C.a, 'stop');
  await sleep(500);

  // The profile goes back to a plain shell, so the cells start again after the restart (no real CLI is ever looked for).
  await app.click('.tb-btn[aria-label="Settings"]');
  await app.until(`[...document.querySelectorAll('.settings-nav [role=tab]')].some((t) => t.textContent === 'Agents')`, 'settings page (back to shell)');
  await app.click('.settings-nav [role=tab]', 'Agents');
  await app.until(`!!document.querySelector('#settings-profile-cli-fake')`, 'profile card (back to shell)');
  await app.click('#settings-profile-cli-fake');
  await app.click('[role=option]', 'shell');
  await sleep(300);
  await app.click('.settings-tab .x');
  await app.until(`!document.querySelector('.settings-tab')`, 'Settings closed');
  await sleep(1500); // the state is written to disk with a short delay

  // 9. Restart: the order of the strip is the same.
  const orderBefore = await strip();
  main.close();
  main = undefined;
  await app.close();
  app = undefined;
  await sleep(1500);
  app = await launchApp(root, env);
  await app.until(`document.querySelectorAll('.tab.grid-tab').length === 4`, 'four grid tabs after the restart');
  await sleep(500);
  const orderAfter = await strip();
  if (JSON.stringify(orderAfter) !== JSON.stringify(orderBefore)) fail(`order after the restart ${JSON.stringify(orderAfter)} vs ${JSON.stringify(orderBefore)}`);
  if ((await activeProject()) !== 'Alpha') fail(`active project after the restart: ${await activeProject()}`);
  await app.screenshot('100-tabs-after-restart.png');
  ok('the order of the strip survives a restart');

  // 10. Closing the grid in front brings its strip neighbour to the front, also when that one belongs to another project.
  const owners = await app.evaluate(`[...document.querySelectorAll('.workspace-tabs .tab.grid-tab')].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((el) => [el.dataset.workspaceId, el.dataset.projectId])`);
  const at = owners.findIndex(([, project], i) => owners[i + 1] && owners[i + 1][1] !== project);
  if (at < 0) fail(`no neighbours of different projects: ${JSON.stringify(owners)}`);
  const [closing, closingProject] = owners[at];
  const [neighbour, neighbourProject] = owners[at + 1];
  const closingId = closing.slice(5);
  await selectTab(closingId);
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId === ${JSON.stringify(closing)}`, 'grid to close in front');
  await app.evaluate(`${tabSel(closingId)}.querySelector('.x').click(), true`);
  await app.until(`!${tabSel(closingId)}`, 'grid closed');
  await app.until(`document.querySelector('.workspace-tabs .tab.active')?.dataset.workspaceId === ${JSON.stringify(neighbour)}`, 'the strip neighbour in front', 5000);
  await projectIs(neighbourProject === P.alpha ? 'Alpha' : 'Beta', 'the neighbour project is active');
  if (closingProject === neighbourProject) fail('the neighbour is of the same project');
  await app.screenshot('100-tabs-close-neighbour.png');
  ok('closing the grid in front brings its strip neighbour (of the other project) to the front');
  console.log(`ALL OK (${results.length})`);
} finally {
  main?.close();
  if (app) await app.close();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
