// Wave 0 exit check of the Tauri build (PLAN F13): starts the `check` build on a scratch copy of a 1.1.4-shaped state.json and
// verifies that the existing UI boots with every project and grid, a renderer edit is saved to state.json atomically and in
// JSON.stringify form (unknown keys kept), a second start on the same data dir hands over and exits, crash.log gets renderer
// reports and panics, the state survives a quit and a restart, and nothing appears in the real profile. Screenshots go to
// artifacts/tauri-smoke/.
//
//   npm run build:check && npm run smoke:tauri          (--keep leaves the scratch dir for inspection)
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, listDir, readText, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'artifacts', 'tauri-smoke');
mkdirSync(shots, { recursive: true });
const keep = process.argv.includes('--keep');

const results = [];
/** Paths whose values differ between two JSON values (and objects whose key order differs). */
function changedPaths(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (obj(a) && obj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) changedPaths(a[k], b[k], `${path}.${k}`, out);
    if (!out.some((p) => p.startsWith(path)) ) out.push(`${path} (key order)`);
    return out;
  }
  out.push(path || '.');
  return out;
}

const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

/** A state.json like 1.1.4 writes it: defaultState plus projects with grids (layouts from the TS code), notes, snippets. */
async function fixtureState() {
  const load = async (file) => (await runnerImport(resolve(root, file), { configFile: false, logLevel: 'silent', root })).module;
  const [{ defaultState }, { layoutForCount }] = await Promise.all([load('src/shared/state.ts'), load('src/shared/layout.ts')]);
  const s = defaultState('win32');
  const profiles = s.profiles.map((p) => p.id);
  const cell = (n, profileId) => ({ id: `cell-${n}`, profileId });
  const tab = (id, name, cells) => ({ id, name, layout: layoutForCount(cells.length), cells });
  const pick = (i) => profiles[i % profiles.length];
  s.projects = [
    { id: 'proj-unimux', name: 'unimux', path: root, color: '#7c5cff', tabs: [
      tab('tab-agents', 'Agenci', [cell(1, pick(0)), cell(2, pick(1)), cell(3, pick(0)), cell(4, pick(2))]),
      tab('tab-server', 'Serwer', [cell(5, pick(2))]),
    ], archive: [], activeTabId: 'tab-agents' },
    { id: 'proj-docs', name: 'Dokumentacja', path: tmpdir(), color: '#2fb380', tabs: [
      tab('tab-wall', 'Ściana 3x2', [1, 2, 3, 4, 5, 6].map((n) => cell(10 + n, pick(n)))),
    ], archive: [], activeTabId: 'tab-wall' },
  ];
  s.activeProjectId = 'proj-unimux';
  s.settings.language = 'pl';
  s.notes = [{ id: 'note-1', title: 'Plan', text: '- [ ] migracja Tauri\n- [x] fala 0', updatedAt: 1762430400000 }];
  s.snippets = [{ id: 'snip-1', name: 'status', text: 'git status' }];
  // A key 1.2.0 does not know (a newer version wrote it): it must survive load and save untouched.
  s.zzFromTheFuture = { kept: true, list: [3, 1.5, 'ą'] };
  // Half an emoji (JSON.stringify writes it as an escaped lone surrogate; JSON.parse in 1.1.x reads it back): the file must
  // load, not be kept aside as corrupt.
  s.snippets.push({ id: 'snip-lone', name: `cut ${'\u{1F600}'.slice(0, 1)}`, text: 'x' });
  return s;
}

const markersBefore = realProfileMarkers();
const scratch = mkdtempSync(join(tmpdir(), 'unimux-tauri-smoke-'));
const dataDir = join(scratch, 'data');
mkdirSync(dataDir, { recursive: true });
const stateFile = join(dataDir, 'state.json');
const fixture = await fixtureState();
writeFileSync(stateFile, JSON.stringify(fixture));
console.log(`scratch: ${scratch}`);

const children = [];
const start = async () => {
  const port = await freePort();
  const child = launchApp({ dataDir, scratch, port });
  children.push(child);
  const page = await connectPage(port, { timeoutMs: 45000 });
  return { child, page, port };
};
const bridge = (page, op, args) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: args ?? null })})`);
const screenshot = async (page, name) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = join(shots, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};

let failed = false;
try {
  // ── first start ──────────────────────────────────────────────────────────
  const first = await start();
  const page = first.page;
  const errors = [];
  await page.send('Runtime.enable');
  page.onEvent((m) => { if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text); });
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready');
  await sleep(1500);
  const view = await page.evaluate(`(() => { const s = window.__mc.useStore.getState().s; return { projects: s.projects.map((p) => ({ name: p.name, tabs: p.tabs.map((t) => ({ name: t.name, cells: t.cells.length, areas: t.layout.areas.length })) })), active: s.activeProjectId, language: s.settings.language, future: s.zzFromTheFuture }; })()`);
  check('state loaded into the UI (projects, grids)', view.projects.length === 2 && view.projects[0].tabs[0].cells === 4 && view.projects[1].tabs[0].cells === 6 && view.projects[0].tabs[0].areas === 4, JSON.stringify(view.projects));
  check('unknown keys reach the renderer', view.future?.kept === true);
  const domText = await page.evaluate('document.body.innerText');
  check('project names are on screen', domText.includes('unimux') && domText.includes('Dokumentacja'), domText.slice(0, 120).replace(/\s+/g, ' '));
  const cells = await page.evaluate(`document.querySelectorAll('[data-cell-id], .cell').length`);
  check('grid cells rendered', cells >= 4, `${cells} cell elements`);
  console.log(`screenshot: ${await screenshot(page, '1-boot')}`);
  const boot = await page.evaluate('({ platform: window.mc.platform, windowsBuild: window.mc.windowsBuild, boot: window.__MC_BOOT__ })');
  check('window.mc sync values from __MC_BOOT__', boot.platform === 'win32' && boot.windowsBuild > 0, JSON.stringify(boot));
  const csp = await page.evaluate(`[...document.querySelectorAll('meta[http-equiv]')].length`);
  check('no meta CSP in the Tauri page (Tauri applies app.security.csp)', csp === 0);

  // ── a renderer edit is saved ─────────────────────────────────────────────
  // The renderer saves its own boot-time changes (workspace order, cell fields) first: wait until state.json is quiet.
  let before = readText(stateFile);
  for (let quiet = 0, i = 0; quiet < 8 && i < 60; i++) {
    await sleep(250);
    const now = readText(stateFile);
    quiet = now === before ? quiet + 1 : 0;
    before = now;
  }
  await page.evaluate(`window.__mc.useStore.getState().update((s) => ({ ...s, settings: { ...s.settings, fontSize: 15 } }))`);
  let saved = null;
  for (let i = 0; i < 40 && !saved; i++) {
    await sleep(100);
    try { const t = readText(stateFile); if (JSON.parse(t).settings.fontSize === 15) saved = t; } catch { /* mid-rename */ }
  }
  check('edit saved to state.json within 4 s', !!saved);
  if (saved) {
    check('saved text is JSON.stringify of itself (JS-compatible writer)', JSON.stringify(JSON.parse(saved)) === saved);
    const parsed = JSON.parse(saved);
    check('unknown key kept on save', JSON.stringify(parsed.zzFromTheFuture) === JSON.stringify(fixture.zzFromTheFuture));
    // The one repair Rust makes on load: a lone surrogate reads as U+FFFD (a Rust string cannot hold one).
    const wellFormed = (v) => (typeof v === 'string' ? v.toWellFormed() : Array.isArray(v) ? v.map(wellFormed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wellFormed(x)])) : v);
    const paths = changedPaths(wellFormed(JSON.parse(before)), parsed);
    check('the edit changed settings.fontSize and nothing else (key order kept)', paths.length === 1 && paths[0] === '.settings.fontSize', paths.join(', '));
    console.log(`info: fields the renderer itself changed at boot: ${changedPaths(fixture, JSON.parse(before)).join(', ') || 'none'}`);
  }
  check('no temp files left (atomic write)', !listDir(dataDir).some((n) => n.endsWith('.tmp')), listDir(dataDir).join(', '));
  const peek = await bridge(page, 'state');
  check('Rust state has the edit with a new revision', peek.snapshot.state.settings.fontSize === 15 && peek.snapshot.revision >= 1, `revision ${peek.snapshot.revision}`);

  // ── crash.log ────────────────────────────────────────────────────────────
  await page.evaluate(`window.mc.reportError('smoke', 'renderer report from smoke-tauri', 'at smoke (smoke.js:1:1)')`);
  await bridge(page, 'panic', { message: 'smoke-tauri injected panic' });
  await sleep(800);
  const crash = existsSync(join(dataDir, 'crash.log')) ? readText(join(dataDir, 'crash.log')) : '';
  check('crash.log has the renderer report', /^\S+Z error renderer smoke: renderer report from smoke-tauri$/m.test(crash));
  check('crash.log has the panic', /^\S+Z error panic: smoke-tauri injected panic at .*\(thread test-bridge-panic\)$/m.test(crash));
  const alive = await page.evaluate('1 + 1');
  check('app keeps running after a panic on another thread', alive === 2);

  // ── a not-yet command answers with the typed error ───────────────────────
  // T1 implements sftp:sessions (it answers the empty snapshot now). The first still unported read-only channel of a few
  // candidates (A5 usage, A4 accounts) proves the typed error; once all of them are ported the check is skipped.
  const sftpSessions = await page.evaluate(`window.mc.sftp.sessions().then((s) => JSON.stringify(s), (e) => e.name + ':' + e.code)`);
  check('sftp:sessions answers the empty snapshot', sftpSessions === '{"sessions":[],"prompts":[]}', sftpSessions);
  const notYet = await page.evaluate(`(async () => {
    for (const [method, channel] of [['getUsage', 'usage:get'], ['swapPending', 'accounts:swapPending']]) {
      const r = await window.mc[method]().then(() => 'resolved', (e) => e.name + ':' + e.code + ':' + e.command);
      if (r !== 'resolved') return r === 'McNotYetError:MC_NOT_YET:' + channel ? 'ok' : r;
    }
    return 'all ported';
  })()`);
  check('unported command rejects with McNotYetError', notYet === 'ok' || notYet === 'all ported', notYet);
  const lone = await page.evaluate(`window.__mc.useStore.getState().s.snippets.find((x) => x.id === 'snip-lone')?.name`);
  check('a state.json with a lone surrogate loads (not kept aside as corrupt)', lone === 'cut \ufffd' && !listDir(dataDir).some((n) => n.startsWith('state.json.bak-')), JSON.stringify(lone));
  const raw = await page.evaluate(`window.mc.notes.saveImage(new Uint8Array([1, 2, 3]), 'image/png').then(() => 'resolved', (e) => e.name + ':' + e.command)`);
  // G8 implements notes:image:save, so the raw call now resolves (before G8 it answered MC_NOT_YET; either way it was routed).
  check('a Uint8Array argument goes through mc_invoke_raw (granted, routed)', raw === 'resolved', raw);
  // A refused send (not yet) must not hold the next one for the 2 s gap timeout.
  const t0 = Date.now();
  await page.evaluate(`(window.mc.cliOpenDocs('claude'), window.mc.systemBeep(), window.mc.reportError('order', 'after two not-yet sends'), 1)`);
  let orderMs = null;
  for (let i = 0; i < 80 && orderMs === null; i++) {
    await sleep(25);
    if (/error renderer order: after two not-yet sends$/m.test(readText(join(dataDir, 'crash.log')))) orderMs = Date.now() - t0;
  }
  check('a send after refused sends is delivered without the gap timeout', orderMs !== null && orderMs < 1000, `${orderMs} ms`);
  const lonePost = await page.evaluate(`(window.__mc.useStore.getState().update((s) => ({ ...s, snippets: s.snippets.map((x) => x.id === 'snip-1' ? { ...x, name: 'edit ' + String.fromCharCode(0xd83d) } : x) })), 'ok')`).catch((e) => String(e));
  let loneSaved = null;
  for (let i = 0; i < 40 && !loneSaved; i++) {
    await sleep(100);
    try { const sn = JSON.parse(readText(stateFile)).snippets.find((x) => x.id === 'snip-1'); if (sn?.name.startsWith('edit ')) loneSaved = sn.name; } catch { /* mid-rename */ }
  }
  check('a renderer edit with a lone surrogate is saved (not refused by the IPC)', lonePost === 'ok' && loneSaved === 'edit \ufffd', JSON.stringify(loneSaved));
  const probe = await bridge(page, 'probe', { label: 'update-gate' });
  check('guard refuses the update-gate label', probe.allowed === false);
  const probeMain = await bridge(page, 'probe');
  check('guard allows the main window (its IPC requests carry the page origin)', probeMain.allowed === true && probeMain.requestOrigin === 'http://tauri.localhost', `${probeMain.url} origin ${probeMain.requestOrigin}`);
  const probeFrame = await bridge(page, 'probe', { requestOrigin: 'https://example.com' });
  check('guard refuses a request whose Origin is not the page origin', probeFrame.allowed === false);

  // ── a reload drops the page's listeners and the bridge works again ───────
  const subsBefore = await page.evaluate('window.__MC_TAURI__.transport.subscriptionCount()');
  await page.evaluate(`window.addEventListener('pagehide', () => { sessionStorage.setItem('smoke:subsAtHide', String(window.__MC_TAURI__.transport.subscriptionCount())); }); setTimeout(() => location.reload(), 50); 1`);
  await sleep(1500);
  await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready after reload');
  const subsAtHide = await page.evaluate(`sessionStorage.getItem('smoke:subsAtHide')`);
  check('pagehide disposes every event subscription of the page', subsBefore > 10 && subsAtHide === '0', `${subsBefore} before, ${subsAtHide} at pagehide`);
  await page.evaluate(`window.__smokeNotice = null; window.__MC_TAURI__.transport.on('app:notice', (...a) => { window.__smokeNotice = a; }); 1`);
  await sleep(300);
  await bridge(page, 'emit', { event: 'app:notice', args: ['after reload'] });
  const notice = await waitFor(page, 'window.__smokeNotice', 5000, 'event after reload').catch(() => null);
  check('events reach the reloaded page', JSON.stringify(notice) === '["after reload"]', JSON.stringify(notice));
  const lanes = await bridge(page, 'lanes');
  check('one send lane for the main window', lanes.sends === 1, JSON.stringify(lanes));

  // ── second instance ──────────────────────────────────────────────────────
  const second = launchApp({ dataDir, scratch });
  children.push(second);
  const code = await waitExit(second, 20000);
  check('second start on the same data dir exits with 0', code === 0, `exit ${code}`);
  check('first instance still runs', (await page.evaluate('2 + 2')) === 4);

  console.log(`screenshot: ${await screenshot(page, '2-after-edit')}`);
  check('no uncaught renderer exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ── quit and restart ─────────────────────────────────────────────────────
  await bridge(page, 'quit').catch(() => undefined);
  page.close();
  const exitCode = await waitExit(first.child, 15000);
  check('quit exits', exitCode !== null, `exit ${exitCode}`);
  const afterQuit = readText(stateFile);
  check('state.json valid after quit and still has the edit', JSON.parse(afterQuit).settings.fontSize === 15);

  const again = await start();
  await waitFor(again.page, 'window.__mc?.useStore?.getState?.().ready === true', 45000, 'renderer ready after restart');
  const restarted = await again.page.evaluate('window.__mc.useStore.getState().s.settings.fontSize');
  check('restart with existing saved data keeps the edit', restarted === 15, `fontSize ${restarted}`);
  await sleep(1000);
  console.log(`screenshot: ${await screenshot(again.page, '3-restart')}`);
  await bridge(again.page, 'quit').catch(() => undefined);
  again.page.close();
  await waitExit(again.child, 15000);
  const startup = existsSync(join(dataDir, 'startup.log')) ? readText(join(dataDir, 'startup.log')).trim().split('\n') : [];
  check('startup.log has a line per launch', startup.length >= 2, startup.at(-1));
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const child of children) killTree(child);
}

const markersAfter = realProfileMarkers();
check('isolation: nothing new in the real profile', JSON.stringify(markersBefore) === JSON.stringify(markersAfter), markersAfter.join(', ') || 'none');

const bad = results.filter((r) => !r.ok);
writeFileSync(join(shots, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
if (!keep && !failed && !bad.length) removeScratch(scratch);
console.log(`\n${results.length - bad.length}/${results.length} checks passed${failed ? ' (aborted by an error)' : ''}`);
process.exit(failed || bad.length ? 1 : 0);
