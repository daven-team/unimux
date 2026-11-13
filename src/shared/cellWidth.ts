// One terminal cell width for both xterm renderers. The WebGL renderer draws a cell `floor(charWidth * dpr)` device pixels wide
// (7.61 px glyphs in 7 px cells at 100 percent), the DOM renderer `charWidth * dpr` (7.61 px). A shown terminal changes
// renderer whenever its WebGL context comes or goes (granted a frame after it is shown, lost by the GPU, moved to a busier
// cell by the pool when more cells are shown than contexts exist), and every fit after such a change gave it another column
// count (76 <-> 70 at 13 px): a pty resize, and the agent in it redrew its screen at the other width each time, leaving
// copies of its messages at both widths in the scrollback. The character width xterm's renderers read is therefore snapped
// to WebGL's grid (see snapCharWidth), so both renderers lay out the same columns: a renderer change never resizes the pty.
// Uses xterm internals (`_core._charSizeService`, `_core._coreBrowserService`, `_core._renderService`); a version without them
// is left as it is. No xterm imports, so it is tested in Node.

/**
 * The character width (CSS pixels) both renderers turn into WebGL's cell: `floor(width * dpr) / dpr`, with a tiny excess so
 * WebGL's own `floor(width * dpr)` of the result never lands one device pixel lower through rounding.
 */
export function snappedCharWidth(width: number, dpr: number): number {
  if (!(width > 0) || !(dpr > 0) || !Number.isFinite(width) || !Number.isFinite(dpr)) return width;
  const device = Math.floor(width * dpr);
  if (device < 1) return width;
  return (device + 1e-4) / dpr;
}

interface CoreLike {
  _charSizeService?: { width: unknown };
  _coreBrowserService?: { dpr: unknown };
  _renderService?: { handleCharSizeChanged?: () => void };
}

/**
 * Makes the opened terminal `term` report the snapped character width to its renderers (now and after every later measure:
 * a font change, a DPR change). Returns false when this xterm has no such internals.
 */
export function snapCharWidth(term: unknown): boolean {
  const core = (term as { _core?: CoreLike } | null)?._core;
  const chars = core?._charSizeService;
  const browser = core?._coreBrowserService;
  if (!chars || !browser || typeof chars.width !== 'number') return false;
  let raw = chars.width;
  const dpr = () => (typeof browser.dpr === 'number' ? browser.dpr : 1);
  Object.defineProperty(chars, 'width', {
    configurable: true,
    enumerable: true,
    get: () => snappedCharWidth(raw, dpr()),
    set: (value: number) => { raw = value; },
  });
  // The renderer measured its cells at open: once more with the snapped width.
  core?._renderService?.handleCharSizeChanged?.();
  return true;
}
