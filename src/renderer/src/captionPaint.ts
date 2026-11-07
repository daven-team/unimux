// The Windows caption buttons of 1.1.4, drawn by the page (1.2.0, Tauri, W1). 1.1.4 used Electron 45's native titleBarOverlay
// {color #0d0d0d, symbolColor #8a8a8a, height 36}; this is a port of how Electron paints it, in device pixels, so the result is
// the same pixel for pixel (test/fixtures/caption has the 1.1.4 captures, scripts/verify-caption.mjs compares):
// - layout (electron shell/browser/ui/views/win_frame_view.cc, win_caption_button_container.cc): the button container is
//   137 DIP wide (minimize 45, maximize/restore 1 + 45, close 1 + 45; the 1 DIP is the gap left of a button), at the right edge
//   of the window's DIP width (the pixel width divided by the scale, rounded up), 1 DIP below the top and 35 DIP high (restored)
//   or at the top and 36 DIP high (maximized); it paints into its own layer, whose origin is rounded to a whole pixel;
// - painting (win_caption_button.cc, win_icon_painter.cc): background fills and the minimize line, the Windows 10 squares and
//   the close cross without anti-aliasing (a pixel is drawn when its centre is inside), the Windows 11 rounded squares with it
//   (the canvas is Skia as well); symbol size round(10 x scale), stroke round(scale).
// Pure: it draws on any CanvasRenderingContext2D-like target (the vitest cases use a recording one).

export type CaptionButton = 'min' | 'max' | 'close';

export interface CaptionState {
  /** How far each button's hover fade is (0..1; 1.1.4 fades in and out in 150 ms, so two can be on their way at once). */
  hover: Partial<Record<CaptionButton, number>>;
  pressed: CaptionButton | null;
  maximized: boolean;
}

export interface CaptionGeometry {
  scale: number;
  /** The client area width in device pixels. */
  clientWidth: number;
  maximized: boolean;
}

export interface ButtonBox {
  button: CaptionButton;
  /** Button origin in DIP inside the container, its width (with the gap) and the gap. */
  dipX: number;
  dipWidth: number;
  spacing: number;
}

export interface CaptionLayout {
  scale: number;
  /** The container layer in client pixels: x, y (rounded origin), right (clipped to the client), bottom. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  heightDip: number;
  topDip: number;
  containerDipX: number;
  buttons: ButtonBox[];
}

export const CAPTION_HEIGHT_DIP = 36;
export const CONTAINER_WIDTH_DIP = 137;
export const SYMBOL_COLOR = '#8a8a8a';
export const BG_COLOR = '#0d0d0d';
export const CLOSE_RED: [number, number, number] = [0xe8, 0x11, 0x23];
/** Non-close buttons: white at 0x1A / 0x33, times 1.3 because the overlay colour is opaque (win_caption_button.cc). */
export const HOVER_ALPHA = Math.round(0x1a * 1.3);
export const PRESSED_ALPHA = Math.round(0x33 * 1.3);
export const CLOSE_PRESSED_ALPHA = 0x98;
export const HOVER_FADE_MS = 150;

const BUTTONS: ButtonBox[] = [
  { button: 'min', dipX: 0, dipWidth: 45, spacing: 0 },
  { button: 'max', dipX: 45, dipWidth: 46, spacing: 1 },
  { button: 'close', dipX: 91, dipWidth: 46, spacing: 1 },
];

/** std::round (halves away from zero) for the positive values used here. */
const roundHalfUp = (v: number) => Math.floor(v + 0.5);
/** A non-anti-aliased edge: the first pixel whose centre is at or past `v` (matches the 1.1.4 fills at every scale). */
const edge = (v: number) => Math.ceil(v - 0.5 - 1e-9);
/** The close cross's clip edge, rounded halves up like Skia's SkScalarRoundToInt (differs from `edge` only at .5, i.e. 150 percent). */
const clipEdge = (v: number) => Math.floor(v + 0.5 + 1e-9);

export function captionLayout({ scale, clientWidth, maximized }: CaptionGeometry): CaptionLayout {
  const widthDip = Math.ceil(clientWidth / scale - 1e-9);
  const topDip = maximized ? 0 : 1;
  const heightDip = CAPTION_HEIGHT_DIP - topDip;
  const containerDipX = widthDip - CONTAINER_WIDTH_DIP;
  const left = roundHalfUp(containerDipX * scale);
  const top = roundHalfUp(topDip * scale);
  return {
    scale,
    left,
    top,
    right: Math.min(clientWidth, roundHalfUp(widthDip * scale)),
    bottom: roundHalfUp(CAPTION_HEIGHT_DIP * scale),
    heightDip,
    topDip,
    containerDipX,
    buttons: BUTTONS,
  };
}

/**
 * The hit-test areas in client pixels, like Chromium's (a pixel is in a button when its floored DIP position is): one rect per
 * button, rows from the container top down to 36 DIP.
 */
export function captionHitRects(layout: CaptionLayout): Record<CaptionButton, { x: number; y: number; width: number; height: number }> {
  const s = layout.scale;
  const px = (dip: number) => Math.ceil(dip * s - 1e-9) + 0; // + 0: no -0
  const y = px(layout.topDip);
  const bottom = px(CAPTION_HEIGHT_DIP);
  const out = {} as Record<CaptionButton, { x: number; y: number; width: number; height: number }>;
  for (const b of layout.buttons) {
    const x0 = px(layout.containerDipX + b.dipX);
    const x1 = Math.min(px(layout.containerDipX + b.dipX + b.dipWidth), layout.right);
    out[b.button] = { x: x0, y, width: Math.max(0, x1 - x0), height: Math.max(0, bottom - y) };
  }
  return out;
}

/** The subset of CanvasRenderingContext2D the painter uses. */
export interface Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii: number | number[]): void;
  stroke(): void;
  clip(rule?: CanvasFillRule): void;
}

const rgba = (r: number, g: number, b: number, a: number) => `rgba(${r}, ${g}, ${b}, ${a / 255})`;
const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/**
 * Paints the container into `ctx`, whose pixel (0, 0) is client pixel (`originX`, `originY`). Pixels outside the container are
 * cleared (the page shows through, as around the native overlay).
 */
export function paintCaption(ctx: Paint2D, layout: CaptionLayout, state: CaptionState, opts: { originX: number; originY: number; width: number; height: number; windows11: boolean }): void {
  const s = layout.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, opts.width, opts.height);
  const ox = layout.left - opts.originX;
  const oy = layout.top - opts.originY;
  const layerW = layout.right - layout.left;
  const layerH = layout.bottom - layout.top;
  // The container's own background (the overlay colour), over its whole layer.
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(ox, oy, layerW, layerH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, layerW, layerH);
  ctx.clip();
  /** Non-anti-aliased fill of a rect given in layer pixels (fractional), with the pixel-centre rule. */
  const fillPx = (l: number, t: number, r: number, b: number) => {
    const x0 = edge(l);
    const x1 = edge(r);
    const y0 = edge(t);
    const y1 = edge(b);
    if (x1 > x0 && y1 > y0) ctx.fillRect(ox + x0, oy + y0, x1 - x0, y1 - y0);
  };
  for (const b of layout.buttons) {
    const tx = b.dipX * s;
    const isClose = b.button === 'close';
    // Background: the semi-transparent hover / pressed fill (the gap pixel stays the overlay colour).
    const pressed = state.pressed === b.button;
    const hoverT = Math.max(0, Math.min(1, state.hover[b.button] ?? 0));
    let alpha = 0;
    if (pressed) alpha = isClose ? CLOSE_PRESSED_ALPHA : PRESSED_ALPHA;
    else alpha = Math.round((isClose ? 255 : HOVER_ALPHA) * hoverT);
    if (alpha > 0) {
      ctx.fillStyle = isClose ? rgba(...CLOSE_RED, alpha) : rgba(255, 255, 255, alpha);
      fillPx(tx + b.spacing * s, 0, tx + b.dipWidth * s, layout.heightDip * s);
    }
    // Symbol colour: the close cross turns white while hovered or pressed (and fades with the hover).
    let symbol = SYMBOL_COLOR;
    if (isClose && (pressed || hoverT >= 1)) symbol = '#ffffff';
    else if (isClose && hoverT > 0) symbol = `rgb(${mix(0x8a, 255, hoverT)}, ${mix(0x8a, 255, hoverT)}, ${mix(0x8a, 255, hoverT)})`;
    // symbol_rect: the button's contents bounds (with the gap) in pixels, enclosed, then a centred square.
    const boundsW = Math.ceil(b.dipWidth * s - 1e-9);
    const boundsH = Math.ceil(layout.heightDip * s - 1e-9);
    const size = Math.round(10 * s);
    const sx = Math.floor((boundsW - size) / 2);
    const sy = Math.floor((boundsH - size) / 2);
    const stroke = Math.round(s);
    ctx.fillStyle = symbol;
    ctx.strokeStyle = symbol;
    if (b.button === 'min') {
      const y = sy + Math.floor(size / 2);
      fillPx(tx + sx, y - stroke / 2, tx + sx + size, y + stroke / 2);
    } else if (b.button === 'max' && !state.maximized) {
      if (opts.windows11) {
        const r = Math.floor(1.5 * s);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, ox + tx, oy);
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.roundRect(sx + stroke / 2, sy + stroke / 2, size - stroke, size - stroke, r);
        ctx.stroke();
        ctx.restore();
      } else strokeRectNoAA(fillPx, tx + sx, sy, size, size, stroke);
    } else if (b.button === 'max') {
      if (opts.windows11) paintRestore11(ctx, ox + tx, oy, sx, sy, size, stroke, s);
      else {
        const sep = Math.floor(2 * s);
        // Front square, then the back one without the pixels inside the front one.
        const fx = sx;
        const fy = sy + sep;
        const fs = size - sep;
        strokeRectNoAA(fillPx, tx + fx, fy, fs, fs, stroke);
        strokeRectNoAA((l, t, r, bb) => {
          // Clip difference with the front square's rect (whole pixels: the rects are integral).
          const parts: [number, number, number, number][] = [];
          const cl = tx + fx;
          const ct = fy;
          const cr = tx + fx + fs;
          const cb = fy + fs;
          if (t < ct) parts.push([l, t, r, Math.min(bb, ct)]);
          if (bb > cb) parts.push([l, Math.max(t, cb), r, bb]);
          const mt = Math.max(t, ct);
          const mb = Math.min(bb, cb);
          if (mb > mt) {
            if (l < cl) parts.push([l, mt, Math.min(r, cl), mb]);
            if (r > cr) parts.push([Math.max(l, cr), mt, r, mb]);
          }
          for (const p of parts) fillPx(...p);
        }, tx + fx + sep, fy - sep, fs, fs, stroke);
      }
    } else {
      const halo = stroke * (symbol === '#ffffff' ? 0.1 : 0.05);
      paintCrossNoAA(ctx, ox, oy, tx + sx, sy, size, stroke + halo);
    }
  }
  ctx.restore();
}

/** Electron's DrawRect without anti-aliasing: the stroke kept inside `size` (four bands, pixel-centre rule). */
function strokeRectNoAA(fill: (l: number, t: number, r: number, b: number) => void, x: number, y: number, w: number, h: number, stroke: number): void {
  const half = stroke / 2;
  // The path is the rect inset by half the stroke; the stroke covers half to each side of it.
  const l = x + half;
  const t = y + half;
  const r = x + w - half;
  const b = y + h - half;
  fill(l - half, t - half, r + half, t + half); // top
  fill(l - half, b - half, r + half, b + half); // bottom
  fill(l - half, t + half, l + half, b - half); // left
  fill(r - half, t + half, r + half, b - half); // right
}

/** The close cross: two diagonals with butt caps, clipped to the symbol square, no anti-aliasing (as Electron 45 draws it). */
function paintCrossNoAA(ctx: Paint2D, ox: number, oy: number, x: number, y: number, size: number, width: number): void {
  const half = width / 2;
  const x0 = Math.floor(x);
  const segs: [number, number, number, number][] = [[x, y, x + size, y + size], [x + size, y, x, y + size]];
  for (let py = y; py < y + size; py++) {
    let run = -1;
    for (let px = x0; px <= Math.ceil(x + size); px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      let on = px >= clipEdge(x) && px < clipEdge(x + size); // the non-anti-aliased clip to the symbol rect
      if (on) {
        on = false;
        for (const [ax, ay, bx, by] of segs) {
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          const t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
          if (t < 0 || t > 1) continue;
          const dist = Math.abs((cx - ax) * dy - (cy - ay) * dx) / Math.sqrt(len2);
          if (dist <= half) { on = true; break; }
        }
      }
      if (on && run < 0) run = px;
      if (!on && run >= 0) { ctx.fillRect(ox + run, oy + py, px - run, 1); run = -1; }
    }
    if (run >= 0) ctx.fillRect(ox + run, oy + py, Math.ceil(x + size) + 1 - run, 1);
  }
}

/** Win11IconPainter::PaintRestoreIcon: two anti-aliased rounded squares, the back one clipped by the front one's outline. */
function paintRestore11(ctx: Paint2D, tx: number, ty: number, sx: number, sy: number, size: number, stroke: number, s: number): void {
  const sep = 2 * s;
  const r = Math.floor(1.5 * s);
  const half = stroke / 2;
  // rect_f: the symbol rect inset by half the stroke, then TLBR(sep, 0, 0, sep).
  const fx = sx + half;
  const fy = sy + half + sep;
  const fw = size - stroke - sep;
  const fh = size - stroke - sep;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, tx, ty);
  ctx.lineWidth = stroke;
  ctx.beginPath();
  ctx.roundRect(fx, fy, fw, fh, r);
  ctx.stroke();
  // Clip: everything except the front rrect outset by (sep - half) (radii grow with it).
  const g = sep - half;
  ctx.beginPath();
  ctx.rect(fx - 4 * size, fy - 4 * size, 9 * size, 9 * size);
  ctx.roundRect(fx - g, fy - g, fw + 2 * g, fh + 2 * g, r + g);
  ctx.clip('evenodd');
  ctx.beginPath();
  ctx.roundRect(fx + sep, fy - sep, fw, fh, [r, 2 * r, r, r]);
  ctx.stroke();
  ctx.restore();
}

/** gfx::Tween::EASE_OUT, the tween of views' hover animation. */
export const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/**
 * One button's hover fade, like views::SlideAnimation: from the value it has now to the target, in 150 ms times the distance,
 * eased out.
 */
export interface Fade { from: number; to: number; start: number; duration: number }

export const fadeValue = (f: Fade, now: number): number => {
  if (f.duration <= 0) return f.to;
  const t = Math.max(0, Math.min(1, (now - f.start) / f.duration));
  return f.from + (f.to - f.from) * easeOut(t);
};

export const fadeTo = (f: Fade | undefined, to: number, now: number): Fade => {
  const from = f ? fadeValue(f, now) : 0;
  return { from, to, start: now, duration: HOVER_FADE_MS * Math.abs(to - from) };
};
