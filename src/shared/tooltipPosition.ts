// Where the styled tooltip bubble goes: centred under the hovered element, above it when there is no room below, always
// clamped into the window. Pure, so the renderer's TooltipHost only measures and the rules stay testable.

export interface TipRect { left: number; top: number; right: number; bottom: number }
export interface TipSize { width: number; height: number }
export interface TipPlacement { left: number; top: number; side: 'below' | 'above' }

/** Distance between the element and the bubble. */
export const TIP_GAP = 6;
/** The bubble never comes closer than this to the window edges. */
export const TIP_MARGIN = 6;

export function placeTooltip(anchor: TipRect, tip: TipSize, viewport: TipSize, gap = TIP_GAP, margin = TIP_MARGIN): TipPlacement {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const centre = (anchor.left + anchor.right) / 2;
  const left = clamp(Math.round(centre - tip.width / 2), margin, viewport.width - tip.width - margin);
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - tip.height;
  const fitsBelow = below + tip.height <= viewport.height - margin;
  const fitsAbove = above >= margin;
  const side = fitsBelow || !fitsAbove ? 'below' : 'above';
  const top = clamp(Math.round(side === 'below' ? below : above), margin, viewport.height - tip.height - margin);
  return { left, top, side };
}
