// Real-app check of the file operations on the Tauri build (1.2.0, PLAN G6): the `check` build on a scratch data dir, scratch
// home, scratch project and MC_TRASH_DIR (nothing reaches the real Recycle Bin). In the Files panel: copy with Ctrl+C / Ctrl+V
// and the conflict dialog (Keep both), move with Ctrl+X / Ctrl+V, a big copy that shows its progress row ("Kopiowanie… (n)",
// the count growing) and is cancelled with "Anuluj" (no partial copy left, the source intact), a copy above 500 MiB that asks
// first (cancelled there: nothing copied), Delete to the trash; then the SFTP view's local pane calls (list, roots, mkdir,
// rename, trash, reveal recorded by the offscreen desktop, never an Explorer window). Offscreen window, nothing shows on the
// desktop. Screenshots go to artifacts/tauri-fileops/.
//
//   npm run build:check && node scripts/verify-tauri-fileops.mjs        (--keep leaves the scratch dir for inspection)
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, ftruncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'artifacts', 'tauri-fileops');
mkdirSync(shots, { recursive: true });
const keep = process.argv.includes('--keep');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const scratch = mkdtempSync(join(tmpdir(), 'unimux-g6-fileops-'));
const dataDir = join(scratch, 'data');
const trashDir = join(scratch, 'trash');
const project = join(scratch, 'Projekt ł');
for (const dir of [dataDir, project, join(project, 'docs'), join(project, 'src'), join(project, 'big'), join(project, 'huge')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, 'a.txt'), 'A');
writeFileSync(join(project, 'docs', 'a.txt'), 'other A');
writeFileSync(join(project, 'src', 'move-me.ts'), 'export {};\n');
// About 190 MB in 6000 files: long enough to see the progress row and press Cancel.
const BIG_FILES = 6000;
const chunk = Buffer.alloc(32 * 1024, 0x61);
for (let i = 0; i < BIG_FILES; i++) {
  const sub = join(project, 'big', `d${String(Math.floor(i / 500)).padStart(2, '0')}`);
  if (i % 500 === 0) mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `f${String(i).padStart(5, '0')}.bin`), chunk);
}
// 600 MiB that take no disk space to make: above the 500 MiB confirmation.
const fd = openSync(join(project, 'huge', 'disk.img'), 'w');
ftruncateSync(fd, 600 * 1024 * 1024);
closeSync(fd);
const projectId = 'proj-g6';
writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, settings: { language: 'pl' }, activeProjectId: projectId,
  projects: [{ id: projectId, name: 'g6', path: project, color: '#3b82f6', tabs: [], archive: [], activeTabId: null }] }));

const count = (dir) => { let n = 0; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { n++; if (e.isDirectory()) walk(join(d, e.name)); } }; walk(dir); return n; };

const markersBefore = realProfileMarkers();
const port = await freePort();
const child = launchApp({ dataDir, scratch, port, extraEnv: { MC_TRASH_DIR: trashDir } });
let page;
try {
  page = await connectPage(port, { timeoutMs: 60000 });
  const { evaluate, send } = page;
  const until = (expr, label, ms = 20000) => waitFor(page, expr, ms, label);
  const bridge = (op, args) => evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
  const shot = async (name) => { await sleep(150); const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64')); };
  const clickAt = async (box) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }); };
  const click = async (selector) => clickAt(await until(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 } : null; })()`, selector));
  const clickButton = async (label) => clickAt(await until(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && x.getBoundingClientRect().width); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, `button ${label}`));
  const key = async (k, code, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key: k, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k, code, windowsVirtualKeyCode: vk });
  };
  const ctrl = (letter) => key(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), 2);
  const row = (path) => `.file-entry[data-path=${JSON.stringify(path)}]`;
  const select = async (path) => { await click(row(path)); await until(`document.querySelector(${JSON.stringify(row(path))})?.getAttribute('aria-selected') === 'true'`, `${path} selected`, 5000).catch(() => null); };
  const toast = () => evaluate(`[...document.querySelectorAll('.toast, [role="status"], [role="alert"]')].map((t) => t.textContent).join(' | ')`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(`!!document.querySelector('#files-view')`, 'app UI', 60000);
  if (!(await evaluate(`document.querySelector('#files-view').getAttribute('aria-selected') === 'true'`))) await click('#files-view');
  await until(`!!document.querySelector(${JSON.stringify(row('a.txt'))})`, 'file tree');

  // Copy a.txt into docs: the name exists there, the conflict dialog offers Keep both.
  await select('a.txt');
  await ctrl('c');
  await select('docs');
  await ctrl('v');
  await until(`document.body.innerText.includes('Konflikt nazw')`, 'conflict dialog');
  await shot('01-conflict');
  await clickButton('Zachowaj oba');
  await until(`!!document.querySelector(${JSON.stringify(row('docs/a copy.txt'))})`, 'docs/a copy.txt in the tree');
  check('copy with a name conflict, Keep both: "a copy.txt" next to the old file', readFileSync(join(project, 'docs', 'a copy.txt'), 'utf8') === 'A' && readFileSync(join(project, 'docs', 'a.txt'), 'utf8') === 'other A');

  // Move src/move-me.ts into docs with Ctrl+X / Ctrl+V.
  await click(row('src'));
  await until(`!!document.querySelector(${JSON.stringify(row('src/move-me.ts'))})`, 'src expanded');
  await select('src/move-me.ts');
  await ctrl('x');
  await select('docs');
  await ctrl('v');
  await until(`!!document.querySelector(${JSON.stringify(row('docs/move-me.ts'))})`, 'moved file in the tree');
  check('move with Ctrl+X / Ctrl+V', existsSync(join(project, 'docs', 'move-me.ts')) && !existsSync(join(project, 'src', 'move-me.ts')));

  // A big copy: the progress row counts up, Cancel stops it and nothing half-copied stays.
  await select('big');
  await ctrl('c');
  await select('docs');
  await ctrl('v');
  const shown = `(() => { const b = document.querySelector('.explorer-busy'); const m = b && b.textContent.match(/\\((\\d[\\d\\s\\u00a0]*)\\)/); return m ? Number(m[1].replace(/\\D/g, '')) : null; })()`;
  const first = await until(shown, 'progress row', 30000);
  // Samples every 100 ms for up to 5 s, until the count moved twice (events come at most every 120 ms; a loaded disk may
  // stall the copy for a moment).
  const samples = [first];
  const sampleStart = Date.now();
  while (Date.now() - sampleStart < 5000 && new Set(samples).size < 3) {
    await sleep(100);
    const value = await evaluate(shown);
    if (value === null) break;
    samples.push(value);
  }
  await shot('02-progress');
  const moved = samples.filter((v, i) => i > 0 && v > samples[i - 1]).length;
  check('the progress row shows a growing count ("Kopiowanie… (n)")', moved >= 2 && samples.every((v, i) => i === 0 || v >= samples[i - 1]), `${[...new Set(samples)].join(' -> ')} in ${Date.now() - sampleStart} ms`);
  const cancelledAt = Date.now();
  await clickButton('Anuluj');
  await until(`!document.querySelector('.explorer-busy')`, 'progress row gone after Cancel', 30000);
  const stopMs = Date.now() - cancelledAt;
  await sleep(300);
  check('Cancel stops the copy and removes the partial tree', !existsSync(join(project, 'docs', 'big')) && !readdirSync(join(project, 'docs')).some((n) => n.startsWith('big')), `${stopMs} ms, docs: ${readdirSync(join(project, 'docs')).join(', ')}`);
  check('the source of the cancelled copy is intact', count(join(project, 'big')) === BIG_FILES + 12, String(count(join(project, 'big'))));

  // Above 500 MiB a copy asks first; cancelling the question copies nothing.
  await select('huge');
  await ctrl('c');
  await select('src');
  await ctrl('v');
  await until(`document.body.innerText.includes('Duże kopiowanie')`, 'large copy question');
  await shot('03-large');
  const question = await evaluate(`[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.includes('Kopiowanie obejmuje'))?.textContent ?? ''`);
  check('a copy above 500 MiB asks first', /Kopiowanie obejmuje co najmniej 2 elementów/.test(question), question);
  await key('Escape', 'Escape', 27);
  await until(`!document.body.innerText.includes('Duże kopiowanie')`, 'question closed');
  check('cancelling the question copies nothing', !existsSync(join(project, 'src', 'huge')));

  // Delete goes to the trash (MC_TRASH_DIR here), after the confirmation.
  await select('a.txt');
  await key('Delete', 'Delete', 46);
  await until(`document.body.innerText.includes('Przenieść do kosza?')`, 'trash question');
  await clickButton('Przenieś do kosza');
  await until(`!document.querySelector(${JSON.stringify(row('a.txt'))})`, 'a.txt gone from the tree');
  const binned = existsSync(trashDir) ? readdirSync(trashDir) : [];
  check('Delete moves the file to the trash, not deleted', !existsSync(join(project, 'a.txt')) && binned.length === 1 && /^[0-9a-f]{8}-a\.txt$/.test(binned[0]) && readFileSync(join(trashDir, binned[0]), 'utf8') === 'A', binned.join(', '));
  await shot('04-after');

  // The SFTP view's local pane (its UI needs an SSH session, T1): the same channels the pane calls.
  const pane = join(scratch, 'pane');
  mkdirSync(pane);
  writeFileSync(join(pane, 'x.txt'), 'xyz');
  const call = (expr) => evaluate(`(async () => ${expr})()`);
  const listed = await call(`await window.mc.localFs.list(${JSON.stringify(pane)})`);
  const x = listed?.value?.entries?.find((e) => e.name === 'x.txt');
  check('local:list lists a folder with kind and size', listed?.ok && x?.kind === 'file' && x?.size === 3 && x?.path === join(pane, 'x.txt'), JSON.stringify(listed));
  const roots = await call(`await window.mc.localFs.roots()`);
  check('local:roots gives the (scratch) home and the drives', roots?.home === join(scratch, 'home') && Array.isArray(roots.drives) && roots.drives.length > 0, JSON.stringify(roots));
  const made = await call(`await window.mc.localFs.mkdir(${JSON.stringify(join(pane, 'nowy'))})`);
  const renamed = await call(`await window.mc.localFs.rename(${JSON.stringify(join(pane, 'x.txt'))}, ${JSON.stringify(join(pane, 'X.TXT'))})`);
  check('local:mkdir and a case-only local:rename', made?.ok && renamed?.ok && readdirSync(pane).includes('X.TXT') && readdirSync(pane).includes('nowy'), JSON.stringify([made, renamed, readdirSync(pane)]));
  const trashed = await call(`await window.mc.localFs.trash([${JSON.stringify(join(pane, 'X.TXT'))}])`);
  const refused = await call(`await window.mc.localFs.trash([${JSON.stringify(join(scratch, 'home'))}])`);
  check('local:trash sends to the trash and refuses the home folder', trashed?.ok && !existsSync(join(pane, 'X.TXT')) && readdirSync(trashDir).length === 2 && refused?.error === 'invalid', JSON.stringify([trashed, refused]));
  await bridge('os', { action: 'log', take: true });
  await call(`await window.mc.localFs.reveal(${JSON.stringify(join(pane, 'nowy'))})`);
  writeFileSync(join(pane, 'y.txt'), 'y');
  await call(`await window.mc.localFs.reveal(${JSON.stringify(join(pane, 'y.txt'))})`);
  const log = await bridge('os', { action: 'log', take: true });
  check('local:reveal opens a folder and shows a file (recorded offscreen, no Explorer window)', JSON.stringify(log) === JSON.stringify([{ op: 'openPath', path: join(pane, 'nowy') }, { op: 'revealPath', path: join(pane, 'y.txt') }]), JSON.stringify(log));
  const notYet = await bridge('notYet');
  const g6 = ['fs:renameEntry', 'fs:createEntry', 'fs:deleteEntries', 'fs:transfer', 'fs:cancelOp', 'local:list', 'local:roots', 'local:mkdir', 'local:rename', 'local:trash', 'local:reveal'];
  const missing = JSON.stringify(notYet ?? []).match(new RegExp(g6.map((c) => c.replace(':', '\\:')).join('|'), 'g'));
  check('no G6 channel answered "not yet"', !missing, JSON.stringify(missing));
} catch (error) {
  check('run', false, error.stack ?? String(error));
} finally {
  page?.close();
  killTree(child);
  await sleep(500);
}
const markersAfter = realProfileMarkers();
check('nothing new in the real profile', JSON.stringify(markersBefore) === JSON.stringify(markersAfter));
if (!keep) removeScratch(scratch); else console.log(`scratch kept: ${scratch}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
