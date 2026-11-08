// B2 acceptance: Electron safeStorage in the real Tauri app (unimux-oscrypt SafeStorage through AppContext), on scratch data
// dirs only. The 1.1.4 side is the committed SP2 fixture (a profile 1.1.4 made); until R1 a `--electron <checkout>` mode also
// ran 1.1.4 from a source checkout next to the Tauri app (safeStorage both ways), which left with Electron.
//
//   npm run build:check && node scripts/verify-safestorage.mjs [--keep]
//
// A. The SP2 fixture (an SSH password, an SSH key with a saved passphrase, a DB password and a GitHub token as 1.1.4 stored
//    them) is copied into a scratch data dir; its DPAPI key unwraps only for the Windows user who made it, so B is skipped
//    for anyone else.
// B. The Tauri check build on that data dir: the key was opened at start (Windows, like OSCrypt::Init) and found, startup.log
//    says so, every secret decrypts to the text 1.1.4 stored, Rust re-encrypts each in place, Local State is never touched.
// D. Fresh install: the Tauri app creates Local State at start; a restart finds it and decrypts.
// E. MC_SSH_NO_SAFESTORAGE: exactly "1" makes storage report unavailable, "true" does not (1.1.x `=== '1'`); as in 1.1.4 the
//    key is still opened (Local State written at start) and existing blobs still decrypt.
// F/G/H. A Local State without a usable key: a foreign DPAPI key (new key stored, other prefs kept, Origin Replaced in
//    startup.log and crash.log), a non-JSON file (`Local State.bad`, created anew), a key in an unknown format (unavailable,
//    file left alone).
// Never touches the real %APPDATA%\unimux, ~/.claude or ~/.codex; ends only the processes it started; no window on the
// desktop (MC_OFFSCREEN).
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
if (process.argv.includes('--electron')) throw new Error('--electron (1.1.4 from a source checkout) was removed with Electron in 1.2.0 (R1)');
const fixtureDir = join(repo, 'src-tauri', 'crates', 'unimux-oscrypt', 'tests', 'fixtures', 'win-electron45');

const SECRETS = { github: 'gho_b2CheckThrowawayToken0123456789abcdef' };
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

const markersBefore = realProfileMarkers();
try {
  // ---------- A: secrets as 1.1.4 stored them (the committed SP2 fixture) ----------
  const rootA = makeRoot('a');
  const dataA = join(rootA, 'data');
  cpSync(join(fixtureDir, 'Local State'), localState(dataA));
  for (const f of FILES) { mkdirSync(dirname(join(dataA, f)), { recursive: true }); cpSync(join(fixtureDir, 'electron', f), join(dataA, f)); }
  const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8'));
  const localA = sha(localState(dataA));
  const matches = (got, want) => (typeof want === 'string' ? got === want : (() => { try { const v = JSON.parse(got); return v.passphrase === want.passphrase && /BEGIN OPENSSH PRIVATE KEY/.test(v.privateKey ?? ''); } catch { return false; } })());

  // ---------- B: the Tauri app reads and re-encrypts ----------
  const b = await startTauri(rootA);
  const infoB = await b.bridge('safeStorage', { op: 'info' });
  if (infoB.origin === 'replaced') {
    console.log('SKIP B: the fixture Local State was made by another Windows user (DPAPI is per user); the Tauri app stored a new key as 1.1.4 would');
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
  const localD = sha(localState(dataD));
  const d2 = await startTauri(rootD);
  const infoD2 = await d2.bridge('safeStorage', { op: 'info' });
  const decD2 = await d2.bridge('safeStorage', { op: 'decrypt', secrets: dBlobs });
  check('D: a restart finds the key and decrypts', infoD2.origin === 'existing' && decD2.every((r, k) => r.text === dTexts[k]), { infoD2, decD2: decD2.map((r) => r.error ?? 'ok') });
  await quitTauri(d2);
  check('D: the restart did not rewrite Local State', sha(localState(dataD)) === localD);

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
  const localD1 = sha(localState(dataD));
  const e1b = await startTauri(rootD, { MC_SSH_NO_SAFESTORAGE: '1' });
  const infoE1b = await e1b.bridge('safeStorage', { op: 'info' });
  const decE1b = await e1b.bridge('safeStorage', { op: 'decrypt', secrets: dBlobs });
  check('E: MC_SSH_NO_SAFESTORAGE=1: existing blobs still decrypt while storage says unavailable', infoE1b.storage === 'unavailable' && decE1b.every((r, k) => r.text === dTexts[k]), { infoE1b, decE1b: decE1b.map((r) => r.error ?? 'ok') });
  await quitTauri(e1b);
  check('E: MC_SSH_NO_SAFESTORAGE=1: Local State of an existing data dir not rewritten', sha(localState(dataD)) === localD1);
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
  await sleep(300);
  check('F: startup.log has the safe-storage-replaced mark', /\bsafe-storage-replaced=\d+/.test(lastStartupLine(dataF)), lastStartupLine(dataF));
  check('F: crash.log says why the key was replaced', /Local State had no usable key, a new one was stored \(the DPAPI key in Local State does not unwrap/.test(crashLog(dataF)));
  await quitTauri(f1);
  const lf = localJson(dataF);
  check('F: other prefs kept, new key stored', lf.browser?.b2_marker === 'keep me' && lf.os_crypt.encrypted_key !== foreignKey && lf.os_crypt.audit_enabled === true);

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
