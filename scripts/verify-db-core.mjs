// Real-app check of the database core (1.0.0, no UI yet): the built app with a scratch data dir and home, a local PGlite
// (scripts/pg-test-server.mjs) and the local SSH test server. Through window.mc.db it saves connections (the password goes to
// <data>/db/vault.json, never state.json), connects directly and through an SSH tunnel (the SSH password question arrives
// as a db:prompt), reads metadata, streams query rows over the DB port, pages a table, applies staged edits and cancels nothing
// real. Run `npm run build` first. Never touches real hosts or the user's data dir; kills only the PIDs it started.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { killTree, launchApp, scratchRoot, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

async function startPg() {
  const child = spawn(process.execPath, ['scripts/pg-test-server.mjs', '--sql', "CREATE TABLE items (id int PRIMARY KEY, name text, big bigint); INSERT INTO items SELECT g, 'item ' || g, 9007199254740993 FROM generate_series(1, 1500) g;"], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('pg test server did not start')), 30000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`pg test server exited (${code})`)); });
    child.stdout.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); } });
  });
  return { ...info, stop: () => killTree(child.pid) };
}

const check = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); console.log(`ok - ${label}`); };

const root = scratchRoot('db');
const pg = await startPg();
const ssh = await startTestServer();
let app;
try {
  const host = testHost(ssh.port);
  writeKnownHost(root, ssh);
  writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host] }));
  app = await launchApp(root);
  // The DB port arrives when the DB Host starts (first connect): listen before connecting.
  await app.evaluate(`(() => {
    window.__db = { port: null, msgs: [], sessions: [], prompts: [] };
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data !== 'mc:db-port' || !e.ports[0]) return;
      window.__db.port = e.ports[0];
      e.ports[0].onmessage = (m) => window.__db.msgs.push(m.data);
    });
    window.mc.on('db:session', (s) => window.__db.sessions.push(s));
    window.mc.on('db:prompt', (id, p) => window.__db.prompts.push({ id, p }));
    return true;
  })()`);
  const saved = await app.evaluate(`window.mc.db.saveConnection({ kind: 'postgres', name: 'local pg', host: '127.0.0.1', port: ${pg.port}, user: 'postgres', database: 'postgres', tls: 'prefer', ssh: null, readOnly: false }, { set: 'not-needed-pw' })`);
  check(saved.ok, 'a connection is saved');
  const state = readFileSync(join(root, 'data', 'state.json'), 'utf8');
  await app.until(`(async () => (await window.mc.db.vaultInfo()).saved.length === 1)()`, 'vault saved');
  const vault = readFileSync(join(root, 'data', 'db', 'vault.json'), 'utf8');
  check(!vault.includes('not-needed-pw') && !state.includes('not-needed-pw'), 'the password is in neither state.json nor vault.json in plain text');

  const c = await app.evaluate(`window.mc.db.connect(${JSON.stringify(saved.connection.id)})`);
  check(c.ok && c.sessionId.startsWith('db:'), 'connect answers at once with a db: session id');
  await app.until(`window.__db.sessions.some((s) => s.id === ${JSON.stringify(c.sessionId)} && s.state === 'connected')`, 'connected', 30000);
  await app.until('!!window.__db.port', 'DB port received');
  const tables = await app.evaluate(`window.mc.db.pg.objects(${JSON.stringify(c.sessionId)}, 'public')`);
  check(tables.ok && tables.value.some((o) => o.name === 'items' && o.kind === 'table'), 'objects of public list the items table');
  const info = await app.evaluate(`window.mc.db.pg.tableInfo(${JSON.stringify(c.sessionId)}, 'public', 'items')`);
  check(info.ok && info.value.editKey.join() === 'id', 'tableInfo reports the primary key as the edit key');

  const qid = 'a0000000-0000-4000-8000-000000000001';
  const q = await app.evaluate(`window.mc.db.pg.query(${JSON.stringify(c.sessionId)}, { queryId: '${qid}', sql: 'SELECT * FROM items ORDER BY id; SELECT count(*) FROM items', rowCap: 1000 })`);
  check(q.ok, 'a query is accepted');
  await app.until(`window.__db.msgs.some((m) => m.t === 'queryEnd' && m.queryId === '${qid}')`, 'query end');
  const rows = await app.evaluate(`window.__db.msgs.filter((m) => m.queryId === '${qid}' && m.t === 'rows' && m.index === 0).reduce((n, m) => n + m.rows.length, 0)`);
  const end0 = await app.evaluate(`window.__db.msgs.find((m) => m.queryId === '${qid}' && m.t === 'statementEnd' && m.index === 0)`);
  check(rows === 1000 && end0.truncated && !end0.hasMore, 'rows stream over the DB port in chunks; an earlier statement of a run is cut at 1000 (truncated)');
  const lid = 'a0000000-0000-4000-8000-000000000004';
  await app.evaluate(`window.mc.db.pg.query(${JSON.stringify(c.sessionId)}, { queryId: '${lid}', sql: 'SELECT * FROM items ORDER BY id', rowCap: 1000 })`);
  await app.until(`window.__db.msgs.some((m) => m.t === 'queryEnd' && m.queryId === '${lid}')`, 'last query end');
  const more = await app.evaluate(`window.mc.db.pg.fetchMore(${JSON.stringify(c.sessionId)}, '${lid}', 1000)`);
  await app.until(`window.__db.msgs.filter((m) => m.queryId === '${lid}' && m.t === 'statementEnd').length === 2`, 'load more end');
  const total = await app.evaluate(`window.__db.msgs.filter((m) => m.queryId === '${lid}' && m.t === 'rows').reduce((n, m) => n + m.rows.length, 0)`);
  const end1 = await app.evaluate(`window.__db.msgs.filter((m) => m.queryId === '${lid}' && m.t === 'statementEnd').at(-1)`);
  check(more.ok && total === 1500 && !end1.hasMore, 'the last read statement keeps its cursor: load more brings the remaining 500 rows');
  const big = await app.evaluate(`window.__db.msgs.find((m) => m.queryId === '${qid}' && m.t === 'rows' && m.index === 0).rows[0][2]`);
  check(big === '9007199254740993', 'bigint keeps every digit');

  const pid = 'a0000000-0000-4000-8000-000000000002';
  await app.evaluate(`window.mc.db.pg.tablePage(${JSON.stringify(c.sessionId)}, { queryId: '${pid}', schema: 'public', table: 'items', limit: 100, sort: [{ column: 'id', desc: true }], filter: "name LIKE 'item 1%'" })`);
  await app.until(`window.__db.msgs.some((m) => m.t === 'queryEnd' && m.queryId === '${pid}')`, 'page end');
  const first = await app.evaluate(`window.__db.msgs.find((m) => m.queryId === '${pid}' && m.t === 'rows').rows[0][0]`);
  check(first === '1500', 'a sorted, filtered table page arrives');

  const preview = await app.evaluate(`window.mc.db.pg.previewEdits(${JSON.stringify(c.sessionId)}, { schema: 'public', table: 'items', edits: [{ op: 'update', key: { id: '1' }, set: { name: 'renamed' } }, { op: 'delete', key: { id: '2' } }] })`);
  check(preview.ok && preview.value.sql.includes(`UPDATE "public"."items" SET "name" = 'renamed' WHERE "id" = '1';`), 'the edit preview shows the SQL');
  const applied = await app.evaluate(`window.mc.db.pg.applyEdits(${JSON.stringify(c.sessionId)}, { schema: 'public', table: 'items', edits: [{ op: 'update', key: { id: '1' }, set: { name: 'renamed' } }, { op: 'delete', key: { id: '2' } }] })`);
  check(applied.ok && applied.value.affected === 2, 'staged edits are applied');
  const conflict = await app.evaluate(`window.mc.db.pg.applyEdits(${JSON.stringify(c.sessionId)}, { schema: 'public', table: 'items', edits: [{ op: 'delete', key: { id: '2' } }] })`);
  check(!conflict.ok && conflict.error === 'conflict' && conflict.index === 0, 'a vanished row rolls the save back as a conflict');

  // Through the SSH tunnel: the SSH password question arrives as a db:prompt.
  const tun = await app.evaluate(`window.mc.db.saveConnection({ kind: 'postgres', name: 'via ssh', host: 'localhost', port: 5432, user: 'postgres', database: 'postgres', tls: 'disable', ssh: { hostId: ${JSON.stringify(host.id)}, dbHost: '127.0.0.1', dbPort: ${pg.port} }, readOnly: true }, { keep: true })`);
  check(tun.ok, 'a tunnel connection is saved');
  const t = await app.evaluate(`window.mc.db.connect(${JSON.stringify(tun.connection.id)})`);
  await app.until(`window.__db.prompts.some((x) => x.id === ${JSON.stringify(t.sessionId)} && x.p && x.p.kind === 'password')`, 'SSH password prompt', 30000);
  const prompt = await app.evaluate(`window.__db.prompts.filter((x) => x.id === ${JSON.stringify(t.sessionId)} && x.p).at(-1).p`);
  const answered = await app.evaluate(`window.mc.db.answer({ sessionId: ${JSON.stringify(t.sessionId)}, promptId: ${JSON.stringify(prompt.id)}, values: [${JSON.stringify(ssh.password)}] })`);
  check(answered.ok, 'the SSH password is answered through db.answer');
  await app.until(`window.__db.sessions.some((s) => s.id === ${JSON.stringify(t.sessionId)} && s.state === 'connected')`, 'tunnel connected', 30000);
  const tq = 'a0000000-0000-4000-8000-000000000003';
  const tw = 'a0000000-0000-4000-8000-000000000005';
  await app.evaluate(`window.mc.db.pg.query(${JSON.stringify(t.sessionId)}, { queryId: '${tq}', sql: 'SELECT name FROM items WHERE id = 1' })`);
  await app.until(`window.__db.msgs.some((m) => m.t === 'queryEnd' && m.queryId === '${tq}')`, 'tunnel query end');
  const tname = await app.evaluate(`window.__db.msgs.find((m) => m.queryId === '${tq}' && m.t === 'rows').rows[0][0]`);
  await app.evaluate(`window.mc.db.pg.query(${JSON.stringify(t.sessionId)}, { queryId: '${tw}', sql: "INSERT INTO items VALUES (9999, 'x', 1)" })`);
  await app.until(`window.__db.msgs.some((m) => m.t === 'queryEnd' && m.queryId === '${tw}')`, 'tunnel write end');
  const refused = await app.evaluate(`window.__db.msgs.find((m) => m.queryId === '${tw}' && m.t === 'statementError')?.error`);
  check(tname === 'renamed' && refused === 'readOnly', 'a query runs through the SSH tunnel; the read-only connection refuses the INSERT');
  const snap = await app.evaluate('window.mc.db.sessions()');
  check(snap.sessions.length === 2 && snap.prompts.length === 0, 'two sessions, no open prompts');
  for (const id of [c.sessionId, t.sessionId]) await app.evaluate(`window.mc.db.disconnect(${JSON.stringify(id)})`);
  await app.until(`(async () => (await window.mc.db.sessions()).sessions.length === 0)()`, 'all disconnected');
  check(true, 'sessions disconnect');
  console.log('DB core real-app check passed');
} finally {
  await app?.close();
  pg.stop();
  ssh.stop();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* a locked file stays until the next run */ }
}
