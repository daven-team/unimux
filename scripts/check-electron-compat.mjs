// Electron 1.1.x and the Tauri build on the same data dir (PLAN F6, release gate item 6): never both at once. Starts the
// Electron build of this tree (`npm run build`, the 1.1.4 code with the shared window.mc table) and the Tauri `check` build on
// one scratch data dir, each while the other runs, and checks that the second one hands over and exits without writing
// state.json. Also checks that the Electron preload still provides window.mc after the mcApi.ts refactor.
//
//   npm run build && npm run build:check && node scripts/check-electron-compat.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, sha256, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const scratch = mkdtempSync(join(tmpdir(), 'unimux-compat-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const stateFile = join(dataDir, 'state.json');
writeFileSync(stateFile, JSON.stringify({ version: 1, projects: [], activeProjectId: null, settings: { language: 'pl', fontSize: 13 } }));

function launchElectron(port) {
  const { env: homeEnv } = scratchHome(scratch);
  const env = scrubAppEnv({ ...process.env, ...homeEnv, MC_DATA_DIR: dataDir, MC_OFFSCREEN: '1', ...(port ? { MC_DEBUG_PORT: String(port) } : {}) });
  return spawn(electronPath, [root], { env, stdio: 'ignore', windowsHide: true });
}
const fingerprint = () => { const s = statSync(stateFile); return `${sha256(readFileSync(stateFile))} ${s.mtimeMs}`; };

const children = [];
try {
  // ── Electron first ───────────────────────────────────────────────────────
  const ePort = await freePort();
  const electron = launchElectron(ePort);
  children.push(electron);
  const page = await connectPageAny(ePort);
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 60000, 'Electron renderer ready');
  const mc = await page.evaluate('({ platform: window.mc.platform, build: window.mc.windowsBuild, methods: Object.keys(window.mc).length, snap: typeof window.mc.loadSnapshot })');
  check('Electron preload provides window.mc from the shared mcApi.ts', mc.platform === 'win32' && mc.build > 0 && mc.snap === 'function' && mc.methods > 100, JSON.stringify(mc));
  await sleep(1500);
  const before = fingerprint();
  const tauri = launchApp({ dataDir, scratch });
  children.push(tauri);
  const code = await waitExit(tauri, 20000);
  check('Tauri started while Electron runs on the same dir exits with 0', code === 0, `exit ${code}`);
  await sleep(1000);
  check('... and did not write state.json', fingerprint() === before);
  check('Electron still runs', (await page.evaluate('1 + 2')) === 3);
  page.close();
  killTree(electron);
  await waitExit(electron, 10000);
  await sleep(1500);

  // ── Tauri first ──────────────────────────────────────────────────────────
  const tPort = await freePort();
  const app = launchApp({ dataDir, scratch, port: tPort });
  children.push(app);
  const tPage = await connectPage(tPort, { timeoutMs: 45000 });
  await waitFor(tPage, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'Tauri renderer ready');
  await sleep(1500);
  const before2 = fingerprint();
  const late = launchElectron();
  children.push(late);
  const lateCode = await waitExit(late, 30000);
  check('Electron started while Tauri runs on the same dir quits', lateCode !== null, `exit ${lateCode}`);
  await sleep(1000);
  check('... and did not write state.json', fingerprint() === before2);
  check('Tauri still runs', (await tPage.evaluate('2 + 3')) === 5);
  await tPage.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'quit', args: null })`).catch(() => undefined);
  tPage.close();
  await waitExit(app, 15000);
} catch (error) {
  console.error(error);
  results.push({ name: 'aborted', ok: false });
} finally {
  for (const child of children) killTree(child);
}

/** The Electron page is a file:// URL; the Tauri helper looks for tauri.localhost. */
async function connectPageAny(port) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && t.url.startsWith('file:') && t.url.includes('index.html') && !t.url.includes('detached='));
      if (target) return await connectPage(port, { timeoutMs: 1000, match: target.id });
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('no Electron page');
    await sleep(300);
  }
}

const bad = results.filter((r) => !r.ok);
if (!bad.length) removeScratch(scratch);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
