// W1 acceptance check of the Tauri check build on Windows: the window has no system title bar, the caption buttons the page
// draws match the 1.1.4 references (test/fixtures/caption, scripts/capture-caption-reference.mjs) per state at 100, 125, 150
// and 200 percent (OS-level window capture: at most 2 percent differing pixels, the glyphs at the same place), Windows gets
// every code of 1.1.4's WM_NCHITTEST map at every sampled pixel (HTMINBUTTON / HTMAXBUTTON / HTCLOSE over the buttons, which is
// what opens the Windows 11 snap layouts, HTTOP / HTTOPRIGHT along the top edge, HTCAPTION over the title bar), the native
// layout matches the page's, the native path works (hover and press reports, clicks run SC_MINIMIZE / SC_MAXIMIZE /
// SC_CLOSE, the hover ends after a release), a double-click on the title bar maximizes, a right click opens the system menu
// with the items of the window's state, a press on the top edge starts the resize loop and one on the title bar the move
// loop, the buttons are named for assistive technology, the tooltips are translated, and a detached window opened through
// W5's real path (the renderer's "Move to a new window") has the same buttons.
//
//   npm run build:check
//   (cd src-tauri && node ../scripts/msvc-run.mjs cargo build -p unimux-platform --example wincap --release)
//   node scripts/verify-caption.mjs [--scale=100,125,150,200] [--keep]      diff images: artifacts/caption/
//
// Nothing appears on the desktop: the app runs off-screen (MC_OFFSCREEN: never activated, parked off every monitor before it
// is shown, DWM transitions off so a minimize draws no animation), states come from messages posted to its windows (the real
// cursor never moves), the maximized look is taken with WS_MAXIMIZE set on the style (no real maximize onto a monitor), and
// the test bridge's caption guard swallows the system commands that would show something (a real maximize, the move and
// size loops, the keyboard menu) after recording them; the system menu is recorded instead of opened (caption.rs seam).
// The "is it off-screen" checks below run after the window was shown: they stop the run on a leak, the prevention is the
// app's own off-screen show. Real-app harness (X1): scratch data dir and home, only our processes end, a test-bridge op this
// build lacks reports "blocked by".
//
// Stand-ins, not the real thing (PROGRESS.md "Open issues after W1"): the maximize is WS_MAXIMIZE on the style (not tao's
// maximized WM_NCCALCSIZE), the scale is a fixed rasterization scale (no monitor DPI change), hover and press come from posted
// messages (no snap flyout, no real cursor leave), and the system menu is recorded, not opened.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runnerImport } from 'vite';
import * as L from './caption-lib.mjs';
import { removeScratch, scratchHome, scrubAppEnv } from './app-env.mjs';
import { bridgeCall, freePort, isTauri, killAppTreeAndWait, requireBuild, sleep, spawnApp } from './real-app.mjs';
import { connectPage, realProfileMarkers, waitExit, waitFor } from './tauri-app.mjs';

if (!isTauri || process.platform !== 'win32') {
  console.log('SKIP verify-caption: the Tauri check build on Windows only (1.1.4 is its reference, scripts/capture-caption-reference.mjs)');
  process.exit(0);
}
requireBuild();
L.wincapBinary();

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const scaleArg = args.find((a) => a.startsWith('--scale='));
const percents = scaleArg ? scaleArg.slice(8).split(',').map(Number) : L.SCALES.map((s) => Math.round(s * 100));
const shots = join(L.root, 'artifacts', 'caption');
mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const MAX_RATIO = 0.02;
const CHANNEL_TOLERANCE = 8;
const BG = [0x0d, 0x0d, 0x0d];
const WS_MAXIMIZE = 0x01000000;
const WS_THICKFRAME = 0x00040000;
const WS_MAXIMIZEBOX = 0x00010000;
const SC = { SIZE: 0xf000, MINIMIZE: 0xf020, MAXIMIZE: 0xf030, CLOSE: 0xf060, MOVE: 0xf010, RESTORE: 0xf120 };
const WMSZ = { TOP: 3, TOPLEFT: 4, TOPRIGHT: 5 };
const HT_OF = { min: L.HT.MINBUTTON, max: L.HT.MAXBUTTON, close: L.HT.CLOSE };
const HT_TOP = 12;
const HT_TOPLEFT = 13;
const HT_TOPRIGHT = 14;
/** The client sizes of the reference windows (recorded in the manifest by the capture). */
const manifest = JSON.parse(readFileSync(join(L.FIXTURES, 'manifest.json'), 'utf8'));
const CLIENT = Object.fromEntries(Object.entries(manifest.scales).map(([p, v]) => [p, v.client[0]]));
const CLIENT_H = Object.fromEntries(Object.entries(manifest.scales).map(([p, v]) => [p, v.client[1]]));
const cropOf = (scale) => ({ w: Math.round(160 * scale), h: Math.round(40 * scale) });
const NAMES = {
  min: ['Minimalizuj', 'Minimize', 'Minimieren', 'Minimizar', 'Réduire', 'Minimizar'],
  max: ['Maksymalizuj', 'Maximize', 'Maximieren', 'Maximizar', 'Agrandir'],
  close: ['Zamknij', 'Close', 'Schließen', 'Cerrar', 'Fermer', 'Fechar'],
};

const bridge = (page, op, a) => bridgeCall(page.evaluate, op, a ?? null);
const caption = (page, a) => bridge(page, 'caption', a);
/** Paints a pointer state exactly as the native child reports it (the page's half; the native half is checked below). */
const pointer = (page, label, hover, pressed) => bridge(page, 'emit', { event: 'window:caption', args: [{ hover, pressed }], label }).then(() => label);

/** The effective WM_NCHITTEST answer at a screen point: the first window of the chain that is not HTTRANSPARENT. */
async function hitAt(wc, x, y) {
  const { chain } = await wc.cmd('hittest', x, y);
  const hit = chain.find((c) => c.hit !== L.HT.TRANSPARENT);
  return { code: hit ? hit.hit : null, hwnd: hit?.hwnd, class: hit?.class, chain };
}

/** Starts the check build off-screen on a scratch data dir (state.json written first when given). */
async function launch(scratch, state) {
  const dataDir = join(scratch, 'data');
  mkdirSync(dataDir, { recursive: true });
  if (state) writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state));
  const port = await freePort();
  const env = scrubAppEnv({ ...process.env, ...scratchHome(scratch).env, MC_DATA_DIR: dataDir, MC_DEBUG_PORT: String(port), MC_OFFSCREEN: '1' });
  const child = spawnApp({ env });
  const page = await connectPage(port, { timeoutMs: 60000 });
  return { child, page, port };
}

/** Stops the run when a window of ours is on a monitor (the check comes after the show: it detects, the app prevents). */
async function assertOffscreen(wc, hwnd, what) {
  const r = await wc.cmd('rect', hwnd);
  if (r.window[2] > -1000) throw new Error(`${what} is not off-screen (${JSON.stringify(r.window)}); stopped`);
  return r;
}

/** Gives a window the reference client size (outer size = client + its invisible borders). */
async function sizeLikeReference(wc, hwnd, percent) {
  const r = await wc.cmd('rect', hwnd);
  const [x0, y0, x1, y1] = r.window;
  await wc.cmd('setpos', hwnd, x0, y0, CLIENT[percent] + (x1 - x0 - r.client[2]), CLIENT_H[percent] + (y1 - y0 - r.client[3]));
}

/** Waits until the native layout of a window answers for the reference client width. */
async function settledProbe(page, percent, label = 'main') {
  let probe = null;
  for (let i = 0; i < 80; i++) {
    probe = await caption(page, { action: 'probe', label });
    if (probe.area && probe.visible && probe.rect[0] + probe.rect[2] === CLIENT[percent] && probe.pageMatches === true) break;
    await sleep(100);
  }
  return probe;
}

/** Every sampled pixel of 1.1.4's map against ours (any code: buttons, the top edge and its corners, the caption, client). */
async function compareHitMap(wc, rect, percent, tag) {
  const ref = manifest.scales[percent];
  const [cx, cy, cw] = rect.client;
  let mismatch = 0;
  const codes = {};
  for (const [row, refRow] of Object.entries(ref.hitMap)) {
    const y = Number(row);
    for (let i = 0; i < refRow.length; i++) {
      const code = (await hitAt(wc, cx + cw - 1 - i, cy + y)).code;
      if (code !== refRow[i]) {
        mismatch++;
        const key = `${refRow[i]}->${code}`;
        codes[key] = (codes[key] ?? 0) + 1;
      }
    }
  }
  check(`${tag} every code of 1.1.4's hit map (buttons, top edge and corner, caption)`, mismatch === 0, mismatch ? `${mismatch} pixels differ (reference->ours ${JSON.stringify(codes)})` : `${Object.values(ref.hitMap).flat().length} pixels`);
}

async function runScale(wc, percent) {
  const scale = percent / 100;
  const scratch = mkdtempSync(join(tmpdir(), 'unimux-caption-check-'));
  let child = null;
  const tag = `${percent}%`;
  try {
    const run = await launch(scratch);
    child = run.child;
    const { page } = run;
    await waitFor(page, `!!(document.querySelector('canvas.mc-caption') && document.querySelector('.titlebar'))`, 60000, 'caption canvas and title bar');
    const win = await L.findAppWindow(wc, child.pid);
    await assertOffscreen(wc, win.hwnd, 'the app window');
    // The native layout exists without the page's help (laid out from the client rect and the DPI at creation).
    const first = await caption(page, { action: 'probe' });
    check(`${tag} the native layout is there on its own`, first.area && first.visible && first.child, JSON.stringify({ rect: first.rect, layered: first.layered }));
    await caption(page, { action: 'scale', scale });
    await sizeLikeReference(wc, win.hwnd, percent);
    await waitFor(page, `window.devicePixelRatio === ${scale}`, 10000, `devicePixelRatio ${scale}`);
    const probe = await settledProbe(page, percent);
    const rect = await wc.cmd('rect', win.hwnd);
    // tao keeps WS_CAPTION in the style (Aero snap and the window animations need it) and takes the whole window as client
    // area in WM_NCCALCSIZE, so no title bar is drawn: the client area starts at the window's top (the 1 px shadow frame).
    check(`${tag} window without a system title bar`, probe.decorated === false && rect.client[1] - rect.window[1] <= 1 && (rect.style & WS_THICKFRAME) && (rect.style & WS_MAXIMIZEBOX), `style 0x${(rect.style >>> 0).toString(16)}, client top ${rect.client[1] - rect.window[1]} px below the window top, client ${rect.client[2]}x${rect.client[3]}`);
    check(`${tag} hit-test children over the buttons and along the top edge`, probe.visible && probe.rect[0] + probe.rect[2] === rect.client[2] && probe.edgeVisible && probe.edgeRect[2] === rect.client[2] && probe.edgeRect[3] === probe.top?.height, JSON.stringify({ rect: probe.rect, edge: probe.edgeRect, top: probe.top, layered: probe.layered }));
    check(`${tag} the page's button rects equal the native layout`, probe.pageMatches === true, JSON.stringify({ native: probe.area, page: probe.pageArea }));

    // ---- hit tests along the caption, against 1.1.4's map ----
    await compareHitMap(wc, rect, percent, tag);
    const [cx, cy, cw] = rect.client;
    const maxCentre = await hitAt(wc, cx + cw - Math.round(69 * scale), cy + Math.round(18 * scale));
    check(`${tag} maximize answers HTMAXBUTTON (Windows 11 snap layouts)`, maxCentre.code === L.HT.MAXBUTTON, `${maxCentre.class} ${maxCentre.code}`);
    const bar = await hitAt(wc, cx + Math.round(cw / 2), cy + Math.round(18 * scale));
    check(`${tag} the title bar answers HTCAPTION`, bar.code === L.HT.CAPTION, JSON.stringify(bar.chain.map((c) => `${c.class}:${c.hit}`)));
    const topLeft = await hitAt(wc, cx + 1, cy + 1);
    check(`${tag} the top left corner answers HTTOPLEFT`, topLeft.code === HT_TOPLEFT, `${topLeft.class} ${topLeft.code}`);

    // ---- pixels, per state, against the references ----
    const crop = cropOf(scale);
    const grab = async () => {
      const raw = join(scratch, 'grab.raw');
      await wc.cmd('capture', win.hwnd, raw);
      const img = L.readRaw(raw);
      return L.crop(img, img.width - crop.w, 0, crop.w, crop.h);
    };
    const container = (img) => L.crop(img, img.width - Math.round(137 * scale), 0, Math.round(137 * scale), img.height);
    const compare = async (state, { glyph = false } = {}) => {
      await sleep(400); // the 150 ms hover fade and a frame
      const ours = await grab();
      const refImg = L.readPng(join(L.FIXTURES, String(percent), `${state}.png`));
      const d = L.diffImages(ours, refImg, CHANNEL_TOLERANCE);
      let glyphOk = true;
      let glyphDetail = '';
      if (glyph) {
        const a = L.glyphBox(container(ours), BG);
        const b = L.glyphBox(container(refImg), BG);
        glyphOk = JSON.stringify(a) === JSON.stringify(b);
        glyphDetail = `, glyphs ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
      }
      if (d.image) L.writePng(join(shots, `${percent}-${state}-diff.png`), d.image);
      L.writePng(join(shots, `${percent}-${state}.png`), ours);
      check(`${tag} ${state} matches 1.1.4`, !d.sizeMismatch && d.ratio <= MAX_RATIO && glyphOk, `${(d.ratio * 100).toFixed(2)} % differing (max channel delta ${d.maxDelta})${glyphDetail}`);
    };
    await compare('idle', { glyph: true });
    for (const b of ['min', 'max', 'close']) {
      await pointer(page, 'main', b, null);
      await compare(`hover-${b}`);
      await pointer(page, 'main', null, b);
      await compare(`pressed-${b}`);
      await pointer(page, 'main', null, null);
    }
    await sleep(400);
    // Active: the page draws the same buttons for an active and an inactive window (so did 1.1.4's overlay).
    await wc.cmd('send', win.hwnd, L.WM.NCACTIVATE, 1, 0);
    await compare('active', { glyph: true });
    await wc.cmd('send', win.hwnd, L.WM.NCACTIVATE, 0, 0);

    // Maximized look: WS_MAXIMIZE on the style, no real maximize (nothing moves onto a monitor). The native layout reads
    // IsZoomed (the style bit) on the WM_SIZE of the setpos; the page asks again on its resize.
    const normal = await wc.cmd('rect', win.hwnd);
    const restyle = async (style) => {
      await wc.cmd('setstyle', win.hwnd, style);
      const [x0, y0, x1, y1] = normal.window;
      await wc.cmd('setpos', win.hwnd, x0, y0, x1 - x0, y1 - y0);
      await sleep(600);
    };
    await restyle(normal.style | WS_MAXIMIZE);
    let maxProbe = null;
    for (let i = 0; i < 30; i++) {
      maxProbe = await caption(page, { action: 'probe' });
      if (maxProbe.pageMatches === true && maxProbe.area?.max?.[1] === 0) break;
      await sleep(100);
    }
    check(`${tag} maximized: the native layout at the very top, no top edge, the page agrees`, maxProbe.maximized === true && maxProbe.area?.max?.[1] === 0 && maxProbe.top === null && !maxProbe.edgeVisible && maxProbe.pageMatches === true, JSON.stringify({ area: maxProbe.area, top: maxProbe.top, page: maxProbe.pageArea }));
    const maxRect = await wc.cmd('rect', win.hwnd);
    const corner = await hitAt(wc, maxRect.client[0] + maxRect.client[2] - 1, maxRect.client[1]);
    check(`${tag} maximized: the top right pixel is the close button`, corner.code === L.HT.CLOSE, `${corner.class} ${corner.code}, client ${JSON.stringify(maxRect.client)}, window ${JSON.stringify(maxRect.window)}`);
    await compare('maximized-idle', { glyph: true });
    await pointer(page, 'main', 'max', null);
    await compare('maximized-hover-restore');
    await pointer(page, 'main', null, 'max');
    await compare('maximized-pressed-restore');
    await pointer(page, 'main', null, null);
    if (percent === percents[0]) await maximizedMenuCheck(wc, page, win, scale, tag);
    await restyle(normal.style);

    if (percent !== percents[0]) return;
    // ---- once: the native path, the title bar, the top edge, names and tooltips, the close button ----
    await nativeChecks(wc, page, win, scale, tag);
    // Close: a click on the close button ends the app the normal way (SC_CLOSE -> WM_CLOSE -> W6's quit).
    const now = await caption(page, { action: 'probe' });
    const [ccx, ccy] = (await wc.cmd('rect', win.hwnd)).client;
    const [x, y, w, h] = now.area.close;
    const pt = [ccx + x + Math.floor(w / 2), ccy + y + Math.floor(h / 2)];
    await wc.cmd('post', now.child, L.WM.NCLBUTTONDOWN, L.HT.CLOSE, L.lparam(...pt));
    await sleep(100);
    await wc.cmd('post', now.child, L.WM.LBUTTONUP, 0, L.lparam(pt[0] - ccx - now.rect[0], pt[1] - ccy - now.rect[1]));
    const code = await waitExit(child, 15000);
    check(`${tag} the close button ends the app`, code === 0, `exit code ${code}`);
  } finally {
    await killAppTreeAndWait(child);
    if (!keep) removeScratch(scratch);
  }
}

/** The system menu of a maximized window: Restore on, Move / Size / Maximize grey (recorded, never shown). */
async function maximizedMenuCheck(wc, page, win, scale, tag) {
  await caption(page, { action: 'guard' });
  await caption(page, { action: 'log' });
  const { client: [cx, cy] } = await wc.cmd('rect', win.hwnd);
  const barPt = [cx + Math.round(500 * scale), cy + Math.round(18 * scale)];
  const bar = await hitAt(wc, ...barPt);
  await wc.cmd('post', bar.hwnd, 0xa4 /* WM_NCRBUTTONDOWN */, L.HT.CAPTION, L.lparam(...barPt));
  await wc.cmd('post', bar.hwnd, 0xa5 /* WM_NCRBUTTONUP */, L.HT.CAPTION, L.lparam(...barPt));
  await sleep(400);
  const menu = (await caption(page, { action: 'log' })).log.find((e) => e.msg === 'systemmenu');
  const on = (c) => menu?.items.find((i) => i.command === c)?.enabled;
  check(`${tag} maximized: the system menu offers Restore, greys Move / Size / Maximize`, menu && on(SC.RESTORE) === true && on(SC.MOVE) === false && on(0xf000) === false && on(SC.MAXIMIZE) === false && on(SC.MINIMIZE) === true && on(SC.CLOSE) === true, JSON.stringify(menu));
}

async function nativeChecks(wc, page, win, scale, tag) {
  await page.evaluate(`window.__capLog = []; window.mc.on('window:caption', (s) => window.__capLog.push(s)); true`);
  await caption(page, { action: 'guard' });
  await caption(page, { action: 'log' });
  const probe = await caption(page, { action: 'probe' });
  const { client: [cx, cy, cw] } = await wc.cmd('rect', win.hwnd);
  const centre = (b) => { const [x, y, w, h] = probe.area[b]; return [cx + x + Math.floor(w / 2), cy + y + Math.floor(h / 2)]; };
  const local = (pt) => [pt[0] - cx - probe.rect[0], pt[1] - cy - probe.rect[1]];
  const log = () => page.evaluate('window.__capLog.splice(0)');
  const sys = async () => (await caption(page, { action: 'log' })).log;

  // Hover: WM_NCMOUSEMOVE on the child reports the button (the real cursor is elsewhere, so the leave follows at once).
  await wc.cmd('post', probe.child, L.WM.NCMOUSEMOVE, L.HT.MAXBUTTON, L.lparam(...centre('max')));
  await sleep(300);
  const hovered = await log();
  check(`${tag} native hover report`, hovered.some((s) => s.hover === 'max' && s.pressed === null), JSON.stringify(hovered));

  // Press and release over a button: the press shows, the release runs the system command, and the hover ends (the leave
  // is tracked again after the capture; the real cursor is not there, so it comes at once).
  const click = async (b) => {
    await wc.cmd('post', probe.child, L.WM.NCLBUTTONDOWN, HT_OF[b], L.lparam(...centre(b)));
    await sleep(150);
    await wc.cmd('post', probe.child, L.WM.LBUTTONUP, 0, L.lparam(...local(centre(b))));
    await sleep(400);
  };
  await click('max');
  const pressLog = await log();
  check(`${tag} native press report`, pressLog.some((s) => s.pressed === 'max'), JSON.stringify(pressLog));
  const last = pressLog.at(-1);
  check(`${tag} no hover stays painted after a release (leave tracked again)`, last && last.hover === null && last.pressed === null, JSON.stringify(pressLog));
  let s = await sys();
  check(`${tag} maximize click runs SC_MAXIMIZE`, s.some((e) => e.msg === 'syscommand' && e.command === SC.MAXIMIZE), JSON.stringify(s));
  // Released off the button: no click.
  await wc.cmd('post', probe.child, L.WM.NCLBUTTONDOWN, L.HT.MAXBUTTON, L.lparam(...centre('max')));
  await sleep(150);
  await wc.cmd('post', probe.child, L.WM.LBUTTONUP, 0, L.lparam(-400, 300));
  await sleep(400);
  s = await sys();
  check(`${tag} a press released elsewhere clicks nothing`, !s.some((e) => e.msg === 'syscommand'), JSON.stringify(s));
  // Minimize really minimizes (off-screen, transitions off: nothing shows), then the window comes back.
  await click('min');
  s = await sys();
  const minimized = (await wc.cmd('rect', win.hwnd)).minimized;
  check(`${tag} minimize click runs SC_MINIMIZE`, s.some((e) => e.command === SC.MINIMIZE) && minimized, JSON.stringify(s));
  await bridge(page, 'window', { action: 'sysRestore' });
  await sleep(500);
  await sys();

  // The title bar: double-click maximizes, a right click opens the system menu, a press starts the move loop (Aero snap).
  const barPt = [cx + Math.round(500 * scale), cy + Math.round(18 * scale)];
  const bar = await hitAt(wc, ...barPt);
  await wc.cmd('post', bar.hwnd, L.WM.NCLBUTTONDOWN + 2 /* WM_NCLBUTTONDBLCLK */, L.HT.CAPTION, L.lparam(...barPt));
  await sleep(400);
  s = await sys();
  check(`${tag} double-click on the title bar maximizes`, s.some((e) => e.command === SC.MAXIMIZE), JSON.stringify(s));
  await wc.cmd('post', bar.hwnd, 0xa4 /* WM_NCRBUTTONDOWN */, L.HT.CAPTION, L.lparam(...barPt));
  await wc.cmd('post', bar.hwnd, 0xa5 /* WM_NCRBUTTONUP */, L.HT.CAPTION, L.lparam(...barPt));
  await sleep(400);
  s = await sys();
  const menu = s.find((e) => e.msg === 'systemmenu');
  const on = (c) => menu?.items.find((i) => i.command === c)?.enabled;
  check(`${tag} right click on the title bar opens the system menu (restored: Restore grey, Move / Size on, Close default)`, menu && menu.x === barPt[0] && menu.y === barPt[1] && on(SC.RESTORE) === false && on(SC.MOVE) === true && on(SC.SIZE) === true && on(SC.MAXIMIZE) === true && menu.default === SC.CLOSE, JSON.stringify(s));
  await wc.cmd('post', bar.hwnd, L.WM.NCLBUTTONDOWN, L.HT.CAPTION, L.lparam(...barPt));
  await sleep(400);
  s = await sys();
  check(`${tag} a press on the title bar starts the move loop (drag, Aero snap)`, s.some((e) => e.command === SC.MOVE), JSON.stringify(s));

  // The top edge: a press resizes from the top, from a corner diagonally (the edge child hands it to the window).
  for (const [name, pt, wmsz, ht] of [['top', [cx + Math.round(500 * scale), cy + 1], WMSZ.TOP, HT_TOP], ['top left', [cx + 1, cy + 1], WMSZ.TOPLEFT, HT_TOPLEFT], ['top right', [cx + cw - 2, cy], WMSZ.TOPRIGHT, HT_TOPRIGHT]]) {
    await wc.cmd('post', probe.edge, L.WM.NCLBUTTONDOWN, ht, L.lparam(...pt));
    await sleep(300);
    s = await sys();
    check(`${tag} a press on the ${name} edge starts the resize loop`, s.some((e) => e.msg === 'syscommand' && e.command === SC.SIZE && e.raw === (SC.SIZE | wmsz)), JSON.stringify(s));
  }

  // Assistive technology: the native child is named, the page's anchors are buttons with names (UI Automation Invoke).
  const named = await page.evaluate(`[...document.querySelectorAll('.mc-caption-tip')].map((e) => [e.dataset.captionButton, e.getAttribute('role'), e.getAttribute('aria-label'), e.getAttribute('aria-hidden')])`);
  const names = Object.fromEntries(named.map(([b, , label]) => [b, label]));
  const ax = await page.send('Accessibility.getFullAXTree').catch(() => null);
  const axButtons = (ax?.nodes ?? []).filter((n) => n.role?.value === 'button').map((n) => n.name?.value);
  check(`${tag} the buttons are named for assistive technology`, named.length === 3 && named.every(([, role, , hidden]) => role === 'button' && hidden === null) && NAMES.min.includes(names.min) && NAMES.max.includes(names.max) && NAMES.close.includes(names.close) && ['min', 'max', 'close'].every((b) => axButtons.includes(names[b])) && probe.text === `${names.min}, ${names.max}, ${names.close}`, JSON.stringify({ named, text: probe.text, axButtons: axButtons.filter((n) => Object.values(names).includes(n)) }));

  // Tooltips: the hovered button's title through tr() (the scratch profile has no language yet: the system one).
  await pointer(page, 'main', 'max', null);
  const tip = await waitFor(page, `document.querySelector('.mc-tooltip.on')?.textContent`, 3000, 'tooltip').catch(() => null);
  await pointer(page, 'main', null, null);
  check(`${tag} maximize tooltip`, NAMES.max.includes(tip), String(tip));
}

/**
 * A detached window through W5's real path: a grid moved to its own window by the renderer's "Move to a new window" (the
 * off-screen run shows it off every monitor). Same chrome, same buttons, the same hit map as 1.1.4's.
 */
async function detachedCheck(wc, percent) {
  const scale = percent / 100;
  const tag = `${percent}% detached`;
  const scratch = mkdtempSync(join(tmpdir(), 'unimux-caption-detached-'));
  let child = null;
  try {
    const load = async (file) => (await runnerImport(resolve(L.root, file), { configFile: false, logLevel: 'silent', root: L.root })).module;
    const [{ addProject, addTab, defaultState }, { layoutForCount }] = await Promise.all([load('src/shared/state.ts'), load('src/shared/layout.ts')]);
    const projectDir = join(scratch, 'project');
    mkdirSync(projectDir, { recursive: true });
    let state = addProject(defaultState('win32'), { name: 'P', path: projectDir });
    const projectId = state.projects[0].id;
    state = addTab(state, projectId, { name: 'Grid 1', layout: layoutForCount(1), cells: [] });
    state = addTab(state, projectId, { name: 'Grid 2', layout: layoutForCount(1), cells: [] });
    state.activeProjectId = projectId;
    const grid = state.projects[0].tabs[1];
    const run = await launch(scratch, state);
    child = run.child;
    const { page } = run;
    await waitFor(page, 'window.__mc?.useStore?.getState?.().ready === true', 60000, 'renderer ready');
    const moved = await page.evaluate(`window.__mc.detach.detachKey('grid:${grid.id}', 'menu')`);
    await waitFor(page, `window.__TAURI_INTERNALS__.invoke('test_bridge', { op: 'detached', args: null }).then((d) => d.service.windows.length === 1)`, 30000, 'detached window');
    const reg = (await bridge(page, 'state')).snapshot.state.detachedWindows ?? [];
    const id = reg[0]?.id;
    const label = `detached-${id}`;
    check(`${tag} window opens through detach (W5)`, moved === true && id, JSON.stringify(reg));
    let probe = null;
    for (let i = 0; i < 100; i++) {
      probe = await caption(page, { action: 'probe', label }).catch(() => null);
      if (probe?.child && probe.hwnd) break;
      await sleep(200);
    }
    if (!probe?.child) throw new Error(`no caption on ${label}: ${JSON.stringify(probe)}`);
    await assertOffscreen(wc, probe.hwnd, 'the detached window');
    await caption(page, { action: 'scale', scale, label });
    await sizeLikeReference(wc, probe.hwnd, percent);
    probe = await settledProbe(page, percent, label);
    await sleep(1500);
    const r = await wc.cmd('rect', probe.hwnd);
    const crop = cropOf(scale);
    const raw = join(scratch, 'detached.raw');
    await wc.cmd('capture', probe.hwnd, raw);
    const img = L.readRaw(raw);
    const ours = L.crop(img, img.width - crop.w, 0, crop.w, crop.h);
    const refImg = L.readPng(join(L.FIXTURES, String(percent), 'idle.png'));
    // The detached page's own title bar differs from the first-run one left of the buttons: compare the 137 DIP container.
    const cut = (i) => L.crop(i, i.width - Math.round(137 * scale), 0, Math.round(137 * scale), i.height);
    const d = L.diffImages(cut(ours), cut(refImg), CHANNEL_TOLERANCE);
    L.writePng(join(shots, `detached-${percent}-idle.png`), ours);
    check(`${tag}: no title bar, buttons match 1.1.4, page agrees with the native layout`, probe.decorated === false && probe.visible && probe.pageMatches === true && d.ratio <= MAX_RATIO, `${(d.ratio * 100).toFixed(2)} % differing, area ${JSON.stringify(probe.area)}`);
    await compareHitMap(wc, r, percent, tag);
    await bridge(page, 'detachedWindow', { id, action: 'close' }).catch(() => null);
  } finally {
    await killAppTreeAndWait(child);
    if (!keep) removeScratch(scratch);
  }
}

const markers = realProfileMarkers();
const wc = L.startWincap();
try {
  for (const percent of percents) {
    try { await runScale(wc, percent); } catch (error) { if (error?.name === 'BlockedError') throw error; check(`${percent}% run`, false, error.stack ?? String(error)); }
  }
  try { await detachedCheck(wc, percents[0]); } catch (error) { if (error?.name === 'BlockedError') throw error; check(`${percents[0]}% detached run`, false, error.stack ?? String(error)); }
} finally {
  wc.close();
}
check('real profile untouched', JSON.stringify(markers) === JSON.stringify(realProfileMarkers()));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
