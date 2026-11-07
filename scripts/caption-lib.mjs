// Shared helpers of the W1 caption checks (scripts/capture-caption-reference.mjs, scripts/verify-caption.mjs): PNG read and
// write, the wincap tool (OS-level window capture, posted window messages, hit tests; never moves the real cursor or
// activates a window) and the off-screen launchers of the Electron reference build and the Tauri check build.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { scratchHome, scrubAppEnv } from './app-env.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCALES = [1, 1.25, 1.5, 2];
export const FIXTURES = join(root, 'test', 'fixtures', 'caption');

// ---- PNG (RGBA 8 bit, no interlace) ----

/** Encodes `{ width, height, data }` (RGBA bytes) as a PNG file. */
export function encodePng({ width, height, data }) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const src = Buffer.from(data.buffer, data.byteOffset, data.length);
  for (let y = 0; y < height; y++) src.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Decodes an 8-bit RGBA or RGB PNG (the files encodePng writes and plain screenshots). */
export function decodePng(buffer) {
  let pos = 8; let width = 0; let height = 0; let colorType = 6; const idat = [];
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos); const type = buffer.toString('ascii', pos + 4, pos + 8); const body = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); colorType = body[9]; if (body[8] !== 8 || body[12] !== 0) throw new Error('unsupported PNG'); }
    if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat)); const stride = width * bpp; const out = Buffer.alloc(width * height * 4); const prev = Buffer.alloc(stride); const cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) { for (let k = 0; k < 3; k++) out[(y * width + x) * 4 + k] = cur[x * bpp + k]; out[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255; }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

/** Reads a wincap raw capture (BGRA) as an RGBA image with opaque alpha. */
export function readRaw(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 5) !== 'W1RAW') throw new Error(`not a wincap capture: ${file}`);
  const width = b.readUInt32LE(5); const height = b.readUInt32LE(9); const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = b[13 + i * 4 + 2]; data[i * 4 + 1] = b[13 + i * 4 + 1]; data[i * 4 + 2] = b[13 + i * 4]; data[i * 4 + 3] = 255; }
  return { width, height, data };
}

export function crop(img, x, y, w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r++) img.data.copy(data, r * w * 4, ((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4);
  return { width: w, height: h, data };
}

/**
 * Per-pixel comparison: a pixel differs when any channel differs by more than `channelTolerance`. Answers the share of
 * differing pixels, the largest channel difference and a diff image (differing pixels red, the rest dimmed).
 */
export function diffImages(a, b, channelTolerance = 8) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true, ratio: 1, differing: a.width * a.height, maxDelta: 255, a: [a.width, a.height], b: [b.width, b.height] };
  let differing = 0; let maxDelta = 0; const out = Buffer.alloc(a.data.length);
  for (let i = 0; i < a.width * a.height; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i * 4 + k] - b.data[i * 4 + k]));
    maxDelta = Math.max(maxDelta, d);
    if (d > channelTolerance) { differing++; out[i * 4] = 255; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; } else { for (let k = 0; k < 3; k++) out[i * 4 + k] = a.data[i * 4 + k] >> 2; }
    out[i * 4 + 3] = 255;
  }
  return { ratio: differing / (a.width * a.height), differing, maxDelta, image: { width: a.width, height: a.height, data: out } };
}

/** Bounding box of the pixels that are not the background colour (the glyph), for the "no glyph offset" check. */
export function glyphBox(img, bg, tolerance = 24) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    if (Math.max(Math.abs(img.data[i] - bg[0]), Math.abs(img.data[i + 1] - bg[1]), Math.abs(img.data[i + 2] - bg[2])) > tolerance) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export const pixel = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };

// ---- wincap ----

export function wincapBinary() {
  const exe = join(root, 'src-tauri', 'target', 'release', 'examples', 'wincap.exe');
  if (!existsSync(exe)) throw new Error('wincap missing: cd src-tauri && node ../scripts/msvc-run.mjs cargo build -p unimux-platform --example wincap --release');
  return exe;
}

/** One wincap process answering one JSON line per command. */
export function startWincap() {
  const child = spawn(wincapBinary(), [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const waiting = [];
  lines.on('line', (l) => waiting.shift()?.(JSON.parse(l)));
  const cmd = (...parts) => new Promise((res, rej) => {
    waiting.push((v) => (v && v.error ? rej(new Error(`wincap ${parts.join(' ')}: ${v.error}`)) : res(v)));
    child.stdin.write(`${parts.join(' ')}\n`);
  });
  return { cmd, close: () => { try { child.stdin.write('quit\n'); child.stdin.end(); } catch { /* gone */ } } };
}

export const WM = { NCACTIVATE: 0x86, MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202, MOUSELEAVE: 0x2a3, NCMOUSEMOVE: 0xa0, NCLBUTTONDOWN: 0xa1, NCLBUTTONUP: 0xa2, NCMOUSELEAVE: 0x2a2, NCHITTEST: 0x84, SYSCOMMAND: 0x112 };
export const HT = { CLIENT: 1, CAPTION: 2, SYSMENU: 3, MINBUTTON: 8, MAXBUTTON: 9, CLOSE: 20, TRANSPARENT: -1 };
export const lparam = (x, y) => ((y & 0xffff) << 16 | (x & 0xffff)) >>> 0;

// ---- launchers (off-screen, scratch data, never the real profile) ----

const electronPath = () => createRequire(import.meta.url)('electron');

/** The Electron build of this tree (npm run build): the 1.1.4 window chrome. `scale` forces a device scale factor. */
export function launchElectron({ dataDir, scratch, port, scale }) {
  const { env: homeEnv } = scratchHome(scratch);
  const env = scrubAppEnv({ ...process.env, ...homeEnv, MC_DATA_DIR: dataDir, MC_OFFSCREEN: '1', ...(port ? { MC_DEBUG_PORT: String(port) } : {}) });
  const args = [...(scale ? [`--force-device-scale-factor=${scale}`] : []), root];
  return spawn(electronPath(), args, { env, stdio: 'ignore', windowsHide: true });
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

/**
 * Waits for the app's visible top-level window (`title` matches). The windows belong to the process we spawned: Electron's
 * main process (electron.exe) and unimux.exe.
 */
export async function findAppWindow(wincap, pid, { title = /unimux/, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { windows } = await wincap.cmd('windows', pid);
    const w = windows.find((x) => x.visible && title.test(x.title) && x.class !== 'Chrome_MessageWindow');
    if (w) return w;
    if (Date.now() > deadline) throw new Error(`no app window for pid ${pid}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export const writePng = (file, img) => writeFileSync(file, encodePng(img));
export const readPng = (file) => decodePng(readFileSync(file));
