// Real-app check of the Postgres UI (1.0.0): the built app with a scratch data dir and home, a local PGlite
// (scripts/pg-test-server.mjs), the fake Postgres for cancelling (scripts/pg-fake-server.mjs) and the local SSH test server.
// Drives the "Bazy danych" panel, the connection form, the tree, table data tabs (sort, filter, paging, edits, Pokaż SQL,
// save, conflict), a read-only connection, the SQL editor (statement, selection, script, several results, load more, cancel,
// transaction), export and drafts across a reload. Screenshots: D:\Projekty\_shots\100-db-*.png.
// Run `npm run build` first. Never touches real hosts or the user's data dir; kills only the PIDs it started.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { killTree, launchApp, scratchRoot, sleep, sshState, startTestServer, testHost, writeState } from './ssh-ui-lib.mjs';

const SEED = `
CREATE TABLE items (id int PRIMARY KEY, name text NOT NULL, price numeric(10,2), data jsonb, active boolean DEFAULT true, note text);
INSERT INTO items SELECT g, 'item ' || g, g * 1.5, ('{"n":' || g || ',"tags":["a","b"]}')::jsonb, g % 3 <> 0, CASE WHEN g % 5 = 0 THEN NULL ELSE 'note ' || g END FROM generate_series(1, 1500) g;
CREATE TABLE nokey (a int, b text); INSERT INTO nokey VALUES (1, 'x'), (2, 'y');
CREATE TABLE wide (id serial PRIMARY KEY, ${Array.from({ length: 60 }, (_, i) => `c${i + 1} text`).join(', ')});
INSERT INTO wide (${Array.from({ length: 60 }, (_, i) => `c${i + 1}`).join(', ')}) SELECT ${Array.from({ length: 60 }, (_, i) => `'r' || g || 'c${i + 1}'`).join(', ')} FROM generate_series(1, 200) g;
CREATE VIEW cheap AS SELECT id, name FROM items WHERE price < 10;
CREATE SEQUENCE counter;
CREATE FUNCTION add1(x int) RETURNS int LANGUAGE sql AS 'SELECT x + 1';
CREATE SCHEMA shop; CREATE TABLE shop.orders (id int PRIMARY KEY, item int REFERENCES items(id), qty int);
ANALYZE;
`;

async function startServer(script, args = [], nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, script, ...args], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${script} did not start`)), 40000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${script} exited (${code})`)); });
    child.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
  return { ...info, stop: () => killTree(child.pid) };
}

let passed = 0;
const check = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); passed++; console.log(`ok - ${label}`); };

const root = scratchRoot('dbui');
const exportDir = join(root, 'export');
mkdirSync(exportDir, { recursive: true });
const pg = await startServer('scripts/pg-test-server.mjs', ['--sql', SEED]);
// The fake server's helper uses TypeScript parameter properties: Node needs the transform, not just type stripping.
const fake = await startServer('scripts/pg-fake-server.mjs', [], ['--experimental-transform-types', '--no-warnings']);
const ssh = await startTestServer();
let app;
const VK = { Enter: 13, Escape: 27, Tab: 9, Home: 36, End: 35, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Delete: 46, a: 65, c: 67 };
const CTRL = 2, SHIFT = 8;
try {
  const host = testHost(ssh.port);
  // No known host entry: the tunnel connection must ask about the host key and the SSH password.
  writeState(root, { ...sshState({ projectPath: join(root, 'project'), hosts: [host] }), snippetsOpen: false });
  app = await launchApp(root, { MC_DB_EXPORT_DIR: exportDir });
  const ev = app.evaluate;
  const key = async (k, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await app.cdp('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers, ...(k === 'Enter' && type === 'keyDown' && !modifiers ? { text: '\r' } : {}) });
    }
  };
  const clickText = (selector, text) => app.click(selector, text);
  const textOf = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const menu = (label) => ev(`(() => { const el = [...document.querySelectorAll('.ctx-menu button, .context-menu button, [role=menu] button, [role=menuitem]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!el) throw new Error('menu item not found: ' + ${JSON.stringify(label)}); el.click(); return true; })()`);
  const rowByText = (text) => `[...document.querySelectorAll('.db-row')].find((r) => r.querySelector('.db-name')?.textContent === ${JSON.stringify(text)})`;
  const contextOn = (expr) => ev(`(() => { const el = ${expr}; if (!el) throw new Error('no element'); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 20, clientY: b.top + 8 })); return true; })()`);
  const dbl = (expr) => ev(`(() => { const el = ${expr}; if (!el) throw new Error('no element'); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  const mouseDown = (expr, extra = '') => ev(`(() => { const el = ${expr}; if (!el) throw new Error('no element'); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ${extra} })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); return true; })()`);
  const cell = (row, col) => `document.querySelector('.db-tab:not([hidden]) .db-grid [aria-rowindex="${row + 2}"] .db-gcell[data-col="${col}"]')`;
  const gridCell = (row, col) => ev(`${cell(row, col)}?.textContent ?? null`);
  const typeCm = async (text) => {
    await ev(`(() => { const el = document.querySelector('.db-sql-editor .cm-content'); el.focus(); return true; })()`);
    await key('a', CTRL);
    await app.insertText(text);
  };

  // ── the panel and the connection form ──
  await app.click('#db-view');
  await app.until(`!!document.querySelector('.db-panel .db-empty')`, 'empty database panel');
  await app.screenshot('100-db-empty.png');
  // The empty panel has no + menu: its full-width button opens the PostgreSQL form.
  await app.click('.db-panel .db-empty .btn.primary');
  await app.until(`!!document.querySelector('.db-editor')`, 'connection form');
  await app.setValue('.db-editor [data-field=name]', 'local pg');
  await app.setValue('.db-editor [data-field=host]', '127.0.0.1');
  await app.setValue('.db-editor [data-field=port]', String(pg.port));
  await app.setValue('.db-editor [data-field=password]', 'secret-pw');
  await app.setValue('.db-editor [data-field=group]', 'Dev');
  await app.click('.db-editor [data-action=test]');
  await app.until(`!!document.querySelector('.db-editor .db-test')`, 'test result', 30000);
  check(await ev(`document.querySelector('.db-editor .db-test').dataset.test === 'ok'`), 'Testuj połączenie reports a working connection');
  await app.screenshot('100-db-form.png');
  // A wrong port: the error is shown inline in the form.
  await app.setValue('.db-editor [data-field=port]', '1');
  await app.click('.db-editor [data-action=test]');
  await app.until(`document.querySelector('.db-editor .db-test')?.dataset.test === 'error'`, 'test error', 30000);
  check((await textOf('.db-editor .db-test.error')).length > 5, 'a failing test shows its error in the form');
  await app.setValue('.db-editor [data-field=port]', String(pg.port));
  await app.click('.db-editor [data-action=save]');
  await app.until(`!document.querySelector('.db-editor')`, 'form closed');
  let state = {};
  for (let i = 0; i < 60 && !state.dbConnections?.length; i++) { await sleep(200); try { state = JSON.parse(readFileSync(join(root, 'data', 'state.json'), 'utf8')); } catch { /* being written */ } }
  check(state.dbConnections?.length === 1 && state.dbConnections[0].group === 'Dev' && !JSON.stringify(state).includes('secret-pw'), 'the connection is saved (group kept, no password in state.json)');
  const connId = state.dbConnections[0].id;

  // ── tree ──
  await app.until(`!!${rowByText('local pg')}`, 'connection row');
  await ev(`${rowByText('local pg')}.click()`);
  await app.until(`!!${rowByText('items')}`, 'tree shows the tables of public', 30000);
  check(await ev(`!!${rowByText('cheap')} === false && !!${rowByText('wide')}`), 'tables folder open, views folder folded');
  await ev(`[...document.querySelectorAll('.db-row.db-folder')].find((r) => r.textContent.includes('Widoki') && !r.textContent.includes('zmaterializowane'))?.click()`);
  await app.until(`!!${rowByText('cheap')}`, 'views folder opens');
  await ev(`(${rowByText('items')}).querySelector('.db-chev-hit').click()`);
  await app.until(`!!${rowByText('price')}`, 'columns of items');
  check(await ev(`${rowByText('id')}?.querySelector('.db-pk') !== null && ${rowByText('price')}.querySelector('.db-type').textContent.startsWith('numeric')`), 'columns with types and the primary key mark');
  await ev(`(() => { const el = document.querySelector('.db-filter'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'ord'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(`${rowByText('shop')}?.click()`);
  await app.until(`!!${rowByText('orders')} && !${rowByText('wide')}`, 'filter keeps only matching objects');
  check(true, 'the tree filter shows matching objects');
  await app.setValue('.db-filter', '');
  await app.until(`!!${rowByText('wide')}`, 'filter cleared');
  await app.screenshot('100-db-tree.png');
  await contextOn(rowByText('items'));
  await menu('Pokaż DDL');
  await app.until(`!!document.querySelector('.db-ddl-tab .cm-content') && document.querySelector('.db-ddl-tab .cm-content').textContent.includes('CREATE TABLE')`, 'DDL tab', 20000);
  check(true, 'Show DDL opens a read-only DDL tab');
  await app.screenshot('100-db-ddl.png');

  // ── table data ──
  await dbl(rowByText('items'));
  await app.until(`${cell(0, 1)}?.textContent === 'item 1'`, 'table data tab rows', 30000);
  check(await textOf('.db-table-tab [data-field=pageinfo]') === '1-100', 'the first page of 100 rows');
  check(await ev(`!!document.querySelector('.workspace-tabs .db-tab-strip.active .tab-host-tag')?.textContent.includes('local pg')`), 'the strip tab carries the connection name');
  check(await ev(`!!document.querySelector('.db-table-tab .db-null')`), 'NULL is shown distinctly');
  await app.screenshot('100-db-table.png');
  await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
  await app.until(`${cell(0, 0)}?.textContent === '1'`, 'sorted asc');
  await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
  await app.until(`${cell(0, 0)}?.textContent === '1500'`, 'sorted desc');
  check(true, 'sort by header click (ascending, descending)');
  await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
  await app.until(`${cell(0, 0)}?.textContent === '1'`, 'sort off');
  await app.setValue('.db-table-tab [data-field=where]', 'id <= 12 AND active');
  await key('Enter');
  await app.until(`document.querySelector('.db-table-tab [data-field=pageinfo]')?.textContent === '1-8'`, 'filtered rows', 20000);
  check(true, 'WHERE filter (8 rows)');
  const liveSessions = `window.mc.db.sessions().then((s) => s.sessions.filter((x) => x.state === 'connected').map((x) => x.id).sort().join(','))`;
  const sessionsBefore = await ev(liveSessions);
  await app.setValue('.db-table-tab [data-field=where]', 'nonsense_col > 1');
  await key('Enter');
  await app.until(`!!document.querySelector('.db-table-tab [data-field=error]')`, 'filter error');
  check((await textOf('.db-table-tab [data-field=error]')).includes('nonsense_col'), 'a bad filter shows the server error');
  await sleep(300);
  check(sessionsBefore !== '' && await ev(liveSessions) === sessionsBefore, 'a bad filter keeps the shared session connected (no reconnect)');
  await app.setValue('.db-table-tab [data-field=where]', '');
  await key('Enter');
  await app.until(`document.querySelector('.db-table-tab [data-field=pageinfo]')?.textContent === '1-100'`, 'filter cleared');
  await app.click('.db-table-tab [data-action=next-page]');
  await app.until(`document.querySelector('.db-table-tab [data-field=pageinfo]')?.textContent === '101-200' && ${cell(0, 0)}?.textContent === '101'`, 'second page');
  check(true, 'paging to the next page');
  await app.click('.db-table-tab [data-action=prev-page]');
  await app.until(`${cell(0, 0)}?.textContent === '1'`, 'back to the first page');

  // A NULL cell entered and left without typing stages nothing (never NULL -> '').
  await dbl(cell(4, 5));
  await app.until(`!!document.querySelector('.db-cell-editor input')`, 'editor on a NULL cell');
  check(await ev(`document.querySelector('.db-cell-editor input').dataset.state === 'null'`), 'the editor of a NULL cell shows NULL as its state');
  await ev(`document.querySelector('.db-cell-editor input').blur(), true`);
  await app.until(`!document.querySelector('.db-cell-editor')`, 'editor closed');
  check(!(await ev(`!!document.querySelector('.db-table-tab [data-field=pending]')`)) && await ev(`!!${cell(4, 5)}.querySelector('.db-null')`), 'leaving a NULL cell without typing stages nothing');
  // Edit a cell inline.
  await dbl(cell(0, 1));
  await app.until(`!!document.querySelector('.db-cell-editor input')`, 'cell editor');
  await app.setValue('.db-cell-editor input', 'renamed one');
  await key('Enter');
  await app.until(`${cell(0, 1)}?.classList.contains('changed') && ${cell(0, 1)}.textContent === 'renamed one'`, 'staged cell');
  // A type check: price is numeric.
  await dbl(cell(1, 2));
  await app.setValue('.db-cell-editor input', 'abc');
  await key('Enter');
  await app.until(`!!document.querySelector('.db-cell-error')`, 'type error');
  check(true, 'a numeric cell refuses text');
  await key('Escape');
  // Add a row.
  await app.click('.db-table-tab [data-action=add-row]');
  await app.until(`!!document.querySelector('.db-table-tab .db-grow.inserted')`, 'new row');
  const newRow = await ev(`Number(document.querySelector('.db-table-tab .db-grow.inserted').getAttribute('aria-rowindex')) - 2`);
  await dbl(cell(newRow, 0));
  await app.setValue('.db-cell-editor input', '5000');
  await key('Enter');
  await dbl(cell(newRow, 1));
  await app.setValue('.db-cell-editor input', 'brand new');
  await key('Enter');
  await app.screenshot('100-db-new-row.png');
  // Delete the fourth row (id 4).
  await ev(`(() => { const g = document.querySelector('.db-table-tab .db-grid'); g.scrollTop = 0; g.dispatchEvent(new Event('scroll')); return true; })()`);
  await app.until(`!!document.querySelector('.db-table-tab .db-grid [aria-rowindex="5"] .db-rn')`, 'top rows again');
  await mouseDown(`document.querySelector('.db-table-tab .db-grid [aria-rowindex="5"] .db-rn')`);
  await app.click('.db-table-tab [data-action=delete-rows]');
  await app.until(`document.querySelector('.db-table-tab .db-grid [aria-rowindex="5"]')?.classList.contains('deleted')`, 'row marked deleted');
  check((await textOf('.db-table-tab [data-field=pending]')).includes('3'), 'three staged changes (edit, insert, delete)');
  check(await ev(`document.querySelector('.workspace-tabs .db-tab-strip.active .file-dirty') !== null`), 'the tab shows unsaved changes');
  await app.screenshot('100-db-staged.png');
  await app.click('.db-table-tab [data-action=show-sql]');
  await app.until(`!!document.querySelector('.db-preview-sql')`, 'SQL preview');
  const preview = await textOf('.db-preview-sql');
  check(preview.startsWith('BEGIN;') && preview.includes(`UPDATE "public"."items" SET "name" = 'renamed one' WHERE "id" = '1' AND ("name" IS NOT NULL AND format('%s', "name") = format('%s', 'item 1'::text));`) && preview.includes(`DELETE FROM "public"."items" WHERE "id" = '4'`) && preview.includes(`format('%s', "active") = format('%s', 't'::boolean)`) && preview.includes('INSERT INTO "public"."items"') && preview.trim().endsWith('COMMIT;'), 'Pokaż SQL shows the transaction');
  await app.screenshot('100-db-preview.png');
  await clickText('.db-preview .modal-foot .btn.primary');
  await app.click('.db-table-tab [data-action=save]');
  await app.until(`!!document.querySelector('.db-table-tab .db-notice, .db-table-tab [data-field=error]')`, 'saved', 20000);
  if (await ev(`!!document.querySelector('.db-table-tab [data-field=error]')`)) throw new Error(await textOf('.db-table-tab [data-field=error]'));
  check((await textOf('.db-table-tab .db-notice')).includes('3') && await gridCell(0, 1) === 'renamed one' && !(await ev(`!!document.querySelector('.db-table-tab [data-field=pending]')`)), 'Zapisz zmiany applies the staged edits');

  // Conflict: a staged edit of a row deleted meanwhile (from a SQL tab).
  await dbl(cell(1, 1));
  await app.setValue('.db-cell-editor input', 'will conflict');
  await key('Enter');
  await app.until(`${cell(1, 1)}?.classList.contains('changed')`, 'staged for conflict');
  const conflictTab = await ev(`(() => { const st = window.__mc.useFileStore.getState(); return st.activeFileId; })()`);
  await contextOn(rowByText('local pg'));
  await menu('Nowy edytor SQL');
  await app.until(`!!document.querySelector('.db-sql-tab .cm-content')`, 'SQL tab');
  await typeCm('DELETE FROM items WHERE id = 2');
  await key('Enter', CTRL);
  await app.until(`!!document.querySelector('.db-sql-tab [data-field=affected]') || [...document.querySelectorAll('.db-sql-tab .db-msg')].some((m) => m.textContent.includes('DELETE'))`, 'delete ran', 20000);
  check(true, 'Ctrl+Enter runs the statement under the cursor');
  await ev(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip')].find((t) => t.querySelector('.label').textContent === 'items' && !t.querySelector('.tab-diff-tag')).click()`);
  await app.until(`!!document.querySelector('.db-table-tab [data-action=save]')`, 'back on the table');
  await app.click('.db-table-tab [data-action=save]');
  await app.until(`!!document.querySelector('.db-table-tab [data-field=error]')`, 'conflict error', 20000);
  const conflictText = await textOf('.db-table-tab [data-field=error]');
  check(conflictText.includes('id = 2') && conflictText.includes('nic nie zapisano'), 'a conflict names the row and saves nothing');
  check(await ev(`document.querySelector('.db-table-tab .db-grid [aria-rowindex="3"]')?.classList.contains('conflict')`), 'the conflicting row is highlighted');
  await app.screenshot('100-db-conflict.png');
  await app.click('.db-table-tab [data-action=discard]');
  await app.until(`!!document.querySelector('.modal .modal-foot')`, 'discard asks');
  await clickText('.modal .modal-foot .btn', 'Cofnij zmiany');
  await app.until(`!document.querySelector('.db-table-tab [data-field=pending]')`, 'discarded');
  check(conflictTab !== null, 'Cofnij zmiany drops the staged edits');

  // Wide table: columns are windowed.
  await dbl(rowByText('wide'));
  await app.until(`!!document.querySelector('.db-table-tab .db-hcell[data-col="c1"]')`, 'wide table', 20000);
  const shownCols = await ev(`document.querySelectorAll('.db-table-tab .db-ghead .db-hcell').length`);
  check(shownCols > 3 && shownCols < 40, `wide table renders only the visible columns (${shownCols} of 61)`);
  await ev(`(() => { const g = document.querySelector('.db-table-tab .db-grid'); g.scrollLeft = g.scrollWidth; g.dispatchEvent(new Event('scroll')); return true; })()`);
  await app.until(`!!document.querySelector('.db-table-tab .db-hcell[data-col="c60"]')`, 'last column after scrolling');
  check(true, 'horizontal scrolling brings in the last column');
  await app.screenshot('100-db-wide.png');

  // A table without a key is read-only with a note.
  await dbl(rowByText('nokey'));
  await app.until(`!!document.querySelector('.db-table-tab [data-field=readonly-note]')`, 'no key note', 20000);
  check(!(await ev(`!!document.querySelector('.db-table-tab [data-action=add-row]')`)), 'a table without a key is read-only with a note');

  // ── SQL editor ──
  await ev(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip')].find((t) => t.querySelector('.label').textContent.startsWith('SQL')).click()`);
  await app.until(`!!document.querySelector('.db-sql-tab .cm-content')`, 'SQL tab again');
  await typeCm('SELECT id, name FROM items ORDER BY id LIMIT 5;\nSELECT 42 AS answer;\nUPDATE items SET note = note WHERE id < 4;');
  // Selection: the second line only.
  await ev(`(() => { const el = document.querySelector('.db-sql-tab .cm-content'); el.focus(); return true; })()`);
  await key('Home', CTRL);
  await key('ArrowDown');
  await key('Home');
  await key('End', SHIFT);
  await app.click('.db-sql-tab [data-action=run]');
  await app.until(`!${'false'} && document.querySelectorAll('.db-sql-tab .db-result-tab').length === 2 && ${cell(0, 0)}?.textContent === '42'`, 'selection result', 20000);
  check(true, 'Run with a selection runs only the selected text');
  await key('Enter', CTRL | SHIFT);
  await app.until(`document.querySelectorAll('.db-sql-tab .db-result-tab').length === 4`, 'script results', 20000);
  check(await ev(`document.querySelector('.db-sql-tab .db-result-tab.on').textContent.includes('5')`) && await gridCell(0, 1) === 'renamed one', 'Ctrl+Shift+Enter runs the script: several result sets');
  await clickText('.db-sql-tab .db-result-tab', 'Wynik 3');
  await app.until(`(document.querySelector('.db-sql-tab [data-field=affected]')?.textContent ?? '').includes('UPDATE')`, 'affected rows');
  check((await textOf('.db-sql-tab [data-field=affected]')).includes('2'), 'rows affected of the UPDATE (2: id 2 was deleted)');
  await app.screenshot('100-db-sql.png');
  // Load more.
  await typeCm('SELECT g, md5(g::text) FROM generate_series(1, 2500) g');
  await key('Enter', CTRL);
  await app.until(`(document.querySelector('.db-sql-tab [data-field=result-rows]')?.textContent ?? '').startsWith('1000')`, 'capped at 1000', 20000);
  await app.click('.db-sql-tab [data-action=load-more]');
  await app.until(`(document.querySelector('.db-sql-tab [data-field=result-rows]')?.textContent ?? '').startsWith('2000')`, 'load more', 20000);
  check(true, 'results are capped at 1000 rows and "Wczytaj więcej" loads the next 1000');
  // Export CSV.
  await ev(`[...document.querySelectorAll('.db-sql-tab .db-result-foot .btn')].find((b) => b.textContent === 'Eksport').click()`);
  await menu('CSV');
  await app.until(`(() => true)()`, 'export');
  let exported = null;
  for (let i = 0; i < 50 && !exported; i++) { await sleep(150); const f = join(exportDir, 'SQL 1.csv'); if (existsSync(f)) exported = readFileSync(f, 'utf8'); }
  check(!!exported && exported.split('\r\n').length === 2002 && exported.startsWith('g,md5'), 'export CSV writes the loaded result to a file');
  // Error with position.
  await typeCm('SELECT nope FROM items');
  await key('Enter', CTRL);
  await app.until(`!!document.querySelector('.db-sql-tab .db-msg.error')`, 'query error', 20000);
  check((await ev(`document.querySelector('.db-sql-tab .db-msg.error').textContent`)).includes('nope') && await ev(`!!document.querySelector('.db-sql-tab .cm-db-error')`), 'a server error is shown and marked in the editor');
  // Transaction mode.
  await ev(`document.querySelector('.db-sql-tab [data-field=txmode]').click()`);
  await app.until(`!!document.querySelector('.db-sql-tab [data-field=tx]')`, 'transaction open', 20000);
  await typeCm(`INSERT INTO items (id, name) VALUES (7777, 'in tx')`);
  await key('Enter', CTRL);
  await app.until(`[...document.querySelectorAll('.db-sql-tab .db-msg')].some((m) => m.textContent.includes('INSERT'))`, 'insert in tx', 20000);
  check((await textOf('.db-sql-tab [data-field=tx]')) === 'transakcja otwarta', 'the transaction mode shows "transakcja otwarta"');
  await app.screenshot('100-db-transaction.png');
  await app.click('.db-sql-tab [data-action=rollback]');
  await app.until(`!document.querySelector('.db-sql-tab [data-field=tx]')`, 'rolled back', 20000);
  await typeCm('SELECT count(*) FROM items WHERE id = 7777');
  await key('Enter', CTRL);
  await app.until(`${cell(0, 0)}?.textContent === '0'`, 'rollback undid the insert', 20000);
  check(true, 'ROLLBACK undoes the insert');
  // COMMIT typed in the script ends the transaction: the toggle follows the session.
  await ev(`document.querySelector('.db-sql-tab [data-field=txmode]').click()`);
  await app.until(`!!document.querySelector('.db-sql-tab [data-field=tx]') && document.querySelector('.db-sql-tab [data-field=txmode]').checked`, 'transaction open again', 20000);
  await typeCm('COMMIT');
  await key('Enter', CTRL);
  await app.until(`!document.querySelector('.db-sql-tab [data-field=tx]') && !document.querySelector('.db-sql-tab [data-field=txmode]').checked`, 'toggle off after a typed COMMIT', 20000);
  check(true, 'a COMMIT typed in the script turns the transaction toggle off');
  // "Rozłącz" with an open transaction in a SQL tab asks first.
  await ev(`document.querySelector('.db-sql-tab [data-field=txmode]').click()`);
  await app.until(`!!document.querySelector('.db-sql-tab [data-field=tx]')`, 'transaction for the disconnect question', 20000);
  await contextOn(rowByText('local pg'));
  await menu('Rozłącz');
  await app.until(`!!document.querySelector('.modal .modal-foot')`, 'disconnect asks');
  check((await textOf('.modal')).includes('Otwarte transakcje: 1'), 'disconnecting with an open transaction asks and counts it');
  await app.screenshot('100-db-disconnect-asks.png');
  await clickText('.modal .modal-foot .btn', 'Anuluj');
  await app.click('.db-sql-tab [data-action=rollback]');
  await app.until(`!document.querySelector('.db-sql-tab [data-field=tx]')`, 'rolled back after the question', 20000);

  // ── read-only connection ──
  const ro = await ev(`window.mc.db.saveConnection({ kind: 'postgres', name: 'pg read-only', color: '#f59e0b', host: '127.0.0.1', port: ${pg.port}, user: 'postgres', database: 'postgres', tls: 'disable', ssh: null, readOnly: true }, { keep: true })`);
  check(ro.ok, 'a read-only connection is saved');
  await app.until(`!!${rowByText('pg read-only')}`, 'read-only connection row');
  // Fold the first connection's tree (its session stays), then open the read-only one.
  await ev(`${rowByText('local pg')}.click()`);
  await app.until(`!${rowByText('items')}`, 'first tree folded');
  await ev(`${rowByText('pg read-only')}.click()`);
  await app.until(`!!${rowByText('items')}`, 'read-only tree', 30000);
  await dbl(rowByText('items'));
  await app.until(`(document.querySelector('.db-table-tab [data-field=readonly-note]')?.textContent ?? '').includes('tylko do odczytu')`, 'read-only table', 20000);
  check(true, 'a read-only connection opens tables read-only with a note');
  check(await ev(`!!document.querySelector('.db-table-tab [data-field=ro]')`), 'the RO badge comes from the session');
  await contextOn(rowByText('pg read-only'));
  await menu('Nowy edytor SQL');
  await app.until(`!!document.querySelector('.db-sql-tab .cm-content')`, 'read-only SQL tab');
  await typeCm(`DELETE FROM items WHERE id = 10`);
  await key('Enter', CTRL);
  await app.until(`!!document.querySelector('.db-sql-tab .db-msg.error, .db-sql-tab [data-field=result-error]')`, 'read-only refusal', 20000);
  check((await ev(`document.querySelector('.db-sql-tab .db-msg.error, .db-sql-tab [data-field=result-error]').textContent`)).includes('tylko do odczytu'), 'a read-only connection refuses a DELETE');
  await app.screenshot('100-db-readonly.png');

  // ── cancel (fake server: its pg_sleep can be cancelled) ──
  const fc = await ev(`window.mc.db.saveConnection({ kind: 'postgres', name: 'fake pg', host: '127.0.0.1', port: ${fake.port}, user: 'postgres', database: 'postgres', tls: 'disable', ssh: null, readOnly: false }, { keep: true })`);
  check(fc.ok, 'the fake server connection is saved');
  await app.until(`!!${rowByText('fake pg')}`, 'fake row');
  await contextOn(rowByText('fake pg'));
  await menu('Nowy edytor SQL');
  await app.until(`!!document.querySelector('.db-sql-tab .cm-content')`, 'fake SQL tab');
  await typeCm('SELECT pg_sleep(30)');
  await key('Enter', CTRL);
  await app.until(`!document.querySelector('.db-sql-tab [data-action=cancel]').disabled`, 'running', 20000);
  await sleep(500);
  await app.click('.db-sql-tab [data-action=cancel]');
  await app.until(`document.querySelector('.db-sql-tab [data-action=cancel]').disabled`, 'cancelled', 15000);
  check(await ev(`[...document.querySelectorAll('.db-sql-tab .db-msg')].some((m) => m.classList.contains('error'))`), 'Anuluj stops a running query');

  // ── via SSH with the prompts ──
  await app.click('.db-panel [data-action="new-connection"]');
  await menu('PostgreSQL');
  await app.until(`!!document.querySelector('.db-editor')`, 'form for the tunnel');
  await app.setValue('.db-editor [data-field=name]', 'pg via ssh');
  await ev(`document.querySelector('.db-editor button[aria-label="Połącz przez SSH"]').click()`);
  await app.until(`!!document.querySelector('.select-popup [role=option], [role=listbox] [role=option]')`, 'host options');
  await ev(`[...document.querySelectorAll('[role=option]')].find((o) => o.textContent.includes('test-server')).click()`);
  await app.until(`!!document.querySelector('.db-editor [data-field=sshDbHost]')`, 'tunnel fields');
  check(await ev(`document.querySelector('.db-editor [data-field=sshDbHost]').value === '127.0.0.1' && document.querySelector('.db-editor [data-field=sshDbPort]').value === '5432'`), 'the tunnel defaults to 127.0.0.1 and the default port');
  await app.setValue('.db-editor [data-field=sshDbPort]', String(pg.port));
  await app.screenshot('100-db-form-ssh.png');
  await app.click('.db-editor [data-action=save]');
  await app.until(`!document.querySelector('.db-editor')`, 'tunnel form closed');
  await app.until(`!!${rowByText('pg via ssh')}`, 'tunnel row');
  await ev(`${rowByText('pg read-only')}.click()`);
  await app.until(`!${rowByText('items')}`, 'read-only tree folded');
  await ev(`${rowByText('pg via ssh')}.click()`);
  await app.until(`!!document.querySelector('.db-panel-login .ssh-prompt')`, 'host key prompt', 30000);
  check((await textOf('.db-panel-login')).includes(ssh.fingerprint.slice(0, 20)), 'the SSH host key question appears in the panel');
  await app.screenshot('100-db-ssh-hostkey.png');
  await clickText('.db-panel-login .btn', 'Zaufaj i zapisz');
  await app.until(`!!document.querySelector('.db-panel-login input[type=password]')`, 'SSH password prompt', 30000);
  await app.setValue('.db-panel-login input[type=password]', ssh.password);
  await app.click('.db-panel-login button[type=submit]');
  await app.until(`!!${rowByText('items')}`, 'tree through the tunnel', 30000);
  check(true, 'the tunnel connection logs in through the prompts and shows its tree');
  await app.screenshot('100-db-tunnel-tree.png');

  // ── drafts across a reload ──
  await ev(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip')].find((t) => t.querySelector('.label').textContent === 'items' && !t.querySelector('.tab-diff-tag')).click()`);
  await app.until(`${cell(0, 1)}?.textContent === 'renamed one'`, 'items tab');
  await dbl(cell(0, 1));
  await app.setValue('.db-cell-editor input', 'draft value');
  await key('Enter');
  await app.until(`${cell(0, 1)}?.classList.contains('changed')`, 'draft staged');
  const sqlName = await ev(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip .label')].map((l) => l.textContent).find((n) => n.startsWith('SQL'))`);
  await sleep(1200);
  await ev('location.reload(), true').catch(() => undefined);
  await sleep(1500);
  await app.until(`!!document.querySelector('.app .workspace-tabs')`, 'reloaded', 30000);
  await app.until(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip')].some((t) => t.querySelector('.label').textContent === 'items' && t.querySelector('.file-dirty'))`, 'table draft after reload', 20000);
  check(await ev(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip .label')].some((l) => l.textContent === ${JSON.stringify(sqlName)})`), 'the SQL draft and the staged edits survive a reload');
  await ev(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip')].find((t) => t.querySelector('.label').textContent === 'items' && !t.querySelector('.tab-diff-tag')).click()`);
  await app.until(`${cell(0, 1)}?.textContent === 'draft value'`, 'staged value shown after reload', 30000);
  check(true, 'the restored staged edit shows on its row');
  // Closing the tab with staged edits asks.
  await ev(`[...document.querySelectorAll('.workspace-tabs .db-tab-strip')].find((t) => t.querySelector('.label').textContent === 'items' && !t.querySelector('.tab-diff-tag')).querySelector('.x').click()`);
  await app.until(`!!document.querySelector('.modal .modal-foot')`, 'close asks');
  check((await textOf('.modal')).includes('items'), 'closing a tab with staged edits asks');
  await app.screenshot('100-db-close-asks.png');
  await clickText('.modal .modal-foot .btn', 'Anuluj');
  console.log(`DB Postgres UI check passed (${passed} checks)`);
} catch (error) {
  // What the window showed when a step failed.
  try {
    await app?.screenshot('100-db-failure.png');
    console.log(await app?.evaluate(`JSON.stringify({ text: document.querySelector('.db-tab')?.innerText?.slice(0, 600), tabs: [...document.querySelectorAll('.workspace-tabs .tab .label')].map((l) => l.textContent) })`));
  } catch { /* the window is gone */ }
  throw error;
} finally {
  await app?.close();
  pg.stop();
  fake.stop();
  ssh.stop();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a locked file stays until the next run */ }
}
