// Real-app check of MySQL / MariaDB connections (1.0.5): the built app with a scratch data dir and home. Creates the connections
// in the form (the empty panel's MySQL / MariaDB link and the + menu), tests them, shows the dolphin and, once a server showed
// itself as MariaDB, the seal; an unreachable server shows its error. With real servers (MC_MYSQL_UI_SERVERS, the format of
// test/db-mysql-real.int.test.ts: "mysql=root:pw@127.0.0.1:33061,mariadb=root:pw@127.0.0.1:33062") it also runs the tree,
// table data (edit, Pokaż SQL, save), DDL, the SQL editor (script, load more, cancel, export) on each, and (1.0.6) triggers and
// events in the tree, every result set of a CALL and the underline of a syntax error.
// Screenshots: D:\Projekty\_shots\105-mysql-*.png. Run `npm run build` first. Never touches the user's data dir; kills only
// the PIDs it started; the scratch database unimux_ui is dropped again.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { launchApp, scratchRoot, sleep, sshState, writeState } from './ssh-ui-lib.mjs';

const servers = (process.env.MC_MYSQL_UI_SERVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
  const m = /^([^=]+)=([^:]+):([^@]*)@([^:]+):(\d+)$/.exec(entry);
  if (!m) throw new Error(`bad MC_MYSQL_UI_SERVERS entry: ${entry}`);
  return { label: m[1], user: m[2], password: m[3], host: m[4], port: Number(m[5]) };
});
const DB = 'unimux_ui';
const SEED = [
  `DROP DATABASE IF EXISTS ${DB}`, `CREATE DATABASE ${DB} CHARACTER SET utf8mb4`, `USE ${DB}`,
  'CREATE TABLE items (id INT PRIMARY KEY, name VARCHAR(60) NOT NULL, price DECIMAL(10,2), note TEXT, raw VARBINARY(4))',
  "INSERT INTO items SELECT n, CONCAT('item ', n), n * 1.5, IF(n % 5 = 0, NULL, CONCAT('note ', n)), IF(n = 1, X'00ff', NULL) FROM (WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 300) SELECT n FROM s) x",
  'CREATE TABLE nums (n INT PRIMARY KEY)',
  'INSERT INTO nums SELECT n FROM (WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 999) SELECT n FROM s) x',
  'CREATE VIEW cheap AS SELECT id, name FROM items WHERE price < 10',
  // 1.0.6: a procedure with two result sets, a trigger and an event.
  'CREATE PROCEDURE two_sets() BEGIN SELECT 1 AS first; SELECT 2 AS second, 3 AS third; END',
  'CREATE TRIGGER items_bu BEFORE UPDATE ON items FOR EACH ROW SET NEW.name = TRIM(NEW.name)',
  "CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY DISABLE COMMENT 'cleanup' DO DELETE FROM nums WHERE n < 0",
];
async function seed(s, drop = false) {
  const c = await mysql.createConnection({ host: s.host, port: s.port, user: s.user, password: s.password });
  try { for (const sql of drop ? [`DROP DATABASE IF EXISTS ${DB}`] : SEED) await c.query(sql); } finally { await c.end(); }
}

let passed = 0;
const check = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); passed++; console.log(`ok - ${label}`); };

const root = scratchRoot('mysqlui');
const exportDir = join(root, 'export');
mkdirSync(exportDir, { recursive: true });
for (const s of servers) await seed(s);
let app;
const VK = { Enter: 13, Escape: 27, a: 65 };
const CTRL = 2, SHIFT = 8;
try {
  writeState(root, { ...sshState({ projectPath: join(root, 'project') }), snippetsOpen: false });
  app = await launchApp(root, { MC_DB_EXPORT_DIR: exportDir });
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
    await app.insertText(text);
  };
  const readState = async (count) => {
    let state = {};
    for (let i = 0; i < 60 && (state.dbConnections?.length ?? 0) < count; i++) { await sleep(200); try { state = JSON.parse(readFileSync(join(root, 'data', 'state.json'), 'utf8')); } catch { /* being written */ } }
    return state;
  };
  /** Fills the open connection form. */
  const fill = async (name, s) => {
    await app.setValue('.db-editor [data-field=name]', name);
    await app.setValue('.db-editor [data-field=host]', s.host);
    await app.setValue('.db-editor [data-field=port]', String(s.port));
    await app.setValue('.db-editor [data-field=user]', s.user);
    if (s.password) await app.setValue('.db-editor [data-field=password]', s.password);
    await app.setValue('.db-editor [data-field=database]', s.database ?? '');
  };
  const newFromMenu = async () => {
    await app.click('.db-panel [data-action=new-connection]');
    await menu('MySQL / MariaDB');
    await app.until(`!!document.querySelector('.db-editor')`, 'connection form');
  };

  // ── the form, from the empty panel ──
  await app.click('#db-view');
  await app.until(`!!document.querySelector('.db-panel .db-empty')`, 'empty database panel');
  check((await textOf('.db-panel .db-empty')).includes('MySQL / MariaDB'), 'the empty panel offers MySQL / MariaDB');
  await app.screenshot('105-mysql-empty.png');
  await ev(`[...document.querySelectorAll('.db-panel .db-empty a, .db-panel .db-empty [role=link], .db-panel .db-empty button')].find((e) => e.textContent === 'MySQL / MariaDB').click()`);
  await app.until(`!!document.querySelector('.db-editor')`, 'connection form');
  check(await ev(`document.querySelector('.db-editor .db-kind-select').textContent.includes('MySQL / MariaDB') && document.querySelector('.db-editor [data-field=port]').value === '3306' && document.querySelector('.db-editor [data-field=user]').value === 'root'`), 'the form starts as MySQL / MariaDB with port 3306 and user root');
  const unreachable = { host: '127.0.0.1', port: 1, user: 'root', password: '' };
  await fill('mysql unreachable', unreachable);
  await app.screenshot('105-mysql-form.png');
  await app.click('.db-editor [data-action=test]');
  await app.until(`document.querySelector('.db-editor .db-test')?.dataset.test === 'error'`, 'test error', 30000);
  check((await textOf('.db-editor .db-test.error')).length > 5, 'Testuj połączenie against an unreachable server shows the error');
  await app.screenshot('105-mysql-form-error.png');
  await app.click('.db-editor [data-action=save]');
  await app.until(`!document.querySelector('.db-editor')`, 'form closed');
  check((await readState(1)).dbConnections?.[0]?.kind === 'mysql', 'the connection is saved as kind mysql');
  await app.until(`!!${rowByText('mysql unreachable')}`, 'connection row');
  check(await ev(`!!${rowByText('mysql unreachable')}.querySelector('.db-kind-icon.mysql')`), 'the tree shows the MySQL dolphin before any connect');
  await ev(`${rowByText('mysql unreachable')}.click()`);
  await app.until(`!!document.querySelector('.db-panel-error')`, 'connect error', 30000);
  check((await textOf('.db-panel-error')).includes('mysql unreachable'), 'connecting to an unreachable server shows the error in the panel');
  await app.screenshot('105-mysql-unreachable.png');

  let n = 1;
  for (const s of servers) {
    const name = `${s.label} local`;
    const mariadb = /maria/i.test(s.label);
    await newFromMenu();
    await fill(name, { ...s, database: DB });
    await app.click('.db-editor [data-action=test]');
    await app.until(`!!document.querySelector('.db-editor .db-test')`, 'test result', 30000);
    check(await ev(`document.querySelector('.db-editor .db-test').dataset.test === 'ok'`) && (await textOf('.db-editor .db-test')).includes(mariadb ? 'MariaDB' : 'MySQL'), `${s.label}: Testuj połączenie works and names the server`);
    await app.screenshot(`105-mysql-${s.label}-test.png`);
    await app.click('.db-editor [data-action=save]');
    await app.until(`!document.querySelector('.db-editor')`, 'form closed');
    n++;
    const state = await readState(n);
    check(!JSON.stringify(state).includes(s.password), `${s.label}: no password in state.json`);

    // ── tree ──
    await app.until(`!!${rowByText(name)}`, 'connection row');
    await ev(`${rowByText(name)}.click()`);
    await app.until(`!!${rowByText('items')}`, 'tree shows the tables of the default database', 30000);
    await app.until(`!!${rowByText(name)}.querySelector('.db-kind-icon.${mariadb ? 'mariadb' : 'mysql'}')`, 'flavour icon', 20000);
    check(true, `${s.label}: the tree icon is the ${mariadb ? 'MariaDB seal' : 'MySQL dolphin'} after connecting`);
    check(await ev(`!!${rowByText('information_schema')}`) && await ev(`${rowByText('information_schema')}.querySelector('.db-name').classList.contains('dim')`), `${s.label}: system databases are listed dimmed`);
    await ev(`[...document.querySelectorAll('.db-row.db-folder')].find((r) => r.textContent.includes('Widoki'))?.click()`);
    await app.until(`!!${rowByText('cheap')}`, 'views folder');
    await ev(`(${rowByText('items')}).querySelector('.db-chev-hit').click()`);
    await app.until(`!!${rowByText('price')}`, 'columns of items');
    check(await ev(`${rowByText('id')}?.querySelector('.db-pk') !== null && ${rowByText('price')}.querySelector('.db-type').textContent.startsWith('decimal')`), `${s.label}: columns with types and the primary key`);
    await app.screenshot(`105-mysql-${s.label}-tree.png`);
    await contextOn(rowByText('items'));
    await menu('Pokaż DDL');
    await app.until(`!!document.querySelector('.db-ddl-tab .cm-content') && document.querySelector('.db-ddl-tab .cm-content').textContent.includes('CREATE TABLE')`, 'DDL tab', 20000);
    check(true, `${s.label}: Pokaż DDL shows SHOW CREATE TABLE`);
    await app.screenshot(`105-mysql-${s.label}-ddl.png`);

    // ── table data ──
    await dbl(rowByText('items'));
    await app.until(`${cell(0, 1)}?.textContent === 'item 1'`, 'table rows', 30000);
    check(await textOf('.db-table-tab [data-field=pageinfo]') === '1-100' && await ev(`${cell(0, 4)}?.textContent === '\\\\x00ff'`), `${s.label}: the first page with bytes as hex`);
    await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
    await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
    await app.until(`${cell(0, 0)}?.textContent === '300'`, 'sorted desc');
    await ev(`document.querySelector('.db-table-tab .db-hcell[data-col="id"]').click()`);
    await app.until(`${cell(0, 0)}?.textContent === '1'`, 'sort off');
    await app.setValue('.db-table-tab [data-field=where]', 'id <= 12 AND note IS NOT NULL');
    await key('Enter');
    await app.until(`document.querySelector('.db-table-tab [data-field=pageinfo]')?.textContent === '1-10'`, 'filtered rows', 20000);
    check(true, `${s.label}: sort and WHERE filter`);
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
    check(preview.startsWith('START TRANSACTION;') && preview.includes("UPDATE `unimux_ui`.`items` SET `name` = 'renamed ąę' WHERE `id` = '1'"), `${s.label}: Pokaż SQL shows backticks and the transaction`);
    await app.screenshot(`105-mysql-${s.label}-preview.png`);
    await app.click('.db-preview .modal-foot .btn.primary');
    await app.click('.db-table-tab [data-action=save]');
    await app.until(`!!document.querySelector('.db-table-tab .db-notice, .db-table-tab [data-field=error]')`, 'saved', 20000);
    if (await ev(`!!document.querySelector('.db-table-tab [data-field=error]')`)) throw new Error(await textOf('.db-table-tab [data-field=error]'));
    check(await ev(`${cell(0, 1)}?.textContent === 'renamed ąę'`), `${s.label}: Zapisz zmiany applies the edit`);
    await app.screenshot(`105-mysql-${s.label}-table.png`);

    // ── SQL editor ──
    await contextOn(rowByText(name));
    await menu('Nowy edytor SQL');
    await app.until(`!!document.querySelector('.db-tab:not([hidden]) .db-sql-editor .cm-content')`, 'SQL tab');
    await typeCm("SELECT id, name FROM items ORDER BY id LIMIT 3;\nSELECT 'a;b' AS s, VERSION() AS v;\nUPDATE items SET note = note WHERE id < 4;");
    await key('Enter', CTRL | SHIFT);
    await app.until(`document.querySelectorAll('.db-tab:not([hidden]) .db-result-tab').length === 4`, 'script results', 20000);
    check(await ev(`${cell(0, 1)}?.textContent === 'renamed ąę'`), `${s.label}: a script runs as three statements`);
    await app.screenshot(`105-mysql-${s.label}-sql.png`);
    await typeCm('SELECT a.n * 1000 + b.n AS v FROM nums a CROSS JOIN nums b ORDER BY v');
    await key('Enter', CTRL);
    await app.until(`(document.querySelector('.db-tab:not([hidden]) [data-field=result-rows]')?.textContent ?? '').startsWith('1000')`, 'capped at 1000', 30000);
    await app.click('.db-tab:not([hidden]) [data-action=load-more]');
    await app.until(`(document.querySelector('.db-tab:not([hidden]) [data-field=result-rows]')?.textContent ?? '').startsWith('2000')`, 'load more', 30000);
    check(true, `${s.label}: results stop at 1000 rows and load the next 1000`);
    await ev(`[...document.querySelectorAll('.db-tab:not([hidden]) .db-result-foot .btn')].find((b) => b.textContent === 'Eksport').click()`);
    await menu('CSV');
    let exported = null;
    const file = join(exportDir, `SQL 1.csv`);
    for (let i = 0; i < 50 && !exported; i++) { await sleep(150); if (existsSync(file)) exported = readFileSync(file, 'utf8'); }
    check(!!exported && exported.startsWith('v\r\n0\r\n'), `${s.label}: export CSV`);
    rmSync(file, { force: true });
    await typeCm('SELECT SUM(a.n + b.n + c.n) FROM nums a, nums b, nums c WHERE a.n + b.n + c.n >= 0');
    await key('Enter', CTRL);
    await app.until(`document.querySelector('.db-tab:not([hidden]) [data-action=cancel]')?.disabled === false`, 'running', 20000);
    await sleep(500);
    await app.click('.db-tab:not([hidden]) [data-action=cancel]');
    await app.until(`document.querySelector('.db-tab:not([hidden]) [data-action=cancel]')?.disabled === true`, 'cancelled', 20000);
    check(/anulowan/i.test(await textOf('.db-tab:not([hidden])')), `${s.label}: Stop cancels a running statement (KILL QUERY)`);
    await app.screenshot(`105-mysql-${s.label}-cancelled.png`);
    await typeCm('SELECT * FROM nope');
    await key('Enter', CTRL);
    await app.until(`!!document.querySelector('.db-tab:not([hidden]) .db-msg.error')`, 'query error', 20000);
    check((await ev(`document.querySelector('.db-tab:not([hidden]) .db-msg.error').textContent`)).includes('1146'), `${s.label}: a server error shows its MySQL code`);
    // ── 1.0.6: CALL result sets, the error underline, triggers and events ──
    await typeCm('CALL two_sets()');
    await key('Enter', CTRL);
    await app.until(`document.querySelectorAll('.db-tab:not([hidden]) .db-result-tab').length === 3`, 'two result sets', 20000);
    check(await ev(`document.querySelectorAll('.db-tab:not([hidden]) .db-result-tab')[1].textContent.includes('#2')`) && await ev(`${cell(0, 0)}?.textContent === '1'`), `${s.label}: a CALL shows each of its result sets`);
    await ev(`document.querySelectorAll('.db-tab:not([hidden]) .db-result-tab')[1].click()`);
    await app.until(`${cell(0, 1)}?.textContent === '3'`, 'second result set');
    await app.screenshot(`106-mysql-${s.label}-call.png`);
    await typeCm('SELECT id FROM\nWHERE');
    await key('Enter', CTRL);
    await app.until(`!!document.querySelector('.db-tab:not([hidden]) .cm-db-error')`, 'error underline', 20000);
    check(await ev(`document.querySelector('.db-tab:not([hidden]) .cm-db-error').textContent === 'WHERE'`), `${s.label}: a syntax error underlines the word after "near"`);
    await app.screenshot(`106-mysql-${s.label}-error.png`);
    for (const folder of ['Wyzwalacze', 'Zdarzenia']) await ev(`[...document.querySelectorAll('.db-row.db-folder')].find((r) => r.textContent.includes(${JSON.stringify(folder)}))?.click()`);
    await app.until(`!!${rowByText('items_bu')} && !!${rowByText('nightly')}`, 'triggers and events', 20000);
    check(await ev(`${rowByText('items_bu')}.textContent.includes('BEFORE UPDATE ON items') && ${rowByText('nightly')}.textContent.includes('EVERY 1 DAY')`), `${s.label}: triggers and events are listed with their details`);
    await dbl(rowByText('items_bu'));
    await app.until(`!!document.querySelector('.db-ddl-tab:not([hidden]) .cm-content') && document.querySelector('.db-ddl-tab:not([hidden]) .cm-content').textContent.includes('TRIGGER')`, 'trigger DDL', 20000);
    check(true, `${s.label}: a trigger opens its CREATE TRIGGER`);
    await app.screenshot(`106-mysql-${s.label}-trigger.png`);
    // Fold this connection: the next server's tree has the same names.
    await ev(`${rowByText(name)}.click()`);
    await app.until(`!${rowByText('items')}`, 'tree folded');
  }
  console.log(`\n${passed} checks passed`);
} catch (error) {
  await app?.screenshot("105-mysql-failure.png").catch(() => undefined);
  throw error;
} finally {
  await app?.close();
  for (const s of servers) await seed(s, true).catch(() => undefined);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* the app may still hold a file */ }
}
