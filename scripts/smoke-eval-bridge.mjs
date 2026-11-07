// Eval-bridge smoke of the Tauri check build (PLAN W2 acceptance; CI job "macOS eval-bridge smoke"): starts the check build on
// a scratch data dir and home with MC_EVAL_PORT, and over the eval bridge (no CDP on macOS) checks that the renderer boots,
// the WebKit shims are in place (requestIdleCallback, crypto.randomUUID, AudioContext resume, the Cmd+V paste guard), and,
// on macOS, that the app menu is 1.1.4's app + Edit menu and WebKit's text substitutions are registered off. Runs on Windows
// too (Chromium: no shims needed, no menu), which is how the bridge is tested without a Mac. Offscreen, nothing on the desktop.
//
//   npm run build:check && node scripts/smoke-eval-bridge.mjs          (--keep leaves the scratch dir)
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeScratch } from './app-env.mjs';
import { connectEval } from './eval-bridge.mjs';
import { freePort, killTree, launchApp, realProfileMarkers, sleep, waitExit } from './tauri-app.mjs';

const keep = process.argv.includes('--keep');
const mac = process.platform === 'darwin';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const scratch = mkdtempSync(join(tmpdir(), 'unimux-evalbridge-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const markersBefore = realProfileMarkers();
const port = await freePort();
const child = launchApp({ dataDir, scratch, extraEnv: { MC_EVAL_PORT: String(port) } });
let page;
try {
  page = await connectEval(port, { timeoutMs: 60000 });
  check('eval bridge listens', true, `127.0.0.1:${port}`);

  // Booted: the store says ready (the same signal smoke-tauri waits for over CDP). Short per-call timeouts while loading.
  const deadline = Date.now() + 60000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = await page.evaluate('window.__mc?.useStore?.getState?.().ready === true', { timeoutMs: 3000 }).catch(() => false);
    if (!ready) await sleep(250);
  }
  check('renderer boots', ready);

  check('expression errors come back as errors', await page.evaluate('(() => { throw new Error("boom"); })()').then(() => false, (e) => /boom/.test(e.message)));
  check('values come back by value', JSON.stringify(await page.evaluate('Promise.resolve({ a: [1, "ą"], u: undefined })')) === '{"a":[1,"ą"]}');

  const compat = await page.evaluate(`(() => {
    const c = window.__MC_COMPAT__;
    let uuid = null; try { uuid = crypto.randomUUID(); } catch (e) { uuid = 'throws: ' + e; }
    return { compat: c, frozen: Object.isFrozen(c), ric: typeof requestIdleCallback, cic: typeof cancelIdleCallback, uuid,
      audio: typeof (window.AudioContext ?? window.webkitAudioContext), platform: window.mc.platform };
  })()`);
  check('compat report present', compat.compat && compat.frozen, compat.compat);
  check('engine matches the platform', compat.compat?.engine === (mac ? 'webkit' : 'chromium') && compat.platform === (mac ? 'darwin' : 'win32'), compat.compat?.engine);
  check('requestIdleCallback present', compat.ric === 'function' && compat.cic === 'function');
  check('crypto.randomUUID gives a v4 uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(compat.uuid ?? ''), compat.uuid);
  check('AudioContext present', compat.audio === 'function');
  check('WebKit-only shims (audio resume, paste guard) only on WebKit', compat.compat?.audioResume === mac && compat.compat?.pasteGuard === mac);
  const idle = await page.evaluate('new Promise((res) => requestIdleCallback((d) => res({ left: d.timeRemaining(), timeout: d.didTimeout }), { timeout: 2000 }))');
  check('an idle callback runs', typeof idle?.left === 'number' && idle.left >= 0 && idle.left <= 50, idle);

  const os = await page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'macos', args: null })`);
  if (mac) {
    const titles = (os.menu ?? []).map((m) => m.text);
    check('menu bar is unimux + Edit', JSON.stringify(titles) === '["unimux","Edit"]', titles);
    const all = JSON.stringify(os.menu).toLowerCase();
    check('no reload / close in the menu', !/reload|close/.test(all));
    const edit = (os.menu?.[1]?.items ?? []).map((i) => i.text);
    check('Edit menu has the 1.1.4 items', ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Delete', 'Select All'].every((t) => edit.includes(t)), edit);
    const defaults = os.textDefaults ?? {};
    check('WebKit text substitutions off', Object.keys(defaults).length === 7 && Object.values(defaults).every((v) => v === false), defaults);
  } else {
    check('no app menu on Windows', os.menu === null, os.menu);
  }
} catch (error) {
  check('smoke ran', false, error.stack ?? String(error));
} finally {
  page?.close();
  killTree(child);
  await waitExit(child, 10000);
  check('real profile untouched', JSON.stringify(realProfileMarkers()) === JSON.stringify(markersBefore));
  if (!keep) {
    // WebView2's helper processes let go of the data folder a moment after the tree kill.
    for (let i = 0; i < 5 && existsSync(scratch); i++) { await sleep(1000); removeScratch(scratch); }
  } else console.log(`scratch kept: ${scratch}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
