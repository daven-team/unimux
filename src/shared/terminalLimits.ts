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

/** Characters of recent output the pty host keeps per terminal to replay into a reloaded renderer. */
export const PTY_REPLAY_CHARS = 512 * 1024;

/** Characters of output the renderer queues for a terminal that has no xterm instance yet (the newest ones are kept). */
export const PENDING_OUTPUT_CHARS = 512 * 1024;

/**
 * Active WebGL contexts Chromium allows the renderer process (switch `max-active-webgl-contexts`, set by main). Without the
 * switch Electron 44 (Chromium 152) keeps 16 and silently loses the oldest context beyond that (measured on Windows, 48 contexts).
 */
export const CHROMIUM_WEBGL_CONTEXTS = 32;

/**
 * WebGL renderers alive at the same time: every cell of the largest grid (20) plus a few parked terminals, well below
 * CHROMIUM_WEBGL_CONTEXTS. Terminals without a context use xterm's DOM renderer; when the pool is short (the limit learned
 * from a lost context, see TerminalManager) the focused and busy cells get the contexts first (webglPool.ts). Parked (not
 * displayed) terminals may keep theirs so that switching back to a grid is instant; the least recently shown one is released first.
 */
export const MAX_WEBGL_CONTEXTS = 24;
