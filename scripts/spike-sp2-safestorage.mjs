// SP2 spike: Electron 1.1.4 safeStorage blobs <-> unimux-oscrypt (Rust), both directions, on a scratch data dir.
//
//   node scripts/spike-sp2-safestorage.mjs --electron <checkout of main (1.1.4) with `npm run build` done> [--fixtures <dir>] [--keep]
//
// A. 1.1.4 (unpackaged, MC_DATA_DIR scratch, scratch home) stores an SSH password, an SSH key with a saved passphrase and a
//    DB password through its own IPC, and a GitHub token through its own safeStorage (1.1.4 ships without an OAuth client id,
//    so its device flow cannot store one); it quits normally.
// B. Rust (examples/sp2_tool) decrypts every blob, then replaces each with a fresh Rust encryption. Local State untouched.
// C. 1.1.4 starts again: its vaults report nothing locked and its safeStorage decrypts every Rust blob to the same text.
// D. Fresh install: Rust creates Local State in a new dir; 1.1.4 started on that dir decrypts Rust's blobs, keeps the key,
//    and Rust decrypts what 1.1.4 wrote there.
// Never touches the real %APPDATA%\unimux, ~/.claude or ~/.codex; kills only the processes it started.
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { launchApp, mainInspector, sleep, sshState, testHost, writeState } from './ssh-ui-lib.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const electronCheckout = resolve(arg('--electron') ?? '');
const fixtures = arg('--fixtures') ? resolve(arg('--fixtures')) : null;
const keep = process.argv.includes('--keep');
if (!existsSync(join(electronCheckout, 'out', 'main', 'index.js'))) throw new Error('--electron must point at a built 1.1.4 checkout');

const SECRETS = {
  ssh: 'ssh-pass zażółć 🔑 "quoted" \\ end',
  passphrase: 'key passphrase ł',
  db: 'db-pass Ünïcode 数据库',
  github: 'gho_sp2SpikeThrowawayToken0123456789abcdef',
};
const FILES = ['ssh/vault.json', 'db/vault.json', 'github/token.json'];

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };
const sha = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
const encryptedKey = (dir) => JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')).os_crypt?.encrypted_key;

// The Rust tool (built in the dev profile through the MSVC environment).
const tauri = join(repo, 'src-tauri');
execFileSync(process.execPath, [join(repo, 'scripts', 'msvc-run.mjs'), 'cargo', 'build', '-q', '-p', 'unimux-oscrypt', '--example', 'sp2_tool'], { cwd: tauri, stdio: 'inherit' });
const tool = join(tauri, 'target', 'debug', 'examples', process.platform === 'win32' ? 'sp2_tool.exe' : 'sp2_tool');
const rust = (...args) => execFileSync(tool, args, { encoding: 'utf8', windowsHide: true });
const rustJson = (...args) => JSON.parse(rust(...args));

const root = mkdtempSync(join('D:\\Projekty', '_tmp-sp2-'));
const freshRoot = join(root, 'fresh');
for (const dir of [join(root, 'data'), join(root, 'project'), join(root, 'home', 'AppData', 'Roaming'), join(root, 'home', 'AppData', 'Local'),
  join(freshRoot, 'data'), join(freshRoot, 'project'), join(freshRoot, 'home', 'AppData', 'Roaming'), join(freshRoot, 'home', 'AppData', 'Local')]) mkdirSync(dir, { recursive: true });
const data = join(root, 'data');
const host = testHost(2222);

/** Starts 1.1.4 on `base` (cwd = the Electron checkout) with the Node inspector on its main process. */
async function start(base) {
  const inspectPort = 9400 + Math.floor(Math.random() * 400);
  const here = process.cwd();
  process.chdir(electronCheckout);
  try {
    const app = await launchApp(base, {}, [`--inspect=${inspectPort}`]);
    const main = await mainInspector(inspectPort);
    return { app, main };
  } finally { process.chdir(here); }
}

/** Quits through app.quit() (Chromium writes Local State on the way out) and waits for the process to end. */
async function quit({ app, main }) {
  await main.evaluate('setTimeout(() => __el.app.quit(), 50), true').catch(() => {});
  main.close();
  for (let i = 0; i < 100; i++) {
    try { process.kill(app.pid, 0); } catch { return; }
    await sleep(100);
  }
  await app.close();
}

/** safeStorage.decryptString in the 1.1.4 main process, plus its time per call. */
const electronDecrypt = (main, blobs) => main.evaluate(`(() => {
  const out = [];
  for (const b of ${JSON.stringify(blobs)}) {
    try {
      const buf = Buffer.from(b, 'base64');
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) __el.safeStorage.decryptString(buf);
      const micros = (performance.now() - t0) * 1000 / 20;
      out.push({ text: __el.safeStorage.decryptString(buf), micros });
    } catch (e) { out.push({ error: String(e.message) }); }
  }
  return out;
})()`);

const writeToken = (main, dir) => main.evaluate(`(() => {
  const fs = process.mainModule.require('fs'), path = process.mainModule.require('path');
  const file = path.join(${JSON.stringify(dir)}, 'github', 'token.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = __el.safeStorage.encryptString(${JSON.stringify(SECRETS.github)}).toString('base64');
  fs.writeFileSync(file, JSON.stringify({ version: 1, login: 'sp2-spike', savedAt: Date.now(), secret }, null, 1));
  return secret;
})()`);

const texts = (report, file) => report.files[file].map((e) => e.text);
const expectedSsh = [SECRETS.ssh];

try {
  // ---------- A: 1.1.4 writes ----------
  writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host] }));
  const a = await start(root);
  const env = await a.main.evaluate(`({ electron: process.versions.electron, chrome: process.versions.chrome, name: __el.app.getName(), userData: __el.app.getPath('userData'),
    available: __el.safeStorage.isEncryptionAvailable(), localStateAtStart: process.mainModule.require('fs').existsSync(process.mainModule.require('path').join(__el.app.getPath('userData'), 'Local State')) })`);
  console.log('1.1.4 runtime', env);
  check('A: 1.1.4 runs on the scratch data dir', resolve(env.userData) === resolve(data), env.userData);
  console.log(`Local State on disk right after start (after isEncryptionAvailable): ${env.localStateAtStart}`);
  check('A: safeStorage available', env.available);
  const pw = await a.app.evaluate(`window.mc.ssh.setPassword(${JSON.stringify(host.id)}, ${JSON.stringify(SECRETS.ssh)})`);
  check('A: ssh password saved by 1.1.4', pw?.ok && !pw.ephemeral, pw);
  const tSaved = Date.now();
  while (!existsSync(join(data, 'Local State')) && Date.now() - tSaved < 30000) await sleep(100);
  console.log(`Local State appeared ${existsSync(join(data, 'Local State')) ? `${Date.now() - tSaved} ms after the first encryptString` : 'not within 30 s of the first encryptString'}`);
  const key = await a.app.evaluate(`window.mc.ssh.generateKey({ label: 'sp2', type: 'ed25519', comment: 'sp2-spike', passphrase: ${JSON.stringify(SECRETS.passphrase)}, savePassphrase: true })`);
  check('A: ssh key with passphrase saved by 1.1.4', key?.ok, key?.ok ? key.key.fingerprint : key);
  const db = await a.app.evaluate(`window.mc.db.saveConnection({ kind: 'postgres', name: 'sp2 pg', host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres', tls: 'prefer', ssh: null, readOnly: false }, { set: ${JSON.stringify(SECRETS.db)} })`);
  check('A: db password saved by 1.1.4', db?.ok, db?.ok ? undefined : db);
  await writeToken(a.main, data);
  const vaultA = await a.app.evaluate('window.mc.ssh.vaultInfo()');
  check('A: ssh vault storage label is dpapi', vaultA.storage === 'dpapi', vaultA.storage);
  await quit(a);

  const localA = sha(join(data, 'Local State'));
  const keyA = encryptedKey(data);
  const electronBlobs = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(data, f), 'utf8')]));
  const localStateA = readFileSync(join(data, 'Local State'), 'utf8');

  // ---------- B: Rust reads and re-encrypts ----------
  const before = rustJson('inspect', data);
  console.log('Local State top-level keys', before.localStateKeys, 'os_crypt keys', before.osCryptKeys);
  check('B: Rust opens the existing key', before.storage === 'dpapi' && before.origin === 'Existing', `${before.origin}, ${before.openMillis.toFixed(2)} ms`);
  check('B: Electron wraps the key with audit_enabled', JSON.parse(readFileSync(join(data, 'Local State'), 'utf8')).os_crypt.audit_enabled === true);
  check('B: no app-bound (v20) key in Local State', !before.osCryptKeys.includes('app_bound_encrypted_key'), before.osCryptKeys);
  const allA = FILES.flatMap((f) => before.files[f]);
  check('B: every Electron 45 blob starts with v10', allA.length === 4 && allA.every((e) => e.prefix === 'v10'), allA.map((e) => e.prefix));
  check('B: Rust decrypts the 1.1.4 ssh password', JSON.stringify(texts(before, 'ssh/vault.json').filter((t) => !t.startsWith('{'))) === JSON.stringify(expectedSsh));
  const keySecret = texts(before, 'ssh/vault.json').find((t) => t.startsWith('{'));
  const keyPlain = keySecret ? JSON.parse(keySecret) : {};
  check('B: Rust decrypts the 1.1.4 ssh key secret', keyPlain.passphrase === SECRETS.passphrase && /BEGIN OPENSSH PRIVATE KEY/.test(keyPlain.privateKey ?? ''));
  check('B: Rust decrypts the 1.1.4 db password', texts(before, 'db/vault.json')[0] === SECRETS.db);
  check('B: Rust decrypts the 1.1.4 GitHub token', texts(before, 'github/token.json')[0] === SECRETS.github);
  const keyHex = rust('export-key', data).trim();
  const rewritten = rustJson('rewrite', data);
  check('B: Rust replaced all 4 blobs', rewritten.length === 4 && rewritten.every((r) => r.old !== r.new));
  check('B: Local State not touched by Rust', sha(join(data, 'Local State')) === localA);
  const after = rustJson('inspect', data);
  check('B: Rust reads its own blobs back', FILES.every((f) => JSON.stringify(texts(after, f)) === JSON.stringify(texts(before, f))));
  const rustBlobs = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(data, f), 'utf8')]));

  // ---------- C: 1.1.4 reads Rust's blobs ----------
  const c = await start(root);
  const vaultC = await c.app.evaluate('window.mc.ssh.vaultInfo()');
  check('C: 1.1.4 ssh vault: password saved and not locked', vaultC.savedPasswords.includes(host.id) && vaultC.lockedPasswords.length === 0, vaultC);
  check('C: 1.1.4 ssh vault: key not locked', vaultC.keys.length === 1 && !vaultC.keys[0].locked, vaultC.keys.map((k) => ({ locked: k.locked, hasPassphrase: k.hasSavedPassphrase ?? k.passphraseSaved })));
  const dbC = await c.app.evaluate('window.mc.db.vaultInfo()');
  check('C: 1.1.4 db vault lists the password, none locked', dbC.saved.length === 1 && dbC.locked.length === 0, dbC);
  const decC = await electronDecrypt(c.main, rewritten.map((r) => r.new));
  const plainByNew = Object.fromEntries(rewritten.map((r, i) => [r.new, decC[i]]));
  const expectedByNew = Object.fromEntries(FILES.flatMap((f) => {
    const olds = rewritten.filter((r) => r.file === f);
    return olds.map((r, i) => [r.new, texts(before, f)[i]]);
  }));
  check('C: 1.1.4 safeStorage decrypts every Rust blob to the same text', rewritten.every((r) => plainByNew[r.new]?.text === expectedByNew[r.new]),
    rewritten.map((r) => plainByNew[r.new]?.error ?? 'ok'));
  const vaultFilesC = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(data, f), 'utf8')]));
  check('C: 1.1.4 did not rewrite the vault files on start', FILES.every((f) => vaultFilesC[f] === rustBlobs[f]));
  await quit(c);
  check('C: os_crypt.encrypted_key unchanged after 1.1.4 ran again', encryptedKey(data) === keyA);
  const localC = sha(join(data, 'Local State'));
  console.log(`Local State bytes after the second 1.1.4 run ${localC === localA ? 'unchanged' : 'changed (Chromium rewrote other prefs, key kept)'}`);

  // ---------- D: fresh install, Rust creates Local State ----------
  const freshData = join(freshRoot, 'data');
  const freshTexts = ['fresh ssh pw ą', SECRETS.github];
  const fresh = rustJson('fresh', freshData, ...freshTexts);
  check('D: Rust created Local State in a dir without one', fresh.origin === 'Created' && existsSync(join(freshData, 'Local State')), `${fresh.openMillis.toFixed(2)} ms`);
  const rustKey = encryptedKey(freshData);
  writeState(freshRoot, sshState({ projectPath: join(freshRoot, 'project'), hosts: [host] }));
  const d = await start(freshRoot);
  const decD = await electronDecrypt(d.main, freshTexts.map((t) => fresh.blobs[t]));
  check('D: 1.1.4 decrypts blobs made with the Rust-created key', decD.every((r, i) => r.text === freshTexts[i]), decD.map((r) => r.error ?? 'ok'));
  await d.app.evaluate(`window.mc.ssh.setPassword(${JSON.stringify(host.id)}, ${JSON.stringify(SECRETS.ssh)})`);
  await quit(d);
  check('D: 1.1.4 kept the Rust-created key', encryptedKey(freshData) === rustKey);
  const freshInspect = rustJson('inspect', freshData);
  check('D: Rust decrypts what 1.1.4 wrote with that key', texts(freshInspect, 'ssh/vault.json')[0] === SECRETS.ssh);
  const freshLocalState = readFileSync(join(freshData, 'Local State'), 'utf8');
  console.log('Local State written by 1.1.4 over the Rust-created one, top-level keys:', Object.keys(JSON.parse(freshLocalState)));

  // ---------- E: an idle 1.1.4 run (no secret stored): is there a key in Local State? ----------
  const idleRoot = join(root, 'idle');
  for (const dir of ['data', 'project', 'home/AppData/Roaming', 'home/AppData/Local']) mkdirSync(join(idleRoot, dir), { recursive: true });
  writeState(idleRoot, sshState({ projectPath: join(idleRoot, 'project') }));
  const e = await start(idleRoot);
  const idleLocal = join(idleRoot, 'data', 'Local State');
  const tIdle = Date.now();
  while (!existsSync(idleLocal) && Date.now() - tIdle < 20000) await sleep(200);
  const idleBefore = existsSync(idleLocal) ? readFileSync(idleLocal, 'utf8') : null;
  console.log(`E: idle 1.1.4: Local State ${idleBefore ? `written ${Date.now() - tIdle} ms after the window appeared` : 'not written within 20 s'}`);
  await quit(e);
  const idleAfter = existsSync(idleLocal) ? JSON.parse(readFileSync(idleLocal, 'utf8')) : null;
  console.log('E: Local State after an idle 1.1.4 run:', idleAfter ? { keys: Object.keys(idleAfter), osCrypt: Object.keys(idleAfter.os_crypt ?? {}) } : 'none');
  check('E: an idle 1.1.4 run still leaves an os_crypt key (so "Local State exists" implies "key exists")', !idleAfter || !!idleAfter.os_crypt?.encrypted_key);

  // ---------- measurements ----------
  const decryptMicros = allA.map((e) => e.decryptMicros);
  console.log(`Rust: open (Local State + DPAPI) ${before.openMillis.toFixed(2)} ms; AES-GCM decrypt per blob ${Math.min(...decryptMicros).toFixed(1)}-${Math.max(...decryptMicros).toFixed(1)} us (debug profile)`);
  console.log(`Electron 1.1.4: decryptString per blob ${decC.map((r) => r.micros?.toFixed(1)).join(', ')} us`);

  // ---------- fixtures ----------
  if (fixtures) {
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(join(fixtures, 'Local State'), localStateA);
    writeFileSync(join(fixtures, 'key.hex'), `${keyHex}\n`);
    for (const [name, files] of [['electron', electronBlobs], ['rust', rustBlobs]]) {
      for (const f of FILES) { mkdirSync(join(fixtures, name, dirname(f)), { recursive: true }); writeFileSync(join(fixtures, name, f), files[f]); }
    }
    writeFileSync(join(fixtures, 'expected.json'), `${JSON.stringify({
      electron: env.electron, chrome: env.chrome,
      'ssh/vault.json': texts(before, 'ssh/vault.json').map((t) => (t.startsWith('{') ? { passphrase: JSON.parse(t).passphrase, privateKeyStartsWith: '-----BEGIN OPENSSH PRIVATE KEY-----' } : t)),
      'db/vault.json': texts(before, 'db/vault.json'),
      'github/token.json': texts(before, 'github/token.json'),
    }, null, 1)}\n`);
    // macOS 'v10' vectors from Node's crypto (Chromium's algorithm: PBKDF2-HMAC-SHA1 saltysalt 1003 -> AES-128-CBC, IV 16 spaces).
    const password = randomBytes(16).toString('base64');
    const macKey = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const mac = ['', 'a', '0123456789abcdef', SECRETS.ssh, SECRETS.db, SECRETS.github].map((text) => {
      const c = createCipheriv('aes-128-cbc', macKey, Buffer.alloc(16, ' '));
      return { text, blob: Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]).toString('base64') };
    });
    writeFileSync(join(fixtures, 'mac-v10.json'), `${JSON.stringify({ password, key: macKey.toString('hex'), vectors: mac }, null, 1)}\n`);
    copyFileSync(join(freshData, 'Local State'), join(fixtures, 'Local State.after-fresh'));
    console.log(`fixtures written to ${fixtures}`);
  }
} catch (error) {
  check('spike ran to the end', false, error.stack ?? String(error));
} finally {
  if (keep) console.log(`scratch kept: ${root}`);
  else removeScratch(root);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
