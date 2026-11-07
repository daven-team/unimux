import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCaptionPointer } from '../src/shared/caption';
// The painter lives with the renderer (DOM types); loaded by path like the other renderer modules the tests use.
const paintPath = '../src/renderer/src/captionPaint';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { captionHitRects, captionLayout, easeOut, fadeTo, fadeValue, HOVER_FADE_MS, paintCaption } = (await import(paintPath)) as Record<string, any>;
type CaptionButton = 'min' | 'max' | 'close';

// The 1.1.4 references (scripts/capture-caption-reference.mjs): WM_NCHITTEST along rows of the caption, from the right edge.
const manifest = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'caption', 'manifest.json'), 'utf8')) as {
  scales: Record<string, { hitMap: Record<string, number[]>; client: [number, number] }>;
};
const HT: Record<CaptionButton, number> = { min: 8, max: 9, close: 20 };

describe('caption layout (W1)', () => {
  for (const [percent, { hitMap, client }] of Object.entries(manifest.scales)) {
    it(`hit areas match the 1.1.4 map at ${percent} percent`, () => {
      const scale = Number(percent) / 100;
      const clientWidth = client[0]; // the reference window's client width
      const rects = captionHitRects(captionLayout({ scale, clientWidth, maximized: false }));
      let checked = 0;
      for (const [row, codes] of Object.entries(hitMap)) {
        const y = Number(row);
        codes.forEach((code, i) => {
          const x = clientWidth - (i + 1);
          const inside = (Object.keys(rects) as CaptionButton[]).find((b) => {
            const r = rects[b];
            return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
          });
          const native = (Object.keys(HT) as CaptionButton[]).find((b) => HT[b] === code);
          expect(inside ?? null, `${percent}% x=${x} y=${y} code=${code}`).toBe(native ?? null);
          checked++;
        });
      }
      expect(checked).toBeGreaterThan(400);
    });
  }

  it('lays the container out like Electron: 137 DIP at the right edge, 1 DIP down unless maximized', () => {
    const l = captionLayout({ scale: 1, clientWidth: 1100, maximized: false });
    expect([l.left, l.top, l.right, l.bottom, l.heightDip]).toEqual([963, 1, 1100, 36, 35]);
    const m = captionLayout({ scale: 1, clientWidth: 1100, maximized: true });
    expect([m.left, m.top, m.bottom, m.heightDip]).toEqual([963, 0, 36, 36]);
    const r = captionHitRects(m);
    expect(r.close).toEqual({ x: 1054, y: 0, width: 46, height: 36 });
    const s = captionLayout({ scale: 1.5, clientWidth: 1649, maximized: false });
    expect([s.left, s.top, s.right, s.bottom]).toEqual([1445, 2, 1649, 54]);
  });
});

describe('caption painting (W1)', () => {
  /** Records the fills (enough to check colours and that nothing is drawn outside the container). */
  const recorder = () => {
    const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
    const ctx = {
      fills,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      save() {},
      restore() {},
      setTransform() {},
      clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) { fills.push({ style: String(ctx.fillStyle), x, y, w, h }); },
      beginPath() {},
      rect() {},
      roundRect() {},
      stroke() {},
      clip() {},
    };
    return ctx;
  };
  const paint = (state: { hover?: Partial<Record<CaptionButton, number>>; pressed?: CaptionButton; maximized?: boolean }) => {
    const layout = captionLayout({ scale: 1, clientWidth: 1100, maximized: !!state.maximized });
    const ctx = recorder();
    paintCaption(ctx, layout, { hover: {}, pressed: null, maximized: false, ...state }, { originX: 0, originY: 0, width: 1100, height: 40, windows11: true });
    return ctx.fills;
  };

  it('fills the container with the overlay colour and the glyphs with the symbol colour', () => {
    const fills = paint({});
    expect(fills[0]).toEqual({ style: '#0d0d0d', x: 963, y: 1, w: 137, h: 35 });
    expect(fills.some((f) => f.style === '#8a8a8a')).toBe(true);
    for (const f of fills) expect(f.x).toBeGreaterThanOrEqual(963);
  });

  it('paints the close hover red with a white cross, the other buttons a light fill', () => {
    const close = paint({ hover: { close: 1 } });
    expect(close.some((f) => f.style === 'rgba(232, 17, 35, 1)' && f.x === 1055 && f.w === 45)).toBe(true);
    expect(close.some((f) => f.style === '#ffffff')).toBe(true);
    const max = paint({ hover: { max: 1 } });
    expect(max.some((f) => f.style.startsWith('rgba(255, 255, 255,') && f.x === 1009 && f.w === 45)).toBe(true);
    const pressed = paint({ pressed: 'min' });
    expect(pressed.some((f) => f.style === `rgba(255, 255, 255, ${Math.round(0x33 * 1.3) / 255})` && f.x === 963 && f.w === 45)).toBe(true);
  });
});

describe('caption hover fade (W1)', () => {
  it('fades in and out in 150 ms, eased out, from wherever it is', () => {
    const f = fadeTo(undefined, 1, 0);
    expect(f.duration).toBe(HOVER_FADE_MS);
    expect(fadeValue(f, 0)).toBe(0);
    expect(fadeValue(f, 75)).toBeCloseTo(easeOut(0.5));
    expect(fadeValue(f, 150)).toBe(1);
    const back = fadeTo(f, 0, 75);
    expect(back.from).toBeCloseTo(0.75);
    expect(back.duration).toBeCloseTo(HOVER_FADE_MS * 0.75);
    expect(fadeValue(back, 75 + back.duration)).toBe(0);
  });

  it('reads the pointer reports of the native side defensively', () => {
    expect(readCaptionPointer({ hover: 'max', pressed: null })).toEqual({ hover: 'max', pressed: null });
    expect(readCaptionPointer({ hover: 'evil', pressed: 'close' })).toEqual({ hover: null, pressed: 'close' });
    expect(readCaptionPointer(null)).toEqual({ hover: null, pressed: null });
  });
});
