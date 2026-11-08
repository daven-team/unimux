// 0.9.8 performance: indicators of ongoing work blink from one shared timer (no CSS animation), background cells get a longer
// output coalescing window, the scrollback is a setting, and node-pty's conout Worker gets small heap reservations and an
// error listener at install time.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLINK_HALF_MS, SharedBlink } from '../src/shared/blink';
import { applyScrollback, DEFAULT_SCROLLBACK_LINES } from '../src/shared/terminalLimits';

const root = join(__dirname, '..');

describe('scrollback setting', () => {
  it('applies a new value to every open terminal, normalized', () => {
    const terms = [{ options: { scrollback: 5000 } }, { options: { scrollback: 5000 } }];
    expect(applyScrollback(terms, 1000)).toBe(1000);
    expect(terms.map((t) => t.options.scrollback)).toEqual([1000, 1000]);
    expect(applyScrollback(terms, 'junk')).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(terms.map((t) => t.options.scrollback)).toEqual([5000, 5000]);
  });
});

describe('shared blink', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** A fake <html>: the attribute the renderer toggles. */
  const fakeRoot = () => {
    const attrs = new Set<string>();
    return { attrs, blink: new SharedBlink((on) => { if (on) attrs.add('data-blink'); else attrs.delete('data-blink'); }) };
  };

  it('runs one timer at 1 Hz while anything holds it and stops with the last one', () => {
    const { attrs, blink } = fakeRoot();
    expect(BLINK_HALF_MS).toBeGreaterThanOrEqual(250);
    expect(BLINK_HALF_MS).toBeLessThanOrEqual(500);
    const a = blink.hold();
    const b = blink.hold();
    expect(vi.getTimerCount()).toBe(1);
    expect(attrs.has('data-blink')).toBe(true);
    vi.advanceTimersByTime(BLINK_HALF_MS);
    expect(attrs.has('data-blink')).toBe(false);
    vi.advanceTimersByTime(BLINK_HALF_MS);
    expect(attrs.has('data-blink')).toBe(true);
    a();
    a(); // a second release changes nothing
    expect(blink.count).toBe(1);
    expect(blink.running).toBe(true);
    b();
    expect(blink.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(attrs.has('data-blink')).toBe(false);
  });

  it('1.0.9: steps through more phases for the ripple of the working dot and shows none once stopped', () => {
    const shown: (number | null)[] = [];
    const pulse = new SharedBlink((phase) => shown.push(phase), 5, 200);
    const release = pulse.hold();
    vi.advanceTimersByTime(200 * 6);
    expect(shown).toEqual([1, 2, 3, 4, 0, 1, 2]);
    expect(vi.getTimerCount()).toBe(1);
    release();
    expect(shown.at(-1)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    pulse.hold();
    expect(shown.at(-1)).toBe(1);
  });

  it('runs no timer while not allowed (hidden window, reduced motion) and resumes afterwards', () => {
    const { attrs, blink } = fakeRoot();
    const release = blink.hold();
    blink.setAllowed(false);
    expect(blink.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(attrs.has('data-blink')).toBe(false);
    vi.advanceTimersByTime(BLINK_HALF_MS * 4);
    expect(attrs.has('data-blink')).toBe(false);
    const other = blink.hold();
    expect(blink.running).toBe(false);
    blink.setAllowed(true);
    expect(blink.running).toBe(true);
    expect(attrs.has('data-blink')).toBe(true);
    release();
    other();
    expect(blink.running).toBe(false);
  });

  it('leaves no infinite CSS animation in the renderer styles except the short brand effect, the spinners and the turning working mark', () => {
    const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
    const infinite: string[] = [];
    const spinners: Array<[string, string]> = [];
    for (const file of cssFiles(join(root, 'src/renderer/src'))) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const animation = /animation\s*:([^;]*\binfinite\b[^;]*)/.exec(rule[2]);
        if (!animation) continue;
        infinite.push(rule[1].trim());
        if (!rule[1].includes('.brand')) spinners.push([rule[1].trim(), animation[1].trim()]);
      }
    }
    // 1.1.3: every turning mark turns the same way: one turn a second at up to 60 frames, a compositor-only transform.
    for (const [selector, animation] of spinners) expect(`${selector}: ${animation}`).toBe(`${selector}: mc-spin 1s steps(60) infinite`);
    // .brand.fx runs 2.4 s after a click on the logo; the spinners (RefreshIcon, BusyRing) and the arc of the SSH connecting
    // card exist only during a wait and turn by transform alone (static under reduced motion). 1.0.8: the pulse of a working
    // cell's status dot (the shared 1 Hz blink read as a two-frame flicker) exists only while the cell works and changes
    // transform and opacity alone, so the compositor runs it without main-thread work (static under reduced motion).
    // 1.0.9: that pulse ran at every vsync while a cell worked (241 frames a second, 43 % of a core with 16 cells); it runs two
    // smooth waves now and then steps with the shared pulse. 1.1.3: it turns again the whole time, at up to 60 frames a
    // second like every spinner (the display rate composited the window up to 150 times a second). Nothing else.
    expect(infinite.sort()).toEqual(['.brand.fx .bn-fx', '.refresh-icon.spinning svg, .busy-ring', '.ssh-mark.active::after', '.smark.working > svg'].sort());
  });
});

