import { describe, expect, it } from 'vitest';
import { snapCharWidth, snappedCharWidth } from '../src/shared/cellWidth';

/** The cell widths (CSS px) xterm 6's renderers compute from a character width (no letter spacing). */
const webglCell = (char: number, dpr: number) => Math.floor(char * dpr) / dpr;
const domCell = (char: number, dpr: number) => (char * dpr) / dpr;

describe('snappedCharWidth', () => {
  it('gives both renderers WebGL cells at every common scale and font', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
      for (let char = 4; char <= 20; char += 0.01) {
        const snapped = snappedCharWidth(char, dpr);
        // WebGL floors the snapped width to the same device pixels as the raw one...
        expect(Math.floor(snapped * dpr)).toBe(Math.floor(char * dpr));
        // ...and the DOM renderer, which does not floor, lays out the same cell within a rounding error.
        expect(Math.abs(domCell(snapped, dpr) - webglCell(char, dpr))).toBeLessThan(1e-3);
      }
    }
  });

  it('the 13 px case: 7.61 px glyphs make 7 px cells in both renderers', () => {
    expect(webglCell(snappedCharWidth(7.61, 1), 1)).toBe(7);
    expect(domCell(snappedCharWidth(7.61, 1), 1)).toBeCloseTo(7, 3);
  });

  it('leaves widths it cannot snap alone', () => {
    expect(snappedCharWidth(0, 1)).toBe(0);
    expect(snappedCharWidth(0.4, 1)).toBe(0.4);
    expect(snappedCharWidth(7.6, 0)).toBe(7.6);
    expect(snappedCharWidth(Number.NaN, 1)).toBeNaN();
  });
});

describe('snapCharWidth', () => {
  const fakeTerm = (width: number, dpr: number) => {
    let refreshed = 0;
    const core = {
      _charSizeService: { width },
      _coreBrowserService: { dpr },
      _renderService: { handleCharSizeChanged: () => { refreshed++; } },
    };
    return { term: { _core: core }, core, refreshed: () => refreshed };
  };

  it('reports the snapped width now and after later measures and DPR changes, and lets the renderer measure again', () => {
    const t = fakeTerm(7.61, 1);
    expect(snapCharWidth(t.term)).toBe(true);
    expect(t.refreshed()).toBe(1);
    expect(t.core._charSizeService.width).toBeCloseTo(7, 3);
    t.core._charSizeService.width = 8.43; // a bigger font measured
    expect(t.core._charSizeService.width).toBeCloseTo(8, 3);
    t.core._coreBrowserService.dpr = 1.5; // moved to a 150 percent display: floor(8.43 * 1.5) = 12 device px
    expect(t.core._charSizeService.width).toBeCloseTo(8, 3);
    t.core._coreBrowserService.dpr = 1.25; // floor(8.43 * 1.25) = 10 device px
    expect(t.core._charSizeService.width).toBeCloseTo(8, 3);
    t.core._charSizeService.width = 7.61; // floor(7.61 * 1.25) = 9 device px
    expect(t.core._charSizeService.width).toBeCloseTo(7.2, 3);
  });

  it('does nothing to an xterm without the internals', () => {
    expect(snapCharWidth({})).toBe(false);
    expect(snapCharWidth(null)).toBe(false);
    expect(snapCharWidth({ _core: { _charSizeService: { width: 7 } } })).toBe(false);
  });
});
