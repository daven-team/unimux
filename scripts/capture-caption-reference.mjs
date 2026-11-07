// W1 reference images: the native caption buttons of 1.1.4 (Electron 45 titleBarOverlay {#0d0d0d, #8a8a8a, 36}), captured with
// an OS-level window capture (PrintWindow, PW_RENDERFULLCONTENT; CDP screenshots do not contain the overlay) at 100, 125, 150
// and 200 percent (--force-device-scale-factor), in every state: idle, hover and pressed per button, the maximized window
// (restore glyph, also hovered and pressed) and the active window. Written to test/fixtures/caption/<scale>/<state>.png with a
// manifest (button hit-test map, sizes, versions).
//
//   npm run build && (cd src-tauri && node ../scripts/msvc-run.mjs cargo build -p unimux-platform --example wincap --release)
//   node scripts/capture-caption-reference.mjs
//
// Off-screen and never focused: the window sits at x=-6000 (MC_OFFSCREEN), states come from messages posted to the window
// (no real cursor move, no activation, no real maximize: WS_MAXIMIZE is set on the style instead, so nothing moves onto a
// monitor). Scratch data dir and home; only the processes started here are ended.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as L from './caption-lib.mjs';
import { removeScratch } from './app-env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUTTONS = ['min', 'max', 'close'];
/** Button centres in DIP from the right edge of the client area (46 DIP wide buttons, measured below by hit tests). */
const CENTRE = { close: 23, max: 69, min: 115 };
const BG = [0x0d, 0x0d, 0x0d];
const WM_RBUTTONDOWN = 0x204;
const WM_RBUTTONUP = 0x205;
const MK_LBUTTON = 1;
const MK_RBUTTON = 2;
const WS_MAXIMIZE = 0x01000000;

/** The capture crop: 160 x 40 DIP at the top-right corner of the client area (the 138 x 36 buttons and a margin). */
export const cropOf = (scale) => ({ w: Math.round(160 * scale), h: Math.round(40 * scale) });

async function captureScale(wc, scale, outDir) {
  const scratch = mkdtempSync(join(tmpdir(), 'unimux-caption-ref-'));
  mkdirSync(join(scratch, 'data'));
  const child = L.launchElectron({ dataDir: join(scratch, 'data'), scratch, scale });
  const result = { scale, states: {} };
  try {
    const win = await L.findAppWindow(wc, child.pid);
    await sleep(4000); // first paint of the page and the overlay
    const normal = await wc.cmd('rect', win.hwnd);
    if (normal.window[2] > -1000) throw new Error(`${scale}: the window is not off-screen (${JSON.stringify(normal.window)}); stopped`);
    result.client = normal.client.slice(2);
    const at = (dip) => Math.round(dip * scale);
    const crop = cropOf(scale);
    const grab = async () => {
      const raw = join(scratch, 'grab.raw');
      await wc.cmd('capture', win.hwnd, raw);
      const img = L.readRaw(raw);
      return L.crop(img, img.width - crop.w, 0, crop.w, crop.h);
    };
    const save = (state, img) => { L.writePng(join(outDir, `${state}.png`), img); result.states[state] = true; };
    const clientWidth = async () => (await wc.cmd('rect', win.hwnd)).client[2];
    /** The background a few pixels inside the button's top-left corner (hover / pressed change it). */
    const bgOf = (img, button) => L.pixel(img, crop.w - at(CENTRE[button] + 23) + 3, 3);
    const idleOf = async () => grab();

    // Hit-test map along the caption (the client's top-right): what Windows gets from WM_NCHITTEST.
    const [cx, cy] = normal.client;
    const cw = normal.client[2];
    const map = {};
    for (const y of [0, 1, 6, 7, 35, 36].map(at)) {
      const row = [];
      for (let dx = 1; dx <= at(150); dx++) row.push((await wc.cmd('hittest', cx + cw - dx, cy + y)).chain.at(-1).hit);
      map[y] = row;
    }
    result.hitMap = map;

    const idle = await idleOf();
    save('idle', idle);
    // Active: the off-screen window never takes the focus; WM_NCACTIVATE(TRUE) makes the frame paint as active. Taken right
    // after idle, on the same client size (the maximized round trip below can leave a fractional scale one pixel off).
    await wc.cmd('send', win.hwnd, L.WM.NCACTIVATE, 1, 0);
    await sleep(400);
    const active = await grab();
    save('active', active);
    result.activeEqualsInactive = L.diffImages(active, idle, 0).differing === 0;
    await wc.cmd('send', win.hwnd, L.WM.NCACTIVATE, 0, 0);
    await sleep(400);

    for (const maximized of [false, true]) {
      if (maximized) {
        await wc.cmd('setstyle', win.hwnd, normal.style | WS_MAXIMIZE);
        const [x0, y0, x1, y1] = normal.window;
        await wc.cmd('setpos', win.hwnd, x0, y0, x1 - x0 + 2, y1 - y0);
        await sleep(800);
        save('maximized-idle', await grab());
      }
      const prefix = maximized ? 'maximized-' : '';
      const buttons = maximized ? ['max'] : BUTTONS;
      for (const b of buttons) {
        const name = maximized ? 'restore' : b;
        const width = await clientWidth();
        const x = width - at(CENTRE[b]);
        const y = at(18);
        const away = [at(300), at(300)];
        // Hover: a right-button press on the button keeps the mouse captured, so the drag that follows hovers it (views'
        // buttons react to the left button only) and no WM_MOUSELEAVE from the real cursor's position cancels it.
        let hovered = null;
        for (let attempt = 0; attempt < 5 && !hovered; attempt++) {
          await wc.cmd('post', win.hwnd, L.WM.MOUSEMOVE, 0, L.lparam(x, y));
          await wc.cmd('post', win.hwnd, WM_RBUTTONDOWN, MK_RBUTTON, L.lparam(x, y));
          await wc.cmd('post', win.hwnd, L.WM.MOUSEMOVE, MK_RBUTTON, L.lparam(x + 1, y));
          await sleep(450); // the hover fade
          const img = await grab();
          if (bgOf(img, b).join() !== BG.join()) hovered = img;
          await wc.cmd('post', win.hwnd, L.WM.MOUSEMOVE, MK_RBUTTON, L.lparam(...away));
          await wc.cmd('post', win.hwnd, WM_RBUTTONUP, 0, L.lparam(...away));
          await sleep(450);
        }
        if (!hovered) throw new Error(`${scale}: ${prefix}hover-${name} not reached`);
        save(`${prefix}hover-${name}`, hovered);
        // Pressed: a left press held (the button keeps the capture); released outside, so nothing is clicked.
        let pressed = null;
        for (let attempt = 0; attempt < 5 && !pressed; attempt++) {
          await wc.cmd('post', win.hwnd, L.WM.MOUSEMOVE, 0, L.lparam(x, y));
          await wc.cmd('post', win.hwnd, L.WM.LBUTTONDOWN, MK_LBUTTON, L.lparam(x, y));
          await sleep(300);
          const img = await grab();
          if (bgOf(img, b).join() !== BG.join()) pressed = img;
          await wc.cmd('post', win.hwnd, L.WM.MOUSEMOVE, MK_LBUTTON, L.lparam(...away));
          await wc.cmd('post', win.hwnd, L.WM.LBUTTONUP, 0, L.lparam(...away));
          await sleep(450);
        }
        if (!pressed) throw new Error(`${scale}: ${prefix}pressed-${name} not reached`);
        save(`${prefix}pressed-${name}`, pressed);
        const back = await grab();
        if (L.diffImages(back, maximized ? await grab() : idle, 0).differing) throw new Error(`${scale}: ${prefix}${name} did not return to idle`);
      }
      if (maximized) {
        await wc.cmd('setstyle', win.hwnd, normal.style);
        const [x0, y0, x1, y1] = normal.window;
        await wc.cmd('setpos', win.hwnd, x0, y0, x1 - x0, y1 - y0);
        await sleep(800);
      }
    }
    if (child.exitCode !== null) throw new Error(`${scale}: the app exited during the capture`);
  } finally {
    L.killTree(child);
    await sleep(500);
    removeScratch(scratch);
  }
  return result;
}

const wc = L.startWincap();
const manifest = {
  source: '1.1.4 window chrome (Electron titleBarOverlay {color #0d0d0d, symbolColor #8a8a8a, height 36}), this tree built with npm run build',
  electron: createRequire(import.meta.url)('electron/package.json').version,
  captured: new Date().toISOString().slice(0, 10),
  crop: 'top-right 160 x 40 DIP of the client area',
  scales: {},
};
try {
  for (const scale of L.SCALES) {
    const outDir = join(L.FIXTURES, String(Math.round(scale * 100)));
    mkdirSync(outDir, { recursive: true });
    const r = await captureScale(wc, scale, outDir);
    manifest.scales[Math.round(scale * 100)] = r;
    console.log(`${scale * 100}%: ${Object.keys(r.states).length} states, active equals inactive: ${r.activeEqualsInactive}`);
  }
} finally {
  wc.close();
}
writeFileSync(join(L.FIXTURES, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
