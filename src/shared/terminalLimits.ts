// Memory bounds of the terminal output path. Everything that buffers terminal output is capped by one of these constants;
// change them here, nowhere else. Rough cost per live terminal (120 columns): scrollback lines x 120 x 12 bytes in the
// renderer (xterm keeps 3 x 32 bits per cell, lines are allocated only once they exist), plus the two caps below as
// strings (one byte per character for plain output).

/**
 * Lines of history kept by each terminal in the renderer (xterm `scrollback`), chosen in Settings > Terminal. A full buffer
 * of 10,000 lines is about 14 MB at 120 columns.
 */
export const SCROLLBACK_CHOICES = [1000, 2500, 5000, 10_000, 25_000] as const;
export const DEFAULT_SCROLLBACK_LINES = 5000;

/** A saved scrollback setting, or the default when it is missing or not one of the choices. */
export function normalizeScrollback(value: unknown): number {
  return (SCROLLBACK_CHOICES as readonly number[]).includes(value as number) ? (value as number) : DEFAULT_SCROLLBACK_LINES;
}

/** Gives open terminals (xterm instances) a new scrollback (xterm drops the oldest lines when it shrinks); returns the value used. */
export function applyScrollback(terminals: Iterable<{ options: { scrollback?: number } }>, lines: unknown): number {
  const next = normalizeScrollback(lines);
  for (const term of terminals) if (term.options.scrollback !== next) term.options.scrollback = next;
  return next;
}

/** Characters of recent output the pty host keeps per terminal to replay into a reloaded renderer. */
export const PTY_REPLAY_CHARS = 512 * 1024;

/** Characters of output the renderer queues for a terminal that has no xterm instance yet (the newest ones are kept). */
export const PENDING_OUTPUT_CHARS = 512 * 1024;

/**
 * Active WebGL contexts Chromium allows the renderer process (switch `max-active-webgl-contexts`, set by main). Without the
 * switch Chromium keeps 16 and silently loses the oldest context beyond that. The switch is a hard cap that Electron 45
 * honors at any value: measured on Windows (RTX 3070) with 32 and with 96, the context created beyond it makes Chromium lose
 * the oldest one at once, and nothing is lost below it. Above MAX_WEBGL_CONTEXTS for headroom: a context given back stays
 * counted until it is collected.
 */
export const CHROMIUM_WEBGL_CONTEXTS = 96;

/**
 * WebGL renderers alive at the same time: every cell of three full grids (3 x 20), so that switching between the grids of a
 * project (or between two projects) finds the contexts of the parked cells instead of creating them again. A new context
 * compiles its shaders (about 10 ms) and its cell draws through the DOM renderer until then: with 24, every switch between a
 * 16-cell and a 12-cell grid recreated 12 to 16 of them (62 frames over 17 ms, up to 46 ms each, per round of the bench);
 * with enough of them the same switches show no frame over 17 ms (scripts/bench-jank.mjs, tabs and projects).
 * Cost, measured with real terminals (Windows, RTX 3070, cells of about 370 x 450 px, linear from 8 to 80 contexts): about
 * 3.9 MB of private memory of the GPU process and 2.9 MB of dedicated video memory per context, nothing in the renderer
 * process; so 64 contexts are about 250 MB and 185 MB. The size of the cell hardly matters (cells half as tall cost the same).
 * Only terminals that were shown hold one: a session with fewer cells pays for its cells only.
 * Terminals without a context use xterm's DOM renderer; when the pool is short (more cells, or the limit learned from a lost
 * context, see TerminalManager) the focused and busy cells get the contexts first (webglPool.ts). Parked (not displayed)
 * terminals keep theirs while slots are free; the least recently shown one is released first.
 */
export const MAX_WEBGL_CONTEXTS = 64;

/** The browser engine of the window: Chromium (Electron 1.1.4, WebView2) or WebKit (WKWebView, the Tauri app on macOS). */
export type WebviewEngine = 'chromium' | 'webkit';

/**
 * Active WebGL contexts WebKit allows a page (WebGLRenderingContextBase `maxActiveContexts`). There is no switch to raise it;
 * the context created beyond it makes WebKit lose the oldest one, like Chromium beyond its switch.
 */
export const WEBKIT_WEBGL_CONTEXTS = 16;

/**
 * WebGL renderers alive at the same time under WebKit: below WEBKIT_WEBGL_CONTEXTS for the same headroom as on Chromium (a
 * context given back stays counted until it is collected). A 5x4 grid then draws 12 cells through WebGL (focused and busy
 * ones first) and the others through xterm's DOM renderer; WebglLimit lowers it further if WebKit evicts earlier. Prewarm
 * (parked cells get a context in idle time) keeps half of this pool free instead of a full grid, which would not fit
 * (webglPool.ts webglPrewarmReserve): up to 6 contexts are prewarmed, so switching to a grid of more than 6 cells draws
 * the rest through the DOM renderer at first, while contexts are created a few per frame.
 */
export const MAX_WEBGL_CONTEXTS_WEBKIT = 12;

/** The WebGL pool size of an engine (TerminalManager's WebglLimit starts here). */
export const maxWebglContexts = (engine: WebviewEngine): number => (engine === 'webkit' ? MAX_WEBGL_CONTEXTS_WEBKIT : MAX_WEBGL_CONTEXTS);
