// The Windows caption buttons of the Tauri build (1.2.0, W1). The window has no system title bar; 1.1.4's buttons were
// Electron's native overlay, drawn here by captionPaint.ts pixel for pixel on a canvas strip along the top of the window,
// above everything the page shows (like the overlay). The pointer never reaches this canvas: a transparent native child
// window (src-tauri/crates/unimux-app/src/caption.rs) sits over the buttons, answers Windows' hit tests like a real caption
// button (the Windows 11 snap layouts open from maximize), runs the clicks and reports the hovered and held button back
// ('window:caption'). The page tells it where the buttons are (setCaptionArea) whenever the layout changes.
// Only in the Tauri build on Windows; the Electron build keeps its overlay, macOS has traffic lights (W2).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { readCaptionPointer, type CaptionPointer } from '../../../shared/caption';
import { uiZoom } from '../uiZoom';
import { captionHitRects, captionLayout, fadeTo, fadeValue, paintCaption, type CaptionButton, type CaptionLayout, type Fade } from '../captionPaint';

const BUTTONS: readonly CaptionButton[] = ['min', 'max', 'close'];
/** The strip the canvas covers, in CSS pixels (the buttons are 36 DIP high). */
const STRIP_HEIGHT = 40;

/** True in the Tauri build on Windows: the page draws the caption buttons. */
export function pageDrawsCaption(): boolean {
  const w = window as unknown as { __MC_TAURI__?: unknown; mc?: { platform?: string } };
  return !!w.__MC_TAURI__ && w.mc?.platform === 'win32';
}

export function CaptionButtons() {
  return pageDrawsCaption() ? <CaptionLayer /> : null;
}

/** The client width in device pixels (what the layout is computed from), the canvas size in device pixels, the scale. */
interface Size { clientWidth: number; canvasWidth: number; height: number; scale: number; cssScale: number }

function CaptionLayer() {
  const { tr } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [pointer, setPointer] = useState<CaptionPointer>({ hover: null, pressed: null });
  const fades = useRef<Partial<Record<CaptionButton, Fade>>>({});
  const frame = useRef(0);
  const tips = useRef<Partial<Record<CaptionButton, HTMLDivElement | null>>>({});
  const tipShown = useRef<CaptionButton | null>(null);
  const tipDismissed = useRef<CaptionButton | null>(null);
  const windows11 = (window.mc?.windowsBuild ?? 0) >= 22000;

  // The canvas size in device pixels (exact, also at 125 / 150 percent) and the scale.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = (entry?: ResizeObserverEntry) => {
      const box = entry?.devicePixelContentBoxSize?.[0];
      // The page zoom (View menu, uiZoom.ts) scales devicePixelRatio, never the native buttons: the layout keeps the DIP scale.
      const cssScale = window.devicePixelRatio || 1;
      const scale = cssScale / uiZoom();
      const canvasWidth = box ? box.inlineSize : Math.round(el.getBoundingClientRect().width * cssScale);
      // The canvas may cover one pixel more than the client at 125 / 150 percent (its CSS width is snapped): the layout
      // follows the client width, which the fractional viewport width gives exactly.
      const clientWidth = Math.round((window.visualViewport?.width ?? window.innerWidth) * cssScale);
      const height = box ? box.blockSize : Math.round(STRIP_HEIGHT * scale);
      setSize((prev) => (prev && prev.clientWidth === clientWidth && prev.canvasWidth === canvasWidth && prev.height === height && prev.scale === scale && prev.cssScale === cssScale ? prev : { clientWidth, canvasWidth, height, scale, cssScale }));
    };
    measure();
    const observer = new ResizeObserver((entries) => measure(entries[0]));
    try { observer.observe(el, { box: 'device-pixel-content-box' }); } catch { observer.observe(el); }
    // A page zoom changes devicePixelRatio but not the canvas's device pixels (the observer stays quiet): measure again then.
    let ratio: MediaQueryList | null = null;
    const onRatio = () => { measure(); watchRatio(); };
    const watchRatio = () => {
      ratio?.removeEventListener('change', onRatio);
      ratio = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
      ratio?.addEventListener('change', onRatio);
    };
    watchRatio();
    return () => { observer.disconnect(); ratio?.removeEventListener('change', onRatio); };
  }, []);

  // Maximized (the restore glyph, the container at the very top) and the pointer from the native child. A listener is
  // registered asynchronously, so a maximize between the first query and the registration (a detached window shown
  // maximized while this mounts) would be lost: the state is asked again whenever the size changes (every maximize and
  // restore does) and whenever the window is shown again.
  const alive = useRef(true);
  const requery = () => {
    void window.mc.windowControls.isMaximized().then((m) => { if (alive.current) setMaximized(!!m); }, () => undefined);
  };
  useEffect(() => {
    alive.current = true;
    const offMax = window.mc.on('window:maximized', (m) => setMaximized(!!m));
    const offShown = window.mc.on('window:shown', () => requery());
    const offPointer = window.mc.on('window:caption', (state) => setPointer(readCaptionPointer(state)));
    return () => { alive.current = false; offMax(); offShown(); offPointer(); };
  }, []);
  useEffect(requery, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  const layout: CaptionLayout | null = size ? captionLayout({ scale: size.scale, clientWidth: size.clientWidth, maximized }) : null;
  const areaKey = layout ? JSON.stringify(captionHitRects(layout)) : '';
  const titles: Record<CaptionButton, string> = {
    min: tr('Minimalizuj'),
    max: maximized ? tr('Przywróć') : tr('Maksymalizuj'),
    close: tr('Zamknij'),
  };
  const labelKey = JSON.stringify(titles);

  // The native side's cross-check and the buttons' names (null on unmount: this page shows none).
  useEffect(() => {
    if (!layout) return;
    window.mc.windowControls.setCaptionArea(captionHitRects(layout), titles);
  }, [areaKey, labelKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.mc.windowControls.setCaptionArea(null), []);

  // Paint: at once for a state or size change, then per frame while a hover fade runs.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !size || !layout) return;
    const now = performance.now();
    for (const b of BUTTONS) {
      const target = pointer.hover === b || pointer.pressed === b ? 1 : 0;
      const f = fades.current[b];
      if ((f?.to ?? 0) !== target) fades.current[b] = fadeTo(f, target, now);
    }
    if (el.width !== size.canvasWidth) el.width = size.canvasWidth;
    if (el.height !== size.height) el.height = size.height;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const draw = () => {
      const t = performance.now();
      const hover: Partial<Record<CaptionButton, number>> = {};
      let running = false;
      for (const b of BUTTONS) {
        const f = fades.current[b];
        if (!f) continue;
        hover[b] = fadeValue(f, t);
        if (t < f.start + f.duration) running = true;
      }
      paintCaption(ctx, layout, { hover, pressed: pointer.pressed, maximized }, { originX: 0, originY: 0, width: el.width, height: el.height, windows11 });
      frame.current = running ? requestAnimationFrame(draw) : 0;
    };
    cancelAnimationFrame(frame.current);
    draw();
    return () => cancelAnimationFrame(frame.current);
  }, [size, areaKey, pointer, maximized, windows11]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tooltips: the pointer is over the native child, not the page, so the hovered button's tooltip element gets the pointer
  // events the app's tooltip host listens to. A press hides it until the pointer leaves the button.
  useEffect(() => {
    if (pointer.pressed) tipDismissed.current = pointer.pressed;
    else if (pointer.hover !== tipDismissed.current) tipDismissed.current = null;
    const next = pointer.pressed || pointer.hover === tipDismissed.current ? null : pointer.hover;
    const prev = tipShown.current;
    if (next === prev) return;
    tipShown.current = next;
    if (prev) tips.current[prev]?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    if (next) tips.current[next]?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  }, [pointer]);

  const rects = layout ? captionHitRects(layout) : null;
  const run: Record<CaptionButton, () => void> = {
    min: () => window.mc.windowControls.minimize(),
    max: () => window.mc.windowControls.toggleMaximize(),
    close: () => window.mc.windowControls.close(),
  };
  const scale = size?.cssScale ?? 1;
  return (
    <>
      <canvas ref={canvas} className="mc-caption" aria-hidden="true" />
      {/* The tooltip anchors are the buttons for assistive technology too (Narrator's scan mode, UI Automation Invoke): the
          pointer never reaches them (the native child is over them), an accessibility click does. */}
      {rects && BUTTONS.map((b) => (
        <div
          key={b}
          ref={(el) => { tips.current[b] = el; }}
          className="mc-caption-tip"
          role="button"
          tabIndex={-1}
          aria-label={titles[b]}
          onClick={run[b]}
          title={titles[b]}
          data-caption-button={b}
          style={{ left: rects[b].x / scale, top: rects[b].y / scale, width: rects[b].width / scale, height: rects[b].height / scale }}
        />
      ))}
    </>
  );
}
