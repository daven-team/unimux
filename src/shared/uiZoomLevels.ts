// The levels of the window zoom (View menu of the title bar, renderer/uiZoom.ts), like a browser's.
export const UI_ZOOM_LEVELS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** A stored level, or 1 when it is missing or not one of the levels. */
export function readZoomLevel(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : NaN;
  return (UI_ZOOM_LEVELS as readonly number[]).includes(n) ? n : 1;
}

/** The next level up (1) or down (-1) from `current`; the same level at either end. */
export function stepZoomLevel(current: number, dir: 1 | -1): number {
  const levels = UI_ZOOM_LEVELS as readonly number[];
  if (dir > 0) return levels.find((l) => l > current + 1e-6) ?? levels[levels.length - 1];
  return [...levels].reverse().find((l) => l < current - 1e-6) ?? levels[0];
}
