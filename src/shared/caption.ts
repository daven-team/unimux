// Window caption buttons of the Tauri build on Windows (1.2.0, W1): what the page tells the native hit-test window and what
// that window reports back. Pixels are client pixels of the window (device pixels, origin at the client's top-left).

export type CaptionButtonId = 'min' | 'max' | 'close';

export interface CaptionRect { x: number; y: number; width: number; height: number }

/** The hit areas of the three buttons (Chromium's rules: a pixel belongs to a button when its floored DIP position does). */
export interface CaptionArea {
  min: CaptionRect;
  max: CaptionRect;
  close: CaptionRect;
}

/** The pointer over the buttons: the hovered one, and the one held down (shown pressed only while the pointer is over it). */
export interface CaptionPointer {
  hover: CaptionButtonId | null;
  pressed: CaptionButtonId | null;
}

const BUTTONS: readonly CaptionButtonId[] = ['min', 'max', 'close'];

/** A pointer report from the native side, checked (unknown values read as none). */
export function readCaptionPointer(value: unknown): CaptionPointer {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const pick = (x: unknown) => (BUTTONS.includes(x as CaptionButtonId) ? (x as CaptionButtonId) : null);
  return { hover: pick(v.hover), pressed: pick(v.pressed) };
}
