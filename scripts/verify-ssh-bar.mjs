// node scripts/verify-ssh-bar.mjs  (after `npm run build`)
// Real-app check of the 1.0.7 SSH status bar against scripts/ssh-test-server.mjs --bar debian (canned /proc answers) and
// --bar windows (a server without sh): the bar fills in, the CPU, user and disk cards, the right-click menu, no runs while
// the grid is hidden, hiding it in one cell and showing it again from Settings, narrow cells, and the back-off.
// Optional: SSH_BAR_REAL='[{"label":"alpine","port":2222,"user":"root","password":"...","keys":["<base64 host key blob>"]}]'
// checks real servers on 127.0.0.1 too (throwaway Linux containers): the bar fills in from their /proc, the cards, the cadence.
// Scratch data dir and home only (ssh-ui-lib.mjs); screenshots go to D:\Projekty\_shots\ssh-bar-*.png.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connected, connectWithPassword, launchApp, scratchRoot, SHOTS, sleep, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const CALLS = `(() => { const t = window.__mc.terminals; if (!t.__barCalls) { t.__barCalls = 0; const run = t.sshStats.bind(t); t.sshStats = (...a) => { t.__barCalls++; return run(...a); }; } return t.__barCalls; })()`;
const BAR = `document.querySelector('.ssh-bar')`;
const TEXT = (cls) => `(document.querySelector('.ssh-bar ${cls}')?.textContent ?? null)`;

/** A screenshot of the area around the bar (and an open card or menu). */
async function shotBar(app, name, extra = 0) {
  const r = await app.evaluate(`(() => { const b = document.querySelector('.ssh-bar').closest('.cell').getBoundingClientRect(); return { x: b.left, y: b.bottom - ${180 + extra}, width: b.width, height: ${180 + extra} }; })()`);
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await app.cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, y: Math.max(0, r.y), scale: 1 } });
  writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
}
async function hover(app, selector) {
  const p = await app.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await app.until(`!!document.querySelector('.ssh-bar-card')`, `card of ${selector}`, 3000);
  await sleep(150);
  return p;
}
const away = async (app) => { const p = await app.evaluate(`(() => { const r = document.querySelector('.cell-body').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 40 }; })()`); await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(200); };

/** known_hosts.json (src/main/ssh/knownHosts.ts) with every host key of a real server. */
function writeKnownKeys(root, port, keys) {
  const entries = keys.map((key) => {
    const blob = Buffer.from(key, 'base64');
    const keyType = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1');
    return { id: randomUUID(), host: '127.0.0.1', port, keyType, key, fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`, addedAt: 0 };
  });
  mkdirSync(join(root, 'data', 'ssh'), { recursive: true });
  writeFileSync(join(root, 'data', 'ssh', 'known_hosts.json'), JSON.stringify({ version: 1, entries }));
}

async function run(name, serverArgs, body, real = null) {
  const root = scratchRoot(`bar-${name}`);
  const server = real ? { port: real.port, password: real.password, stop: () => undefined } : await startTestServer(serverArgs);
  let app;
  try {
    if (real) writeKnownKeys(root, real.port, real.keys); else writeKnownHost(root, server);
    const host = testHost(server.port, { label: real ? real.label : name === 'debian' ? 'srv36' : 'win-server', ...(real ? { username: real.user } : {}) });
    writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] }));
    app = await launchApp(root);
    await app.evaluate(CALLS);
    await app.until(`!!document.querySelector('.cell .ssh-card')`, 'idle card');
    await app.click('.ssh-card button', 'Połącz');
    await connectWithPassword(app, server.password);
    await connected(app);
    await app.evaluate(CALLS);
    try { await body(app); } catch (error) {
      console.log('     diag:', await app.evaluate(`JSON.stringify({ calls: window.__mc.terminals.__barCalls, bar: document.querySelector('.ssh-bar')?.textContent ?? null, cells: document.querySelectorAll('.cell').length })`).catch((e) => String(e)));
      console.log('     error:', error.message);
      throw error;
    }
  } finally {
    await app?.close();
    server.stop();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log(`     scratch dir left: ${root} (${e.code})`); }
  }
}

await run('debian', ['--bar', 'debian'], async (app) => {
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 800, deviceScaleFactor: 1, mobile: false });
  await app.until(`${TEXT('.ssh-bar-mem')} !== null && ${TEXT('.ssh-bar-cpu')} !== null`, 'bar filled in', 15000);
  await app.until(`document.querySelector('.ssh-bar-spark polyline') !== null`, 'sparkline', 15000);
  check((await app.evaluate(TEXT('.ssh-bar-host'))) === 'srv36', `host name (${await app.evaluate(TEXT('.ssh-bar-host'))})`);
  check(await app.evaluate(`!!document.querySelector('.ssh-bar-host .ssh-bar-logo path')`), 'Debian logo');
  check((await app.evaluate(TEXT('.ssh-bar-mem'))) === '0,23 GB / 0,96 GB', `memory (${await app.evaluate(TEXT('.ssh-bar-mem'))})`);
  check(/^\/: 92%$/.test(await app.evaluate(TEXT('.ssh-bar-disk'))), `root disk (${await app.evaluate(TEXT('.ssh-bar-disk'))})`);
  check(await app.evaluate(`document.querySelector('.ssh-bar-disk').classList.contains('full')`), 'disk over 90 % is red');
  check(/^root3$/.test(await app.evaluate(TEXT('.ssh-bar-user'))), `user with the session count (${await app.evaluate(TEXT('.ssh-bar-user'))})`);
  await app.until(`${TEXT('.ssh-bar-net')} !== null`, 'network rate', 10000);
  const body = await app.evaluate(`(() => { const c = document.querySelector('.cell-body').getBoundingClientRect(); const b = ${BAR}.getBoundingClientRect(); return { body: c.bottom, bar: b.top, h: b.height }; })()`);
  check(Math.abs(body.body - body.bar) <= 1 && body.h <= 24, `bar under the terminal body (${JSON.stringify(body)})`);
  await sleep(4000);
  await shotBar(app, 'ssh-bar.png');

  // Cards.
  await hover(app, '.ssh-bar-cpu');
  check(await app.evaluate(`document.querySelector('.ssh-bar-card').textContent.includes('Obciążenie')`), 'CPU card: load average');
  await shotBar(app, 'ssh-bar-cpu.png');
  await away(app);
  await hover(app, '.ssh-bar-user');
  const who = await app.evaluate(`[...document.querySelectorAll('.ssh-bar-card tbody tr')].map((r) => r.textContent)`);
  check(who.length === 3 && who[0].includes('(ty)') && !who[1].includes('(ty)'), `who card marks you (${JSON.stringify(who)})`);
  await shotBar(app, 'ssh-bar-who.png');
  await away(app);
  await hover(app, '.ssh-bar-disk');
  const disks = await app.evaluate(`[...document.querySelectorAll('.ssh-bar-card tbody tr td:first-child')].map((r) => r.textContent)`);
  check(JSON.stringify(disks) === JSON.stringify(['/', '/srv/data', '/var/backups']), `disk card lists the filesystems (${JSON.stringify(disks)})`);
  await shotBar(app, 'ssh-bar-disk.png');
  await away(app);
  await app.until(`!document.querySelector('.ssh-bar-card')`, 'card closed', 3000);

  // The host tooltip has the cost of a run.
  const title = await app.evaluate(`document.querySelector('.ssh-bar-host').getAttribute('title') ?? document.querySelector('.ssh-bar-host').getAttribute('data-mc-title')`);
  console.log(`     host tooltip: ${JSON.stringify(title)}`);
  check(/Odczyt co 3 s: \d+ ms, [\d,]+ (B|KB)/.test(title ?? ''), 'host tooltip reports the round trip and bytes');

  // Cadence: about one run every 3 s.
  const c0 = await app.evaluate(CALLS);
  await sleep(9200);
  const c1 = await app.evaluate(CALLS);
  check(c1 - c0 >= 2 && c1 - c0 <= 4, `runs every ~3 s while visible (${c1 - c0} in 9.2 s)`);

  // Hidden grid (Settings in front): no runs.
  await app.click('button[aria-label="Ustawienia"]');
  await app.until(`!!document.querySelector('.settings-nav [role=tab]')`, 'settings page');
  await sleep(500);
  const h0 = await app.evaluate(CALLS);
  await sleep(7000);
  const h1 = await app.evaluate(CALLS);
  check(h1 === h0, `no runs while the grid is hidden (${h1 - h0})`);
  await app.click('.settings-nav [role=tab]', 'SSH');
  await app.until(`!!document.querySelector('#settings-ssh-bar')`, 'bar setting');
  check(await app.evaluate(`document.querySelector('#settings-ssh-bar').checked`), 'bar on by default');
  await app.evaluate(`document.querySelector('#settings-ssh-bar').scrollIntoView({ block: 'center' }), true`);
  await app.screenshot('ssh-bar-settings.png');
  await app.evaluate(`window.__mc.useStore.getState().setUi({ settingsTabOpen: false, settingsActive: false }), true`);
  await app.until(`!document.querySelector('.settings-tab')`, 'settings tab closed');
  await app.until(`(${CALLS}) > ${h1}`, 'runs again once visible', 5000);

  // Right-click menu.
  const p = await app.evaluate(`(() => { const r = document.querySelector('.ssh-bar-mem').getBoundingClientRect(); return { x: r.left + 10, y: r.top + 8 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', clickCount: 1 });
  await app.until(`!!document.querySelector('.menu')`, 'context menu');
  const items = await app.evaluate(`[...document.querySelectorAll('.menu button, .menu [role=menuitem]')].map((b) => b.textContent)`);
  console.log(`     menu: ${JSON.stringify(items)}`);
  check(items.some((t) => t.includes('Ukryj pasek w tej komórce')) && items.some((t) => t.includes('Ukryj pasek we wszystkich komórkach SSH')), 'menu has both hide entries');
  await shotBar(app, 'ssh-bar-menu.png', 160);
  // Switch the network off from the menu.
  await app.click('.menu button', 'Sieć');
  await app.until(`!document.querySelector('.ssh-bar-net')`, 'network item off');
  check(await app.evaluate(`window.__mc.useStore.getState().s.settings.sshStatusBarItems?.net === false`), 'item toggle saved');
  for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', clickCount: 1 });
  await app.until(`!!document.querySelector('.menu')`, 'context menu again');
  await app.click('.menu button', 'Sieć');
  await app.until(`!!document.querySelector('.ssh-bar-net')`, 'network item on');

  // Narrow cells drop items by priority.
  for (const width of [1100, 900, 780, 640, 520]) {
    await app.cdp('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const shown = await app.evaluate(`[...document.querySelectorAll('.ssh-bar > .ssh-bar-item')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.className.split(' ')[1].replace('ssh-bar-', ''))`);
    const overflow = await app.evaluate(`(() => { const b = ${BAR}; return b.scrollWidth - b.clientWidth; })()`);
    console.log(`     ${width}px: bar ${await app.evaluate(`Math.round(${BAR}.getBoundingClientRect().width)`)}px, ${JSON.stringify(shown)}, overflow ${overflow}`);
    check(overflow <= 0, `no clipped item at a ${width}px window`);
    await shotBar(app, `ssh-bar-narrow-${width}.png`, -120);
  }
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  Object.assign(p, await app.evaluate(`(() => { const r = document.querySelector('.ssh-bar-mem').getBoundingClientRect(); return { x: r.left + 10, y: r.top + 8 }; })()`));

  // Hidden in this cell, then shown again from Settings.
  for (const type of ['mousePressed', 'mouseReleased']) await app.cdp('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'right', clickCount: 1 });
  await app.until(`!!document.querySelector('.menu')`, 'context menu (hide)');
  await app.click('.menu button', 'Ukryj pasek w tej komórce');
  await app.until(`!${BAR}`, 'bar hidden');
  const g0 = await app.evaluate(CALLS);
  await sleep(4000);
  check((await app.evaluate(CALLS)) === g0, 'no runs while the bar is hidden');
  await app.click('button[aria-label="Ustawienia"]');
  await app.until(`!!document.querySelector('.settings-nav [role=tab]')`, 'settings page 2');
  await app.click('.settings-nav [role=tab]', 'SSH');
  await app.until(`[...document.querySelectorAll('.setting-row button')].some((b) => b.textContent === 'Pokaż we wszystkich')`, 'show again button');
  await app.click('.setting-row button', 'Pokaż we wszystkich');
  await app.evaluate(`window.__mc.useStore.getState().setUi({ settingsTabOpen: false, settingsActive: false }), true`);
  await app.until(`!!${BAR} && ${TEXT('.ssh-bar-mem')} !== null`, 'bar back', 10000);

  // Disconnect: the bar goes, its data is dropped.
  await app.evaluate(`(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId); window.__mc.terminals.write?.(t.cells[0].id, 'exit\\r'); return true; })()`).catch(() => undefined);
});

await run('windows', ['--bar', 'windows'], async (app) => {
  await sleep(12_000);
  const calls = await app.evaluate(CALLS);
  check(calls === 3, `a server without sh: three tries, then no more (${calls})`);
  check(await app.evaluate(`!document.querySelector('.ssh-bar:not(.ssh-bar-pending)')`), 'no bar shown for a server without sh');
  check(await app.evaluate(`!document.querySelector('.ssh-bar')`), 'the empty line is gone after the back-off');
  await app.screenshot('ssh-bar-windows.png');
});

for (const real of JSON.parse(process.env.SSH_BAR_REAL ?? '[]')) {
  await run(`real-${real.label}`, [], async (app) => {
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 800, deviceScaleFactor: 1, mobile: false });
    await app.until(`${TEXT('.ssh-bar-mem')} !== null && ${TEXT('.ssh-bar-cpu')} !== null && ${TEXT('.ssh-bar-net')} !== null`, `${real.label}: bar filled in`, 20000);
    await sleep(6500);
    console.log(`     ${real.label}: ${JSON.stringify(await app.evaluate(`[...document.querySelectorAll('.ssh-bar > .ssh-bar-item')].map((e) => e.textContent)`))}`);
    const title = await app.evaluate(`document.querySelector('.ssh-bar-host').getAttribute('title') ?? document.querySelector('.ssh-bar-host').getAttribute('data-mc-title')`);
    console.log(`     ${real.label} host tooltip: ${JSON.stringify(title)}`);
    check(await app.evaluate(`!!document.querySelector('.ssh-bar-host .ssh-bar-logo path')`), `${real.label}: distro logo`);
    check(/Odczyt co 3 s: \d+ ms/.test(title ?? ''), `${real.label}: round trip in the tooltip`);
    await shotBar(app, `ssh-bar-real-${real.label}.png`);
    for (const [cls, shot] of [['.ssh-bar-cpu', 'cpu'], ['.ssh-bar-user', 'who'], ['.ssh-bar-disk', 'disk']]) {
      await hover(app, cls);
      console.log(`     ${real.label} ${shot} card: ${JSON.stringify(await app.evaluate(`[...document.querySelectorAll('.ssh-bar-card tr, .ssh-bar-card p')].map((r) => r.textContent)`))}`);
      await shotBar(app, `ssh-bar-real-${real.label}-${shot}.png`);
      await away(app);
    }
    const c0 = await app.evaluate(CALLS);
    await sleep(9200);
    const c1 = await app.evaluate(CALLS);
    check(c1 - c0 >= 2 && c1 - c0 <= 4, `${real.label}: runs every ~3 s (${c1 - c0} in 9.2 s)`);
  }, real);
}

if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exitCode = 1; } else console.log('\nall ok');
