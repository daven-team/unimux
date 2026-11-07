// Real-app check of the project search and replace on the Tauri build (1.2.0, PLAN G7): the `check` build on a scratch data
// dir, scratch home and a scratch project with Polish diacritics, an emoji, a UTF-8 BOM + CRLF file, a binary file and a
// node_modules folder. Opens "Znajdź i zamień w plikach…" from the Files panel, searches (counts, UTF-16 columns and previews
// over the bridge, the skipped binary, node_modules left out), shows V8's message for an invalid expression, replaces one
// occurrence and then all of them (BOM and CRLF kept, the in-app confirmation), and leaves nothing in the real profile.
// Offscreen window, nothing shows on the desktop. Screenshots go to artifacts/tauri-search/.
//
//   npm run build:check && node scripts/verify-tauri-search.mjs        (--keep leaves the scratch dir for inspection)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'artifacts', 'tauri-search');
mkdirSync(shots, { recursive: true });
const keep = process.argv.includes('--keep');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const scratch = mkdtempSync(join(tmpdir(), 'unimux-g7-search-'));
const dataDir = join(scratch, 'data');
const project = join(scratch, 'Projekt ż');
for (const dir of [dataDir, project, join(project, 'src'), join(project, 'node_modules', 'pkg')]) mkdirSync(dir, { recursive: true });
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const notes = join(project, 'notatki.txt');
writeFileSync(notes, Buffer.concat([BOM, Buffer.from('żółw token\r\nŻÓŁW 😀 token żółw\r\n', 'utf8')]));
const code = join(project, 'src', 'kod.ts');
writeFileSync(code, 'const żółwie = 1; // żółw\n');
writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'żółw\n');
writeFileSync(join(project, 'dane.bin'), Buffer.concat([Buffer.from('żółw', 'utf8'), Buffer.from([0, 1, 2])]));
const projectId = 'proj-g7';
writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, settings: { language: 'pl' }, activeProjectId: projectId,
  projects: [{ id: projectId, name: 'g7', path: project, color: '#3b82f6', tabs: [], archive: [], activeTabId: null }] }));

const markersBefore = realProfileMarkers();
const port = await freePort();
const child = launchApp({ dataDir, scratch, port });
let page;
try {
  page = await connectPage(port, { timeoutMs: 60000 });
  const { evaluate, send } = page;
  const until = (expr, label, ms = 20000) => waitFor(page, expr, ms, label);
  const shot = async (name) => { await sleep(250); const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shots, `${name}.png`), Buffer.from(data, 'base64')); };
  const clickAt = async (box) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }); };
  const boxOf = (finder) => `(() => { const e = ${finder}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`;
  const click = async (selector) => clickAt(await until(boxOf(`document.querySelector(${JSON.stringify(selector)})`), selector));
  /** The last visible button with exactly this text (a dialog on top of the modal comes last). */
  const clickText = async (text) => clickAt(await until(boxOf(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.getBoundingClientRect().width).pop()`), text));
  const typeInto = async (selector, text) => {
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select(); })()`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    if (text) await send('Input.insertText', { text });
  };
  // The regex toggle by its text: while the pointer rests on it, TooltipHost keeps its title aside (no [title] to select).
  const clickRegex = async () => clickAt(await until(boxOf(`[...document.querySelectorAll('.find-replace .fr-toggle')].find((b) => b.textContent === '.*')`), 'regex toggle'));
  const status = () => evaluate(`document.querySelector('.find-replace .fr-status')?.textContent ?? ''`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(`!!document.querySelector('#files-view')`, 'app UI', 60000);
  if (!(await evaluate(`document.querySelector('#files-view').getAttribute('aria-selected') === 'true'`))) await click('#files-view');
  await until(`!!document.querySelector('.file-entry[data-path="notatki.txt"]')`, 'file tree');

  // The bridge answer itself: UTF-16 columns (the emoji is two units), previews, the binary skipped, node_modules left out.
  const direct = await evaluate(`window.mc.searchProject(${JSON.stringify(projectId)}, { query: 'token' })`);
  const second = direct.files?.find((f) => f.path === 'notatki.txt')?.matches?.[1];
  check('search over the bridge: UTF-16 column after the emoji', direct.ok && direct.matches === 2 && second?.line === 2 && second?.column === 8 && second?.preview === 'ŻÓŁW 😀 token żółw', JSON.stringify(direct));
  const polish = await evaluate(`window.mc.searchProject(${JSON.stringify(projectId)}, { query: 'ŻÓŁW' })`);
  check('case-insensitive Polish search, binary skipped, node_modules left out',
    polish.ok && polish.matches === 5 && polish.scanned === 3 && polish.skipped === 1 && JSON.stringify(polish.files.map((f) => f.path)) === '["notatki.txt","src/kod.ts"]',
    JSON.stringify({ matches: polish.matches, scanned: polish.scanned, skipped: polish.skipped, files: polish.files?.map((f) => f.path) }));
  const word = await evaluate(`window.mc.searchProject(${JSON.stringify(projectId)}, { query: 'żółw', wholeWord: true, caseSensitive: true })`);
  check('whole word with letters outside ASCII (żółwie is no match)', word.ok && word.matches === 3, JSON.stringify(word.files?.map((f) => [f.path, f.matches.map((m) => m.column)])));
  const withIgnored = await evaluate(`window.mc.searchProject(${JSON.stringify(projectId)}, { query: 'żółw', includeIgnored: true, include: '*.js' })`);
  check('includeIgnored and an include glob', withIgnored.ok && withIgnored.matches === 1 && withIgnored.files[0]?.path === 'node_modules/pkg/index.js', JSON.stringify(withIgnored.files?.map((f) => f.path)));

  // The modal: open it from the Files panel's more-actions menu.
  await click('#explorer-panel button[aria-haspopup="menu"], .explorer button[aria-haspopup="menu"], button[aria-haspopup="menu"]');
  await clickText('Znajdź i zamień w plikach…');
  await until(`!!document.querySelector('.find-replace input[aria-label="Znajdź"]')`, 'search modal');
  await typeInto('.find-replace input[aria-label="Znajdź"]', 'żółw');
  await until(`document.querySelector('.find-replace .fr-status')?.textContent.includes('Znaleziono')`, 'search result');
  const found = await status();
  check('the modal shows the counts and the skipped binary', found.includes('Znaleziono 5 w 2 plikach') && found.includes('Pominięto 1 plików'), found);
  const previews = await evaluate(`[...document.querySelectorAll('.find-replace .fr-match')].map((m) => m.textContent)`);
  check('match rows with the emoji preview', previews.length === 5 && previews.some((p) => p.includes('ŻÓŁW 😀 token żółw')), JSON.stringify(previews));
  await shot('01-results');

  // An invalid expression: V8's message of 1.1.4.
  await clickRegex();
  await typeInto('.find-replace input[aria-label="Znajdź"]', '(');
  await until(`!!document.querySelector('.find-replace .fr-error')`, 'regex error');
  const error = await evaluate(`document.querySelector('.find-replace .fr-error').textContent`);
  check('an invalid expression shows V8\'s message', error === 'Nieprawidłowe wyrażenie regularne: Invalid regular expression: /(/gi: Unterminated group', error);
  await shot('02-invalid');
  await clickRegex();

  // Replace one occurrence (the first of notatki.txt), then all of them after the in-app confirmation.
  await typeInto('.find-replace input[aria-label="Znajdź"]', 'żółw');
  await until(`document.querySelector('.find-replace .fr-status')?.textContent.includes('Znaleziono 5')`, 'search again');
  await typeInto('.find-replace input[aria-label="Zamień na"]', 'Żaba 🐸');
  await clickAt(await until(boxOf(`document.querySelector('.find-replace .fr-match button')`), 'replace one'));
  await until(`document.querySelector('.find-replace .fr-status')?.textContent.includes('Znaleziono 4')`, 'four left', 20000);
  const afterOne = readFileSync(notes);
  check('one occurrence replaced, BOM and CRLF kept', afterOne.equals(Buffer.concat([BOM, Buffer.from('Żaba 🐸 token\r\nŻÓŁW 😀 token żółw\r\n', 'utf8')])), JSON.stringify(afterOne.toString('utf8')));
  await clickText('Zamień wszystko (4)');
  await until(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Zamień wszystko').length > 0`, 'confirmation');
  await shot('03-confirm');
  await clickText('Zamień wszystko');
  await until(`document.querySelector('.find-replace .fr-status')?.textContent.includes('Brak wyników')`, 'nothing left', 20000);
  const notesAfter = readFileSync(notes);
  check('replace all in notatki.txt (case-insensitive), BOM and CRLF kept',
    notesAfter.equals(Buffer.concat([BOM, Buffer.from('Żaba 🐸 token\r\nŻaba 🐸 😀 token Żaba 🐸\r\n', 'utf8')])), JSON.stringify(notesAfter.toString('utf8')));
  check('replace all in src/kod.ts', readFileSync(code, 'utf8') === 'const Żaba 🐸ie = 1; // Żaba 🐸\n', JSON.stringify(readFileSync(code, 'utf8')));
  check('node_modules and the binary file untouched', readFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'utf8') === 'żółw\n'
    && readFileSync(join(project, 'dane.bin')).subarray(0, 7).toString('utf8') === 'żółw');
  await shot('04-replaced');
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
