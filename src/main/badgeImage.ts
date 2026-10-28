// 1.0.9: the overlay icon of the Windows taskbar button (a red disc with the number of agents waiting for you). Drawn here
// in a few microseconds per size, no canvas and no image files: a disc and stroke-font digits rasterised with analytic
// anti-aliasing at the exact pixel size of each display scale (16 px at 100 %, 20 at 125 %, 24 at 150 %, 32 at 200 %), so
// the badge stays crisp instead of being scaled from one bitmap. Encoded as PNG (zlib only) for nativeImage.
import { deflateSync } from 'zlib';

/** Display scales that get their own bitmap (the taskbar picks the one of the window's monitor). */
export const BADGE_SCALES = [1, 1.25, 1.5, 2] as const;
/** The overlay icon's size at 100 %. */
export const BADGE_SIZE = 16;

type Point = readonly [number, number];
/** Stroke font on a 4 x 6 box (x right, y down): each glyph is a list of polylines. */
const GLYPHS: Record<string, readonly (readonly Point[])[]> = {
  '0': [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  '1': [[[0.8, 1.2], [2.2, 0], [2.2, 6]]],
  '2': [[[0, 1.2], [1, 0], [3, 0], [4, 1], [4, 2.2], [0, 6], [4, 6]]],
  '3': [[[0, 0], [4, 0], [1.8, 2.6], [3, 2.6], [4, 3.6], [4, 5], [3, 6], [1, 6], [0, 5]]],
  '4': [[[3, 6], [3, 0], [0, 4.2], [4.2, 4.2]]],
  '5': [[[4, 0], [0.3, 0], [0, 2.7], [3, 2.7], [4, 3.7], [4, 5], [3, 6], [0, 6]]],
  '6': [[[3.4, 0], [1.4, 0], [0, 1.6], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.6], [3, 2.6], [0, 2.6]]],
  '7': [[[0, 0], [4, 0], [1.4, 6]]],
  '8': [[[1, 0], [3, 0], [4, 0.9], [4, 1.9], [3, 2.9], [1, 2.9], [0, 1.9], [0, 0.9], [1, 0]], [[1, 2.9], [0, 3.9], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.9], [3, 2.9]]],
  '9': [[[4, 3.4], [1, 3.4], [0, 2.4], [0, 1], [1, 0], [3, 0], [4, 1], [4, 4.4], [2.6, 6], [0.6, 6]]],
  '+': [[[2, 1.4], [2, 4.6]], [[0.4, 3], [3.6, 3]]],
};
const GLYPH_W = 4;
const GLYPH_H = 6;

/** The disc's colour (a strong red that reads on light and dark taskbars) and its thin light rim. */
const FILL: readonly [number, number, number] = [0xd9, 0x30, 0x25];
const RIM: readonly [number, number, number] = [0xff, 0xff, 0xff];
const TEXT: readonly [number, number, number] = [0xff, 0xff, 0xff];

function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len)) : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}

/** Coverage 0..1 of a pixel by a shape whose signed distance at the pixel centre is `d` (negative = inside), in pixels. */
const cover = (d: number): number => Math.max(0, Math.min(1, 0.5 - d));

/**
 * The badge as straight (not premultiplied) RGBA, `px` x `px` pixels. Pure, for the tests. Unknown characters draw nothing
 * (the label comes from badgeLabel: 1..9 or 9+).
 */
export function renderBadge(label: string, px: number): Uint8Array {
  const size = Math.max(8, Math.round(px));
  const out = new Uint8Array(size * size * 4);
  const r = size / 2;
  const rim = Math.max(1, size / 16);
  const chars = [...label].filter((c) => GLYPHS[c]);
  // Two characters ("9+") get narrower, slightly smaller glyphs; one gets a glyph about 9/16 of the badge high.
  const two = chars.length > 1;
  const glyphH = size * (two ? 0.5 : 0.56);
  const scale = glyphH / GLYPH_H;
  const gap = size * 0.08;
  const glyphW = GLYPH_W * scale * (two ? 0.8 : 1);
  const totalW = chars.length * glyphW + Math.max(0, chars.length - 1) * gap;
  const stroke = Math.max(1.15, size * (two ? 0.1 : 0.12));
  const left = (size - totalW) / 2;
  const top = (size - glyphH) / 2;
  const segments: Array<[Point, Point]> = [];
  chars.forEach((c, i) => {
    const x0 = left + i * (glyphW + gap);
    const sx = glyphW / GLYPH_W;
    for (const line of GLYPHS[c]) {
      for (let k = 1; k < line.length; k++) {
        const a: Point = [x0 + line[k - 1][0] * sx, top + line[k - 1][1] * scale];
        const b: Point = [x0 + line[k][0] * sx, top + line[k][1] * scale];
        segments.push([a, b]);
      }
    }
  });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const disc = Math.hypot(cx - r, cy - r) - r;
      const outer = cover(disc);
      if (outer <= 0) continue;
      const inner = cover(disc + rim);
      let ink = 0;
      for (const [a, b] of segments) {
        ink = Math.max(ink, cover(segmentDistance(cx, cy, a, b) - stroke / 2));
        if (ink >= 1) break;
      }
      // Rim (outside the inner disc), then the red disc, then the white digits on top.
      const channel = (i: number) => {
        const base = RIM[i] * (1 - inner) + FILL[i] * inner;
        return Math.round(base * (1 - ink) + TEXT[i] * ink);
      };
      const o = (y * size + x) * 4;
      out[o] = channel(0);
      out[o + 1] = channel(1);
      out[o + 2] = channel(2);
      out[o + 3] = Math.round(outer * 255);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** A PNG (8-bit RGBA, no interlace) of straight RGBA pixels. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)),
  ]);
}

/** The PNG of the badge for every display scale (see BADGE_SCALES). */
export function badgePngs(label: string): Array<{ scaleFactor: number; size: number; png: Buffer }> {
  return BADGE_SCALES.map((scaleFactor) => {
    const size = Math.round(BADGE_SIZE * scaleFactor);
    return { scaleFactor, size, png: encodePng(renderBadge(label, size), size, size) };
  });
}
