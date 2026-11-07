// W1 acceptance check of the Tauri check build on Windows: the window has no system title bar, the caption buttons the page
// draws match the 1.1.4 references (test/fixtures/caption, scripts/capture-caption-reference.mjs) per state at 100, 125, 150
// and 200 percent (OS-level window capture: at most 2 percent differing pixels, the glyphs at the same place), Windows gets
// HTMINBUTTON / HTMAXBUTTON / HTCLOSE over the buttons exactly where 1.1.4 answered them (HTMAXBUTTON is what opens the
// Windows 11 snap layouts) and HTCAPTION over the title bar, the native path works (hover and press reports, clicks run
// SC_MINIMIZE / SC_MAXIMIZE / SC_CLOSE), a double-click on the title bar maximizes, a right click opens the system menu and a
// press starts the move loop, the tooltips are translated, and a detached window has the same buttons.
//
//   npm run build:check
//   (cd src-tauri && node ../scripts/msvc-run.mjs cargo build -p unimux-platform --example wincap --release)
//   node scripts/verify-caption.mjs [--scale=100,125,150,200] [--keep]      diff images: artifacts/caption/
//
// Nothing appears on the desktop: the app runs off-screen (MC_OFFSCREEN, never activated), states come from messages posted
// to its windows (the real cursor never moves), the maximized look is taken with WS_MAXIMIZE set on the style (no real
// maximize onto a monitor), and the test bridge's caption guard swallows the system commands that would show something (a
// real maximize, the system menu, the move loop) after recording them. Scratch data dir and home; only our processes end.
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as L from './caption-lib.mjs';
import { removeScratch } from './app-env.mjs';
import { connectPage, freePort, killTree, launchApp, realProfileMarkers, sleep, waitExit, waitFor } from './tauri-app.mjs';

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
const SC = { MINIMIZE: 0xf020, MAXIMIZE: 0xf030, CLOSE: 0xf060, MOVE: 0xf010, RESTORE: 0xf120 };
const HT_OF = { min: L.HT.MINBUTTON, max: L.HT.MAXBUTTON, close: L.HT.CLOSE };
/** The client sizes of the reference windows (recorded in the manifest by the capture). */
const manifest = JSON.parse(readFileSync(join(L.FIXTURES, 'manifest.json'), 'utf8'));
const CLIENT = Object.fromEntries(Object.entries(manifest.scales).map(([p, v]) => [p, v.client[0]]));
const CLIENT_H = Object.fromEntries(Object.entries(manifest.scales).map(([p, v]) => [p, v.client[1]]));
const cropOf = (scale) => ({ w: Math.round(160 * scale), h: Math.round(40 * scale) });

const bridge = (page, op, a) => page.evaluate(`window.__TAURI_INTERNALS__.invoke('test_bridge', ${JSON.stringify({ op, args: a ?? null })})`);
const caption = (page, a) => bridge(page, 'caption', a);
/** Paints a pointer state exactly as the native child reports it (the page's half; the native half is checked below). */
const pointer = (page, label, hover, pressed) => bridge(page, 'emit', { event: 'window:caption', args: [{ hover, pressed }] }).then(() => label);

/** The effective WM_NCHITTEST answer at a screen point: the first window of the chain that is not HTTRANSPARENT. */
async function hitAt(wc, x, y) {
  const { chain } = await wc.cmd('hittest', x, y);
  const hit = chain.find((c) => c.hit !== L.HT.TRANSPARENT);
  return { code: hit ? hit.hit : null, hwnd: hit?.hwnd, class: hit?.class, chain };
}

async function runScale(wc, percent) {
  const scale = percent / 100;
  const scratch = mkdtempSync(join(tmpdir(), 'unimux-caption-check-'));
  mkdirSync(join(scratch, 'data'));
  const port = await freePort();
  const child = launchApp({ dataDir: join(scratch, 'data'), scratch, port });
  const tag = `${percent}%`;
  try {
    const page = await connectPage(port, { timeoutMs: 60000 });
    await waitFor(page, `!!(document.querySelector('canvas.mc-caption') && document.querySelector('.titlebar'))`, 60000, 'caption canvas and title bar');
    const win = await L.findAppWindow(wc, child.pid);
    // Never on the desktop: a window that is not off every monitor ends the run at once.
    const parked = await wc.cmd('rect', win.hwnd);
    if (parked.window[2] > -1000) throw new Error(`the app window is not off-screen (${JSON.stringify(parked.window)}); stopped`);
    await caption(page, { action: 'scale', scale });
    // The reference window's client size.
    const before = await wc.cmd('rect', win.hwnd);
    const [wx0, wy0, wx1, wy1] = before.window;
    const extraW = (wx1 - wx0) - before.client[2];
    const extraH = (wy1 - wy0) - before.client[3];
    await wc.cmd('setpos', win.hwnd, wx0, wy0, CLIENT[percent] + extraW, CLIENT_H[percent] + extraH);
    await waitFor(page, `window.devicePixelRatio === ${scale}`, 10000, `devicePixelRatio ${scale}`);
    let probe = null;
    for (let i = 0; i < 50; i++) {
      probe = await caption(page, { action: 'probe' });
      if (probe.area && probe.visible && probe.rect[0] + probe.rect[2] === CLIENT[percent]) break;
      await sleep(100);
    }
    const rect = await wc.cmd('rect', win.hwnd);
    // tao keeps WS_CAPTION in the style (Aero snap and the window animations need it) and takes the whole window as client
    // area in WM_NCCALCSIZE, so no title bar is drawn: the client area starts at the window's top (the 1 px shadow frame).
    check(`${tag} window without a system title bar`, probe.decorated === false && rect.client[1] - rect.window[1] <= 1 && (rect.style & WS_THICKFRAME) && (rect.style & WS_MAXIMIZEBOX), `style 0x${(rect.style >>> 0).toString(16)}, client top ${rect.client[1] - rect.window[1]} px below the window top, client ${rect.client[2]}x${rect.client[3]}`);
    check(`${tag} hit-test child over the buttons`, probe.visible && probe.area && probe.rect[0] + probe.rect[2] === rect.client[2], JSON.stringify({ rect: probe.rect, area: probe.area }));

    // ---- hit tests along the caption, against 1.1.4's map ----
    const ref = manifest.scales[percent];
    const [cx, cy] = rect.client;
    const cw = rect.client[2];
    let buttonMismatch = 0;
    const codes = {};
    for (const [row, refRow] of Object.entries(ref.hitMap)) {
      const y = Number(row);
      const ours = [];
      for (let dx = 1; dx <= refRow.length; dx++) ours.push((await hitAt(wc, cx + cw - dx, cy + y)).code);
      ours.forEach((code, i) => {
        const isButton = (c) => [L.HT.MINBUTTON, L.HT.MAXBUTTON, L.HT.CLOSE].includes(c);
        if ((isButton(code) || isButton(refRow[i])) && code !== refRow[i]) buttonMismatch++;
        const key = `${refRow[i]}->${code}`;
        codes[key] = (codes[key] ?? 0) + 1;
      });
    }
    check(`${tag} HTMINBUTTON / HTMAXBUTTON / HTCLOSE exactly where 1.1.4 answered them`, buttonMismatch === 0, `${buttonMismatch} pixels differ; reference->ours counts ${JSON.stringify(codes)}`);
    const maxCentre = await hitAt(wc, cx + cw - Math.round(69 * scale), cy + Math.round(18 * scale));
    check(`${tag} maximize answers HTMAXBUTTON (Windows 11 snap layouts)`, maxCentre.code === L.HT.MAXBUTTON, `${maxCentre.class} ${maxCentre.code}`);
    const bar = await hitAt(wc, cx + Math.round(cw / 2), cy + Math.round(18 * scale));
    check(`${tag} the title bar answers HTCAPTION`, bar.code === L.HT.CAPTION, JSON.stringify(bar.chain.map((c) => `${c.class}:${c.hit}`)));

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
      await pointer(page, b, b, null);
      await compare(`hover-${b}`);
      await pointer(page, b, null, b);
      await compare(`pressed-${b}`);
      await pointer(page, b, null, null);
    }
    await sleep(400);
    // Active: the page draws the same buttons for an active and an inactive window (so did 1.1.4's overlay).
    await wc.cmd('send', win.hwnd, L.WM.NCACTIVATE, 1, 0);
    await compare('active', { glyph: true });
    await wc.cmd('send', win.hwnd, L.WM.NCACTIVATE, 0, 0);

    // Maximized look: WS_MAXIMIZE on the style, no real maximize (nothing moves onto a monitor).
    const normal = await wc.cmd('rect', win.hwnd);
    await wc.cmd('setstyle', win.hwnd, normal.style | WS_MAXIMIZE);
    {
      const [x0, y0, x1, y1] = normal.window;
      await wc.cmd('setpos', win.hwnd, x0, y0, x1 - x0, y1 - y0);
    }
    await sleep(600);
    const maxProbe = await caption(page, { action: 'probe' });
    check(`${tag} maximized state reaches the page`, maxProbe.maximized === true && maxProbe.area?.max?.[1] === 0, JSON.stringify(maxProbe.area));
    await compare('maximized-idle', { glyph: true });
    await pointer(page, 'max', 'max', null);
    await compare('maximized-hover-restore');
    await pointer(page, 'max', null, 'max');
    await compare('maximized-pressed-restore');
    await pointer(page, 'max', null, null);
    await wc.cmd('setstyle', win.hwnd, normal.style);
    {
      const [x0, y0, x1, y1] = normal.window;
      await wc.cmd('setpos', win.hwnd, x0, y0, x1 - x0, y1 - y0);
    }
    await sleep(600);

    if (percent !== percents[0]) return;
    // ---- once: the native path, the title bar, tooltips, a detached window, the close button ----
    await nativeChecks(wc, page, win, scale, tag);
    await detachedCheck(wc, page, child, scale, tag, scratch);
    // Close: a click on the close button ends the app the normal way (SC_CLOSE -> WM_CLOSE).
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
    killTree(child);
    await sleep(500);
    if (!keep) removeScratch(scratch);
  }
}

async function nativeChecks(wc, page, win, scale, tag) {
  await page.evaluate(`window.__capLog = []; window.mc.on('window:caption', (s) => window.__capLog.push(s)); true`);
  await caption(page, { action: 'guard' });
  await caption(page, { action: 'log' });
  const probe = await caption(page, { action: 'probe' });
  const { client: [cx, cy] } = await wc.cmd('rect', win.hwnd);
  const centre = (b) => { const [x, y, w, h] = probe.area[b]; return [cx + x + Math.floor(w / 2), cy + y + Math.floor(h / 2)]; };
  const local = (pt) => [pt[0] - cx - probe.rect[0], pt[1] - cy - probe.rect[1]];
  const log = () => page.evaluate('window.__capLog.splice(0)');
  const sys = async () => (await caption(page, { action: 'log' })).log;

  // Hover: WM_NCMOUSEMOVE on the child reports the button (the real cursor is elsewhere, so the leave follows at once).
  await wc.cmd('post', probe.child, L.WM.NCMOUSEMOVE, L.HT.MAXBUTTON, L.lparam(...centre('max')));
  await sleep(300);
  const hovered = await log();
  check(`${tag} native hover report`, hovered.some((s) => s.hover === 'max' && s.pressed === null), JSON.stringify(hovered));

  // Press and release over a button: the press shows, the release runs the system command.
  const click = async (b) => {
    await wc.cmd('post', probe.child, L.WM.NCLBUTTONDOWN, HT_OF[b], L.lparam(...centre(b)));
    await sleep(150);
    await wc.cmd('post', probe.child, L.WM.LBUTTONUP, 0, L.lparam(...local(centre(b))));
    await sleep(400);
  };
  await click('max');
  const pressLog = await log();
  check(`${tag} native press report`, pressLog.some((s) => s.pressed === 'max'), JSON.stringify(pressLog));
  let s = await sys();
  check(`${tag} maximize click runs SC_MAXIMIZE`, s.some((e) => e.msg === 'syscommand' && e.command === SC.MAXIMIZE), JSON.stringify(s));
  // Released off the button: no click.
  await wc.cmd('post', probe.child, L.WM.NCLBUTTONDOWN, L.HT.MAXBUTTON, L.lparam(...centre('max')));
  await sleep(150);
  await wc.cmd('post', probe.child, L.WM.LBUTTONUP, 0, L.lparam(-400, 300));
  await sleep(400);
  s = await sys();
  check(`${tag} a press released elsewhere clicks nothing`, !s.some((e) => e.msg === 'syscommand'), JSON.stringify(s));
  // Minimize really minimizes (off-screen, nothing shows), then the window comes back.
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
  check(`${tag} right click on the title bar opens the system menu`, s.some((e) => e.msg === 'contextmenu' || e.command === 0xf090 /* SC_MOUSEMENU */), JSON.stringify(s));
  await wc.cmd('post', bar.hwnd, L.WM.NCLBUTTONDOWN, L.HT.CAPTION, L.lparam(...barPt));
  await sleep(400);
  s = await sys();
  check(`${tag} a press on the title bar starts the move loop (drag, Aero snap)`, s.some((e) => e.command === SC.MOVE), JSON.stringify(s));

  // Tooltips: the hovered button's title through tr() (the scratch profile has no language yet: the system one, Polish or English).
  await pointer(page, 'max', 'max', null);
  const tip = await waitFor(page, `document.querySelector('.mc-tooltip.on')?.textContent`, 3000, 'tooltip').catch(() => null);
  await pointer(page, 'max', null, null);
  check(`${tag} maximize tooltip`, tip === 'Maksymalizuj' || tip === 'Maximize' || tip === 'Maximieren' || tip === 'Maximizar' || tip === 'Agrandir', String(tip));
}

async function detachedCheck(wc, page, child, scale, tag, scratch) {
  const opened = await bridge(page, 'openWindow', { label: 'detached-w1', url: 'index.html?detached=w1', visible: true });
  if (!opened.ok) { check(`${tag} detached window opens`, false, JSON.stringify(opened)); return; }
  let det = null;
  for (let i = 0; i < 100 && !det; i++) {
    const { windows } = await wc.cmd('windows', child.pid);
    const mainProbe = await caption(page, { action: 'probe' });
    det = windows.find((w) => w.visible && w.class !== 'Chrome_MessageWindow' && w.hwnd !== mainProbe.hwnd && /unimux/.test(w.title));
    if (!det) await sleep(200);
  }
  if (!det) { check(`${tag} detached window opens`, false, 'no window'); return; }
  await caption(page, { action: 'scale', scale, label: 'detached-w1' });
  const r = await wc.cmd('rect', det.hwnd);
  if (r.window[2] > -1000) {
    await bridge(page, 'window', { label: 'detached-w1', action: 'close' });
    throw new Error(`the detached window is not off-screen (${JSON.stringify(r.window)}); stopped`);
  }
  const [x0, y0, x1, y1] = r.window;
  await wc.cmd('setpos', det.hwnd, x0, y0, CLIENT[Math.round(scale * 100)] + (x1 - x0 - r.client[2]), CLIENT_H[Math.round(scale * 100)] + (y1 - y0 - r.client[3]));
  let probe = null;
  for (let i = 0; i < 80; i++) {
    probe = await caption(page, { action: 'probe', label: 'detached-w1' });
    if (probe.visible && probe.area && probe.rect[0] + probe.rect[2] === CLIENT[Math.round(scale * 100)]) break;
    await sleep(150);
  }
  await sleep(1500);
  const crop = cropOf(scale);
  const raw = join(scratch, 'detached.raw');
  await wc.cmd('capture', det.hwnd, raw);
  const img = L.readRaw(raw);
  const ours = L.crop(img, img.width - crop.w, 0, crop.w, crop.h);
  const refImg = L.readPng(join(L.FIXTURES, String(Math.round(scale * 100)), 'idle.png'));
  // The detached page's own title bar differs from the first-run one left of the buttons: compare the 137 DIP container.
  const cut = (i) => L.crop(i, i.width - Math.round(137 * scale), 0, Math.round(137 * scale), i.height);
  const d = L.diffImages(cut(ours), cut(refImg), CHANNEL_TOLERANCE);
  L.writePng(join(shots, `detached-${Math.round(scale * 100)}-idle.png`), ours);
  check(`${tag} detached window: no title bar, buttons match 1.1.4`, probe.decorated === false && probe.visible && d.ratio <= MAX_RATIO, `${(d.ratio * 100).toFixed(2)} % differing, area ${JSON.stringify(probe.area)}`);
  const { client: [cx, cy] } = r;
  const hit = await hitAt(wc, cx + r.client[2] - Math.round(69 * scale), cy + Math.round(18 * scale));
  check(`${tag} detached window: maximize answers HTMAXBUTTON`, hit.code === L.HT.MAXBUTTON, `${hit.class} ${hit.code}`);
  await bridge(page, 'window', { label: 'detached-w1', action: 'close' });
}

const markers = realProfileMarkers();
const wc = L.startWincap();
try {
  for (const percent of percents) {
    try { await runScale(wc, percent); } catch (error) { check(`${percent}% run`, false, error.stack ?? String(error)); }
  }
} finally {
  wc.close();
}
check('real profile untouched', JSON.stringify(markers) === JSON.stringify(realProfileMarkers()));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
