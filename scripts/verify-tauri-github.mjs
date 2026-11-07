// Real-app check of the GitHub sign-in (1.2.0, PLAN A6) on the `check` build: the github/token.json and `Local State` that
// unimux 1.1.4 (Electron 45.2.2) wrote on the SP2 throwaway profile are put into a scratch data dir, and window.mc.github
// answers what 1.1.4 answers: the quick status shows the stored sign-in (the 1.1.4 blob decrypts in place, the file and
// Local State stay byte for byte), sign-out removes the file, the full status asks `gh` and finds no sign-in, the device flow
// is hidden (no OAuth App in 1.1.4), bad flow ids answer "cancelled". The `gh` the app runs is a stand-in first on its PATH
// (a copy of where.exe: it exits 1 for `auth token ...`, i.e. "signed out"), so the usual places (C:\Program Files\GitHub
// CLI\gh.exe) are never tried: a real gh answers from the Windows Credential Manager even with a scratch GH_CONFIG_DIR, and
// the user's own sign-in must never be read. No request reaches github.com. Scratch data dir and home only; ends only the
// processes it started. Windows only.
//
//   npm run build:check && node scripts/verify-tauri-github.mjs
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sha256, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'src-tauri/crates/unimux-oscrypt/tests/fixtures/win-electron45');
const keep = process.argv.includes('--keep');
if (process.platform !== 'win32') {
  console.log('skip: the gh stand-in and the SP2 fixture are Windows only');
  process.exit(0);
}

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CANCELLED = { ok: false, code: 'cancelled', error: 'Logowanie zostało anulowane.' };
const NO_CLIENT = { ok: false, code: 'no-client', error: 'Logowanie przez przeglądarkę nie jest dostępne w tej wersji.' };

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-github-'));
const dataDir = join(scratch, 'data');
const ghConfig = join(scratch, 'gh-config');
mkdirSync(join(dataDir, 'github'), { recursive: true });
mkdirSync(ghConfig, { recursive: true });
const ghStub = join(scratch, 'gh-stub');
mkdirSync(ghStub, { recursive: true });
copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), join(ghStub, 'gh.exe'));
const tokenFile = join(dataDir, 'github', 'token.json');
copyFileSync(join(fixture, 'electron/github/token.json'), tokenFile);
copyFileSync(join(fixture, 'Local State'), join(dataDir, 'Local State'));
const tokenHash = sha256(readFileSync(tokenFile));
const localStateHash = sha256(readFileSync(join(dataDir, 'Local State')));
console.log(`scratch: ${scratch}`);

let child;
try {
  const port = await freePort();
  // The stand-in gh first on the PATH; a scratch gh config and no token variables on top.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const extraEnv = { [pathKey]: `${ghStub}${delimiter}${process.env[pathKey] ?? ''}`, GH_CONFIG_DIR: ghConfig, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined, GH_HOST: undefined };
  child = launchApp({ dataDir, scratch, port, extraEnv });
  const page = await connectPage(port, { timeoutMs: 45000 });
  await waitFor(page, `typeof window.mc?.github?.status === 'function'`, 30000, 'window.mc.github');
  const call = (expr) => page.evaluate(expr);

  const quick = await call(`window.mc.github.status({ local: true })`);
  const fixtureUser = quick.signedIn === true;
  if (!fixtureUser && quick.storage === 'dpapi') {
    console.log('note: the fixture Local State belongs to another Windows user (SP2 throwaway profile); the stored-token half is skipped');
  }
  if (fixtureUser) {
    check('the 1.1.4 token decrypts: quick status shows the stored sign-in', same(quick, { deviceFlow: false, storage: 'dpapi', signedIn: true, source: 'stored', login: 'sp2-spike' }), JSON.stringify(quick));
    check('reading the 1.1.4 files rewrites neither token.json nor Local State', sha256(readFileSync(tokenFile)) === tokenHash && sha256(readFileSync(join(dataDir, 'Local State'))) === localStateHash);
    const out = await call(`window.mc.github.signOut()`);
    check('sign-out answers the local status', same(out, { deviceFlow: false, storage: 'dpapi', signedIn: false, source: null, login: null }), JSON.stringify(out));
    check('sign-out removes github/token.json', !existsSync(tokenFile));
  }
  const full = await call(`window.mc.github.status()`);
  check('full status: gh (stand-in, signed out) gives no sign-in', same(full, { deviceFlow: false, storage: 'dpapi', signedIn: false, source: null, login: null }), JSON.stringify(full));
  check('options other than { local: true } are the full status', same(await call(`window.mc.github.status({ local: 'yes' })`), full));
  check('device flow hidden without an OAuth App (no-client)', same(await call(`window.mc.github.deviceStart()`), NO_CLIENT));
  check('deviceWait with a bad id answers cancelled', same(await call(`window.mc.github.deviceWait('not-a-flow')`), CANCELLED));
  check('deviceWait with an unknown id answers cancelled', same(await call(`window.mc.github.deviceWait('00000000-0000-4000-8000-000000000000')`), CANCELLED));
  check('deviceCancel answers undefined', (await call(`window.mc.github.deviceCancel('00000000-0000-4000-8000-000000000000').then((v) => v === undefined || v === null)`)) === true);
  check('no token file was written', !existsSync(tokenFile));
  page.close();
} catch (error) {
  failed = true;
  console.log(`FAIL ${error.stack ?? error}`);
} finally {
  killTree(child);
  if (child) await waitExit(child, 10000);
}
check('the real profile was not touched', same(realProfileMarkers(), markersBefore));
if (!keep) removeScratch(scratch);
console.log(failed ? 'FAILED' : 'all checks passed');
process.exit(failed ? 1 : 0);
