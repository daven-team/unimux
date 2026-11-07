// B2 acceptance: Electron safeStorage in the real Tauri app (unimux-oscrypt SafeStorage through AppContext), both directions
// with the real 1.1.4, on scratch data dirs only.
//
//   npm run build:check && node scripts/verify-safestorage.mjs [--electron <checkout with `npx electron-vite build` done>] [--keep]
//
// A. 1.1.4 stores an SSH password, an SSH key with a saved passphrase, a DB password (through its own IPC) and a GitHub token
//    (its own safeStorage). Without --electron the committed SP2 fixture (a profile 1.1.4 made) is copied instead; its DPAPI
//    key unwraps only for the Windows user who made it, so those checks are skipped for anyone else.
// B. The Tauri check build on that data dir: the key was opened at start (Windows, like OSCrypt::Init) and found, startup.log
//    says so, every secret decrypts to the text 1.1.4 stored, Rust re-encrypts each in place, Local State is never touched.
// C. 1.1.4 again: nothing locked, its safeStorage decrypts every blob the Tauri app wrote, files and key untouched.
// D. Fresh install: the Tauri app creates Local State at start; a restart finds it; 1.1.4 decrypts the Tauri blobs and keeps
//    the key.
// E. MC_SSH_NO_SAFESTORAGE: exactly "1" makes storage report unavailable, "true" does not (1.1.x `=== '1'`); as in 1.1.4 the
//    key is still opened (Local State written at start) and existing blobs still decrypt.
// F/G/H. A Local State without a usable key: a foreign DPAPI key (new key stored, other prefs kept, Origin Replaced in
//    startup.log and crash.log; 1.1.4 keeps that key), a non-JSON file (`Local State.bad`, created anew), a key in an unknown
//    format (unavailable, file left alone).
// Never touches the real %APPDATA%\unimux, ~/.claude or ~/.codex; ends only the processes it started; no window on the
// desktop (MC_OFFSCREEN for both apps).
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const electronCheckout = arg('--electron') ? resolve(arg('--electron')) : null;
const keep = process.argv.includes('--keep');
if (electronCheckout && !existsSync(join(electronCheckout, 'out', 'main', 'index.js'))) throw new Error('--electron must point at a built 1.1.4 checkout');
const fixtureDir = join(repo, 'src-tauri', 'crates', 'unimux-oscrypt', 'tests', 'fixtures', 'win-electron45');

const SECRETS = {
  ssh: 'ssh-pass zażółć 🔑 "quoted" \\ end',
  passphrase: 'key passphrase ł',
  db: 'db-pass Ünïcode 数据库',
  github: 'gho_b2CheckThrowawayToken0123456789abcdef',
};
const FILES = ['ssh/vault.json', 'db/vault.json', 'github/token.json'];

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
const localState = (data) => join(data, 'Local State');
const localJson = (data) => JSON.parse(readFileSync(localState(data), 'utf8'));

/** Every `"secret"` string of a vault file, in file order (the same walk as the SP2 tool). */
function secretsOf(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => secretsOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (k === 'secret' && typeof v === 'string') out.push(v); else secretsOf(v, out); }
  return out;
}
const fileSecrets = (data, f) => (existsSync(join(data, f)) ? secretsOf(JSON.parse(readFileSync(join(data, f), 'utf8'))) : []);

const scratchRoot = mkdtempSync(join(tmpdir(), 'unimux-b2-'));
const makeRoot = (name, local) => {
  const base = join(scratchRoot, name);
  for (const dir of ['data', 'project', 'home/AppData/Roaming', 'home/AppData/Local']) mkdirSync(join(base, dir), { recursive: true });
  if (local !== undefined) writeFileSync(localState(join(base, 'data')), local);
  return base;
};

// ---------- the Tauri check build ----------
const children = [];
// Last resort (a crash between start and quit): end every process this script started, never anything else.
process.on('exit', () => { for (const child of children) killTree(child); });
async function startTauri(base, extraEnv = {}) {
  const port = await freePort();
  const child = launchApp({ dataDir: join(base, 'data'), scratch: base, port, extraEnv });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.__TAURI_INTERNALS__?.invoke === 'function'`, 30000, 'Tauri IPC');
  const bridge = (op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
  return { child, page, bridge };
}
async function quitTauri(app) {
  await app.bridge('quit').catch(() => {});
  app.page.close();
  if ((await waitExit(app.child, 15000)) === null) killTree(app.child);
}
/** startup.log: the line of the last launch. */
const lastStartupLine = (data) => readFileSync(join(data, 'startup.log'), 'utf8').trim().split('\n').at(-1) ?? '';
const crashLog = (data) => (existsSync(join(data, 'crash.log')) ? readFileSync(join(data, 'crash.log'), 'utf8') : '');

// ---------- 1.1.4 (only with --electron) ----------
let lib = null;
async function electronLib() {
  // ssh-ui-lib drives the target real-app.mjs picks when it is first imported (X1): here always 1.1.4 (Electron).
  process.env.MC_APP_TARGET = 'electron';
  lib ??= await import('./ssh-ui-lib.mjs');
  return lib;
}
/**
 * CDP of the main process (Node inspector): evaluates with the app's own electron module. Attached while 1.1.4 is still
 * loading (ssh-ui-lib launchApp with `options.main` attaches only after the page answers, which can hang with --inspect).
 */
async function mainInspector(port) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]; } catch { await sleep(200); }
  }
  if (!target) throw new Error('main inspector not reachable');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  // The process went away (killed, or a second instance that quit): fail what is pending instead of waiting forever.
  let closed = false;
  ws.onclose = () => { closed = true; for (const done of pending.values()) done({ error: { message: 'main inspector closed' } }); pending.clear(); };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('main inspector closed')); return; }
    const id = ++next;
    pending.set(id, (m) => (m.error || m.result.exceptionDetails ? reject(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails))) : resolve(m.result.result.value)));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  await evaluate(`globalThis.__el = process.mainModule.require('electron'); globalThis.__notes = [];
    __el.ipcMain.on('notify', (_e, n) => __notes.push(n)); true`);
  return {
    evaluate,
    hook: (cellId, event) => evaluate(`__el.BrowserWindow.getAllWindows()[0].webContents.send('cell:hook', ${JSON.stringify(cellId)}, ${JSON.stringify(event)}), true`),
    notes: () => evaluate('__notes.splice(0)'),
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
}

async function startElectron(base, hosts = [], extraEnv = {}) {
  const { launchApp: launchElectron, sshState, writeState } = await electronLib();
  // Only a data dir without a state yet: later runs keep the state (the DB connection) 1.1.4 and the Tauri app saved.
  if (!existsSync(join(base, 'data', 'state.json'))) writeState(base, sshState({ projectPath: join(base, 'project'), hosts }));
  const here = process.cwd();
  process.chdir(electronCheckout);
  try {
    // The main inspector is attached while the window loads: with --inspect and nobody attached, 1.1.4's page stopped
    // answering CDP on this machine (Electron 45.2.2, Node 24.22.2). Even so the page's Runtime.enable hangs now and then
    // (about one start in three), so a start that does not come up is ended (only that process tree) and tried again.
    // Every 1.1.4 process is in `children` from the moment it is spawned, so `finally` ends it whatever fails later.
    for (let attempt = 1; ; attempt++) {
      const inspectPort = await freePort();
      let spawned = null;
      const launching = launchElectron(base, extraEnv, [`--inspect=${inspectPort}`], { onSpawn: (child) => { spawned = child; children.push(child); } });
      launching.catch(() => {});
      let main = null;
      try {
        main = await mainInspector(inspectPort);
        const app = await launching;
        return { app, main };
      } catch (error) {
        main?.close();
        // Wait until it is gone: a 1.1.4 that still holds the single-instance lock would make the next start quit at once.
        if (spawned) { killTree(spawned); await waitExit(spawned, 10000); }
        // Not spawned yet (launchApp was still picking its port): end it as soon as it comes up.
        else launching.then((app) => app.close(), () => {});
        await sleep(1500);
        if (attempt >= 5) throw error;
        console.log(`1.1.4 did not come up (${error.message}), attempt ${attempt + 1}`);
      }
    }
  } finally { process.chdir(here); }
}
async function quitElectron({ app, main }) {
  await main.evaluate('setTimeout(() => __el.app.quit(), 50), true').catch(() => {});
  main.close();
  for (let i = 0; i < 100; i++) {
    try { process.kill(app.pid, 0); } catch { return; }
    await sleep(100);
  }
  await app.close();
}
const electronDecrypt = (main, blobs) => main.evaluate(`(() => ${JSON.stringify(blobs)}.map((b) => {
  try { return { text: __el.safeStorage.decryptString(Buffer.from(b, 'base64')) }; } catch (e) { return { error: String(e.message) }; }
}))()`);
let electronHost = null;

const markersBefore = realProfileMarkers();
try {
  // ---------- A: secrets as 1.1.4 stored them ----------
  const rootA = makeRoot('a');
  const dataA = join(rootA, 'data');
  let expected;
  let foreignFixture = false;
  if (electronCheckout) {
    electronHost = (await electronLib()).testHost(2222);
    const a = await startElectron(rootA, [electronHost]);
    check('A: 1.1.4 safeStorage available', await a.main.evaluate('__el.safeStorage.isEncryptionAvailable()'));
    const pw = await a.app.evaluate(`window.mc.ssh.setPassword(${JSON.stringify(electronHost.id)}, ${JSON.stringify(SECRETS.ssh)})`);
    const key = await a.app.evaluate(`window.mc.ssh.generateKey({ label: 'b2', type: 'ed25519', comment: 'b2-check', passphrase: ${JSON.stringify(SECRETS.passphrase)}, savePassphrase: true })`);
    const db = await a.app.evaluate(`window.mc.db.saveConnection({ kind: 'postgres', name: 'b2 pg', host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres', tls: 'prefer', ssh: null, readOnly: false }, { set: ${JSON.stringify(SECRETS.db)} })`);
    await a.main.evaluate(`(() => {
      const fs = process.mainModule.require('fs'), path = process.mainModule.require('path');
      const file = path.join(${JSON.stringify(dataA)}, 'github', 'token.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const secret = __el.safeStorage.encryptString(${JSON.stringify(SECRETS.github)}).toString('base64');
      fs.writeFileSync(file, JSON.stringify({ version: 1, login: 'b2-check', savedAt: Date.now(), secret }, null, 1));
      return true;
    })()`);
    check('A: 1.1.4 saved the SSH password, the SSH key and the DB password', pw?.ok && !pw.ephemeral && key?.ok && db?.ok, { pw, key: key?.ok, db: db?.ok });
    await quitElectron(a);
    expected = { 'ssh/vault.json': [{ passphrase: SECRETS.passphrase }, SECRETS.ssh], 'db/vault.json': [SECRETS.db], 'github/token.json': [SECRETS.github] };
  } else {
    cpSync(join(fixtureDir, 'Local State'), localState(dataA));
    for (const f of FILES) { mkdirSync(dirname(join(dataA, f)), { recursive: true }); cpSync(join(fixtureDir, 'electron', f), join(dataA, f)); }
    expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8'));
    console.log('A: no --electron: the committed SP2 fixture (made by 1.1.4) is the data copy');
  }
  const localA = sha(localState(dataA));
  const keyA = localJson(dataA).os_crypt?.encrypted_key;
  const matches = (got, want) => (typeof want === 'string' ? got === want : (() => { try { const v = JSON.parse(got); return v.passphrase === want.passphrase && /BEGIN OPENSSH PRIVATE KEY/.test(v.privateKey ?? ''); } catch { return false; } })());

  // ---------- B: the Tauri app reads and re-encrypts ----------
  const b = await startTauri(rootA);
  const infoB = await b.bridge('safeStorage', { op: 'info' });
  foreignFixture = !electronCheckout && infoB.origin === 'replaced';
  if (foreignFixture) {
    console.log('SKIP B/C: the fixture Local State was made by another Windows user (DPAPI is per user); the Tauri app stored a new key as 1.1.4 would');
    await quitTauri(b);
  } else {
    check('B: the key was opened at start (Windows, like OSCrypt::Init), before any store asked', infoB.openedBefore === 'existing', infoB);
    check('B: storage dpapi, key found in the existing Local State', infoB.storage === 'dpapi' && infoB.available && infoB.origin === 'existing', infoB);
    const byFile = Object.fromEntries(FILES.map((f) => [f, fileSecrets(dataA, f)]));
    const all = FILES.flatMap((f) => byFile[f]);
    const plain = await b.bridge('safeStorage', { op: 'decrypt', secrets: all });
    let i = 0;
    for (const f of FILES) {
      const got = byFile[f].map(() => plain[i++]);
      const want = expected[f];
      check(`B: the Tauri app decrypts every 1.1.4 secret of ${f}`, got.length === want.length && want.every((w) => got.some((g) => g.text !== undefined && matches(g.text, w))), got.map((g) => g.error ?? 'ok'));
    }
    // Re-encrypt in place: only each base64 string changes in the file.
    const fresh = await b.bridge('safeStorage', { op: 'encrypt', texts: plain.map((p) => p.text ?? '') });
    check('B: the Tauri app encrypts', fresh.every((s) => typeof s === 'string' && Buffer.from(s, 'base64').subarray(0, 3).toString() === 'v10'), fresh.filter((s) => typeof s !== 'string'));
    i = 0;
    for (const f of FILES) {
      let text = readFileSync(join(dataA, f), 'utf8');
      for (const old of byFile[f]) text = text.replace(old, fresh[i++]);
      writeFileSync(join(dataA, f), text);
    }
    const back = await b.bridge('safeStorage', { op: 'decrypt', secrets: fresh });
    check('B: the Tauri app reads its own blobs back', back.every((r, k) => r.text === plain[k].text));
    await sleep(500);
    check('B: startup.log has the safe-storage-existing mark', /\bsafe-storage-existing=\d+/.test(lastStartupLine(dataA)), lastStartupLine(dataA));
    await quitTauri(b);
    check('B: Local State not touched by the Tauri app', sha(localState(dataA)) === localA);
    const rustBlobs = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(dataA, f), 'utf8')]));

    // ---------- C: 1.1.4 reads what the Tauri app wrote ----------
    if (electronCheckout) {
      const c = await startElectron(rootA, [electronHost]);
      const vault = await c.app.evaluate('window.mc.ssh.vaultInfo()');
      check('C: 1.1.4 SSH vault: password and key not locked', vault.savedPasswords.includes(electronHost.id) && vault.lockedPasswords.length === 0 && vault.keys.length === 1 && !vault.keys[0].locked, { locked: vault.lockedPasswords, keys: vault.keys.map((k) => k.locked) });
      const dbInfo = await c.app.evaluate('window.mc.db.vaultInfo()');
      check('C: 1.1.4 DB vault: nothing locked', dbInfo.saved.length === 1 && dbInfo.locked.length === 0, dbInfo);
      const dec = await electronDecrypt(c.main, fresh);
      check('C: 1.1.4 safeStorage decrypts every Tauri blob to the same text', dec.every((r, k) => r.text === plain[k].text), dec.map((r) => r.error ?? 'ok'));
      check('C: 1.1.4 did not rewrite the vault files', FILES.every((f) => readFileSync(join(dataA, f), 'utf8') === rustBlobs[f]));
      await quitElectron(c);
      check('C: os_crypt.encrypted_key unchanged after 1.1.4 ran again', localJson(dataA).os_crypt?.encrypted_key === keyA);
    }
  }

  // ---------- D: fresh install ----------
  const rootD = makeRoot('d');
  const dataD = join(rootD, 'data');
  const d1 = await startTauri(rootD);
  const infoD = await d1.bridge('safeStorage', { op: 'info' });
  check('D: a fresh data dir gets a new key at start', infoD.openedBefore === 'created' && infoD.storage === 'dpapi', infoD);
  const ls = existsSync(localState(dataD)) ? localJson(dataD) : null;
  check('D: Local State in Chromium format', ls?.os_crypt?.audit_enabled === true && typeof ls.os_crypt.encrypted_key === 'string' && Object.keys(ls).join() === 'os_crypt', ls && Object.keys(ls.os_crypt));
  const dTexts = ['fresh ssh pw ą', SECRETS.github];
  const dBlobs = await d1.bridge('safeStorage', { op: 'encrypt', texts: dTexts });
  await sleep(300);
  check('D: startup.log has the safe-storage-created mark', /\bsafe-storage-created=\d+/.test(lastStartupLine(dataD)), lastStartupLine(dataD));
  check('D: crash.log notes the new key', /safeStorage key created/.test(crashLog(dataD)));
  await quitTauri(d1);
  const keyD = localJson(dataD).os_crypt.encrypted_key;
  const localD = sha(localState(dataD));
  const d2 = await startTauri(rootD);
  const infoD2 = await d2.bridge('safeStorage', { op: 'info' });
  const decD2 = await d2.bridge('safeStorage', { op: 'decrypt', secrets: dBlobs });
  check('D: a restart finds the key and decrypts', infoD2.origin === 'existing' && decD2.every((r, k) => r.text === dTexts[k]), { infoD2, decD2: decD2.map((r) => r.error ?? 'ok') });
  await quitTauri(d2);
  check('D: the restart did not rewrite Local State', sha(localState(dataD)) === localD);
  if (electronCheckout) {
    const e = await startElectron(rootD);
    const dec = await electronDecrypt(e.main, dBlobs);
    check('D: 1.1.4 decrypts blobs made with the key the Tauri app created', dec.every((r, k) => r.text === dTexts[k]), dec.map((r) => r.error ?? 'ok'));
    await quitElectron(e);
    check('D: 1.1.4 kept that key', localJson(dataD).os_crypt.encrypted_key === keyD);
  }

  // ---------- E: MC_SSH_NO_SAFESTORAGE ----------
  // 1.1.x `electronCipher`: the flag only makes `storage` / `available()` say unavailable; decryptString still uses the real
  // key and OSCrypt::Init still writes Local State at start.
  const rootE = makeRoot('e');
  const dataE = join(rootE, 'data');
  const e1 = await startTauri(rootE, { MC_SSH_NO_SAFESTORAGE: '1' });
  const infoE = await e1.bridge('safeStorage', { op: 'info' });
  check('E: MC_SSH_NO_SAFESTORAGE=1: storage unavailable, the key still opened at start', infoE.storage === 'unavailable' && !infoE.available && infoE.openedBefore === 'created', infoE);
  await sleep(300);
  check('E: MC_SSH_NO_SAFESTORAGE=1: startup.log has the safe-storage-created mark', /\bsafe-storage-created=\d+/.test(lastStartupLine(dataE)), lastStartupLine(dataE));
  await quitTauri(e1);
  check('E: MC_SSH_NO_SAFESTORAGE=1: Local State written as in 1.1.4', !!(existsSync(localState(dataE)) && localJson(dataE).os_crypt?.encrypted_key));
  const localD1 = sha(localState(dataD)); // after 1.1.4 ran on it (Chromium rewrites its prefs)
  const e1b = await startTauri(rootD, { MC_SSH_NO_SAFESTORAGE: '1' });
  const infoE1b = await e1b.bridge('safeStorage', { op: 'info' });
  const decE1b = await e1b.bridge('safeStorage', { op: 'decrypt', secrets: dBlobs });
  check('E: MC_SSH_NO_SAFESTORAGE=1: existing blobs still decrypt while storage says unavailable', infoE1b.storage === 'unavailable' && decE1b.every((r, k) => r.text === dTexts[k]), { infoE1b, decE1b: decE1b.map((r) => r.error ?? 'ok') });
  await quitTauri(e1b);
  check('E: MC_SSH_NO_SAFESTORAGE=1: Local State of an existing data dir not rewritten', sha(localState(dataD)) === localD1);
  if (electronCheckout) {
    const rootE3 = makeRoot('e3');
    const e3 = await startElectron(rootE3, [], { MC_SSH_NO_SAFESTORAGE: '1' });
    const vaultE3 = await e3.app.evaluate('window.mc.ssh.vaultInfo()');
    await quitElectron(e3);
    check('E: 1.1.4 with MC_SSH_NO_SAFESTORAGE=1 also reports unavailable and writes Local State', vaultE3.storage === 'unavailable' && !!localJson(join(rootE3, 'data')).os_crypt?.encrypted_key, vaultE3.storage);
  }
  const rootE2 = makeRoot('e2');
  const e2 = await startTauri(rootE2, { MC_SSH_NO_SAFESTORAGE: 'true' });
  const infoE2 = await e2.bridge('safeStorage', { op: 'info' });
  check('E: MC_SSH_NO_SAFESTORAGE=true keeps safeStorage on (1.1.x checks === "1")', infoE2.storage === 'dpapi', infoE2);
  await quitTauri(e2);

  // ---------- F: a foreign DPAPI key ----------
  const foreignKey = Buffer.concat([Buffer.from('DPAPI'), Buffer.from([1, 0, 0, 0]), randomBytes(200)]).toString('base64');
  const rootF = makeRoot('f', JSON.stringify({ browser: { b2_marker: 'keep me' }, os_crypt: { audit_enabled: true, encrypted_key: foreignKey } }));
  const dataF = join(rootF, 'data');
  const f1 = await startTauri(rootF);
  const infoF = await f1.bridge('safeStorage', { op: 'info' });
  check('F: a foreign DPAPI key: a new key is stored, storage stays dpapi', infoF.origin === 'replaced' && infoF.storage === 'dpapi' && /does not unwrap/.test(infoF.reason ?? ''), infoF);
  const fBlobs = await f1.bridge('safeStorage', { op: 'encrypt', texts: ['foreign ssh pw ą'] });
  await sleep(300);
  check('F: startup.log has the safe-storage-replaced mark', /\bsafe-storage-replaced=\d+/.test(lastStartupLine(dataF)), lastStartupLine(dataF));
  check('F: crash.log says why the key was replaced', /Local State had no usable key, a new one was stored \(the DPAPI key in Local State does not unwrap/.test(crashLog(dataF)));
  await quitTauri(f1);
  const lf = localJson(dataF);
  check('F: other prefs kept, new key stored', lf.browser?.b2_marker === 'keep me' && lf.os_crypt.encrypted_key !== foreignKey && lf.os_crypt.audit_enabled === true);
  if (electronCheckout) {
    const g = await startElectron(rootF);
    const dec = await electronDecrypt(g.main, fBlobs);
    await quitElectron(g);
    check('F: 1.1.4 decrypts with the key the Tauri app stored and keeps it', dec[0]?.text === 'foreign ssh pw ą' && localJson(dataF).os_crypt.encrypted_key === lf.os_crypt.encrypted_key, dec);
  }

  // ---------- G: not JSON ----------
  const rootG = makeRoot('g', '{broken');
  const g1 = await startTauri(rootG);
  const infoG = await g1.bridge('safeStorage', { op: 'info' });
  await quitTauri(g1);
  const dataG = join(rootG, 'data');
  check('G: a non-JSON Local State goes to Local State.bad and a new one is created', infoG.origin === 'created' && infoG.storage === 'dpapi'
    && readFileSync(join(dataG, 'Local State.bad'), 'utf8') === '{broken' && !!localJson(dataG).os_crypt?.encrypted_key, infoG);

  // ---------- H: a key in an unknown format ----------
  const unknown = '{"os_crypt":{"encrypted_key":"not base64!"}}';
  const rootH = makeRoot('h', unknown);
  const dataH = join(rootH, 'data');
  const h1 = await startTauri(rootH);
  const infoH = await h1.bridge('safeStorage', { op: 'info' });
  await sleep(300);
  check('H: a key in an unknown format: unavailable', infoH.storage === 'unavailable' && infoH.origin === 'failed', infoH);
  check('H: startup.log safe-storage-failed, crash.log says why', /\bsafe-storage-failed=\d+/.test(lastStartupLine(dataH)) && /safeStorage unavailable: os_crypt.encrypted_key in Local State is not a DPAPI key/.test(crashLog(dataH)));
  await quitTauri(h1);
  check('H: the file is left alone', readFileSync(localState(dataH), 'utf8') === unknown && !existsSync(join(dataH, 'Local State.bad')));

  check('the real profile was not touched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
} catch (error) {
  check('check ran to the end', false, error.stack ?? String(error));
} finally {
  for (const child of children) killTree(child);
  if (keep) console.log(`scratch kept: ${scratchRoot}`);
  else { await sleep(500); removeScratch(scratchRoot); }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
