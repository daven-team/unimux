// W3 real-app check (1.2.0, docs/tauri/PLAN.md): the first start after 1.1.x brings its localStorage over once, and OS file
// drops give their paths while HTML5 drag and drop inside the app keeps working.
//
// 1. "1.1.4 copy": the Electron build of this tree (`npm run build`, Electron 45 like 1.1.4) runs twice on a scratch data dir
//    and stores what 1.1.4 keeps in localStorage (an unsaved file draft, Redis console history, panel sizes, the DB tree, SSH
//    folds, a 300 KB value, a lone surrogate, a non-Latin-1 key); the second run overwrites one key and deletes another, so
//    the database has a compacted table, a log and a tombstone.
// 2. The Tauri check build starts on a copy: every entry is there with the same UTF-16 units, the draft is back in the file
//    store, the marker is written (unconfirmed, with the sentinel key), Electron's files are byte-identical. A change made in
//    1.2.0 survives the second start, which confirms the marker (no second import). Before that, a copy whose app is
//    hard-killed (taskkill /T /F) 300 ms after the page reported still has every entry on the next start.
// 3. OS drops (CDP Input.dispatchDragEvent with real paths): a file and a folder onto a cell, onto the SSH key editor and a
//    page-level probe get their exact paths through window.mc.pathsForFiles.
// 4. Internal drags (CDP Input.setInterceptDrags: the page's own dragstart data is dropped back): grid tab reorder, tab dropped
//    outside (detach request), snippet and note onto a cell, note and snippet reorder.
//
//   npm run build && npm run build:check && node scripts/verify-tauri-w3.mjs [--keep] [--write-fixture]
//
// --write-fixture also copies the Electron database to test/fixtures/electron-local-storage (the cargo test of
// unimux-state::webview_import reads it). Nothing here shows a window on the desktop (MC_OFFSCREEN, scratch homes).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sha256, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const keep = process.argv.includes('--keep');
const writeFixture = process.argv.includes('--write-fixture');
const shots = join(root, 'artifacts', 'tauri-w3');
mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-w3-'));
console.log(`scratch: ${scratch}`);
const children = [];

// ── 1. The 1.1.4 copy ────────────────────────────────────────────────────────

const electronDir = join(scratch, 'electron-data');
mkdirSync(electronDir, { recursive: true });
// No projects: Electron must not start shells or agents here.
writeFileSync(join(electronDir, 'state.json'), JSON.stringify({ version: 1, projects: [], activeProjectId: null, settings: { language: 'pl' } }));

async function connectElectronPage(port) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && t.url.startsWith('file:') && t.url.includes('index.html') && !t.url.includes('detached='));
      if (target) return await connectPage(port, { timeoutMs: 1000, match: target.id });
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('no Electron page');
    await sleep(300);
  }
}

/** One Electron run: `fn(page)`, then a normal quit (closing the window) so Chromium commits localStorage. */
async function electronRun(fn) {
  const port = await freePort();
  const { env: homeEnv } = scratchHome(join(scratch, 'electron'));
  const env = scrubAppEnv({ ...process.env, ...homeEnv, MC_DATA_DIR: electronDir, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port) });
  const child = spawn(electronPath, [root], { env, stdio: 'ignore', windowsHide: true });
  children.push(child);
  let page = null;
  let out;
  try {
    page = await connectElectronPage(port);
    await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 120000, 'Electron renderer ready');
    out = await fn(page);
  } catch (error) {
    killTree(child);
    page?.close();
    if (!keep) removeScratch(scratch);
    throw error;
  }
  await sleep(1500);
  await page.evaluate('setTimeout(() => window.close(), 50), true').catch(() => undefined);
  const code = await waitExit(child, 20000);
  if (code === null) { console.log('Electron did not quit by itself; ending it'); killTree(child); await waitExit(child, 10000); }
  page.close();
  return out;
}

/** Every localStorage entry as UTF-16 code units (lone surrogates survive CDP's JSON). */
const DUMP = `(() => { const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)); const out = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.push([units(k), units(localStorage.getItem(k))]); }
  return out; })()`;
const fromUnits = (u) => { let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.slice(i, i + 8192)); return s; };
const asMap = (dump) => new Map(dump.map(([k, v]) => [fromUnits(k), v]));

const PROJECT = 'proj-w3';
const DRAFT = { id: JSON.stringify([PROJECT, 'src/zażółć.ts']), projectId: PROJECT, relativePath: 'src/zażółć.ts', name: 'zażółć.ts', text: 'const a = "niezapisane 😀";\n', savedText: 'const a = 1;\n', diskText: 'const a = 1;\n' };
const FIRST = {
  'mc-file-drafts-v1': JSON.stringify([DRAFT]),
  'mc-redis-history-v1:conn-1': JSON.stringify(['PING', 'GET klucz:ł', 'SET a 😀']),
  'mc-split-ratio-v1': '0.62',
  'mc-split-swapped-v1': '0',
  'mc-automation-height-v1': '333',
  'mc-db-tree-v1': JSON.stringify(['conn-1', 'conn-1\ndb']),
  'mc-file-zoom-v1': '1.25',
  'mc-ssh-groups-v1': JSON.stringify(['Produkcja']),
  'mc-w3-big': `${'x'.repeat(300000)}ą`,
  'mc-w3-klucz-ł': 'wartość',
  'mc-w3-deleted': 'gone',
};

await electronRun((page) => page.evaluate(`(() => {
  const values = ${JSON.stringify(FIRST)};
  values['mc-w3-lone'] = 'cut ' + String.fromCharCode(0xd83d);
  for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
  return localStorage.length;
})()`));
const expectedDump = await electronRun(async (page) => {
  const restored = await page.evaluate('window.__mc.useFileStore.getState().documents.map((d) => d.text)');
  check('Electron (1.1.4 runtime) restores the draft it stored (the fixture is a real one)', restored.length === 1 && restored[0] === DRAFT.text, JSON.stringify(restored));
  await page.evaluate(`localStorage.setItem('mc-split-swapped-v1', '1'); localStorage.setItem('mc-w3-run2', 'second run'); localStorage.removeItem('mc-w3-deleted'); true`);
  return page.evaluate(DUMP);
});
const expected = asMap(expectedDump);
const leveldb = join(electronDir, 'Local Storage', 'leveldb');
const dbFiles = readdirSync(leveldb);
check('the 1.1.4 copy has a localStorage database with a table and a log', dbFiles.some((f) => f.endsWith('.ldb')) && dbFiles.some((f) => f.endsWith('.log')), dbFiles.join(' '));
check('the 1.1.4 copy holds every entry', Object.keys(FIRST).every((k) => k === 'mc-w3-deleted' || expected.has(k)) && expected.has('mc-w3-lone') && expected.has('mc-w3-run2') && !expected.has('mc-w3-deleted') && fromUnits(expected.get('mc-split-swapped-v1')) === '1', [...expected.keys()].join(', '));

if (writeFixture) {
  const target = join(root, 'test', 'fixtures', 'electron-local-storage');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, 'leveldb'), { recursive: true });
  for (const f of dbFiles) if (f !== 'LOCK' && !f.startsWith('LOG')) cpSync(join(leveldb, f), join(target, 'leveldb', f));
  // JSON cannot hold a lone surrogate for serde: the test compares lossy strings (U+FFFD), as Entry::lossy gives.
  const rows = [...expected].map(([k, v]) => [k.toWellFormed(), fromUnits(v).toWellFormed()]);
  writeFileSync(join(target, 'expected.json'), `${JSON.stringify(rows, null, 1)}\n`);
  console.log(`fixture written: ${target}`);
}

// ── 2. The Tauri build on a copy ─────────────────────────────────────────────

const dataDir = join(scratch, 'tauri-data');
cpSync(electronDir, dataDir, { recursive: true });
const copiedDb = join(dataDir, 'Local Storage', 'leveldb');
const hashDb = () => readdirSync(copiedDb).filter((f) => f !== 'LOCK' && !f.startsWith('LOG')).sort().map((f) => `${f} ${sha256(readFileSync(join(copiedDb, f)))}`).join('\n');
const dbBefore = hashDb();

// A state with a project (two grids of shell cells with cmd: the app starts them, and no agent CLI runs here), notes and
// snippets.
const dropDir = join(scratch, 'drop');
const dropFile = join(dropDir, 'plik ą 1.txt');
const dropFolder = join(dropDir, 'folder ż');
mkdirSync(dropFolder, { recursive: true });
writeFileSync(dropFile, 'dropped from the OS\n');
const state = JSON.parse(readFileSync(join(electronDir, 'state.json'), 'utf8'));
const { layoutForCount } = (await runnerImport(resolve(root, 'src/shared/layout.ts'), { configFile: false, logLevel: 'silent', root })).module;
const profileId = 'shell';
state.settings = { ...state.settings, shell: 'cmd' };
state.projects = [{ id: PROJECT, name: 'w3', path: dropDir, color: '#7c5cff', archive: [], activeTabId: 'tab-a', tabs: [
  { id: 'tab-a', name: 'Pierwszy', layout: layoutForCount(2), cells: [{ id: 'cell-1', profileId }, { id: 'cell-2', profileId }] },
  { id: 'tab-b', name: 'Drugi', layout: layoutForCount(1), cells: [{ id: 'cell-3', profileId }] },
] }];
state.activeProjectId = PROJECT;
state.notes = [{ id: 'note-1', name: 'Pierwsza', text: 'notatka 1', updatedAt: 1762430400000 }, { id: 'note-2', name: 'Druga', text: 'notatka 2', updatedAt: 1762430400001 }];
state.snippets = [{ id: 'snip-1', name: 'status', text: 'git status', autoSend: false }, { id: 'snip-2', name: 'log', text: 'git log', autoSend: false }];
writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state));

const shot = (page, name) => page.send('Page.captureScreenshot', { format: 'png' }).then(({ data }) => writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64')), () => undefined);
/** A real click (mouse events at the element's centre), so React's handlers run as for the user. */
async function clickEl(page, selector) {
  const p = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!p) return false;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(200);
  return true;
}
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
async function startTauri(dir = dataDir) {
  const port = await freePort();
  const child = launchApp({ dataDir: dir, scratch, port });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 60000 });
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 60000, 'Tauri renderer ready');
  return { child, page };
}
async function quitTauri({ child, page }) {
  await sleep(2500); // WebView2 commits localStorage on its own schedule
  await bridge(page, 'quit').catch(() => undefined);
  const code = await waitExit(child, 20000);
  if (code === null) { killTree(child); await waitExit(child, 10000); }
  page.close();
}
const markerFile = join(dataDir, 'webview-import.json');
const SENTINEL = 'mc:webview-import';
const readMarker = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const sameEntries = (got) => [...expected].filter(([k, v]) => JSON.stringify(got.get(k)) !== JSON.stringify(v)).map(([k]) => k);

try {
  // ── 2a. Hard kill right after the import (WebView2 has not written localStorage to disk yet) ──
  {
    const killDir = join(scratch, 'tauri-kill');
    cpSync(electronDir, killDir, { recursive: true });
    const killMarker = join(killDir, 'webview-import.json');
    let app = await startTauri(killDir);
    const deadline = Date.now() + 20000;
    while (!existsSync(killMarker) && Date.now() < deadline) await sleep(50);
    await sleep(300);
    const first = readMarker(killMarker);
    check('kill case: the page reported, the marker waits for confirmation', first && first.confirmed === false && typeof first.id === 'string' && first.imported === expected.size, JSON.stringify(first));
    killTree(app.child);
    await waitExit(app.child, 10000);
    app.page.close();
    await sleep(1000);

    app = await startTauri(killDir);
    const missing = sameEntries(asMap(await app.page.evaluate(DUMP)));
    check('kill case, second start: every 1.1.4 entry is there', missing.length === 0, missing.length ? `missing or different: ${missing.length} of ${expected.size}` : `${expected.size} entries`);
    const second = readMarker(killMarker);
    // Either WebView2 got the writes out before the kill (confirmed now) or it did not (imported again, still unconfirmed).
    check('kill case, second start: the marker is confirmed or the import ran again', second && ((second.confirmed === true && second.id === first?.id) || (second.confirmed === false && second.id !== first?.id)), JSON.stringify(second));
    await quitTauri(app);

    app = await startTauri(killDir);
    const third = asMap(await app.page.evaluate(DUMP));
    const thirdMissing = sameEntries(third);
    const thirdMarker = readMarker(killMarker);
    check('kill case, after a normal quit: entries kept, marker confirmed, sentinel removed', thirdMissing.length === 0 && thirdMarker?.confirmed === true && !third.has(SENTINEL), JSON.stringify({ missing: thirdMissing.length, marker: thirdMarker }));
    await quitTauri(app);
  }

  let app = await startTauri();
  const got = asMap(await app.page.evaluate(DUMP));
  const missing = [...expected].filter(([k, v]) => JSON.stringify(got.get(k)) !== JSON.stringify(v)).map(([k]) => k);
  check('first start: every 1.1.4 localStorage entry is there with the same UTF-16 units', missing.length === 0, missing.length ? `differs: ${missing.join(', ')}` : `${expected.size} entries`);
  const extra = [...got.keys()].filter((k) => !expected.has(k));
  check('... and nothing else was imported (the deleted key stays deleted)', !got.has('mc-w3-deleted'), extra.length ? `written by the app itself: ${extra.join(', ')}` : '');
  const drafts = await app.page.evaluate('window.__mc.useFileStore.getState().documents.map((d) => ({ name: d.name, text: d.text, saved: d.savedText }))');
  check('the unsaved file draft is back in the file store', drafts.length === 1 && drafts[0].text === DRAFT.text && drafts[0].saved === DRAFT.savedText, JSON.stringify(drafts));
  const dbOpen = await app.page.evaluate('window.__mc.dbClient?.useDbStore?.getState?.().open ?? null');
  check('the DB tree state is back (read at module load)', JSON.stringify(dbOpen) === FIRST['mc-db-tree-v1'], JSON.stringify(dbOpen));
  const marker = readMarker(markerFile);
  check('webview-import.json written (unconfirmed) after the page stored them', marker && marker.version === 1 && marker.entries === expected.size && marker.imported === expected.size && marker.kept === 0 && marker.error === null && marker.origin === 'file://' && marker.confirmed === false && typeof marker.id === 'string', JSON.stringify(marker));
  check('... and the sentinel holds the import id', JSON.stringify(got.get(SENTINEL)) === JSON.stringify([...marker?.id ?? ''].map((c) => c.charCodeAt(0))));
  check('Electron\'s localStorage files are byte-identical', hashDb() === dbBefore);
  const scratchCopies = readdirSync(tmpdir()).filter((f) => f.startsWith(`unimux-ls-import-${app.child.pid}-`));
  check('the scratch copy of the database was removed', scratchCopies.length === 0, scratchCopies.join(' '));
  const markerText = readFileSync(markerFile, 'utf8');

  // A change made in 1.2.0, then a reload of the same window (the import script must not apply again).
  await app.page.evaluate(`localStorage.setItem('mc-split-ratio-v1', '0.4'); localStorage.removeItem('mc-w3-klucz-ł'); true`);
  await app.page.evaluate('location.reload(), true').catch(() => undefined);
  await sleep(500);
  await waitFor(app.page, 'window.__mc?.useStore?.getState?.().ready === true', 60000, 'ready after reload');
  const afterReload = await app.page.evaluate(`[localStorage.getItem('mc-split-ratio-v1'), localStorage.getItem('mc-w3-klucz-ł')]`);
  check('a reload keeps the changes made in 1.2.0', afterReload[0] === '0.4' && afterReload[1] === null, JSON.stringify(afterReload));
  await quitTauri(app);

  app = await startTauri();
  const second = await app.page.evaluate(`[localStorage.getItem('mc-split-ratio-v1'), localStorage.getItem('mc-w3-klucz-ł'), localStorage.getItem('mc-w3-run2')]`);
  check('second start: not imported again (changed and removed keys stay as 1.2.0 left them)', second[0] === '0.4' && second[1] === null && second[2] === 'second run', JSON.stringify(second));
  for (const until = Date.now() + 10000; readMarker(markerFile)?.confirmed !== true && Date.now() < until;) await sleep(100);
  const confirmedMarker = readMarker(markerFile);
  const firstMarker = JSON.parse(markerText);
  check('... the marker is confirmed (same import, same counts) and the sentinel is gone', confirmedMarker?.confirmed === true && JSON.stringify({ ...confirmedMarker, confirmed: false }) === JSON.stringify(firstMarker) && (await app.page.evaluate(`localStorage.getItem(${JSON.stringify(SENTINEL)})`)) === null, JSON.stringify(confirmedMarker));
  check('Electron\'s localStorage files are still byte-identical', hashDb() === dbBefore);

  // ── 3. OS drops ────────────────────────────────────────────────────────────
  const { page } = app;
  await page.evaluate(`(() => {
    window.__w3 = { calls: [], probe: [] };
    const original = window.mc.pathsForFiles;
    window.mc.pathsForFiles = (files) => original(files).then((paths) => { window.__w3.calls.push({ names: files.map((f) => f.name), paths }); return paths; });
    window.addEventListener('drop', (e) => {
      const files = [...e.dataTransfer.files];
      if (files.length) original(files).then((paths) => window.__w3.probe.push({ names: files.map((f) => f.name), paths }));
    }, true);
    return true;
  })()`);
  const center = (selector) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const osDrop = async (point, files) => {
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data });
  };
  const startCheck = (t) => t.includes('dopiero się uruchamia') || t.includes('komórka nie jest uruchomiona');
  const toasts = () => page.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent)`);
  // What the cells take (terminals.paste: the dropped paths of a running cell).
  await page.evaluate(`(() => { window.__w3.osPastes = []; const t = window.__mc.terminals; const paste = t.paste.bind(t); t.paste = (id, text, send) => { window.__w3.osPastes.push({ id, text }); return paste(id, text, send); }; return true; })()`);

  const cellPoint = await center('[data-cell-id="cell-1"] .cell-body') ?? await center('[data-cell-id="cell-1"]') ?? await center('.cell');
  check('a cell is on screen', !!cellPoint);
  await osDrop(cellPoint, [dropFile, dropFolder]);
  const cellCall = await waitFor(page, 'window.__w3.calls[0]', 5000, 'pathsForFiles from the cell').catch(() => null);
  check('OS drop of a file and a folder onto a cell: the cell gets both absolute paths', JSON.stringify(cellCall?.paths) === JSON.stringify([dropFile, dropFolder]), JSON.stringify(cellCall));
  check('... the page-level probe saw the same paths', JSON.stringify((await page.evaluate('window.__w3.probe[0]'))?.paths) === JSON.stringify([dropFile, dropFolder]));
  const pasted = `window.__w3.osPastes.some((p) => p.id === 'cell-1' && p.text.includes(${JSON.stringify('plik ą 1.txt')}) && p.text.includes(${JSON.stringify('folder ż')}))`;
  await waitFor(page, `${pasted} || [...document.querySelectorAll('.toast')].some((t) => /dopiero się uruchamia|komórka nie jest uruchomiona|Nie udało się dodać ścieżki/.test(t.textContent))`, 5000, 'the cell took the drop').catch(() => undefined);
  const cellToasts = await toasts();
  // The cell pastes both paths into its terminal (1.1.4), or, while it is still starting, answers with its start check, which
  // comes only after the paths were there; "could not add the path" would mean they were missing.
  check('... and the cell took both paths (pasted, or its start check; not "could not add the path")', ((await page.evaluate(pasted)) || cellToasts.some(startCheck)) && !cellToasts.some((t) => t.includes('Nie udało się dodać ścieżki')), JSON.stringify({ pastes: await page.evaluate('window.__w3.osPastes'), toasts: cellToasts }));
  await shot(page, 'after-cell-drop');

  // A File the page made itself has no path: one '' per File, no wait (1.1.4: getPathForFile gives '').
  const memory = await page.evaluate(`(async () => { const t0 = performance.now(); const r = await window.mc.pathsForFiles([new File(['x'], 'mem.txt'), new File([], 'b')]); return { r, ms: performance.now() - t0 }; })()`);
  check('a File made by the page gets \'\' without waiting', JSON.stringify(memory.r) === '["",""]' && memory.ms < 500, JSON.stringify(memory));

  // ── 3b. The SSH key editor (file mode): the dropped key file's path goes to ssh.draftFromFile ───────────────
  // The SSH backend comes with S1 / S2: draftFromFile is replaced by a recorder, the drop and its path are what W3 owns.
  await page.evaluate(`(() => {
    window.__w3.drafts = [];
    window.mc.ssh.draftFromFile = (path) => { window.__w3.drafts.push(path); return new Promise(() => {}); };
    return true;
  })()`);
  await clickEl(page, '.rail-tiles [aria-label="SSH"]');
  const keyMenu = await waitFor(page, `!!document.querySelector('.ssh-view-head button')`, 15000, 'SSH view').then(() => true, () => false);
  check('the SSH view opens', keyMenu);
  await page.evaluate(`[...document.querySelectorAll('.ssh-view-head button')].find((b) => b.textContent.includes('Nowy klucz'))?.click(), true`);
  await waitFor(page, `!!document.querySelector('.menu [role=menuitem]')`, 5000, 'new key menu').catch(() => undefined);
  await page.evaluate(`[...document.querySelectorAll('.menu [role=menuitem]')].find((b) => b.textContent.includes('Importuj z pliku'))?.click(), true`);
  const dropZone = await waitFor(page, `!!document.querySelector('.ssh-view-detail .ssh-drop')`, 10000, 'key drop zone').then(() => center('.ssh-view-detail .ssh-drop'), () => null);
  check('the key editor shows its drop zone', !!dropZone);
  if (dropZone) {
    const keyFile = join(dropDir, 'id_w3 ą');
    writeFileSync(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n');
    await osDrop(dropZone, [keyFile]);
    const draft = await waitFor(page, 'window.__w3.drafts[0]', 5000, 'draftFromFile').catch(() => null);
    check('OS drop of a key file onto the key editor: draftFromFile gets its absolute path', draft === keyFile, JSON.stringify(draft));
    await shot(page, 'key-editor-drop');
  }

  // ── 3c. The SFTP view's local pane: dropped files are copied into the folder shown (local-copy transfer) ────
  // The local listing and the transfer queue come with T1 / T2: recorders stand in for them; the pane's own drop rules run.
  const sftpLocal = join(scratch, 'sftp-local');
  mkdirSync(sftpLocal, { recursive: true });
  await page.evaluate(`(() => {
    window.__w3.enqueued = [];
    const home = ${JSON.stringify(sftpLocal)};
    window.mc.localFs.roots = async () => ({ home, drives: [] });
    window.mc.localFs.list = async (path) => ({ ok: true, value: { path, entries: [], truncated: false } });
    window.mc.sftp.enqueue = async (queue, req) => { window.__w3.enqueued.push({ queue, req }); return { ok: true }; };
    return true;
  })()`);
  await clickEl(page, '.ssh-nav [data-section="sftp"]');
  const sftpReady = await waitFor(page, `document.querySelector('.sftp-pane-local .sftp-crumb button.on') !== null || document.querySelector('.sftp-pane-local .sftp-path-input')?.value === ${JSON.stringify(sftpLocal)} || [...document.querySelectorAll('.sftp-pane-local *')].some((e) => e.title === ${JSON.stringify(sftpLocal)})`, 15000, 'SFTP local pane').then(() => true, () => false);
  const localPane = await center('.sftp-pane-local .sftp-list') ?? await center('.sftp-pane-local');
  check('the SFTP view shows its local pane on a folder', sftpReady && !!localPane);
  if (localPane) {
    await osDrop(localPane, [dropFile, dropFolder]);
    const job = await waitFor(page, 'window.__w3.enqueued[0]', 5000, 'sftp enqueue').catch(() => null);
    check('OS drop of a file and a folder onto the SFTP local pane: a local-copy of both paths into the folder shown', job && job.queue === null && job.req.direction === 'local-copy' && JSON.stringify(job.req.sources) === JSON.stringify([dropFile, dropFolder]) && job.req.targetDir === sftpLocal, JSON.stringify(job));
    await shot(page, 'sftp-drop');
  }
  // Back to the grid.
  await clickEl(page, '.rail-tiles [aria-label="SSH"]');
  await page.evaluate(`document.querySelector('.workspace-tabs .grid-tab')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })), true`);
  await waitFor(page, `getComputedStyle(document.querySelector('.terminal-workspace')).display !== 'none'`, 10000, 'grid in front').catch(() => undefined);

  // ── 4. Internal HTML5 drags (WebView2's own drop target must still be in charge) ────────────────────────────
  // CDP Input.setInterceptDrags: the drag the page starts (its dragstart data) is caught and dropped back where we say, the
  // same events a mouse drag gives. The OS-level drop target (an Explorer drag over the window) needs a visible window and
  // is a manual check (PROGRESS.md W3 open issues).
  let intercepted = null;
  page.onEvent((m) => { if (m.method === 'Input.dragIntercepted') intercepted = m.params.data; });
  async function htmlDrag(from, to, { cancel = false } = {}) {
    intercepted = null;
    await page.send('Input.setInterceptDrags', { enabled: true });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + ((to.x - from.x) * i) / 6), y: Math.round(from.y + ((to.y - from.y) * i) / 6), button: 'left', buttons: 1 });
      if (intercepted) break;
    }
    const t0 = Date.now();
    while (!intercepted && Date.now() - t0 < 3000) await sleep(50);
    const data = intercepted;
    if (data) {
      if (cancel) await page.send('Input.dispatchDragEvent', { type: 'dragCancel', x: to.x, y: to.y, data });
      else for (const type of ['dragEnter', 'dragOver', 'dragOver', 'drop']) await page.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
    }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    await page.send('Input.setInterceptDrags', { enabled: false });
    await sleep(300);
    return data;
  }
  const stateNow = async () => (await bridge(page, 'state')).snapshot.state;
  // The snippet and note panels (opened only now: with them open at start the app rewrites mc-right-panels-v1 itself).
  await page.evaluate(`window.__mc.useStore.getState().update((s) => ({ ...s, snippetsOpen: true, notesOpen: true })), true`);
  await waitFor(page, `!!document.querySelector('[data-snippet-id="snip-1"]') && !!document.querySelector('[data-note-id="note-1"]')`, 10000, 'side panels').catch(() => undefined);
  await page.evaluate(`(() => {
    window.__w3.pastes = []; window.__w3.toastsSeen = [];
    const t = window.__mc.terminals; const paste = t.paste.bind(t);
    t.paste = (id, text, send) => { window.__w3.pastes.push({ id, text }); return paste(id, text, send); };
    // Every toast set from now on (the same text twice is one element on screen, so the store is watched, not the DOM).
    window.__mc.useStore.subscribe((st, prev) => { if (st.ui.toast && st.ui.toast !== prev.ui.toast) window.__w3.toastsSeen.push(st.ui.toast.text); });
    window.__w3.detached = [];
    const drop = window.mc.detach.dropOutside;
    window.mc.detach.dropOutside = (target, docs) => { window.__w3.detached.push({ target, docs }); return Promise.resolve({ ok: false, error: 'w3-check' }); };
    return !!drop;
  })()`);
  const reachedCell = (cellId, text) => `window.__w3.pastes.some((p) => p.id === ${JSON.stringify(cellId)} && p.text === ${JSON.stringify(text)}) || window.__w3.toastsSeen.some((t) => t.includes('w trakcie startu') || t.includes('dopiero się uruchamia'))`;
  const clearSeen = () => page.evaluate('window.__w3.pastes = []; window.__w3.toastsSeen = []; true');

  // Grid tab reorder in the strip.
  const tabA = await center('.workspace-tabs [data-workspace-id="grid:tab-a"]');
  const tabB = await page.evaluate(`(() => { const r = document.querySelector('.workspace-tabs [data-workspace-id="grid:tab-b"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.right - 4), y: Math.round(r.top + r.height / 2) } : null; })()`);
  check('both grid tabs are in the strip', !!tabA && !!tabB);
  if (tabA && tabB) {
    const before = (await stateNow()).projects[0].tabs.map((t) => t.id);
    const data = await htmlDrag(tabA, tabB);
    await sleep(500);
    const after = (await stateNow()).projects[0].tabs.map((t) => t.id);
    check('grid tab dragged behind the other: the order changes', !!data && JSON.stringify(before) === '["tab-a","tab-b"]' && JSON.stringify(after) === '["tab-b","tab-a"]', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    // Dropped outside the window (nobody takes it): the detach request goes to main with the tab under the cursor.
    const tabNow = await center('.workspace-tabs [data-workspace-id="grid:tab-a"]');
    const out = await htmlDrag(tabNow, { x: tabNow.x, y: tabNow.y + 300 }, { cancel: true });
    const detached = await waitFor(page, 'window.__w3.detached[0]', 5000, 'detach request').catch(() => null);
    check('grid tab dropped outside the window: the detach request is sent', !!out && !!detached, JSON.stringify(detached));
  }

  // A snippet and a note dragged onto a cell.
  const cell2 = await center('[data-cell-id="cell-2"]');
  const snippet = await center('[data-snippet-id="snip-1"]');
  check('the snippet panel and the second cell are on screen', !!cell2 && !!snippet);
  if (cell2 && snippet) {
    await clearSeen();
    const data = await htmlDrag(snippet, cell2);
    const ok = await waitFor(page, reachedCell('cell-2', 'git status'), 5000, 'snippet on the cell').then(() => true, () => false);
    check('snippet dragged onto a cell: the cell takes it (pastes, or starts first like 1.1.4)', !!data && ok, JSON.stringify(await page.evaluate('window.__w3.toastsSeen')));
  }
  const note = await center('[data-note-id="note-1"]');
  check('the notes panel is on screen', !!note);
  if (cell2 && note) {
    await clearSeen();
    const data = await htmlDrag(note, cell2);
    const ok = await waitFor(page, reachedCell('cell-2', 'notatka 1'), 5000, 'note on the cell').then(() => true, () => false);
    check('note dragged onto a cell: the cell takes its text', !!data && ok, JSON.stringify(await page.evaluate('window.__w3.toastsSeen')));
  }
  // Reorder inside the panels (drop on the lower half of the second card).
  const lowerHalf = (selector) => page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 3) } : null; })()`);
  const snip2 = await lowerHalf('[data-snippet-id="snip-2"]');
  if (snippet && snip2) {
    await htmlDrag(await center('[data-snippet-id="snip-1"]'), snip2);
    const order = (await stateNow()).snippets.map((s) => s.id);
    check('snippet reorder by drag', JSON.stringify(order) === '["snip-2","snip-1"]', JSON.stringify(order));
  }
  const note2 = await lowerHalf('[data-note-id="note-2"]');
  if (note && note2) {
    await htmlDrag(await center('[data-note-id="note-1"]'), note2);
    const order = (await stateNow()).notes.map((n) => n.id);
    check('note reorder by drag', JSON.stringify(order) === '["note-2","note-1"]', JSON.stringify(order));
  }

  // A file from the explorer tree onto a cell (the listing comes with G5: a recorder stands in for it).
  await page.evaluate(`(() => {
    const entries = { '': [{ name: 'folder ż', path: 'folder ż', kind: 'directory' }, { name: 'plik ą 1.txt', path: 'plik ą 1.txt', kind: 'file' }] };
    window.mc.listProjectDirectory = async (_p, rel = '') => ({ ok: true, entries: entries[rel] ?? [], truncated: false });
    window.mc.listProjectDirectoryBatch = async (_p, rels) => Object.fromEntries(rels.map((rel) => [rel, { ok: true, entries: entries[rel] ?? [], truncated: false }]));
    return true;
  })()`);
  await clickEl(page, '.rail-tiles [aria-label="Pliki"]');
  const row = await waitFor(page, `!!document.querySelector('[draggable="true"][data-path="plik ą 1.txt"]')`, 10000, 'tree row').then(() => center('[draggable="true"][data-path="plik ą 1.txt"]'), () => null);
  check('the explorer tree lists the project', !!row);
  if (row && cell2) {
    await clearSeen();
    await page.evaluate(`window.__w3.drops = []; window.addEventListener('drop', (e) => window.__w3.drops.push({ cell: e.target.closest?.('[data-cell-id]')?.dataset.cellId ?? null, cls: String(e.target.className).slice(0, 60), path: e.dataTransfer.getData('application/x-ajz-path') }), true); true`);
    const data = await htmlDrag(row, await center('[data-cell-id="cell-2"]'));
    const ok = await waitFor(page, `window.__w3.pastes.some((p) => p.id === 'cell-2' && p.text.includes('plik ą 1.txt')) || window.__w3.toastsSeen.some((t) => t.includes('dopiero się uruchamia') || t.includes('komórka nie jest uruchomiona'))`, 5000, 'tree path on the cell').then(() => true, () => false);
    check('explorer file dragged onto a cell: the cell takes the path (or starts first like 1.1.4)', !!data && ok, JSON.stringify({ types: data?.items?.map((i) => i.mimeType), seen: await page.evaluate('[window.__w3.pastes, window.__w3.toastsSeen, window.__w3.drops]') }));
  }
  await shot(page, 'after-internal-drags');
} finally {
  for (const child of children) killTree(child);
  await sleep(500);
  const markersAfter = realProfileMarkers();
  check('nothing appeared in the real profile', JSON.stringify(markersAfter) === JSON.stringify(markersBefore));
  if (!keep) removeScratch(scratch);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
