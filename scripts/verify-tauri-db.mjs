// Real-app checks of the DB service layer (PLAN D1) on the `check` build, offscreen, with a scratch data dir and home:
//   A. a data dir 1.1.4 left behind (the SP2 fixture: its `Local State` and db/vault.json, made by the real 1.1.4) opens: the
//      DB password decrypts (vaultInfo: saved, not locked) for the Windows user who made the fixture (skipped for anyone else);
//   B. connections through window.mc.db: save with a password (state.json has the connection, never the password; vault.json
//      has a sealed blob; db:vault:changed), duplicate (with the password), delete (password gone), refusals of the 1.1.4
//      validation;
//   C. sessions: connect answers at once with a db: id, then db:session events (until the session packages land the host
//      ends every session with `unsupported`), test connection, sessions(), pins;
//   D. the query history: record (masked), star, clear, the switch, query_history.json written after 1.5 s and on quit;
//   E. SQLite files and dialogs: create at a typed path, the open / save / CA dialogs answered by the test bridge (no dialog on
//      the desktop), the export into MC_DB_EXPORT_DIR;
//   F. restart on the same data: the connections, passwords and history are still there; the wind-down plan has the history
//      save; every db:* channel is implemented.
// Never touches the real %APPDATA%\unimux, ~/.claude or ~/.codex; ends only the processes it started.
//
//   npm run build:check && node scripts/verify-tauri-db.mjs [--keep]
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, readText, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(repo, 'src-tauri', 'crates', 'unimux-oscrypt', 'tests', 'fixtures', 'win-electron45');
const keep = process.argv.includes('--keep');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const FIXTURE_ID = '2d855a7a-4192-4b5c-a5be-8551bacddb33';
const SECRET = 'd1-check pässwörd 🔑';
const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-d1-'));
const dataDir = join(scratch, 'data');
const exportDir = join(scratch, 'exports');
mkdirSync(join(dataDir, 'db'), { recursive: true });
mkdirSync(exportDir, { recursive: true });
console.log(`scratch: ${scratch}`);
const stateFile = join(dataDir, 'state.json');
const vaultFile = join(dataDir, 'db', 'vault.json');
const historyFile = join(dataDir, 'db', 'query_history.json');

// A 1.1.4 data dir: the connection whose password the fixture vault holds, and that vault with its Local State.
copyFileSync(join(fixture, 'Local State'), join(dataDir, 'Local State'));
copyFileSync(join(fixture, 'electron', 'db', 'vault.json'), vaultFile);
const fixtureConnection = { id: FIXTURE_ID, kind: 'postgres', name: 'b2 pg', host: '127.0.0.1', port: 5432, user: 'postgres', tls: 'prefer', ssh: null, readOnly: false, createdAt: 1, updatedAt: 1, database: 'postgres' };
writeFileSync(stateFile, JSON.stringify({ version: 1, projects: [], settings: { language: 'pl' }, dbConnections: [fixtureConnection] }));

const children = [];
async function start() {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port, extraEnv: { MC_DB_EXPORT_DIR: exportDir } });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  await page.evaluate(`(() => {
    window.__d1 = { sessions: [], prompts: [], vault: [] };
    window.mc.on('db:session', (s) => window.__d1.sessions.push(s));
    window.mc.on('db:prompt', (id, p) => window.__d1.prompts.push({ id, p }));
    window.mc.on('db:vault:changed', (info) => window.__d1.vault.push(info));
    return true;
  })()`);
  return { child, page };
}
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
const mc = (page, expr) => page.evaluate(`(async () => ${expr})()`);
const state = () => JSON.parse(readText(stateFile));
const pg = { kind: 'postgres', name: 'd1 pg', host: 'db.example.com', port: 5432, user: 'app', database: 'shop', tls: 'prefer', ssh: null, readOnly: false };

async function quit(app) {
  await bridge(app.page, 'quit').catch(() => undefined);
  const code = await waitExit(app.child, 20000);
  return code;
}

let savedId = null;
let copyId = null;
try {
  // ── A. the 1.1.4 vault ─────────────────────────────────────────────────────
  let app = await start();
  const info = await mc(app.page, 'window.mc.db.vaultInfo()');
  const sameUser = info.locked.length === 0;
  check('A: the 1.1.4 db/vault.json opens (storage dpapi, the fixture password listed, not read-only)', info.storage === 'dpapi' && info.saved.includes(FIXTURE_ID) && !info.readOnly, info);
  if (sameUser) check('A: the 1.1.4 DB password decrypts (fixture user)', !info.locked.includes(FIXTURE_ID), info);
  else console.log(`SKIP A: the fixture Local State belongs to another Windows user (locked: ${info.locked})`);
  const ls = readFileSync(join(dataDir, 'Local State'));
  check('A: Local State with a usable key is never rewritten', !sameUser || ls.equals(readFileSync(join(fixture, 'Local State'))));

  // ── B. connections ────────────────────────────────────────────────────────
  const saved = await mc(app.page, `window.mc.db.saveConnection(${JSON.stringify(pg)}, { set: ${JSON.stringify(SECRET)} })`);
  savedId = saved.connection?.id;
  check('B: a connection is saved', saved.ok && /^[0-9a-f-]{36}$/.test(savedId), saved);
  await waitFor(app.page, `window.__d1.vault.some((v) => v.saved.includes(${JSON.stringify(savedId)}))`, 5000, 'db:vault:changed');
  check('B: db:vault:changed carries the vault info', true);
  await bridge(app.page, 'flush');
  const st = state();
  check('B: state.json has the connection (normalized, no password)', st.dbConnections?.some((c) => c.id === savedId && c.name === 'd1 pg') && !readText(stateFile).includes(SECRET));
  const vaultText = readText(vaultFile);
  const vault = JSON.parse(vaultText);
  check('B: vault.json keeps the 1.1.4 entry and seals the new password (1-space JSON, no plain text)', vault.version === 1 && vault.passwords.length === 2 && vault.passwords[0].connectionId === FIXTURE_ID && !vaultText.includes(SECRET) && vaultText.startsWith('{\n "version": 1,\n "passwords": [\n  {'));
  const blob = Buffer.from(vault.passwords[1].secret, 'base64');
  check('B: the new secret is an OSCrypt v10 blob', blob.subarray(0, 3).toString() === 'v10');
  const dup = await mc(app.page, `window.mc.db.duplicateConnection(${JSON.stringify(savedId)})`);
  copyId = dup.connection?.id;
  check('B: duplicate names the copy "(2)" and copies the password', dup.ok && dup.connection.name === 'd1 pg (2)' && (await mc(app.page, 'window.mc.db.vaultInfo()')).saved.includes(copyId), dup);
  const del = await mc(app.page, `window.mc.db.deleteConnection(${JSON.stringify(copyId)})`);
  const afterDel = await mc(app.page, 'window.mc.db.vaultInfo()');
  check('B: delete removes the connection and its password', del.ok && !afterDel.saved.includes(copyId), afterDel);
  const refused = await mc(app.page, `Promise.all([
    window.mc.db.saveConnection({ ...${JSON.stringify(pg)}, extra: 1 }, { keep: true }),
    window.mc.db.saveConnection({ ...${JSON.stringify(pg)}, port: 0 }, { keep: true }),
    window.mc.db.saveConnection({ ...${JSON.stringify(pg)}, id: '00000000-0000-4000-8000-0000000000ff' }, { keep: true }),
    window.mc.db.deleteConnection('nope'),
    window.mc.db.connect('nope'),
    window.mc.db.pg.schemas('sftp:00000000-0000-4000-8000-000000000001'),
    window.mc.db.redis.databases('db:00000000-0000-4000-8000-000000000001'),
    window.mc.db.answer({ sessionId: 'x', promptId: 'y', cancel: true }),
  ])`);
  check('B: malformed requests get the fixed 1.1.4 answers', JSON.stringify(refused) === JSON.stringify([
    { ok: false, error: 'invalid' }, { ok: false, error: 'invalid' }, { ok: false, error: 'notFound' }, { ok: false }, { ok: false, error: 'invalid' },
    { ok: false, error: 'invalid' }, { ok: false, error: 'noSession' }, { ok: false },
  ]), refused);

  // ── C. sessions ───────────────────────────────────────────────────────────
  const c = await mc(app.page, `window.mc.db.connect(${JSON.stringify(savedId)})`);
  check('C: connect answers at once with a db: session id', c.ok && /^db:[0-9a-f-]{36}$/.test(c.sessionId), c);
  await waitFor(app.page, `window.__d1.sessions.some((s) => s.id === ${JSON.stringify(c.sessionId)} && s.state === 'error')`, 5000, 'session end');
  const states = await app.page.evaluate(`window.__d1.sessions.filter((s) => s.id === ${JSON.stringify(c.sessionId)})`);
  check('C: db:session goes connecting -> error (unsupported until the session packages land)', states[0].state === 'connecting' && states[0].database === 'shop' && states.at(-1).error === 'unsupported', states);
  const snap = await mc(app.page, 'window.mc.db.sessions()');
  check('C: sessions() is empty again', snap.sessions.length === 0 && snap.prompts.length === 0, snap);
  const tests = await mc(app.page, `Promise.all([window.mc.db.testConnection({ ...${JSON.stringify(pg)}, port: -1 }, null), window.mc.db.testConnection(${JSON.stringify(pg)}, { saved: ${JSON.stringify(savedId)} })])`);
  check('C: testConnection validates and resolves with the session result', tests[0].error === 'invalid' && tests[1].ok === false && tests[1].error === 'unsupported', tests);
  await mc(app.page, `(window.mc.db.pin([${JSON.stringify(c.sessionId)}, 'bad']), true)`);
  const disc = await mc(app.page, `window.mc.db.disconnect(${JSON.stringify(c.sessionId)})`);
  check('C: pin is accepted, disconnect of an ended session answers ok:false', disc.ok === false, disc);

  // ── D. query history ──────────────────────────────────────────────────────
  const empty = await mc(app.page, `window.mc.db.history.list(${JSON.stringify(savedId)})`);
  check('D: an empty history, recording on', empty.enabled === true && empty.entries.length === 0, empty);
  await mc(app.page, `(window.mc.db.history.record(${JSON.stringify(savedId)}, [{ sql: 'SELECT 1', at: 5, timeMs: 2.6, rows: 1, ok: true }, { sql: "ALTER USER x PASSWORD 'p'", at: 6, timeMs: 1, rows: null, ok: false, error: 'boom\\nline 2' }]), true)`);
  const listed = await mc(app.page, `window.mc.db.history.list(${JSON.stringify(savedId)})`);
  check('D: records are kept newest first, masked, with one error line', listed.entries.length === 2 && listed.entries[0].sql === "ALTER USER x PASSWORD '***'" && listed.entries[0].error === 'boom' && listed.entries[1].timeMs === 3, listed);
  const star = await mc(app.page, `window.mc.db.history.star(${JSON.stringify(savedId)}, ${JSON.stringify(listed.entries[1].id)}, true)`);
  check('D: star', star.ok === true, star);
  check('D: nothing is written before the 1.5 s batch', !existsSync(historyFile));
  await sleep(2200);
  const hist = existsSync(historyFile) ? JSON.parse(readText(historyFile)) : null;
  check('D: query_history.json written after the batch delay', hist?.version === 1 && hist.enabled === true && hist.connections[savedId]?.length === 2 && hist.connections[savedId][1].star === true, hist);
  const cleared = await mc(app.page, `window.mc.db.history.clear(${JSON.stringify(savedId)}, false)`);
  const afterClear = await mc(app.page, `window.mc.db.history.list(${JSON.stringify(savedId)})`);
  check('D: clear keeps the favourites (written at once)', cleared.ok && afterClear.entries.length === 1 && JSON.parse(readText(historyFile)).connections[savedId].length === 1, afterClear);
  const badStar = await mc(app.page, `window.mc.db.history.star('nope', 'x', true)`);
  check('D: a bad star request answers ok:false', badStar.ok === false);

  // ── E. files and dialogs ──────────────────────────────────────────────────
  const dbPath = join(scratch, 'new.sqlite');
  const created = await mc(app.page, `window.mc.db.sqlite.create(${JSON.stringify(dbPath)})`);
  const again = await mc(app.page, `window.mc.db.sqlite.create(${JSON.stringify(dbPath)})`);
  check('E: sqlite.create at a typed path makes an empty file once', created.ok && !created.existed && existsSync(dbPath) && again.error === 'exists', [created, again]);
  await bridge(app.page, 'os', { action: 'log', take: true });
  await bridge(app.page, 'os', { action: 'answer', path: dbPath });
  const picked = await mc(app.page, 'window.mc.db.sqlite.pick()');
  await bridge(app.page, 'os', { action: 'answer', path: dbPath });
  const viaSave = await mc(app.page, 'window.mc.db.sqlite.create()');
  await bridge(app.page, 'os', { action: 'answer', path: null });
  const cancelled = await mc(app.page, 'window.mc.db.sqlite.create()');
  await bridge(app.page, 'os', { action: 'answer', path: null });
  const ca = await mc(app.page, 'window.mc.dbPickCaFile()');
  const log = await bridge(app.page, 'os', { action: 'log', take: true });
  check('E: the open dialog returns the picked file', picked === dbPath, picked);
  check('E: the save dialog opens an existing file it confirmed; cancel answers cancelled', viaSave.ok && viaSave.existed && cancelled.error === 'cancelled', [viaSave, cancelled]);
  check('E: the CA dialog answers null when cancelled', ca === null, ca);
  const titles = log.map((e) => `${e.op}:${e.title}`);
  check('E: the dialogs are the recorder\'s (none on the desktop), titled in Polish, with the 1.1.4 filters', JSON.stringify(titles) === JSON.stringify(['pick:Otwórz plik bazy SQLite', 'save:Nowy plik bazy SQLite', 'save:Nowy plik bazy SQLite', 'pick:Wybierz plik certyfikatu CA'])
    && log[0].filter.extensions.join() === 'db,sqlite,sqlite3,db3' && log[0].moreFilters[0].name === '*' && log[1].defaultPath === 'database.sqlite' && log[3].filter.name === 'PEM' && log.every((e) => e.parent === 'main'), log);
  const exported = await mc(app.page, `window.mc.dbExport('result.csv', 'a,b\\n1,2')`);
  check('E: export writes into MC_DB_EXPORT_DIR', exported.ok && readText(join(exportDir, 'result.csv')) === 'a,b\n1,2', exported);
  const badExport = await mc(app.page, `window.mc.dbExport('../x.csv', 'a')`);
  check('E: export refuses a name with a folder', badExport.ok === false && !badExport.cancelled, badExport);

  // ── F. restart, quit, wind-down ───────────────────────────────────────────
  const report = await bridge(app.page, 'report');
  const dbChannels = Object.entries(report).filter(([ch]) => ch.startsWith('db:'));
  check('F: every db:* channel is implemented', dbChannels.length === 21 && dbChannels.every(([, s]) => s === 'implemented'), dbChannels.filter(([, s]) => s !== 'implemented'));
  const plan = (await bridge(app.page, 'lifecycle')).windDown.map((s) => s.name);
  check('F: the wind-down saves the query history after the state', plan.indexOf('db history save') === plan.indexOf('state save') + 1, plan.join(' > '));
  await mc(app.page, `(window.mc.db.history.record(${JSON.stringify(savedId)}, [{ sql: 'SELECT last', at: 9, timeMs: 1, rows: 0, ok: true }]), true)`);
  const code = await quit(app);
  check('F: quit exits 0', code === 0, code);
  check('F: a record just before the quit is saved by the wind-down', JSON.parse(readText(historyFile)).connections[savedId].some((e) => e.sql === 'SELECT last'));
  app = await start();
  const info2 = await mc(app.page, 'window.mc.db.vaultInfo()');
  const list2 = await mc(app.page, `window.mc.db.history.list(${JSON.stringify(savedId)})`);
  check('F: after a restart the connections, passwords and history are still there', state().dbConnections.some((x) => x.id === savedId) && info2.saved.includes(savedId) && !info2.locked.includes(savedId) && list2.entries.length === 2, { info2, n: list2.entries.length });
  const off = await mc(app.page, 'window.mc.db.history.setEnabled(false)');
  check('F: the history switch is saved at once', off.ok && JSON.parse(readText(historyFile)).enabled === false);
  check('F: quit exits 0 again', (await quit(app)) === 0);
  const crash = existsSync(join(dataDir, 'crash.log')) ? readText(join(dataDir, 'crash.log')) : '';
  // Other domains' not-yet calls of the renderer boot (ssh:vault:info until S1) are not this package's.
  const dbErrors = crash.split('\n').filter((l) => / (error|warn) /i.test(l) && /\bdb[: ]|vault|history|sqlite/i.test(l) && !/ssh:vault:info/.test(l));
  check('no DB errors in crash.log', dbErrors.length === 0, dbErrors.slice(0, 5));
} catch (e) {
  check('run', false, e.stack ?? String(e));
} finally {
  for (const child of children) killTree(child);
  check('isolation: nothing appeared in the real profile', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  if (!keep) { await sleep(1500); removeScratch(scratch); }
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks FAILED` : `all ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
