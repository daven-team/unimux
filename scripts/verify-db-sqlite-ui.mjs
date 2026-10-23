// Real-app check of SQLite connections and the SQL query history (1.0.6): the built app with a scratch data dir and home.
// Creates a SQLite connection from the empty panel's link with a typed path of a file that does not exist yet (Testuj
// połączenie offers to create it), opens a prepared database file from the + menu, then runs the tree (tables, views,
// indexes, triggers, columns), table data (sort, WHERE, edit, Pokaż SQL, save: checked in the file itself), DDL, the SQL
// editor (script, error underline, load more, cancel) and the History panel (search, star, insert, double-click run,
// clear, the file in the data dir). Screenshots: D:\Projekty\_shots\106-sqlite-*.png. Run `npm run build` first.
// Never touches the user's data dir; kills only the PIDs it started.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

let passed = 0;
const check = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); passed++; console.log(`ok - ${label}`); };

const root = scratchRoot('sqliteui');
const shopFile = join(root, 'shop.sqlite');
const newFile = join(root, 'new-empty.sqlite');
{
  const db = new DatabaseSync(shopFile);
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, note TEXT, raw BLOB);
    CREATE TABLE notes (body TEXT, n);
    CREATE INDEX items_by_name ON items(name);
    CREATE VIEW cheap AS SELECT id, name FROM items WHERE price < 10;
    WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 300)
      INSERT INTO items SELECT n, 'item ' || n, n * 1.5, CASE WHEN n % 5 = 0 THEN NULL ELSE 'note ' || n END, CASE WHEN n = 1 THEN x'00ff' END FROM s;
    INSERT INTO notes VALUES ('first', 1), ('second', '2');
    CREATE TRIGGER items_touch AFTER UPDATE ON items BEGIN INSERT INTO notes VALUES ('touched ' || NEW.id, NEW.id); END;
  `);
  db.close();
}

let app;
const VK = { Enter: 13, Escape: 27, Backspace: 8, a: 65 };
const CTRL = 2, SHIFT = 8;
try {
  writeState(root, { ...sshState({ projectPath: join(root, 'project') }), snippetsOpen: false });
  app = await launchApp(root);
  const ev = app.evaluate;
  const key = async (k, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await app.cdp('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: VK[k] ?? 0, modifiers, ...(k === 'Enter' && type === 'keyDown' && !modifiers ? { text: '\r' } : {}) });
    }
  };
  const textOf = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const menu = (label) => ev(`(() => { const el = [...document.querySelectorAll('.ctx-menu button, .context-menu button, [role=menu] button, [role=menuitem]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!el) throw new Error('menu item not found: ' + ${JSON.stringify(label)}); el.click(); return true; })()`);
  const rowByText = (text) => `[...document.querySelectorAll('.db-row')].find((r) => r.querySelector('.db-name')?.textContent === ${JSON.stringify(text)})`;
  const contextOn = (expr) => ev(`(() => { const el = ${expr}; if (!el) throw new Error('no element'); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 20, clientY: b.top + 8 })); return true; })()`);
  const dbl = (expr) => ev(`(() => { const el = ${expr}; if (!el) throw new Error('no element'); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  const cell = (row, col) => `document.querySelector('.db-tab:not([hidden]) .db-grid [aria-rowindex="${row + 2}"] .db-gcell[data-col="${col}"]')`;
  const typeCm = async (text) => {
    await ev(`(() => { const el = document.querySelector('.db-tab:not([hidden]) .db-sql-editor .cm-content'); el.focus(); return true; })()`);
    await key('a', CTRL);
    if (text) await app.insertText(text); else await key('Backspace');
  };
  const readState = async (count) => {
    let state = {};
    for (let i = 0; i < 60 && (state.dbConnections?.length ?? 0) < count; i++) { await sleep(200); try { state = JSON.parse(readFileSync(join(root, 'data', 'state.json'), 'utf8')); } catch { /* being written */ } }
    return state;
  };

  // ── a new file from the empty panel ──
  await app.click('#db-view');
  await app.until(`!!document.querySelector('.db-panel .db-empty')`, 'empty database panel');
  check((await textOf('.db-panel .db-empty')).includes('SQLite'), 'the empty panel offers SQLite');
  await ev(`[...document.querySelectorAll('.db-panel .db-empty a, .db-panel .db-empty [role=link], .db-panel .db-empty button')].find((e) => e.textContent === 'SQLite').click()`);
  await app.until(`!!document.querySelector('.db-editor [data-field=path]')`, 'SQLite form');
  check(await ev(`!document.querySelector('.db-editor [data-field=host]') && !document.querySelector('.db-editor [data-field=password]')`), 'the SQLite form has no host, user or password');
  await app.setValue('.db-editor [data-field=path]', newFile);
  await app.screenshot('106-sqlite-form.png');
  await app.click('.db-editor [data-action=test]');
  await app.until(`document.querySelector('.db-editor .db-test')?.dataset.test === 'error'`, 'test error', 30000);
  check((await textOf('.db-editor .db-test.error')).includes('Nie znaleziono pliku bazy'), 'Testuj połączenie of a missing file says so');
  await app.screenshot('106-sqlite-form-missing.png');
  await app.click('.db-editor [data-action=sqlite-create]');
  await app.until(`document.querySelector('.db-editor .db-test')?.dataset.test === 'ok'`, 'test ok after create', 30000);
  check(existsSync(newFile) && (await textOf('.db-editor .db-test.ok')).includes('SQLite 3.'), 'Utwórz pusty plik bazy creates the file and the test then works');
  await app.screenshot('106-sqlite-form-created.png');
  await app.click('.db-editor [data-action=save]');
  await app.until(`!document.querySelector('.db-editor')`, 'form closed');
  const first = (await readState(1)).dbConnections?.[0];
  check(first?.kind === 'sqlite' && first.path === newFile && first.name === 'new-empty.sqlite', 'the connection is saved with its path and the file name as its name');
  await app.until(`!!${rowByText('new-empty.sqlite')}?.querySelector('.db-kind-icon.sqlite')`, 'SQLite icon');
  check(true, 'the tree shows the SQLite feather');

  // ── the prepared file from the + menu ──
  await app.click('.db-panel [data-action=new-connection]');
  await menu('SQLite');
  await app.until(`!!document.querySelector('.db-editor [data-field=path]')`, 'SQLite form');
  await app.setValue('.db-editor [data-field=name]', 'shop');
  await app.setValue('.db-editor [data-field=path]', shopFile);
  await app.click('.db-editor [data-action=save]');
  await app.until(`!document.querySelector('.db-editor')`, 'form closed');
  await readState(2);
  await app.until(`!!${rowByText('shop')}`, 'shop row');
  await ev(`${rowByText('shop')}.click()`);
  await app.until(`!!${rowByText('items')} && !!${rowByText('notes')}`, 'tables under the connection', 30000);
  check(!(await ev(`!!${rowByText('main')}`)), 'the objects sit right under the connection (no database level)');
  for (const folder of ['Widoki', 'Indeksy', 'Wyzwalacze']) await ev(`[...document.querySelectorAll('.db-row.db-folder')].find((r) => r.textContent.includes(${JSON.stringify(folder)}))?.click()`);
  await app.until(`!!${rowByText('cheap')} && !!${rowByText('items_by_name')} && !!${rowByText('items_touch')}`, 'views, indexes and triggers');
  check(await ev(`${rowByText('items_touch')}.textContent.includes('AFTER UPDATE')`), 'a trigger shows its table and timing');
  await ev(`(${rowByText('items')}).querySelector('.db-chev-hit').click()`);
  await app.until(`!!${rowByText('price')}`, 'columns of items');
  check(await ev(`${rowByText('id')}?.querySelector('.db-pk') !== null && ${rowByText('price')}.querySelector('.db-type').textContent.startsWith('REAL')`), 'columns with their declared types and the primary key');
  await app.screenshot('106-sqlite-tree.png');
  await dbl(rowByText('items_touch'));
  await app.until(`!!document.querySelector('.db-ddl-tab .cm-content') && document.querySelector('.db-ddl-tab .cm-content').textContent.includes('CREATE TRIGGER items_touch')`, 'trigger DDL', 20000);
  check(true, 'a trigger opens its DDL');
  await app.screenshot('106-sqlite-ddl.png');

  // ── table data ──
  await dbl(rowByText('items'));
  await app.until(`${cell(0, 1)}?.textContent === 'item 1'`, 'table rows', 30000);
  check(await textOf('.db-table-tab [data-field=pageinfo]') === '1-100' && await ev(`${cell(0, 4)}?.textContent === '\\\\x00ff'`), 'the first page, bytes as hex');
  await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
  await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
  await app.until(`${cell(0, 0)}?.textContent === '300'`, 'sorted desc');
  await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
  await app.until(`${cell(0, 0)}?.textContent === '1'`, 'sort off');
  await app.setValue('.db-table-tab [data-field=where]', 'id <= 12 AND note IS NOT NULL');
  await key('Enter');
  await app.until(`document.querySelector('.db-table-tab [data-field=pageinfo]')?.textContent === '1-10'`, 'filtered rows', 20000);
  check(true, 'sort and WHERE filter');
  await app.setValue('.db-table-tab [data-field=where]', '');
  await key('Enter');
  await app.until(`document.querySelector('.db-table-tab [data-field=pageinfo]')?.textContent === '1-100'`, 'filter cleared');
  await dbl(cell(0, 1));
  await app.until(`!!document.querySelector('.db-cell-editor input')`, 'cell editor');
  await app.setValue('.db-cell-editor input', 'renamed ąę');
  await key('Enter');
  await app.until(`${cell(0, 1)}?.classList.contains('changed')`, 'staged cell');
  await app.click('.db-table-tab [data-action=show-sql]');
  await app.until(`!!document.querySelector('.db-preview-sql')`, 'SQL preview');
  const preview = await textOf('.db-preview-sql');
  check(preview.startsWith('BEGIN;') && preview.includes(`UPDATE "main"."items" SET "name" = 'renamed ąę' WHERE "id" = 1 AND ("name" IS 'item 1')`), 'Pokaż SQL shows the bound values written in');
  await app.screenshot('106-sqlite-preview.png');
  await app.click('.db-preview .modal-foot .btn.primary');
  await app.until(`!!document.querySelector('.db-table-tab .db-notice, .db-table-tab [data-field=error]')`, 'saved', 20000);
  if (await ev(`!!document.querySelector('.db-table-tab [data-field=error]')`)) throw new Error(await textOf('.db-table-tab [data-field=error]'));
  check(await ev(`${cell(0, 1)}?.textContent === 'renamed ąę'`), 'Zapisz zmiany applies the edit');
  {
    const check2 = new DatabaseSync(shopFile, { readOnly: true });
    const row = check2.prepare('SELECT name FROM items WHERE id = 1').get();
    const touched = check2.prepare("SELECT count(*) AS n FROM notes WHERE body = 'touched 1'").get();
    check2.close();
    check(row?.name === 'renamed ąę' && touched?.n === 1, 'the file has the new value (and the trigger ran)');
  }
  await app.screenshot('106-sqlite-table.png');
  // A table without a primary key is edited by its rowid.
  await dbl(rowByText('notes'));
  await app.until(`${cell(0, 1)}?.textContent === 'first'`, 'notes rows', 20000);
  check(await ev(`document.querySelector('.db-table-tab:not([hidden]) .db-hcell[data-col="rowid"]') !== null && !document.querySelector('.db-table-tab:not([hidden]) [data-field=readonly-note]')`), 'a table without a key shows its rowid and can be edited');

  // ── SQL editor ──
  await contextOn(rowByText('shop'));
  await menu('Nowy edytor SQL');
  await app.until(`!!document.querySelector('.db-tab:not([hidden]) .db-sql-editor .cm-content')`, 'SQL tab');
  await typeCm("SELECT id, name FROM items ORDER BY id LIMIT 3;\nSELECT 'a;b' AS s, sqlite_version() AS v;\nUPDATE items SET note = note WHERE id < 4;");
  await key('Enter', CTRL | SHIFT);
  await app.until(`document.querySelectorAll('.db-tab:not([hidden]) .db-result-tab').length === 4`, 'script results', 20000);
  check(await ev(`${cell(0, 1)}?.textContent === 'renamed ąę'`), 'a script runs as three statements');
  await app.screenshot('106-sqlite-sql.png');
  await typeCm('SELECT *\nFRM items');
  await key('Enter', CTRL);
  await app.until(`!!document.querySelector('.db-tab:not([hidden]) .cm-db-error')`, 'error underline', 20000);
  check(await ev(`document.querySelector('.db-tab:not([hidden]) .cm-db-error').textContent === 'FRM'`), 'a syntax error underlines the word SQLite names');
  await app.screenshot('106-sqlite-error.png');
  await typeCm('WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 5000) SELECT n FROM s');
  await key('Enter', CTRL);
  await app.until(`(document.querySelector('.db-tab:not([hidden]) [data-field=result-rows]')?.textContent ?? '').startsWith('1000')`, 'capped at 1000', 30000);
  await app.click('.db-tab:not([hidden]) [data-action=load-more]');
  await app.until(`(document.querySelector('.db-tab:not([hidden]) [data-field=result-rows]')?.textContent ?? '').startsWith('2000')`, 'load more', 30000);
  check(true, 'results stop at 1000 rows and load the next 1000');
  await typeCm('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 500000000) SELECT count(*) FROM c');
  await key('Enter', CTRL);
  await app.until(`document.querySelector('.db-tab:not([hidden]) [data-action=cancel]')?.disabled === false`, 'running', 20000);
  await sleep(700);
  await app.click('.db-tab:not([hidden]) [data-action=cancel]');
  await app.until(`document.querySelector('.db-tab:not([hidden]) [data-action=cancel]')?.disabled === true`, 'cancelled', 20000);
  check(/anulowan/i.test(await textOf('.db-tab:not([hidden])')), 'Anuluj stops a statement stuck in one SQLite step');
  await typeCm('SELECT count(*) FROM items');
  await key('Enter', CTRL);
  await app.until(`${cell(0, 0)}?.textContent === '300'`, 'session works after cancel', 20000);
  check(true, 'the session goes on after the cancel');
  await app.screenshot('106-sqlite-after-cancel.png');

  // ── history ──
  await app.click('.db-tab:not([hidden]) [data-action=history]');
  await app.until(`document.querySelectorAll('.db-tab:not([hidden]) .db-history-item').length >= 6`, 'history entries', 20000);
  const entries = await ev(`[...document.querySelectorAll('.db-tab:not([hidden]) .db-history-item .db-history-sql')].map((e) => e.textContent)`);
  check(entries[0] === 'SELECT count(*) FROM items' && entries.includes("SELECT 'a;b' AS s, sqlite_version() AS v"), 'the History panel lists every statement, newest first');
  check(await ev(`[...document.querySelectorAll('.db-tab:not([hidden]) .db-history-item')].some((e) => e.classList.contains('error') && e.textContent.includes('syntax error'))`), 'a failed statement shows its error');
  await app.screenshot('106-sqlite-history.png');
  await app.setValue('.db-tab:not([hidden]) [data-field=history-search]', 'a;b');
  await app.until(`document.querySelectorAll('.db-tab:not([hidden]) .db-history-item').length === 1`, 'search');
  check(true, 'search narrows the history');
  await ev(`document.querySelector('.db-tab:not([hidden]) .db-history-item .db-history-star').click()`);
  await app.until(`!!document.querySelector('.db-tab:not([hidden]) .db-history-star.on')`, 'starred');
  await app.setValue('.db-tab:not([hidden]) [data-field=history-search]', '');
  await typeCm('');
  await ev(`(() => { const el = [...document.querySelectorAll('.db-tab:not([hidden]) .db-history-item')].find((e) => e.textContent.includes('LIMIT 3')); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); return true; })()`);
  await app.until(`document.querySelector('.db-tab:not([hidden]) .db-sql-editor .cm-content').textContent.includes('LIMIT 3')`, 'inserted');
  check(true, 'a click puts the statement into the editor');
  await ev(`(() => { const el = [...document.querySelectorAll('.db-tab:not([hidden]) .db-history-item')].find((e) => e.textContent.includes('LIMIT 3')); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); return true; })()`);
  await app.until(`document.querySelectorAll('.db-tab:not([hidden]) .db-history-item').length >= 8 && document.querySelector('.db-tab:not([hidden]) .db-history-item .db-history-sql').textContent.includes('LIMIT 3')`, 'double click ran it', 20000);
  const editorText = await textOf('.db-tab:not([hidden]) .db-sql-editor .cm-content');
  // Its first click put it there again over the selected copy (a selection is replaced): one copy, and it ran.
  check((editorText.match(/LIMIT 3/g) ?? []).length === 1, 'a double click runs the statement it put into the editor');
  check(await ev(`!!document.querySelector('.db-tab:not([hidden]) .db-tree-row-trigger, .db-panel') && [...document.querySelectorAll('.db-row')].find((r) => r.querySelector('.db-name')?.textContent === 'items_touch').querySelector('.db-name').scrollWidth <= [...document.querySelectorAll('.db-row')].find((r) => r.querySelector('.db-name')?.textContent === 'items_touch').querySelector('.db-name').clientWidth`), 'a trigger name is not cut by its details');
  await app.screenshot('106-sqlite-history-run.png');
  // Main writes the history a moment after the last change.
  const shopId = (await readState(2)).dbConnections.find((c) => c.name === 'shop').id;
  const starredOnDisk = () => { try { const f = JSON.parse(readFileSync(join(root, 'data', 'db', 'query_history.json'), 'utf8')); return f.version === 1 && f.connections[shopId]?.some((e) => e.star && e.sql.includes('a;b')); } catch { return false; } };
  let stored = false;
  for (let i = 0; i < 80 && !stored; i++) { await sleep(150); stored = starredOnDisk(); }
  check(stored, 'the history is kept in the data dir with its favourite');
  await ev(`document.querySelector('.db-tab:not([hidden]) [data-action=history-clear]').click()`);
  await app.until(`!!document.querySelector('.modal')`, 'clear question');
  await ev(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Wyczyść historię').click()`);
  await app.until(`document.querySelectorAll('.db-tab:not([hidden]) .db-history-item').length === 1`, 'cleared but the favourite');
  check(true, 'clearing keeps the favourite');
  await ev(`document.querySelector('.db-tab:not([hidden]) [data-field=history-enabled]').click()`);
  await typeCm('SELECT 7');
  await key('Enter', CTRL);
  await app.until(`${cell(0, 0)}?.textContent === '7'`, 'ran with history off', 20000);
  await sleep(500);
  check(await ev(`document.querySelectorAll('.db-tab:not([hidden]) .db-history-item').length === 1`), 'with the history off nothing is recorded');
  await app.screenshot('106-sqlite-history-off.png');
  console.log(`\n${passed} checks passed`);
} catch (error) {
  await app?.screenshot('106-sqlite-failure.png').catch(() => undefined);
  throw error;
} finally {
  await app?.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* the app may still hold a file */ }
}
