// Capture the real built Electron renderer. Never uses an installed app's data or AI models.
// Run: npm run build && node scripts/capture-readme.mjs
// Captures main, editor, project, grid-dialog, palette, git (a scratch git repository with history and changes) and ssh
// (the SSH view with demo hosts connected to the local test server scripts/ssh-test-server.mjs on 127.0.0.1).
// Requires Node >=22, installed dependencies, and an Electron desktop environment.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';
import { verifyWorkspaceUI } from './verify-workspace-ui.mjs';
import { scrubAppEnv } from './app-env.mjs';
import { killTree, startTestServer, writeKnownHost } from './ssh-ui-lib.mjs';

const checkout = process.cwd();
if (!existsSync(join(checkout, 'out/main/index.js'))) throw new Error('Build first: npm run build');
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'docs/screenshots');
mkdirSync(output, { recursive: true });
// Set MC_CAPTURE_ROOT to a generic path if your OS temp path contains a personal name.
const temporaryBase = resolve(process.env.MC_CAPTURE_ROOT ?? tmpdir());
mkdirSync(temporaryBase, { recursive: true });
const root = mkdtempSync(join(temporaryBase, 'unimux-readme-'));
const data = join(root, 'data'), project = join(root, 'atlas');
// The app gets a scratch home as well, so it never reads the real profile (~/.claude, ~/.codex, ~/.ssh, its appData).
const home = join(root, 'home');
for (const dir of [data, project, join(project, 'src'), join(project, 'test'), join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'atlas-demo', private: true, type: 'module', scripts: { test: 'node --test', check: 'node --check src/catalog.mjs' } }, null, 2));
writeFileSync(join(project, 'README.md'), [
  '# Atlas storefront',
  '',
  'A small product catalog shared by the storefront and API. **Six focused tests** cover filtering and price formatting.',
  '',
  '[Project checks](#project-checks) · [Browse the catalog source](src/catalog.mjs)',
  '',
  '## Catalog',
  '',
  '| Product | Category | Price |',
  '| --- | --- | ---: |',
  '| Orbit desk lamp | Lighting | $79 |',
  '| Folio notebook | Stationery | $12 |',
  '| Arc bookend | Workspace | $24 |',
  '',
  '> Keep the catalog API small. Review behavior beside the terminal before changing the implementation.',
  '',
  '## Quick start',
  '',
  '```javascript',
  "import { findProducts, formatPrice } from './src/catalog.mjs';",
  "console.log(findProducts('orbit'));",
  'console.log(formatPrice(79));',
  '```',
  '',
  '## Project checks',
  '',
  '- [x] Filter names and categories',
  '- [x] Format prices in USD',
  '- [ ] Review the next feature',
  '',
  'Run `npm test` to check filtering and price formatting.',
  '',
  '<details><summary>Preview sanitization fixture</summary>',
  '<p onclick="window.__markdownInjected=true">This text remains readable.</p>',
  '<script>window.__markdownInjected=true</script>',
  '<a href="javascript:window.__markdownInjected=true">Unsafe URL fixture</a>',
  '</details>',
  '',
].join('\n'));
writeFileSync(join(project, 'src/catalog.mjs'), `/** A tiny catalog shared by the storefront and API. */
export const products = [
  { id: 'orbit', name: 'Orbit desk lamp', category: 'lighting', price: 79 },
  { id: 'folio', name: 'Folio notebook', category: 'stationery', price: 12 },
  { id: 'arc', name: 'Arc bookend', category: 'workspace', price: 24 },
];

export function findProducts(query, catalog = products) {
  const search = query.trim().toLowerCase();
  return catalog.filter(product =>
    product.name.toLowerCase().includes(search) ||
    product.category.toLowerCase().includes(search)
  );
}

export function formatPrice(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
  }).format(amount);
}
`);
writeFileSync(join(project, 'test/catalog.test.mjs'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProducts, formatPrice } from '../src/catalog.mjs';
test('search finds a product by name', () => assert.equal(findProducts('orbit')[0].id, 'orbit'));
test('search is case insensitive', () => assert.equal(findProducts('FOLIO').length, 1));
test('search trims whitespace', () => assert.equal(findProducts(' arc ')[0].id, 'arc'));
test('search matches categories', () => assert.equal(findProducts('workspace').length, 1));
test('empty search returns the catalog', () => assert.equal(findProducts('').length, 3));
test('prices use US dollars', () => assert.equal(formatPrice(79), '$79.00'));
`);
writeFileSync(join(project, 'inspect.mjs'), `import { products, formatPrice } from './src/catalog.mjs';
console.log('ATLAS / PRODUCT CATALOG\\n');
for (const p of products) console.log(p.name.padEnd(24) + formatPrice(p.price).padStart(8));
console.log('\\n3 products · 3 categories · USD');
`);
writeFileSync(join(project, 'review.mjs'), `import { readFileSync } from 'node:fs';
const source = readFileSync('src/catalog.mjs', 'utf8');
console.log('ATLAS / SOURCE CHECK\\n');
console.log('Module:        src/catalog.mjs');
console.log('Exports:       ' + [...source.matchAll(/export (?:const|function) (\\w+)/g)].map(m => m[1]).join(', '));
console.log('Lines:         ' + source.trimEnd().split('\\n').length);
console.log('Dependencies:  JavaScript standard library');
console.log('\\nReady to review beside the terminal.');
`);
// The demo project is a scratch git repository: a few commits (one merged branch) now, working-tree changes just before the git capture.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Alex Demo', GIT_AUTHOR_EMAIL: 'alex@example.com', GIT_COMMITTER_NAME: 'Alex Demo', GIT_COMMITTER_EMAIL: 'alex@example.com' };
writeFileSync(join(root, 'gitconfig'), '');
function git(...args) { return execFileSync('git', args, { cwd: project, env: gitEnv, windowsHide: true, stdio: 'ignore' }); }
let commitHours = 52;
function commit(message, ...files) {
  git('add', ...files);
  const date = new Date(Date.now() - commitHours * 3600e3).toISOString(); commitHours -= 9;
  git('-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '-m', message, '--date', date);
}
git('init', '-q', '-b', 'main');
commit('Add the product catalog module', 'package.json', 'src/catalog.mjs');
commit('Cover catalog search and prices with tests', 'test/catalog.test.mjs');
git('switch', '-q', '-c', 'feature/inspect');
commit('Add a script that prints the catalog', 'inspect.mjs');
git('switch', '-q', 'main');
commit('Document the catalog in the README', 'README.md');
git('merge', '-q', '--no-ff', '--no-edit', 'feature/inspect');
commit('Add a source review script', 'review.mjs');
// SSH demo: three hosts of the group "production" on the local test server (user alice, no password), a few more hosts that are never contacted.
const sshServer = await startTestServer(['--no-auth', '--port', '2222']).catch(() => startTestServer(['--no-auth']));
process.on('exit', () => sshServer.stop());
writeKnownHost(root, sshServer);
const sshHost = (label, address, port, group, tags) => ({ id: randomUUID(), label, address, port, username: 'alice', ...(group ? { group } : {}), ...(tags ? { tags } : {}), createdAt: Date.now(), updatedAt: Date.now() });
const sshHosts = [
  sshHost('web-1', '127.0.0.1', sshServer.port, 'production', ['web']),
  sshHost('web-2', '127.0.0.1', sshServer.port, 'production', ['web']),
  sshHost('db-1', '127.0.0.1', sshServer.port, 'production', ['db']),
  sshHost('staging-web', 'stg-web.example.com', 22, 'staging', ['web']),
  sshHost('staging-db', 'stg-db.example.com', 22, 'staging', ['db']),
  sshHost('build-box', 'build.example.com', 22),
];
const layout = { cols: 2, rows: 2, areas: [0, 1, 2, 3].map(i => ({ col: i % 2, row: Math.floor(i / 2), colSpan: 1, rowSpan: 1 })) };
const cells = ['Tests', 'Catalog', 'Syntax check', 'Source review'].map((name, i) => ({ id: `readme-shell-${i}`, name, profileId: 'shell', color: ['#10b981', '#60a5fa', '#c084fc', '#fbbf24'][i] }));
const demoProject = { id: 'atlas', name: 'Atlas storefront', path: project, color: '#60a5fa', icon: { kind: 'emoji', value: '🌐' }, archive: [], activeTabId: 'development', tabs: [{ id: 'development', name: 'Development', layout, cells }] };
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'atlas', sshHosts, projects: [demoProject,
    { id: 'design', name: 'Design system', path: project, color: '#c084fc', icon: { kind: 'emoji', value: '🎨' }, tabs: [], archive: [], activeTabId: null },
    { id: 'api', name: 'Catalog API', path: project, color: '#10b981', icon: { kind: 'emoji', value: '⚡' }, tabs: [], archive: [], activeTabId: null }],
  profiles: [{ id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' }, { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  snippets: [
    { id: 'review', name: 'Review changes', icon: '🔎', color: '#60a5fa', text: 'Review the diff. Focus on correctness and missing tests.', autoSend: false },
    { id: 'test', name: 'Add focused tests', icon: '🧪', color: '#10b981', text: 'Add focused tests for the behavior we changed.', autoSend: false },
    { id: 'plan', name: 'Plan the next step', icon: '📋', color: '#c084fc', text: 'Explain the next implementation step before editing.', autoSend: false }],
  presets: [{ id: 'review-team', name: 'Review team', layout, cells: ['Coordinator', 'Frontend', 'Backend', 'Tests'].map((name, i) => ({ name, profileId: i % 2 ? 'codex' : 'claude', role: i ? 'worker' : 'coordinator', worktree: false, prompt: ['Plan and coordinate the review.', 'Review the storefront accessibility.', 'Review catalog validation.', 'Check edge cases and tests.'][i] })) }],
  settings: { language: 'en', fontSize: 14, notifications: false, showAiUsage: false, shell: process.platform === 'win32' ? 'cmd' : 'bash', lastProfileId: 'claude' },
  sidebarCollapsed: false, snippetsOpen: true, sidebarWidth: 230, snippetsWidth: 220,
}));
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
});
const env = { ...process.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port), USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') };
scrubAppEnv(env); // never the real login folders or tokens
const child = spawn(electron, ['.'], { cwd: checkout, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', exited = false, socket, requestId = 0;
child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
child.on('error', e => { log += e.message; exited = true; }); child.on('exit', () => { exited = true; });
const pending = new Map(), exceptions = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; if (exited) throw new Error(`App exited: ${log}`); await sleep(100); }
  throw new Error(`Timeout: ${label}\n${log.slice(-3000)}`);
}
function cdp(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolveRequest(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function click(selector, text) {
  await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if (!el) throw new Error('Missing control: ' + ${JSON.stringify(text ?? selector)}); el.click(); })()`);
}
async function key(key, code, modifiers = {}) {
  await evaluate(`(document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, code, bubbles: true, ...modifiers })}))`);
}
async function screenshot(name) {
  await evaluate('document.fonts.ready'); await sleep(600);
  const { data: png } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(output, `${name}.png`), Buffer.from(png, 'base64'));
  console.log(`Captured ${name}.png`);
}
try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { return null; } }, 'debugger');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    const p = pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // Electron does not expose Chrome's Browser window-management CDP methods.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate('!!window.mc && document.querySelectorAll(".cell").length === 4'), 'four terminals');
  // The README shows the version the screenshots were taken with (the release bumps package.json later).
  const version = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version;
  await until(() => evaluate(`document.querySelector('.sb-version')?.textContent.includes(${JSON.stringify(`v${version}`)})`), `status bar shows v${version}`);
  console.log(`Capturing with version ${version}`);
  if (await evaluate('document.title !== "unimux" || document.querySelector(".bn-base")?.textContent !== "unimux"')) throw new Error('Expected Unimux branding');
  // Observe real PTY output (single messages and, since 0.9.3, batches of several terminals) and use its existing MessagePort to enter demo commands.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__readmeOutput = {}; window.addEventListener('message', e => { if (e.data === 'mc:pty-port' && e.ports[0]) { window.__readmePort = e.ports[0]; const add = (id, data) => { window.__readmeOutput[id] = (window.__readmeOutput[id] || '') + data; }; e.ports[0].addEventListener('message', e => { if (e.data.t === 'data' || e.data.t === 'replay') add(e.data.id, e.data.data); else if (e.data.t === 'dataBatch') for (const [id, data] of e.data.items) add(id, data); }); } });` });
  await cdp('Page.reload');
  // An evaluation sent while the reload is still navigating fails with "Inspected target navigated or closed": retried.
  await until(() => evaluate('!!window.__readmePort').catch(() => false), 'PTY port');
  await until(async () => (await evaluate('window.mc.aliveCells()')).length === 4, 'running shells');
  const commands = ['node --test --test-reporter=spec', 'node inspect.mjs', 'node --check src/catalog.mjs && node --check test/catalog.test.mjs && echo JavaScript syntax checks passed.', 'node review.mjs'];
  for (let i = 0; i < cells.length; i++) {
    const command = process.platform === 'win32' ? `prompt Atlas$G & cls & ${commands[i]}\r` : `export PS1='Atlas> '; clear; ${commands[i]}\r`;
    await evaluate(`window.__readmePort.postMessage({ t: 'write', id: ${JSON.stringify(cells[i].id)}, data: ${JSON.stringify(command)} })`);
  }
  await until(() => evaluate(`window.__readmeOutput['readme-shell-0']?.includes('pass 6') && window.__readmeOutput['readme-shell-3']?.includes('Ready to review beside the terminal.')`), 'demo output');
  await screenshot('main');
  await click('#files-view');
  await until(() => evaluate('!!document.querySelector(".file-entry[title=src]")'), 'file tree');
  await click('.file-entry[title=src]');
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify('.file-entry[title="src/catalog.mjs"]')})`), 'source file');
  await click('.file-entry[title="src/catalog.mjs"]');
  await until(() => evaluate('!!document.querySelector(".file-editor textarea, .monaco-editor, .cm-editor")'), 'integrated editor');
  await screenshot('editor');
  await evaluate(`(() => { const tab = [...document.querySelectorAll('.workspace-tabs .tab')].find(el => el.textContent.includes('Development')); if (!tab) throw new Error('Missing Development workspace tab'); tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
  // Clicking the tile of the panel already shown folds it (0.9.2): only open the project list when it is not shown.
  if (!(await evaluate('!!document.querySelector(".project")'))) await click('#projects-view');
  await evaluate(`(() => { const row = [...document.querySelectorAll('.project')].find(el => el.textContent.includes('Atlas storefront')); if (!row) throw new Error('Missing Atlas project'); const rect = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 30, clientY: rect.top + 10 })); })()`);
  await until(() => evaluate('!!document.querySelector(".menu")'), 'project menu');
  await click('.menu-item', 'Edit project (name, icon)…');
  await until(() => evaluate('!!document.querySelector(".overlay")'), 'project editor');
  await screenshot('project');
  await click('.modal-foot button', 'Cancel');
  await until(() => evaluate('!document.querySelector(".overlay")'), 'close project editor');
  await key('G', 'KeyG', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin', shiftKey: true });
  await until(() => evaluate('!!document.querySelector(".cell-table")'), 'grid dialog');
  await click('.presets span.btn', 'Review team');
  await screenshot('grid-dialog');
  await key('Escape', 'Escape');
  await key('k', 'KeyK', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin' });
  await until(() => evaluate('!!document.querySelector(".palette")'), 'command palette');
  // Search for "new": the list stays short and shows projects, grids, terminals, SSH hosts and snippets.
  await evaluate(`(() => { const input = document.querySelector('.palette input'); input.focus(); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'new'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(() => evaluate(`document.querySelectorAll('.palette-item').length > 1 && document.querySelector('.palette input').value === 'new' && [...document.querySelectorAll('.palette-item')].some(item => /SSH: new host/.test(item.textContent))`), 'palette search results');
  await screenshot('palette');
  await key('Escape', 'Escape');
  await until(() => evaluate('!document.querySelector(".palette")'), 'close palette');
  // Git: working-tree changes on top of the committed history, one of them staged.
  const catalogSource = join(project, 'src/catalog.mjs');
  writeFileSync(catalogSource, readFileSync(catalogSource, 'utf8').replace('price: 24 }', 'price: 26 }') + `\nexport function categories(catalog = products) {\n  return [...new Set(catalog.map(product => product.category))].sort();\n}\n\nexport function byCategory(category, catalog = products) {\n  return catalog.filter(product => product.category === category);\n}\n`);
  appendFileSync(join(project, 'README.md'), '\nSee `inspect.mjs` for a printed overview of the catalog.\n');
  writeFileSync(join(project, 'CHANGELOG.md'), '# Changelog\n\n- Add a category list\n');
  git('add', 'README.md');
  await evaluate(`document.querySelector('.file-tab .x')?.click()`);
  await click('#git-view');
  await until(() => evaluate('document.querySelectorAll(".git-file").length >= 3 && document.querySelectorAll(".git-commit").length >= 6'), 'git changes and history');
  await click('.git-file[title="src/catalog.mjs"]');
  await until(() => evaluate('document.querySelectorAll(".git-diff-line.add").length > 0'), 'working-tree diff');
  await screenshot('git');
  // SSH: the SSH view opens in the main area; the group "production" opens as a grid of three sessions on the local test
  // server (its host key is already trusted), then the view shows the connected tiles and web-1's details.
  await click('#terminal-view');
  await until(() => evaluate('!!document.querySelector(".ssh-view")'), 'SSH view');
  await evaluate(`(() => { const group = [...document.querySelectorAll('.ssh-view-group')].find((g) => g.querySelector('.ssh-group-head')?.textContent.includes('production')); if (!group) throw new Error('Missing production group'); group.querySelector('.ssh-group-open').click(); })()`);
  await until(() => evaluate(`(() => { const ssh = [...document.querySelectorAll('.cell')].filter(c => c.querySelector('.cell-head .ssh-host')); return ssh.length === 3 && ssh.every(c => !c.querySelector('.ssh-card') && !c.querySelector('.ssh-bar') && !c.querySelector('.status-text.ssh')); })()`), 'three SSH sessions');
  await click('#terminal-view');
  await until(() => evaluate('document.querySelectorAll(".ssh-tile .ssh-state.connected").length === 3'), 'connected tiles');
  await evaluate(`(() => { const tile = [...document.querySelectorAll('.ssh-tile[data-host-id]')].find((t) => t.textContent.includes('web-1')); tile.closest('.ssh-host-card').querySelector('.ssh-host-edit').click(); })()`);
  await until(() => evaluate(`document.querySelector('.ssh-view-detail h2')?.textContent === 'web-1'`), 'web-1 details');
  // The sidebar still shows the Git panel from the previous shot: the SSH shot shows the project list instead.
  await click('#projects-view');
  await until(() => evaluate('!document.querySelector(".git-file") && !!document.querySelector(".project")'), 'project list beside the SSH view');
  await screenshot('ssh');
  // Back to the Development grid and the project list for the optional checks.
  await evaluate(`(() => { const tab = [...document.querySelectorAll('.workspace-tabs .tab')].find(el => el.textContent.includes('Development')); if (!tab) throw new Error('Missing Development workspace tab'); tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
  if (!(await evaluate('!!document.querySelector(".project")'))) await click('#projects-view');
  if (process.argv.includes('--verify')) {
    await key('Escape', 'Escape');
    await until(() => evaluate('!document.querySelector(".palette")'), 'close palette before checks');
    // The checks open the source file and expect it to be the only file tab: the diff tab left by the git capture goes first.
    const diffTab = `[...document.querySelectorAll('.workspace-tabs .file-tab')].find(tab => tab.dataset.workspaceId?.includes('"diff"'))`;
    await evaluate(`${diffTab}?.querySelector('.x')?.click()`);
    await until(() => evaluate(`!${diffTab}`), 'diff tab closed before checks');
    await verifyWorkspaceUI({ cdp, evaluate, click, key, until, project, cells, screenshot });
  }
  if (exceptions.length) throw new Error(`Renderer exceptions: ${exceptions.join('; ')}`);
  console.log(`Screenshots: ${output}\nIsolated demo data: ${root}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (socket?.readyState === WebSocket.OPEN) console.error(await evaluate('({ port: !!window.__readmePort, outputCells: Object.keys(window.__readmeOutput ?? {}), text: document.body.textContent.slice(0, 1800) })').catch(() => 'Renderer unavailable'));
} finally {
  sshServer.stop();
  if (socket?.readyState === WebSocket.OPEN) { await cdp('Browser.close').catch(() => {}); socket.close(); }
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  if (!exited) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}
