// Real-app check of the Files tree on a big generated project: "expand all" timing, scrolling, sticky folder rows and indentation.
// Usage (after npm run build): node scripts/verify-tree-ui.mjs [--keep] [--label before|after]
// Scratch data, home and project live in D:\Projekty\_tmp-093tree-<rand> and are deleted afterwards. Kills only the PID it started.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { launchApp, sleep, writeState } from './ssh-ui-lib.mjs';

const args = process.argv.slice(2);
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'after';
const SHOTS = 'D:\\Projekty\\_shots';

/** ~20k files in ~1400 folders, the deepest 14 levels below the root. */
function generateProject(dir) {
  let folders = 0, files = 0;
  const extensions = ['ts', 'tsx', 'json', 'md', 'css', 'js', 'py', 'txt'];
  const walk = (path, depth, seed) => {
    const fileCount = depth === 0 ? 4 : 14;
    for (let i = 0; i < fileCount; i++) { writeFileSync(join(path, `file-${String(i).padStart(2, '0')}-of-level-${depth}.${extensions[(seed + i) % extensions.length]}`), ''); files++; }
    const children = depth < 6 ? 3 : (depth < 14 && seed % 9 === 0) ? 1 : 0;
    for (let i = 0; i < children; i++) {
      const name = depth < 6 ? `module-${depth}-${String.fromCharCode(97 + i)}` : `nested-level-${depth + 1}`;
      const child = join(path, name);
      mkdirSync(child);
      folders++;
      walk(child, depth + 1, depth < 6 ? seed * 3 + i : seed);
    }
  };
  walk(dir, 0, 0);
  return { folders, files };
}

/** Rows of the fully expanded tree in display order (folders first, natural order), as the app lists them. */
function displayOrder(dir, prefix = '', out = []) {
  const order = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
  const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || order.compare(a.name, b.name));
  for (const item of items) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    out.push(path);
    if (item.isDirectory() && item.name !== '.git') displayOrder(join(dir, item.name), path, out);
  }
  return out;
}

const root = mkdtempSync(join('D:\\Projekty', '_tmp-093tree-'));
for (const sub of ['data', 'project', 'home\\AppData\\Roaming', 'home\\AppData\\Local']) mkdirSync(join(root, sub), { recursive: true });
const projectPath = join(root, 'project');
const t0 = Date.now();
const { folders, files } = generateProject(projectPath);
console.log(`generated ${files} files in ${folders} folders (${Date.now() - t0} ms)`);
// An empty repository: every top folder is untracked, so the rows carry git letters.
try { execFileSync('git', ['init', '-q'], { cwd: projectPath, stdio: 'ignore' }); } catch { console.log('git not available: no git decorations check'); }
const projectId = randomUUID();
writeState(root, { version: 1, settings: { language: 'pl' }, activeProjectId: projectId,
  projects: [{ id: projectId, name: 'big-tree', path: projectPath, color: '#3b82f6', tabs: [], archive: [], activeTabId: null }] });

let app;
const results = { label, files, folders };
try {
  app = await launchApp(root);
  const { evaluate, until, cdp } = app;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false });
  if (!(await evaluate(`document.querySelector('#files-view')?.getAttribute('aria-selected') === 'true'`))) await app.click('#files-view');
  await until(`!!document.querySelector('.file-entry[data-path="module-0-a"]')`, 'file tree');
  // Rows of the tree: the virtual list reports them, the old tree had one element per row.
  const state = `(() => { const t = document.querySelector('.explorer-tree');
    const rows = t.dataset.rows ? Number(t.dataset.rows) : t.querySelectorAll('.file-entry').length;
    const loading = t.dataset.loading ? Number(t.dataset.loading) : [...t.querySelectorAll('.tree-message')].filter((m) => m.textContent.includes('Wczytywanie')).length;
    return { rows, loading, elements: t.querySelectorAll('*').length }; })()`;
  const total = files + folders;
  // Where the time goes: the folder walk of "expand all" and the listings of every folder (one IPC call each, or one batch).
  results.ipc = await evaluate(`(async () => {
    let t = performance.now();
    const all = await window.mc.listProjectDirectories(${JSON.stringify(projectId)});
    const walkMs = Math.round(performance.now() - t);
    t = performance.now();
    await Promise.all(all.paths.map((p) => window.mc.listProjectDirectory(${JSON.stringify(projectId)}, p)));
    const singleMs = Math.round(performance.now() - t);
    let batchMs = null;
    if (window.mc.listProjectDirectoryBatch) { t = performance.now(); await window.mc.listProjectDirectoryBatch(${JSON.stringify(projectId)}, all.paths); batchMs = Math.round(performance.now() - t); }
    return { folders: all.paths.length, walkMs, singleMs, batchMs };
  })()`);
  console.log('ipc', results.ipc);

  // Expand all: from the menu click until every row is listed and painted.
  await app.click('.explorer-heading-actions .btn[aria-haspopup=menu]');
  await until(`!!document.querySelector('.menu')`, 'actions menu');
  results.expandAll = await evaluate(`new Promise((resolve) => {
    let long = 0;
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) long += e.duration; });
    observer.observe({ entryTypes: ['longtask'] });
    const item = [...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('Rozwiń wszystkie foldery'));
    const start = performance.now();
    item.click();
    const check = () => {
      const s = ${state};
      if (s.rows >= ${total} && s.loading === 0) requestAnimationFrame(() => setTimeout(() => { observer.disconnect(); resolve({ ms: Math.round(performance.now() - start), longTaskMs: Math.round(long), ...s }); }));
      else if (performance.now() - start > 120000) resolve({ ms: -1, ...s });
      else setTimeout(check, 20);
    };
    check();
  })`);
  console.log('expand all', results.expandAll);

  // One folder toggled while everything is open: the cost of a re-render of the big tree.
  const toggle = (path) => evaluate(`new Promise((resolve) => {
    const el = document.querySelector('.file-entry[data-path=${JSON.stringify(path)}]');
    const start = performance.now();
    el.click();
    requestAnimationFrame(() => setTimeout(() => resolve(Math.round(performance.now() - start))));
  })`);
  await sleep(500);
  results.collapseOne = await toggle('module-0-a');
  await sleep(300);
  results.expandOne = await toggle('module-0-a');
  console.log('toggle one folder', results.collapseOne, results.expandOne);
  await sleep(500);

  // Scrolling: 60 steps through the tree, the duration of each frame.
  results.scroll = await evaluate(`new Promise((resolve) => {
    const t = document.querySelector('.explorer-tree');
    const frames = [];
    let i = 0, last = performance.now();
    const step = () => {
      const now = performance.now(); frames.push(now - last); last = now;
      if (i++ >= 60) { frames.shift(); frames.sort((a, b) => a - b); resolve({ medianMs: Math.round(frames[30]), maxMs: Math.round(frames[frames.length - 1]) }); return; }
      t.scrollTop += 1500;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`);
  console.log('scroll frames', results.scroll);
  mkdirSync(SHOTS, { recursive: true });
  const shot = async (name) => { await sleep(300); const { data } = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(SHOTS, `093-tree-${name}.png`), Buffer.from(data, 'base64')); console.log(`shot 093-tree-${name}.png`); };

  // Deep inside: scroll so the first visible row sits in the 14th level, the parents stay pinned above it.
  const deepest = 'module-0-a/module-1-a/module-2-a/module-3-a/module-4-a/module-5-a/nested-level-7/nested-level-8/nested-level-9/nested-level-10/nested-level-11/nested-level-12/nested-level-13/nested-level-14';
  const virtual = await evaluate(`!!document.querySelector('.explorer-tree').dataset.rows`);
  if (virtual) {
    // The file becomes the first row under five pinned folders.
    const order = displayOrder(projectPath);
    const target = order.indexOf(deepest + '/file-05-of-level-14.js');
    const rowHeight = await evaluate(`document.querySelector('.tree-rows .file-entry').offsetHeight`);
    await evaluate(`document.querySelector('.explorer-tree').scrollTop = ${(target - 5) * rowHeight}`);
    await sleep(400);
    assert.equal(await evaluate(`document.querySelector('.tree-rows .file-entry[data-index="${target}"]')?.dataset.path`), deepest + '/file-05-of-level-14.js', 'rows in display order');
    results.sticky = await evaluate(`[...document.querySelectorAll('.tree-sticky .file-entry')].map((e) => e.dataset.path)`);
    console.log('sticky rows', results.sticky);
    assert.ok(results.sticky.length === 5, 'five pinned levels');
    assert.equal(results.sticky.at(-1), deepest, 'the deepest pinned row is the parent of the first visible row');
    const layout = await evaluate(`(() => { const t = document.querySelector('.explorer-tree');
      const rows = [...t.querySelectorAll('.tree-rows .file-entry')].map((e) => ({ path: e.dataset.path, left: e.querySelector('.file-name').getBoundingClientRect().left, top: e.getBoundingClientRect().top, right: e.querySelector('.file-name').getBoundingClientRect().right }));
      const sticky = t.querySelector('.tree-sticky-rows').getBoundingClientRect();
      const box = t.getBoundingClientRect();
      return { overflowX: t.scrollWidth > t.clientWidth, maxLeft: Math.max(...rows.map((r) => r.left)) - box.left, width: box.width, stickyBottom: sticky.bottom - box.top, firstUnder: rows.find((r) => r.top >= sticky.bottom - 1)?.path };
    })()`);
    results.layout = layout;
    console.log('layout', layout);
    assert.equal(layout.overflowX, false, 'no horizontal scrollbar');
    assert.ok(layout.maxLeft < layout.width * 0.6, 'deep names keep most of the width');
    await shot('deep-sticky');
    // A folder appears above the viewport and Refresh lists it: the rows on screen stay where they are.
    const firstRow = `(() => { const t = document.querySelector('.explorer-tree'); const i = Math.floor(t.scrollTop / ${rowHeight}) + 5; return { top: t.scrollTop, path: document.querySelector('.tree-rows .file-entry[data-index="' + i + '"]')?.dataset.path }; })()`;
    const beforeRefresh = await evaluate(firstRow);
    mkdirSync(join(projectPath, 'module-0-a', 'aaa-new-folder'));
    await app.click(`.explorer-heading-actions .btn[title="Odśwież pliki"]`);
    await until(`Number(document.querySelector('.explorer-tree').dataset.rows) === ${total + 2}`, 'refreshed listing with the new folder');
    await sleep(300);
    const afterRefresh = await evaluate(firstRow);
    console.log('anchoring', beforeRefresh, afterRefresh);
    assert.equal(afterRefresh.path, beforeRefresh.path, 'the first visible row stays in place');
    assert.equal(afterRefresh.top, beforeRefresh.top + rowHeight, 'scrolled by the inserted row');
    // A click on a pinned row brings that folder to the top.
    const pinned = results.sticky[1];
    await app.click(`.tree-sticky .file-entry[data-path=${JSON.stringify(pinned)}]`);
    await sleep(300);
    const afterClick = await evaluate(`({ sticky: [...document.querySelectorAll('.tree-sticky .file-entry')].map((e) => e.dataset.path), open: document.querySelector('.tree-rows .file-entry[data-path=${JSON.stringify(pinned)}]')?.getAttribute('aria-expanded') })`);
    console.log('after click on a pinned row', afterClick);
    assert.equal(afterClick.open, 'true', 'the folder stays open and is scrolled to');
    assert.ok(!afterClick.sticky.includes(pinned) || afterClick.sticky.at(-1) !== pinned, 'the clicked folder is the top row, not pinned below itself');
    await shot('sticky-click');
    // Open the deep file in the editor (for "Show in Files panel" later).
    const deepFile = deepest + '/file-05-of-level-14.js';
    await evaluate(`document.querySelector('.explorer-tree').scrollTop = ${(target + 1 - 5) * rowHeight}`);
    await sleep(300);
    await app.click(`.tree-rows .file-entry[data-path=${JSON.stringify(deepFile)}]`);
    await until(`!!document.querySelector('.tab.file-tab[title^=${JSON.stringify(deepFile)}]')`, 'deep file opened');
    // Keyboard: ArrowDown moves focus through virtual rows, past the rendered window.
    await evaluate(`document.querySelector('.tree-rows .file-entry[data-path=${JSON.stringify(pinned)}]').focus()`);
    for (let i = 0; i < 80; i++) await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    const focused = await evaluate(`document.activeElement?.dataset?.path ?? null`);
    console.log('focused after 80 x ArrowDown', focused);
    assert.ok(focused && focused !== pinned, 'keyboard focus moved');
    assert.ok(await evaluate(`(() => { const r = document.activeElement.getBoundingClientRect(), t = document.querySelector('.explorer-tree').getBoundingClientRect(); return r.top >= t.top && r.bottom <= t.bottom + 1; })()`), 'the focused row is scrolled into view');
    // Rename with F2 on the focused row (a file deep in the list).
    if (await evaluate(`document.activeElement.dataset.kind === 'file'`)) {
      const parent = focused.slice(0, focused.lastIndexOf('/'));
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
      await until(`document.activeElement?.classList.contains('file-rename')`, 'rename input');
      await app.setValue('.file-rename', 'renamed-by-check.txt');
      await app.press('Enter');
      await until(`!!document.querySelector('.tree-rows .file-entry[data-path=${JSON.stringify(parent + '/renamed-by-check.txt')}]')`, 'renamed row');
      assert.ok(existsSync(join(projectPath, ...(parent + '/renamed-by-check.txt').split('/'))), 'renamed on disk');
      console.log('rename ok');
    }
    // Context menu of a row.
    await evaluate(`(() => { const el = document.querySelector('.tree-rows .file-entry.selected') ?? document.querySelector('.tree-rows .file-entry'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 8 })); })()`);
    await until(`[...document.querySelectorAll('.menu .menu-item')].some((e) => e.textContent.includes('Zmień nazwę'))`, 'row context menu');
    await app.press('Escape');
    await until(`!document.querySelector('.menu')`, 'menu closed');
    // Collapse all, then the middle of a fully open tree for an overview shot.
    await evaluate(`document.querySelector('.explorer-tree').scrollTop = document.querySelector('.explorer-tree').scrollHeight * 0.37`);
    await sleep(300);
    const stack = await evaluate(`(() => { const box = document.querySelector('.tree-sticky-rows'); if (!box) return null; const b = box.getBoundingClientRect();
      return { top: document.querySelector('.explorer-tree').scrollTop, box: [b.top, b.bottom], rows: [...box.children].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.path, r.top, r.bottom, e.style.top]; }) }; })()`);
    console.log('stack in the middle', JSON.stringify(stack));
    await shot('middle');

    // Collapse all, then drag a root file onto a folder: it moves on disk and the folder opens.
    await app.click('.explorer-heading-actions .btn[aria-haspopup=menu]');
    await app.click('.menu-item', 'Zwiń wszystkie foldery');
    await until(`Number(document.querySelector('.explorer-tree').dataset.rows) < 10`, 'collapsed');
    const moved = 'file-00-of-level-0.ts';
    await evaluate(`(() => {
      const src = document.querySelector('.tree-rows .file-entry[data-path=${JSON.stringify(moved)}]');
      const dst = document.querySelector('.tree-rows .file-entry[data-path="module-0-b"]');
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await until(`!!document.querySelector('.tree-rows .file-entry.selected[data-path="module-0-b/${moved}"]')`, 'moved row selected in the opened folder');
    assert.ok(existsSync(join(projectPath, 'module-0-b', moved)) && !existsSync(join(projectPath, moved)), 'moved on disk');
    console.log('drag and drop ok');
    await shot('collapsed-dnd');

    // "Show in Files panel" from the editor tab: the folders open down to the deep file, which is scrolled into view and focused.
    await app.click('.explorer-heading-actions .btn[aria-haspopup=menu]');
    await app.click('.menu-item', 'Zwiń wszystkie foldery');
    await until(`Number(document.querySelector('.explorer-tree').dataset.rows) < 10`, 'collapsed again');
    await evaluate(`(() => { const tab = document.querySelector('.tab.file-tab[title^=${JSON.stringify(deepFile)}]'); const r = tab.getBoundingClientRect(); tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 })); })()`);
    await app.click('.menu-item', 'Pokaż w panelu plików');
    await until(`document.activeElement?.dataset?.path === ${JSON.stringify(deepFile)}`, 'revealed and focused');
    const revealed = await evaluate(`(() => { const r = document.activeElement.getBoundingClientRect(), t = document.querySelector('.explorer-tree').getBoundingClientRect(), s = document.querySelector('.tree-sticky-rows')?.getBoundingClientRect();
      return { inView: r.top >= (s ? s.bottom - 1 : t.top) && r.bottom <= t.bottom + 1, selected: document.activeElement.classList.contains('selected') }; })()`);
    console.log('reveal', revealed);
    assert.ok(revealed.inView && revealed.selected, 'revealed row visible below the pinned folders and selected');
    await shot('reveal');

    // Git decorations on virtual rows (untracked folders of the fresh repository).
    try {
      await until(`!!document.querySelector('.tree-rows .file-entry .file-git')`, 'git decorations', 15000);
      console.log('git decorations ok');
    } catch { console.log('no git decorations (git missing or repository not trusted)'); }
  } else {
    await evaluate(`document.querySelector('.file-entry[data-path=${JSON.stringify(deepest + '/file-05-of-level-14.js')}]').scrollIntoView({ block: 'start' })`);
    await shot(`deep-${label}`);
  }
  console.log(JSON.stringify(results));
} finally {
  await app?.close();
  if (!args.includes('--keep')) removeScratch(root);
}
