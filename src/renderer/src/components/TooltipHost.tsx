// The app's styled tooltips: one host, mounted once, turns every `title` into a dark bubble instead of the plain system
// tooltip. Event delegation, so no call site changes: while an element with a title is hovered its title waits in
// `data-mc-title` (no system tooltip), and comes back when the pointer leaves. A title React or a mouseenter handler sets
// while hovered is picked up by a MutationObserver, so the bubble always shows the current text.
import { useEffect } from 'react';
import { placeTooltip } from '../../../shared/tooltipPosition';
import './tooltip.css';

const SHOW_DELAY = 400;
/** Moving to another element this soon after a bubble was shown opens the next one at once. */
const WARM_MS = 600;
const HIDDEN = 'data-mc-title';

/** The element whose tooltip the hovered element shows: the closest one with a title (an empty title means none). */
function anchorOf(target: Element | null): HTMLElement | SVGElement | null {
  if (!target || target.closest('.xterm')) return null;
  const el = target.closest<HTMLElement | SVGElement>(`[title], [${HIDDEN}]`);
  if (!el) return null;
  return (el.getAttribute('title') ?? el.getAttribute(HIDDEN) ?? '').trim() ? el : null;
}

function installTooltips(): () => void {
  const tip = document.createElement('div');
  tip.className = 'mc-tooltip';
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);

  let target: Element | null = null;
  let anchor: HTMLElement | SVGElement | null = null;
  let text = '';
  let timer = 0;
  let watch = 0;
  let visible = false;
  let suppressed = false;
  let warmUntil = 0;

  /** Moves the anchor's title aside (no system tooltip) and remembers its text. */
  const capture = (el: HTMLElement | SVGElement) => {
    const title = el.getAttribute('title');
    if (title !== null) {
      text = title;
      el.setAttribute(HIDDEN, title);
      el.removeAttribute('title');
    } else text = el.getAttribute(HIDDEN) ?? '';
  };
  /** Gives the title back; a title set meanwhile (React re-rendered) wins over the saved one. */
  const release = (el: HTMLElement | SVGElement) => {
    const saved = el.getAttribute(HIDDEN);
    el.removeAttribute(HIDDEN);
    if (saved !== null && el.getAttribute('title') === null) el.setAttribute('title', saved);
  };

  const hide = () => {
    window.clearTimeout(timer);
    window.clearInterval(watch);
    if (visible) warmUntil = performance.now() + WARM_MS;
    visible = false;
    tip.classList.remove('on');
  };
  const show = () => {
    if (!anchor || !anchor.isConnected || !text.trim()) return hide();
    tip.textContent = text;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const box = tip.getBoundingClientRect();
    const place = placeTooltip(anchor.getBoundingClientRect(), { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight });
    tip.style.left = `${place.left}px`;
    tip.style.top = `${place.top}px`;
    tip.classList.add('on');
    visible = true;
    window.clearInterval(watch);
    // A removed element sends no pointer event: the bubble checks for it while it shows.
    watch = window.setInterval(() => { if (!anchor?.isConnected) { hide(); if (anchor) release(anchor); anchor = null; } }, 250);
  };
  const schedule = () => {
    window.clearTimeout(timer);
    if (suppressed || !anchor) return;
    if (visible || performance.now() < warmUntil) show();
    else timer = window.setTimeout(show, SHOW_DELAY);
  };

  /** Follows the hovered element: a new anchor releases the old one and starts its own bubble. */
  const update = () => {
    const next = anchorOf(target);
    if (next === anchor) return;
    if (anchor) release(anchor);
    hide();
    anchor = next;
    suppressed = false;
    if (anchor) {
      capture(anchor);
      schedule();
    }
  };

  const onOver = (e: PointerEvent) => {
    target = e.target instanceof Element ? e.target : null;
    update();
  };
  const onOut = (e: PointerEvent) => {
    if (e.relatedTarget) return;
    target = null;
    update();
  };
  /** A click, a key, a scroll: the bubble goes and stays away until the pointer moves to another element. */
  const dismiss = () => {
    hide();
    suppressed = true;
  };
  // Only a scroll that moves the hovered element: a terminal printing elsewhere scrolls all the time.
  const onScroll = (e: Event) => {
    if (anchor && (e.target === document || (e.target instanceof Node && e.target.contains(anchor)))) dismiss();
  };
  const onBlur = () => {
    target = null;
    update();
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const el = record.target as HTMLElement | SVGElement;
      const title = el.getAttribute('title');
      if (title === null || !target || !el.contains(target)) continue;
      if (el === anchor) {
        // The hovered element's title changed: hide the new one too and show the current text.
        capture(el);
        if (visible) show();
      } else update();
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['title'] });

  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('keydown', dismiss, true);
  window.addEventListener('wheel', dismiss, { capture: true, passive: true });
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', onBlur);
  return () => {
    observer.disconnect();
    document.removeEventListener('pointerover', onOver, true);
    document.removeEventListener('pointerout', onOut, true);
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('keydown', dismiss, true);
    window.removeEventListener('wheel', dismiss, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', onBlur);
    hide();
    if (anchor) release(anchor);
    tip.remove();
  };
}

export function TooltipHost() {
  useEffect(installTooltips, []);
  return null;
}
