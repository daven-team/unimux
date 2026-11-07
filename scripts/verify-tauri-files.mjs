// Real-app check of the Files panel on the Tauri build (1.2.0, PLAN G5): the `check` build on a scratch data dir, scratch home
// and a scratch project. Lists the project (folders first, natural order), opens a UTF-8 BOM + CRLF file, types into the
// editor, saves with Ctrl+S (BOM and CRLF kept, no staged file left), saves again after an external edit (the conflict
// notice, the file untouched), shows a PNG through the bridge's data: URL and a Parquet file as a table, and leaves nothing
// in the real profile. Offscreen window, nothing shows on the desktop. Screenshots go to artifacts/tauri-files/.
//
//   npm run build:check && node scripts/verify-tauri-files.mjs        (--keep leaves the scratch dir for inspection)
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'artifacts', 'tauri-files');
mkdirSync(shots, { recursive: true });
const keep = process.argv.includes('--keep');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

/** A real 3 x 2 RGB PNG (so the page can decode it and show its size). */
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const scratch = mkdtempSync(join(tmpdir(), 'unimux-g5-files-'));
const dataDir = join(scratch, 'data');
const project = join(scratch, 'Projekt ł');
for (const dir of [dataDir, project, join(project, 'src'), join(project, 'docs')]) mkdirSync(dir, { recursive: true });
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const notes = join(project, 'notatki.txt');
writeFileSync(notes, Buffer.concat([BOM, Buffer.from('Cześć\r\nświat\r\n', 'utf8')]));
for (const name of ['plik10.ts', 'plik2.ts', 'Plik1.ts']) writeFileSync(join(project, 'src', name), `export const x = '${name}';\n`);
writeFileSync(join(project, 'obraz.png'), png());
writeFileSync(join(project, 'Zebra.md'), '# Z\n');
writeFileSync(join(project, 'żaba.md'), '# ż\n');
copyFileSync(join(root, 'test', 'golden', 'parquet', 'many.parquet'), join(project, 'dane.parquet'));
const projectId = 'proj-g5';
writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, settings: { language: 'pl' }, activeProjectId: projectId,
  projects: [{ id: projectId, name: 'g5', path: project, color: '#3b82f6', tabs: [], archive: [], activeTabId: null }] }));

const markersBefore = realProfileMarkers();
const port = await freePort();
const child = launchApp({ dataDir, scratch, port });
let page;
try {
  page = await connectPage(port, { timeoutMs: 60000 });
  const { evaluate, send } = page;
  const until = (expr, label, ms = 20000) => waitFor(page, expr, ms, label);
  const shot = async (name) => { await sleep(250); const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64')); };
  const click = async (selector) => {
    const box = await until(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 } : null; })()`, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  const ctrlKey = async (key, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key, code, windowsVirtualKeyCode: vk });
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(`!!document.querySelector('#files-view')`, 'app UI', 60000);
  if (!(await evaluate(`document.querySelector('#files-view').getAttribute('aria-selected') === 'true'`))) await click('#files-view');

  // Listing: folders first, then files in the Polish natural order.
  await until(`!!document.querySelector('.file-entry[data-path="notatki.txt"]')`, 'file tree');
  const top = await evaluate(`[...document.querySelectorAll('.explorer-tree .file-entry')].map((e) => e.dataset.path)`);
  check('top level: folders first, Polish name order', JSON.stringify(top) === JSON.stringify(['docs', 'src', 'dane.parquet', 'notatki.txt', 'obraz.png', 'Zebra.md', 'żaba.md']), JSON.stringify(top));
  await click('.file-entry[data-path="src"]');
  await until(`!!document.querySelector('.file-entry[data-path="src/plik10.ts"]')`, 'src expanded');
  const inSrc = await evaluate(`[...document.querySelectorAll('.explorer-tree .file-entry')].map((e) => e.dataset.path).filter((p) => p.startsWith('src/'))`);
  check('numeric order inside a folder', JSON.stringify(inSrc) === JSON.stringify(['src/Plik1.ts', 'src/plik2.ts', 'src/plik10.ts']), JSON.stringify(inSrc));

  // Open, edit, save.
  await click('.file-entry[data-path="notatki.txt"]');
  await until(`document.querySelector('.file-editor .cm-content')?.textContent.includes('świat')`, 'editor with the file text');
  check('file opens in the editor', true);
  await evaluate(`document.querySelector('.file-editor .cm-content').focus()`);
  await ctrlKey('End', 'End', 35);
  await send('Input.insertText', { text: 'dopisane w Tauri' });
  await until(`!!document.querySelector('.file-editor .save-dirty')`, 'dirty mark');
  await shot('01-edited');
  await ctrlKey('s', 'KeyS', 83);
  await until(`!document.querySelector('.file-editor .save-dirty')`, 'saved (no dirty mark)');
  const saved = readFileSync(notes);
  const expected = Buffer.concat([BOM, Buffer.from('Cześć\r\nświat\r\ndopisane w Tauri', 'utf8')]);
  check('Ctrl+S writes the file with its BOM and CRLF kept', saved.equals(expected), JSON.stringify(saved.toString('utf8')));
  check('no staged .mc-save file left', !readdirSync(project).some((n) => n.includes('.mc-save-')));

  // Conflict: the file changes on disk, then a save of the stale draft is refused and the file stays as the other writer left it.
  const external = Buffer.from('zmienione obok\n', 'utf8');
  await send('Input.insertText', { text: ' i jeszcze' });
  writeFileSync(notes, external);
  await until(`!!document.querySelector('.file-editor .save-dirty')`, 'dirty again');
  await ctrlKey('s', 'KeyS', 83);
  await until(`!!document.querySelector('.file-disk-conflict')`, 'conflict notice');
  await shot('02-conflict');
  check('a save after an external edit shows the conflict notice', true, await evaluate(`document.querySelector('.file-disk-conflict').textContent`));
  check('the externally written file is untouched', readFileSync(notes).equals(external));

  // Image preview: raw bytes over IPC, a data: URL the page decodes.
  await click('.file-entry[data-path="obraz.png"]');
  await until(`[...document.querySelectorAll('.image-stage img')].some((i) => i.complete && i.naturalWidth === 3 && i.naturalHeight === 2)`, 'decoded image');
  const src = await evaluate(`[...document.querySelectorAll('.image-stage img')].find((i) => i.naturalWidth === 3).src.slice(0, 30)`);
  check('PNG preview shows the decoded image from a data: URL', src.startsWith('data:image/png;base64,'), src);
  await shot('03-image');

  // Parquet: the large view shows the table (first 1000 of 1500 rows).
  await click('.file-entry[data-path="dane.parquet"]');
  // The table is windowed: the first row is on screen, the note tells the totals.
  await until(`document.body.innerText.includes('wiersz 0') && document.body.innerText.includes('PARQUET')`, 'parquet table', 30000);
  const note = await evaluate(`document.body.innerText.split('\\n').find((l) => l.includes('PARQUET'))`);
  check('Parquet file opens as a table of the first 1000 of 1500 rows', /1\s?500 wierszy/.test(note) && /pokazano pierwsze 1\s?000/.test(note), note);
  await shot('04-parquet');
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
