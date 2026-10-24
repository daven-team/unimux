// Real-app check of database, Redis and remote file tabs in their own window (1.0.8): the built app with a scratch data dir and
// home, a SQLite file, the local Postgres (scripts/pg-test-server.mjs, PGlite), the local Redis (scripts/redis-test-server.mjs)
// and the local SSH/SFTP test server (scripts/ssh-test-server.mjs --sftp-root). Never a real server, never the user's data.
// - SQLite table tab with a staged edit: moved to its own window (tab menu) on the same session, attached back, then saved.
// - SQLite SQL tab with a running query: moving asks first; "Przerwij i przenieś" stops it and moves the tab.
// - Postgres SQL tab with results and an open transaction: moved, "Wczytaj więcej" and a new query there (rows on that
//   window's DB port), the main window's quit guard counts the transaction, attached back with the transaction still open.
// - Redis Pub/Sub tab subscribed to a channel: moved, a message published from the main window arrives in the detached one.
// - A remote file with unsaved text: moved (no new login), saved there over SFTP, edited again and attached back.
// - A restart reopens a detached SQL tab with its unsaved script and a detached Redis tab, each logging in again.
// Screenshots: D:\Projekty\_shots\108-detach-*.png. Run `npm run build` first. Kills only the PIDs it started.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { killTree, launchApp, scratchRoot, SHOTS, sleep, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

let passed = 0;
const check = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); passed++; console.log(`ok - ${label}`); };

async function startServer(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${script} did not start`)), 40000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${script} exited (${code})`)); });
    child.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
  return { ...info, stop: () => killTree(child.pid) };
}

/** A DevTools connection to a detached window of the app (its page has `?detached=<id>`; `skip`: window ids already taken). */
async function detachedPage(debugPort, skip = [], ms = 20000) {
  const t0 = Date.now();
  let target;
  while (!target && Date.now() - t0 < ms) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json())
        .find((t) => t.type === 'page' && t.url.includes('detached=') && !skip.some((id) => t.url.includes(id)));
    } catch { /* starting */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('no detached window');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, label, wait = 20000) => {
    const start = Date.now();
    while (Date.now() - start < wait) { if (await evaluate(expression).catch(() => false)) return; await sleep(150); }
    await screenshot('108-detach-failure-detached.png').catch(() => undefined);
    throw new Error(`timeout (detached): ${label}`);
  };
  const screenshot = async (name) => {
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  return { id: new URL(target.url).searchParams.get('detached'), cdp, evaluate, until, screenshot, close: () => { try { ws.close(); } catch { /* closed */ } } };
}

const noDetached = async (debugPort) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    if (!list.some((t) => t.type === 'page' && t.url.includes('detached='))) return true;
    await sleep(200);
  }
  return false;
};

const root = scratchRoot('detachdb');
const sqliteFile = join(root, 'shop.sqlite');
{
  const db = new DatabaseSync(sqliteFile);
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 50) INSERT INTO items SELECT n, 'item ' || n FROM s;`);
  db.close();
}
const remoteRoot = join(root, 'remote');
const remoteHome = join(remoteRoot, 'home', 'alice');
mkdirSync(remoteHome, { recursive: true });
const remoteFile = join(remoteHome, 'notes.txt');
writeFileSync(remoteFile, 'line one\n');

const pg = await startServer('scripts/pg-test-server.mjs', ['--sql', "CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 5000) g;"]);
const redis = await startServer('scripts/redis-test-server.mjs', ['--seed', '20']);
const ssh = await startTestServer(['--sftp-root', remoteRoot, '--sftp-home', '/home/alice']);
const host = testHost(ssh.port, { label: 'vps' });
writeKnownHost(root, ssh);
const SQLITE = randomUUID(), PG = randomUUID(), REDIS = randomUUID();
writeState(root, {
  ...sshState({ projectPath: join(root, 'project'), hosts: [host] }), snippetsOpen: false,
  dbConnections: [
    { id: SQLITE, kind: 'sqlite', name: 'shop', path: sqliteFile, host: '', port: 0, user: '', tls: 'disable', ssh: null, readOnly: false, createdAt: 1, updatedAt: 1 },
    { id: PG, kind: 'postgres', name: 'pglite', host: '127.0.0.1', port: pg.port, user: 'postgres', database: 'postgres', tls: 'disable', ssh: null, readOnly: false, createdAt: 1, updatedAt: 1 },
    { id: REDIS, kind: 'redis', name: 'cache', host: '127.0.0.1', port: redis.port, user: '', dbIndex: 0, tls: 'disable', ssh: null, readOnly: false, createdAt: 1, updatedAt: 1 },
  ],
});
mkdirSync(join(root, 'project'), { recursive: true });

const CTRL = 2;
let app;
let win;
try {
  app = await launchApp(root);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
  const ev = app.evaluate;
  const mc = 'window.__mc';
  const docs = `${mc}.useFileStore.getState().documents`;
  const sessionsCount = () => ev('window.mc.db.sessions().then((s) => s.sessions.length)');
  const cell = (row, col) => `document.querySelector('.db-tab:not([hidden]) .db-grid [aria-rowindex="${row + 2}"] .db-gcell[data-col="${col}"]')`;
  const rowByText = (text) => `[...document.querySelectorAll('.db-row')].find((r) => r.querySelector('.db-name')?.textContent === ${JSON.stringify(text)})`;
  const key = async (target, k, code, vk, modifiers = 0, text) => {
    for (const type of ['keyDown', 'keyUp']) await target.cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(type === 'keyDown' && text ? { text } : {}) });
  };
  /** "Przenieś do nowego okna" from the menu of the tab in front. */
  const moveActiveTab = async () => {
    await ev(`(() => { const t = document.querySelector('.workspace-tabs .file-tab.active'); if (!t) throw new Error('no active file tab'); const b = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 10, clientY: b.top + 8 })); return true; })()`);
    await app.until(`[...document.querySelectorAll('[role=menu] button, [role=menuitem], .ctx-menu button')].some((b) => b.textContent.trim().startsWith('Przenieś do nowego okna'))`, 'tab menu');
    await ev(`[...document.querySelectorAll('[role=menu] button, [role=menuitem], .ctx-menu button')].find((b) => b.textContent.trim().startsWith('Przenieś do nowego okna')).click()`);
  };

  // ── 1. SQLite table tab with a staged edit, moved and back on the same session ──
  await app.click('#db-view');
  await app.until(`!!${rowByText('shop')}`, 'shop connection');
  await ev(`${rowByText('shop')}.click()`);
  await app.until(`!!${rowByText('items')}`, 'items table', 30000);
  await ev(`${rowByText('items')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await app.until(`${cell(0, 1)}?.textContent === 'item 1'`, 'table rows', 30000);
  await ev(`${cell(0, 1)}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await app.until(`!!document.querySelector('.db-cell-editor input')`, 'cell editor');
  await app.setValue('.db-cell-editor input', 'moved edit');
  await key(app, 'Enter', 'Enter', 13, 0, '\r');
  await app.until(`${cell(0, 1)}?.classList.contains('changed')`, 'staged cell');
  const tableId = await ev(`${mc}.useFileStore.getState().activeFileId`);
  const before = await sessionsCount();
  await moveActiveTab();
  win = await detachedPage(app.debugPort);
  await win.until(`document.querySelector('.db-table-tab .db-grid [aria-rowindex="2"] .db-gcell[data-col="1"]')?.textContent === 'moved edit'`, 'staged edit in the detached window', 30000);
  check(await win.evaluate(`document.querySelector('.db-table-tab .db-grid [aria-rowindex="2"] .db-gcell[data-col="1"]').classList.contains('changed') && document.querySelector('[data-field=pending]')?.textContent.includes('1')`), 'the table tab moved with its rows and its staged edit');
  check(await sessionsCount() === before, 'it uses the same database session (no second login)');
  check(await ev(`!${docs}.some((d) => d.id === ${JSON.stringify(tableId)}) && !!document.querySelector('.workspace-tabs .detached-chip')`), 'the main window shows the dimmed chip instead of the tab');
  await win.screenshot('108-detach-sqlite-table.png');
  await app.screenshot('108-detach-main-chip.png');
  await win.evaluate(`setTimeout(() => document.querySelector('.detached-attach').click(), 0), true`);
  check(await noDetached(app.debugPort), 'Przypnij z powrotem closes the window');
  await app.until(`${cell(0, 1)}?.textContent === 'moved edit' && ${cell(0, 1)}?.classList.contains('changed')`, 'staged edit back in the main window', 20000);
  check(true, 'the staged edit came back to the main window');
  win.close(); win = null;
  await app.click('.db-table-tab [data-action=save]');
  await app.until(`!!document.querySelector('.db-table-tab .db-notice')`, 'saved', 20000);
  {
    const db = new DatabaseSync(sqliteFile, { readOnly: true });
    const row = db.prepare('SELECT name FROM items WHERE id = 1').get();
    db.close();
    check(row?.name === 'moved edit', 'the edit is saved to the file on the same session after the round trip');
  }

  // ── 2. a running query asks before the tab moves ──
  const sqliteSql = await ev(`${mc}.dbTabs.openSqlTab(${JSON.stringify(SQLITE)}, ${mc}.dbClient.sharedDatabase(${mc}.useStore.getState().s.dbConnections.find((c) => c.kind === 'sqlite')), 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 500000000) SELECT count(*) FROM c')`);
  await app.until(`!!document.querySelector('.db-sql-tab .cm-content')`, 'SQLite SQL tab');
  await ev(`(() => { const d = ${docs}.find((x) => x.id === ${JSON.stringify(sqliteSql)}); void ${mc}.dbTabs.runSql(d.id, d.text, 0); return true; })()`);
  await app.until(`document.querySelector('.db-sql-tab [data-action=cancel]')?.disabled === false`, 'query running', 20000);
  await sleep(500);
  const moving = ev(`${mc}.detach.detachKey('file:' + ${JSON.stringify(sqliteSql)}, 'menu')`);
  await app.until(`[...document.querySelectorAll('.modal')].some((m) => m.textContent.includes('Zapytanie wciąż trwa'))`, 'the running query question');
  await app.screenshot('108-detach-running-query.png');
  check(true, 'moving a tab with a running query asks first');
  await ev(`[...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Przerwij i przenieś').click()`);
  check(await moving === true, 'Przerwij i przenieś stops the query and moves the tab');
  win = await detachedPage(app.debugPort);
  await win.until(`/anulowan/i.test(document.querySelector('.db-sql-tab')?.textContent ?? '')`, 'cancelled run shown in the detached window', 20000);
  check(true, 'the detached tab shows the stopped run');
  await win.evaluate(`setTimeout(() => document.querySelector('.detached-attach').click(), 0), true`);
  check(await noDetached(app.debugPort), 'attached back');
  win.close(); win = null;
  await app.until(`${docs}.some((d) => d.id === ${JSON.stringify(sqliteSql)})`, 'SQLite SQL tab back');

  // ── 3. Postgres SQL tab: results, an open transaction, load more and a query in the detached window ──
  const pgSql = await ev(`${mc}.dbTabs.openSqlTab(${JSON.stringify(PG)}, 'postgres', 'SELECT id, v FROM t ORDER BY id')`);
  await app.until(`!!document.querySelector('.db-sql-tab .cm-content')`, 'Postgres SQL tab');
  await ev(`${mc}.dbTabs.sqlTransaction(${JSON.stringify(pgSql)}, 'begin')`);
  await ev(`${mc}.dbTabs.runSql(${JSON.stringify(pgSql)}, "INSERT INTO t VALUES (9001, 'in tx')", 0)`);
  await app.until(`${mc}.dbTabs.useDbTabs.getState()[${JSON.stringify(pgSql)}]?.running === false && ${mc}.dbTabs.sqlTx(${JSON.stringify(pgSql)}) !== 'idle'`, 'transaction open', 30000);
  await ev(`${mc}.dbTabs.runSql(${JSON.stringify(pgSql)}, 'SELECT id, v FROM t ORDER BY id', 0)`);
  await app.until(`(document.querySelector('.db-sql-tab [data-field=result-rows]')?.textContent ?? '').startsWith('1000')`, 'first 1000 rows', 30000);
  const pgBefore = await sessionsCount();
  await moveActiveTab();
  win = await detachedPage(app.debugPort);
  await win.until(`(document.querySelector('.db-sql-tab [data-field=result-rows]')?.textContent ?? '').startsWith('1000')`, 'results in the detached window', 30000);
  check(await sessionsCount() === pgBefore, 'the SQL tab keeps its own session (the transaction goes along)');
  check(await win.evaluate(`!!document.querySelector('.db-sql-tab [data-action=commit]') && !document.querySelector('.db-sql-tab [data-action=commit]').disabled`), 'the detached tab shows the open transaction (COMMIT available)');
  const works = await ev('window.mc.detach.works()');
  check(works.length === 1 && works[0].work.tx === 1, 'the main window learns the detached window holds an open transaction');
  await win.evaluate(`document.querySelector('.db-sql-tab [data-action=load-more]').click()`);
  await win.until(`(document.querySelector('.db-sql-tab [data-field=result-rows]')?.textContent ?? '').startsWith('2000')`, 'load more in the detached window', 30000);
  check(true, '"Wczytaj więcej" works in the detached window (its rows come to that window)');
  await win.screenshot('108-detach-pg-loadmore.png');
  await win.evaluate(`window.__mc.dbTabs.runSql(${JSON.stringify(pgSql)}, "SELECT v FROM t WHERE id = 9001", 0)`);
  await win.until(`document.querySelector('.db-sql-tab .db-grid [aria-rowindex="2"] .db-gcell[data-col="0"]')?.textContent === 'in tx'`, 'query inside the open transaction', 30000);
  check(true, 'a new query in the detached window sees the row of the still open transaction');
  await win.screenshot('108-detach-pg-tx.png');
  await win.evaluate(`setTimeout(() => document.querySelector('.detached-attach').click(), 0), true`);
  check(await noDetached(app.debugPort), 'the Postgres tab is attached back');
  win.close(); win = null;
  await app.until(`${mc}.dbTabs.sqlTx(${JSON.stringify(pgSql)}) !== 'idle' && document.querySelector('.db-sql-tab .db-grid [aria-rowindex="2"] .db-gcell[data-col="0"]')?.textContent === 'in tx'`, 'transaction still open in the main window', 20000);
  check(true, 'back in the main window the transaction is still open and the last result is shown');
  check((await ev('window.mc.detach.works()')).length === 0, 'the detached window\'s work report is gone');
  await ev(`${mc}.dbTabs.sqlTransaction(${JSON.stringify(pgSql)}, 'rollback')`);
  await app.until(`${mc}.dbTabs.sqlTx(${JSON.stringify(pgSql)}) === 'idle'`, 'rolled back');

  // ── 4. Redis Pub/Sub moves with its subscription ──
  const pubsubTab = await ev(`${mc}.redis.openRedisTab(${JSON.stringify(REDIS)}, 'pubsub', 0)`);
  await app.until(`${mc}.redis.useRedisStore.getState().sessions[${mc}.redis.useRedisStore.getState().tabSessions[${JSON.stringify(pubsubTab)}]]?.state === 'connected'`, 'Redis session', 30000);
  const pubSid = await ev(`${mc}.redis.useRedisStore.getState().tabSessions[${JSON.stringify(pubsubTab)}]`);
  const sub = await ev(`window.mc.db.redis.subscribe(${JSON.stringify(pubSid)}, { channels: ['news'] })`);
  check(sub.ok, 'subscribed to a channel in the main window');
  await moveActiveTab();
  win = await detachedPage(app.debugPort);
  await win.until(`!!document.querySelector('.redis-view')`, 'Redis view in the detached window', 30000);
  // A key browser in the main window publishes (its own session).
  const keysTab = await ev(`${mc}.redis.openRedisTab(${JSON.stringify(REDIS)}, 'keys', 0)`);
  await app.until(`${mc}.redis.useRedisStore.getState().sessions[${mc}.redis.useRedisStore.getState().tabSessions[${JSON.stringify(keysTab)}]]?.state === 'connected'`, 'key browser session', 30000);
  const keysSid = await ev(`${mc}.redis.useRedisStore.getState().tabSessions[${JSON.stringify(keysTab)}]`);
  check(keysSid !== pubSid, 'the key browser in the main window has its own session (the Pub/Sub one moved)');
  const published = await ev(`window.mc.db.redis.publish(${JSON.stringify(keysSid)}, 'news', 'hello detached', true)`);
  check(published.ok && published.value === 1, 'a message published from the main window reaches one subscriber');
  await win.until(`(window.__mc.redis.useRedisStore.getState().pubsub[${JSON.stringify(pubSid)}]?.messages ?? []).some((m) => JSON.stringify(m).includes('hello detached'))`, 'Pub/Sub message in the detached window', 20000);
  check(true, 'the Pub/Sub message arrives in the detached window');
  await sleep(300);
  await win.screenshot('108-detach-redis-pubsub.png');
  await win.evaluate(`setTimeout(() => document.querySelector('.detached-attach').click(), 0), true`);
  check(await noDetached(app.debugPort), 'the Redis tab is attached back');
  win.close(); win = null;
  await app.until(`${mc}.redis.useRedisStore.getState().tabSessions[${JSON.stringify(pubsubTab)}] === ${JSON.stringify(pubSid)}`, 'Pub/Sub session back');
  await ev(`window.mc.db.redis.publish(${JSON.stringify(keysSid)}, 'news', 'hello main', true)`);
  await app.until(`(${mc}.redis.useRedisStore.getState().pubsub[${JSON.stringify(pubSid)}]?.messages ?? []).some((m) => JSON.stringify(m).includes('hello main'))`, 'Pub/Sub message back in the main window', 20000);
  check(true, 'after attaching back the messages arrive in the main window again');

  // ── 5. a remote file with unsaved text ──
  const opening = ev(`${mc}.files.openRemoteFile(${JSON.stringify(host.id)}, '/home/alice/notes.txt')`);
  await app.until(`!!document.querySelector('.remote-login input[type=password]')`, 'remote login prompt', 30000);
  await app.setValue('.remote-login input[type=password]', ssh.password);
  await app.click('.remote-login button[type=submit]');
  await opening;
  await app.until(`(document.querySelector('.file-editor .cm-content')?.textContent ?? '').includes('line one')`, 'remote file open', 30000);
  await ev(`document.querySelector('.file-editor .cm-content').focus()`);
  await key(app, 'a', 'KeyA', 65, CTRL);
  await app.insertText('line one\nunsaved in main\n');
  await app.until(`${docs}.some((d) => d.source?.kind === 'remote' && d.text.includes('unsaved in main') && d.text !== d.savedText)`, 'unsaved remote text');
  const sftpBefore = await ev('window.mc.sftp.sessions().then((s) => s.sessions.length)');
  await moveActiveTab();
  win = await detachedPage(app.debugPort);
  await win.until(`(document.querySelector('.file-editor .cm-content')?.textContent ?? '').includes('unsaved in main') && !!document.querySelector('.detached-titlebar .file-dirty')`, 'unsaved text in the detached window', 20000);
  check(true, 'the remote tab moved with its unsaved text');
  await win.evaluate(`document.querySelector('.file-editor .cm-content').focus()`);
  for (const type of ['keyDown', 'keyUp']) await win.cdp('Input.dispatchKeyEvent', { type, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: CTRL });
  let saved = false;
  for (let i = 0; i < 100 && !saved; i++) { await sleep(150); saved = readFileSync(remoteFile, 'utf8') === 'line one\nunsaved in main\n'; }
  check(saved, 'Ctrl+S in the detached window saves the file on the server');
  check(await ev('window.mc.sftp.sessions().then((s) => s.sessions.length)') === sftpBefore, 'the save used the existing SFTP session (no new login)');
  await win.evaluate(`document.querySelector('.file-editor .cm-content').focus()`);
  await win.cdp('Input.insertText', { text: 'typed in the detached window\n' });
  await win.until(`!!document.querySelector('.detached-titlebar .file-dirty')`, 'dirty again');
  await win.screenshot('108-detach-remote.png');
  await win.evaluate(`setTimeout(() => document.querySelector('.detached-attach').click(), 0), true`);
  check(await noDetached(app.debugPort), 'the remote tab is attached back');
  win.close(); win = null;
  await app.until(`${docs}.some((d) => d.source?.kind === 'remote' && d.text.includes('typed in the detached window') && d.text !== d.savedText)`, 'unsaved text back in the main window', 20000);
  check(true, 'the unsaved text came back to the main window');
  await app.screenshot('108-detach-remote-back.png');

  // ── 6. a restart reopens detached SQL and Redis tabs ──
  await ev(`${mc}.files.closeFiles(${docs}.filter((d) => d.source?.kind === 'remote').map((d) => d.id))`).catch(() => undefined);
  if (await ev(`!!document.querySelector('.modal')`)) await ev(`[...document.querySelectorAll('.modal button')].find((b) => /Odrzuć|Discard/.test(b.textContent)).click()`);
  const restartSql = await ev(`${mc}.dbTabs.openSqlTab(${JSON.stringify(PG)}, 'postgres', 'SELECT 42 AS answer')`);
  await app.until(`!!document.querySelector('.db-sql-tab .cm-content')`, 'SQL tab for the restart');
  await ev(`${mc}.detach.detachKey('file:' + ${JSON.stringify(restartSql)}, 'menu')`);
  win = await detachedPage(app.debugPort);
  await win.until(`(document.querySelector('.db-sql-tab .cm-content')?.textContent ?? '').includes('SELECT 42')`, 'restart SQL tab detached');
  await win.evaluate(`window.__mc.files.flushDrafts(); true`);
  win.close(); win = null;
  const redisKeys = await ev(`${mc}.redis.openRedisTab(${JSON.stringify(REDIS)}, 'keys', 0)`);
  await ev(`${mc}.detach.detachKey('file:' + ${JSON.stringify(redisKeys)}, 'menu')`);
  await sleep(1500);
  // A normal quit (the windows close, their storage is written), then the leftovers go.
  await app.cdp('Browser.close').catch(() => undefined);
  await sleep(4000);
  await app.close();
  app = await launchApp(root);
  const pages = async () => (await (await fetch(`http://127.0.0.1:${app.debugPort}/json/list`)).json()).filter((t) => t.type === 'page' && t.url.includes('detached='));
  let reopened = [];
  for (let i = 0; i < 100 && reopened.length < 2; i++) { await sleep(200); reopened = await pages(); }
  check(reopened.length === 2, 'both detached windows open again after a restart');
  const first = await detachedPage(app.debugPort);
  const second = await detachedPage(app.debugPort, [first.id]);
  await first.until(`!!document.querySelector('.db-sql-tab, .redis-view')`, 'first window content', 20000);
  await second.until(`!!document.querySelector('.db-sql-tab, .redis-view')`, 'second window content', 20000);
  const sqlFirst = await first.evaluate(`!!document.querySelector('.db-sql-tab')`);
  const [sqlPage, redisPage] = sqlFirst ? [first, second] : [second, first];
  await sqlPage.until(`(document.querySelector('.db-sql-tab .cm-content')?.textContent ?? '').includes('SELECT 42')`, 'unsaved script after the restart', 20000);
  await sqlPage.evaluate(`window.__mc.dbTabs.runSql(window.__mc.useFileStore.getState().activeFileId, 'SELECT 42 AS answer', 0)`);
  await sqlPage.until(`document.querySelector('.db-sql-tab .db-grid [aria-rowindex="2"] .db-gcell[data-col="0"]')?.textContent === '42'`, 'query after the restart (new session)', 30000);
  check(true, 'the detached SQL tab came back with its script and runs on a new session');
  await sqlPage.screenshot('108-detach-restart-sql.png');
  await redisPage.until(`[...document.querySelectorAll('.redis-view')].some((v) => /item/.test(v.textContent) && /queue/.test(v.textContent))`, 'Redis keys after the restart', 30000);
  check(true, 'the detached Redis key browser came back and logged in again');
  await redisPage.screenshot('108-detach-restart-redis.png');
  sqlPage.close(); redisPage.close();
  console.log(`\n${passed} checks passed`);
} catch (error) {
  await app?.screenshot('108-detach-failure.png').catch(() => undefined);
  await win?.screenshot('108-detach-failure-detached.png').catch(() => undefined);
  throw error;
} finally {
  win?.close();
  await app?.close();
  pg.stop(); redis.stop(); ssh.stop();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* the app may still hold a file */ }
}
