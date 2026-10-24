// node scripts/verify-ssh-bar.mjs  (after `npm run build`)
// Real-app check of the 1.0.7 SSH status bar against scripts/ssh-test-server.mjs --bar debian (canned /proc answers) and
// --bar windows (a server without sh): the bar fills in, the CPU, user and disk cards, the right-click menu, no runs while
// the grid is hidden, hiding it in one cell and showing it again from Settings, narrow cells, and the back-off.
// 1.0.8: the uptime item, the user item ("root+2", the cell's own session last in its card), and the layout at cells of
// 1600/1100/800/600/450/350 px: one row from the left with even gaps, short forms before dropped items, no item hidden while
// a roomier layout would fit, and back to everything when the cell grows again (screenshots ssh-bar-width-<px>.png).
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
/**
 * The bar's layout as laid out: the items shown with their text, the gaps between them, the free room at the end, and what
 * would still have fitted in that free room (from the hidden measuring copy): a dropped item, the sparkline, the full forms.
 */
const LAYOUT = `(() => {
  const bar = document.querySelector('.ssh-bar'); const cs = getComputedStyle(bar); const b = bar.getBoundingClientRect();
  const shown = [...bar.querySelectorAll(':scope > [data-item]')]; const r = shown.map((e) => e.getBoundingClientRect());
  const inner = { left: b.left + bar.clientLeft + parseFloat(cs.paddingLeft), right: b.left + bar.clientLeft + bar.clientWidth - parseFloat(cs.paddingRight) };
  const widths = {};
  for (const el of bar.querySelectorAll('[data-measure]')) { const [i, f] = el.dataset.measure.split(':'); (widths[i] ??= {})[f] = Math.round(el.getBoundingClientRect().width * 10) / 10; }
  const present = Object.keys(widths); const gap = parseFloat(cs.columnGap);
  const items = shown.map((e) => e.dataset.item);
  const free = r.length ? inner.right - r[r.length - 1].right : 0;
  const spark = !!bar.querySelector(':scope > [data-item=cpu] .ssh-bar-spark');
  const compact = !!bar.querySelector(':scope > [data-item=mem]') && !/GB|MB/.test(bar.querySelector(':scope > [data-item=mem]').textContent);
  const dropped = present.filter((i) => !items.includes(i));
  // With the 8 px a layout needs to spare before it grows back.
  const fits = (px) => px <= free - 8;
  const missed = [
    ...dropped.filter((i) => fits(gap + (i === 'cpu' ? widths[i].bare : widths[i].compact))).map((i) => 'item ' + i),
    ...(!dropped.length && !spark && widths.cpu && fits(widths.cpu.compact - widths.cpu.bare) ? ['sparkline'] : []),
    ...(!dropped.length && spark && compact && fits(present.reduce((n, i) => n + Math.min(i === 'host' ? 90 : Infinity, widths[i].full) - Math.min(i === 'host' ? 90 : Infinity, widths[i].compact), 0)) ? ['full forms'] : []),
  ];
  return {
    bar: Math.round(b.width), room: Math.round((inner.right - inner.left) * 10) / 10, stage: Number(bar.dataset.stage), widths,
    texts: shown.map((e) => e.dataset.item + ':' + e.textContent), compact, spark,
    gaps: r.slice(1).map((x, i) => Math.round((x.left - r[i].right) * 10) / 10),
    start: r.length ? Math.round((r[0].left - inner.left) * 10) / 10 : 0,
    free: Math.round(free * 10) / 10, missed,
    hostCut: (() => { const t = bar.querySelector(':scope > [data-item=host] .ssh-bar-text'); return t ? t.scrollWidth > t.clientWidth : false; })(),
    overflow: bar.scrollWidth - bar.clientWidth,
  };
})()`;

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
  check((await app.evaluate(TEXT('.ssh-bar-mem'))) === '0,23/0,96 GB', `memory (${await app.evaluate(TEXT('.ssh-bar-mem'))})`);
  check(/^\/: 92%$/.test(await app.evaluate(TEXT('.ssh-bar-disk'))), `root disk (${await app.evaluate(TEXT('.ssh-bar-disk'))})`);
  check(await app.evaluate(`document.querySelector('.ssh-bar-disk').classList.contains('full')`), 'disk over 90 % is red');
  check(/^root\+2$/.test(await app.evaluate(TEXT('.ssh-bar-user'))), `user with the other sessions (${await app.evaluate(TEXT('.ssh-bar-user'))})`);
  check((await app.evaluate(TEXT('.ssh-bar-uptime'))) === '14 dni', `uptime (${await app.evaluate(TEXT('.ssh-bar-uptime'))})`);
  const upTitle = await app.evaluate(`document.querySelector('.ssh-bar-uptime').getAttribute('title') ?? document.querySelector('.ssh-bar-uptime').getAttribute('data-mc-title')`);
  check(upTitle === 'Czas działania serwera: 14 d 6 h', `uptime tooltip (${JSON.stringify(upTitle)})`);
  await app.until(`${TEXT('.ssh-bar-net')} !== null`, 'network rate', 10000);
  check(await app.evaluate(`document.querySelectorAll('.ssh-bar > .ssh-bar-net .ssh-bar-dir').length === 2`), 'network up and down apart');
  const order = await app.evaluate(`[...document.querySelectorAll('.ssh-bar > [data-item]')].map((e) => e.dataset.item)`);
  check(JSON.stringify(order) === JSON.stringify(['host', 'cpu', 'mem', 'net', 'uptime', 'user', 'disk']), `items left to right (${JSON.stringify(order)})`);
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
  check(who.length === 3 && who[2].includes('(ty)') && !who[0].includes('(ty)') && !who[1].includes('(ty)') && who[2].includes('pts/0'),
    `who card lists the others first and you last (${JSON.stringify(who)})`);
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
  // The uptime has its own switch among the items.
  const UPTIME_BOX = `[...document.querySelectorAll('.ssh-bar-setting-items label')].find((l) => l.textContent === 'Czas działania')?.querySelector('input')`;
  check(await app.evaluate(`${UPTIME_BOX}?.checked === true`), 'uptime switch in Settings, on');
  await app.evaluate(`${UPTIME_BOX}.click(), true`);
  await app.until(`window.__mc.useStore.getState().s.settings.sshStatusBarItems?.uptime === false`, 'uptime switched off');
  await app.evaluate(`${UPTIME_BOX}.click(), true`);
  await app.until(`!window.__mc.useStore.getState().s.settings.sshStatusBarItems?.uptime`, 'uptime switched on again');
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

  // 1.0.8: cells of several widths (the window sized so the cell gets it): one row from the left with even gaps, short forms
  // before dropped items, and no item shortened or dropped while the roomier layout would fit.
  const offset = await app.evaluate(`window.innerWidth - document.querySelector('.ssh-bar').closest('.cell').getBoundingClientRect().width`);
  const stageWidth = await app.evaluate(LAYOUT);
  console.log(`     window minus cell: ${Math.round(offset)}px; widths ${JSON.stringify(stageWidth.widths)}`);
  const layoutChecks = (width, l) => {
    check(l.overflow <= 0, `${width}px: no clipped item (${l.overflow})`);
    check(l.start <= 1, `${width}px: the row starts at the left (${l.start})`);
    check(l.gaps.every((g) => Math.abs(g - 12) <= 1), `${width}px: even gaps (${JSON.stringify(l.gaps)})`);
    check(!l.missed.length, `${width}px: nothing shortened or dropped while it would fit (${JSON.stringify(l.missed)}, free ${l.free})`);
    check(l.free >= -1, `${width}px: everything within the bar (${l.free})`);
  };
  for (const width of [1600, 1100, 800, 600, 520, 450, 400, 350, 300, 250, 1600]) {
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(width + offset), height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const l = await app.evaluate(LAYOUT);
    console.log(`     ${width}px cell (bar ${l.bar}px, room ${l.room}): stage ${l.stage}${l.compact ? ' short' : ''}${l.spark ? ' spark' : ''} ${JSON.stringify(l.texts)}, gaps ${JSON.stringify(l.gaps)}, free ${l.free}${l.hostCut ? ', host cut' : ''}`);
    layoutChecks(width, l);
    if (width >= 600) check(l.stage === 0 && l.texts.length === 7, `${width}px: every item in full`);
    check(l.texts.some((t) => t.startsWith('host:')) && (width < 300 || l.texts.some((t) => t.startsWith('cpu:'))), `${width}px: host and CPU kept`);
    await shotBar(app, `ssh-bar-width-${width}.png`, -120);
  }
  // A cell dragged narrower and wider pixel by pixel: the layout follows without gaps or clipping either way.
  let sweepBad = 0;
  for (const width of [...Array.from({ length: 41 }, (_, i) => 640 - i * 10), ...Array.from({ length: 41 }, (_, i) => 240 + i * 10)]) {
    await app.cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(width + offset), height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(60);
    const l = await app.evaluate(LAYOUT);
    if (l.overflow > 0 || l.free < -1 || l.missed.length || !l.gaps.every((g) => Math.abs(g - 12) <= 1)) { sweepBad++; console.log(`     sweep ${width}px: ${JSON.stringify(l)}`); }
  }
  check(sweepBad === 0, `dragging the cell from 640 to 240 px and back: always fitted (${sweepBad} bad)`);
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
