// The styled tooltip's placement: under the element by default, above it near the bottom edge, clamped into the window.
import { describe, expect, it } from 'vitest';
import { placeTooltip, TIP_GAP, TIP_MARGIN } from '../src/shared/tooltipPosition';

const viewport = { width: 1000, height: 600 };
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });

describe('placeTooltip', () => {
  it('centres the bubble under the element', () => {
    expect(placeTooltip(rect(400, 100, 40, 20), { width: 100, height: 24 }, viewport)).toEqual({ left: 370, top: 120 + TIP_GAP, side: 'below' });
  });

  it('flips above the element when there is no room below', () => {
    const place = placeTooltip(rect(400, 570, 40, 20), { width: 100, height: 24 }, viewport);
    expect(place).toEqual({ left: 370, top: 570 - TIP_GAP - 24, side: 'above' });
  });

  it('stays below when it fits neither side, clamped into the window', () => {
    const place = placeTooltip(rect(0, 10, 50, 560), { width: 100, height: 200 }, viewport);
    expect(place.side).toBe('below');
    expect(place.top).toBe(600 - 200 - TIP_MARGIN);
  });

  it('clamps at the left and right edges', () => {
    expect(placeTooltip(rect(0, 0, 20, 20), { width: 200, height: 24 }, viewport).left).toBe(TIP_MARGIN);
    expect(placeTooltip(rect(980, 0, 20, 20), { width: 200, height: 24 }, viewport).left).toBe(1000 - 200 - TIP_MARGIN);
  });

  it('keeps a bubble wider than the window at the left margin', () => {
    expect(placeTooltip(rect(500, 0, 20, 20), { width: 1200, height: 24 }, viewport).left).toBe(TIP_MARGIN);
  });
});
