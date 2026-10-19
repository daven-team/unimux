// 0.9.8 performance: the working dot blinks from one shared timer (no CSS animation), background cells get a longer output
// coalescing window, the scrollback is a setting, and node-pty's conout Worker gets small heap limits at install time.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_WINDOW_MS, alignedDelay, BACKGROUND_COALESCE_MS, BULK_COALESCE_MS, coalesceDelay, ECHO_COALESCE_MS } from '../src/ptyhost/flow';
import { OutputChannel, setFocusedTerminal } from '../src/ptyhost/output';
import { BLINK_HALF_MS, SharedBlink } from '../src/shared/blink';
import { defaultState, normalizeState, updateSettings } from '../src/shared/state';
import { DEFAULT_SCROLLBACK_LINES, normalizeScrollback, SCROLLBACK_CHOICES } from '../src/shared/terminalLimits';

const root = join(__dirname, '..');

describe('output coalescing window', () => {
  it('keeps the echo window right after typing, focused or not', () => {
    expect(coalesceDelay(10_000, 9_950, false)).toBe(ECHO_COALESCE_MS);
    expect(coalesceDelay(10_000, 9_950, true)).toBe(ECHO_COALESCE_MS);
  });

  it('keeps the short bulk window for the focused cell and a cell typed into within the last second', () => {
    expect(coalesceDelay(10_000, -Infinity, true)).toBe(BULK_COALESCE_MS);
    expect(coalesceDelay(10_000, 10_000 - ACTIVE_WINDOW_MS + 1, false)).toBe(BULK_COALESCE_MS);
  });

  it('waits longer for cells nobody types in', () => {
    expect(BACKGROUND_COALESCE_MS).toBeGreaterThanOrEqual(30);
    expect(BACKGROUND_COALESCE_MS).toBeLessThanOrEqual(40);
    expect(coalesceDelay(10_000, -Infinity, false)).toBe(BACKGROUND_COALESCE_MS);
    expect(coalesceDelay(10_000, 10_000 - ACTIVE_WINDOW_MS, false)).toBe(BACKGROUND_COALESCE_MS);
  });

  it('puts background flushes on their own shared grid', () => {
    for (let now = 0; now < 100; now++) {
      const delay = alignedDelay(now, BACKGROUND_COALESCE_MS);
      expect((now + delay) % BACKGROUND_COALESCE_MS).toBe(0);
      expect(delay).toBeGreaterThanOrEqual(BACKGROUND_COALESCE_MS / 2);
      expect(delay).toBeLessThanOrEqual(BACKGROUND_COALESCE_MS * 1.5);
    }
  });

  describe('OutputChannel', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
    afterEach(() => { setFocusedTerminal(null); vi.useRealTimers(); });

    const channel = (id: string) => {
      const sent: string[] = [];
      const out = new OutputChannel(id, () => ({ data: (_id: string, d: string) => { sent.push(d); return true; }, exit: () => undefined }), { pause: () => undefined, resume: () => undefined }, () => true);
      return { out, sent };
    };

    it('flushes a background cell on the long window and the focused one on the short window', () => {
      setFocusedTerminal('front');
      const front = channel('front');
      const back = channel('back');
      front.out.push('f');
      back.out.push('b');
      vi.advanceTimersByTime(BULK_COALESCE_MS * 1.5);
      expect(front.sent).toEqual(['f']);
      expect(back.sent).toEqual([]);
      vi.advanceTimersByTime(BACKGROUND_COALESCE_MS * 1.5);
      expect(back.sent).toEqual(['b']);
    });

    it('treats a cell that just got input like the focused one', () => {
      const typed = channel('typed');
      typed.out.wrote();
      vi.advanceTimersByTime(400);
      typed.out.push('x');
      vi.advanceTimersByTime(BULK_COALESCE_MS * 1.5);
      expect(typed.sent).toEqual(['x']);
    });
  });
});

describe('scrollback setting', () => {
  it('offers 1000 to 25000 lines with 5000 as the default', () => {
    expect([...SCROLLBACK_CHOICES]).toEqual([1000, 2500, 5000, 10_000, 25_000]);
    expect(DEFAULT_SCROLLBACK_LINES).toBe(5000);
    expect(defaultState().settings.scrollbackLines).toBe(5000);
  });

  it('normalizes a saved value', () => {
    expect(normalizeScrollback(25_000)).toBe(25_000);
    expect(normalizeScrollback(1000)).toBe(1000);
    for (const bad of [undefined, null, 0, -5, 7000, '5000', 1e9, Number.NaN]) expect(normalizeScrollback(bad)).toBe(DEFAULT_SCROLLBACK_LINES);
    const { scrollbackLines: _gone, ...older } = defaultState().settings;
    expect(normalizeState({ ...defaultState(), settings: older })!.settings.scrollbackLines).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(normalizeState({ ...defaultState(), settings: { ...older, scrollbackLines: 123 } })!.settings.scrollbackLines).toBe(DEFAULT_SCROLLBACK_LINES);
    const saved = JSON.parse(JSON.stringify(updateSettings(defaultState(), { scrollbackLines: 10_000 })));
    expect(normalizeState(saved)!.settings.scrollbackLines).toBe(10_000);
  });

  it('is applied to live terminals and new ones by the renderer', () => {
    const manager = readFileSync(join(root, 'src/renderer/src/terminals/TerminalManager.ts'), 'utf8');
    expect(manager).toContain('scrollback: this.scrollback');
    expect(manager).toMatch(/e\.term\.options\.scrollback = next/);
    expect(readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')).toContain('terminals.setScrollback(st.s.settings.scrollbackLines)');
  });
});

describe('working dot blink', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs one shared timer at 1 Hz while any cell holds it and stops with the last one', () => {
    let reduced = false;
    const phases: boolean[] = [];
    const blink = new SharedBlink((on) => phases.push(on), () => reduced);
    expect(BLINK_HALF_MS).toBeGreaterThanOrEqual(250);
    expect(BLINK_HALF_MS).toBeLessThanOrEqual(500);
    const a = blink.hold();
    const b = blink.hold();
    expect(vi.getTimerCount()).toBe(1);
    expect(phases).toEqual([true]);
    vi.advanceTimersByTime(BLINK_HALF_MS * 2);
    expect(phases).toEqual([true, false, true]);
    a();
    a(); // a second release changes nothing
    expect(blink.count).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    b();
    expect(blink.count).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(phases.at(-1)).toBe(false);
    reduced = true;
    const c = blink.hold();
    vi.advanceTimersByTime(BLINK_HALF_MS * 4);
    expect(phases.slice(-5)).toEqual([false, false, false, false, false]);
    c();
  });

  it('has no infinite CSS animation on the status dots', () => {
    const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8');
    const dotRules = css.split('\n').filter((line) => /\.dot\b/.test(line));
    expect(dotRules.length).toBeGreaterThan(0);
    for (const rule of dotRules) expect(rule).not.toMatch(/animation\s*:/);
    expect(css).not.toMatch(/@keyframes pulse\b/);
    expect(css).toMatch(/:root\[data-blink\] \.dot\.working/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ :root\[data-blink\] \.dot\.working \{ box-shadow: none; \}/);
    expect(readFileSync(join(root, 'src/renderer/src/components/CellView.tsx'), 'utf8')).toContain("useBlink(status === 'working')");
  });
});

describe('node-pty conout Worker limits', () => {
  const require = createRequire(import.meta.url);
  const patch = require('../scripts/patch-node-pty.cjs') as {
    MARKER: string; LIMITS: string; patchSource(source: string): string; isPatched(source: string): boolean;
  };
  const original = "this._worker = new worker_threads_1.Worker(path_1.join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData: workerData });";

  it('adds resourceLimits once and is idempotent', () => {
    const once = patch.patchSource(original);
    expect(once).toContain(patch.LIMITS);
    expect(patch.isPatched(once)).toBe(true);
    expect(patch.patchSource(once)).toBe(once);
    expect(() => new Function('worker_threads_1', 'path_1', 'scriptPath', 'workerData', once)).not.toThrow();
  });

  it('updates an older version of the patch', () => {
    const older = original.replace('{ workerData: workerData }', `{ workerData: workerData, ${patch.MARKER} resourceLimits: { maxYoungGenerationSizeMb: 2 } }`);
    const updated = patch.patchSource(older);
    expect(updated).toContain(patch.LIMITS);
    expect(updated.match(/unimux: conout/g)).toHaveLength(1);
  });

  it('fails loudly when node-pty changed', () => {
    expect(() => patch.patchSource('new Worker(file, { workerData })')).toThrow(/node-pty changed/);
    expect(() => patch.patchSource(`${original}\n${original}`)).toThrow(/exactly one/);
  });

  it('is applied to the installed node-pty and checked in the packaged smoke test', () => {
    const installed = readFileSync(join(root, 'node_modules/node-pty/lib/windowsConoutConnection.js'), 'utf8');
    expect(patch.isPatched(installed)).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.postinstall).toContain('node scripts/patch-node-pty.cjs');
    expect(readFileSync(join(root, 'scripts/smoke-pty.mjs'), 'utf8')).toContain('conout Worker limits OK');
  });
});
