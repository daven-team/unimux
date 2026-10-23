// 0.9.8 performance: indicators of ongoing work blink from one shared timer (no CSS animation), background cells get a longer
// output coalescing window, the scrollback is a setting, and node-pty's conout Worker gets small heap reservations and an
// error listener at install time.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_WINDOW_MS, alignedDelay, BACKGROUND_COALESCE_MS, BULK_COALESCE_MS, coalesceDelay, ECHO_COALESCE_MS } from '../src/ptyhost/flow';
import { focusedTerminalId, OutputChannel, setFocusedTerminal } from '../src/ptyhost/output';
import { HostRouter, type TerminalBackend } from '../src/ptyhost/router';
import { BLINK_HALF_MS, SharedBlink } from '../src/shared/blink';
import { defaultState, normalizeState, updateSettings } from '../src/shared/state';
import { applyScrollback, DEFAULT_SCROLLBACK_LINES, normalizeScrollback, SCROLLBACK_CHOICES } from '../src/shared/terminalLimits';

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

  describe('OutputChannel and the focus protocol', () => {
    const channels: OutputChannel[] = [];
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
    afterEach(() => { for (const c of channels.splice(0)) c.dispose(); setFocusedTerminal(null); vi.useRealTimers(); });

    const channel = (id: string) => {
      const sent: string[] = [];
      const out = new OutputChannel(id, () => ({ data: (_id: string, d: string) => { sent.push(d); return true; }, exit: () => undefined }), { pause: () => undefined, resume: () => undefined }, () => true);
      channels.push(out);
      return { out, sent };
    };
    const backend = (ids: string[], log: string[]): TerminalBackend => ({
      has: (id) => ids.includes(id),
      write: (id, data, reply) => { log.push(`${id} ${data} ${reply === true ? 'reply' : 'typed'}`); },
      resize: () => undefined, ack: () => undefined, setFlowControl: () => undefined, histories: () => [],
      kill: async () => undefined, killAll: async () => undefined,
    });

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

    it('moves a pending background flush up when the user types into the cell', () => {
      const cell = channel('streaming');
      cell.out.push('stream ');
      vi.advanceTimersByTime(1);
      cell.out.wrote();
      cell.out.push('echo');
      vi.advanceTimersByTime(ECHO_COALESCE_MS);
      expect(cell.sent).toEqual(['stream echo']);
    });

    it('moves a pending background flush up when the cell gets the focus, and leaves other cells alone', () => {
      const a = channel('a');
      const b = channel('b');
      a.out.push('A');
      b.out.push('B');
      vi.advanceTimersByTime(1);
      setFocusedTerminal('a');
      vi.advanceTimersByTime(BULK_COALESCE_MS * 1.5);
      expect(a.sent).toEqual(['A']);
      expect(b.sent).toEqual([]);
      vi.advanceTimersByTime(BACKGROUND_COALESCE_MS * 1.5);
      expect(b.sent).toEqual(['B']);
    });

    it('a focus message from the renderer changes the window, a new renderer clears it', () => {
      const router = new HostRouter([]);
      const cell = channel('c1');
      router.message({ t: 'focus', id: 'c1' });
      expect(focusedTerminalId()).toBe('c1');
      cell.out.push('x');
      vi.advanceTimersByTime(BULK_COALESCE_MS * 1.5);
      expect(cell.sent).toEqual(['x']);
      router.rendererAttached();
      expect(focusedTerminalId()).toBeNull();
      cell.out.push('y');
      vi.advanceTimersByTime(BULK_COALESCE_MS * 1.5);
      expect(cell.sent).toEqual(['x']);
      vi.advanceTimersByTime(BACKGROUND_COALESCE_MS * 1.5);
      expect(cell.sent).toEqual(['x', 'y']);
      router.message({ t: 'focus', id: 42 as unknown as string });
      expect(focusedTerminalId()).toBeNull();
    });

    it('passes terminal replies on as replies, so they do not count as typing', () => {
      const log: string[] = [];
      const router = new HostRouter([backend(['p'], log)]);
      router.message({ t: 'write', id: 'p', data: 'ls' });
      router.message({ t: 'write', id: 'p', data: '\x1b[I', reply: true });
      expect(log).toEqual(['p ls typed', 'p \x1b[I reply']);
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

  it('leaves no infinite CSS animation in the renderer styles except the short brand effect and the spinners', () => {
    const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
    const infinite: string[] = [];
    for (const file of cssFiles(join(root, 'src/renderer/src'))) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/animation\s*:[^;]*\binfinite\b/.test(rule[2])) infinite.push(rule[1].trim());
      }
    }
    // .brand.fx runs 2.4 s after a click on the logo; the spinners (RefreshIcon, BusyRing) and the arc of the SSH connecting
    // card exist only during a wait and turn by transform alone (static under reduced motion). Nothing else.
    expect(infinite.sort()).toEqual(['.brand.fx .bn-fx', '.refresh-icon.spinning svg, .busy-ring', '.ssh-mark.active::after'].sort());
  });
});

describe('node-pty conout Worker patch', () => {
  const require = createRequire(import.meta.url);
  const patch = require('../scripts/patch-node-pty.cjs') as {
    MARKER: string; LIMITS: string; PATCHED: string; patchSource(source: string): string; isPatched(source: string): boolean;
    patchModule(moduleRoot: string): { file: string; changed: boolean };
  };
  const original = "    this._worker = new worker_threads_1.Worker(path_1.join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData: workerData });";

  /** Runs the patched statement with a fake Worker: its options and listeners. */
  const runPatched = (source: string) => {
    const seen: { options?: { resourceLimits?: Record<string, number> }; listeners: Record<string, (e: unknown) => void> } = { listeners: {} };
    class FakeWorker {
      constructor(_file: string, options: never) { seen.options = options; }
      on(event: string, listener: (e: unknown) => void) { seen.listeners[event] = listener; return this; }
    }
    const self = {};
    // Only this test's own fixed text is evaluated.
    new Function('worker_threads_1', 'path_1', 'scriptPath', 'workerData', source).call(self, { Worker: FakeWorker }, { join: (...p: string[]) => p.join('/') }, 'lib', {});
    return seen;
  };

  it('adds the heap limits and an error listener that logs, once', () => {
    const once = patch.patchSource(original);
    expect(patch.isPatched(once)).toBe(true);
    expect(patch.patchSource(once)).toBe(once);
    const seen = runPatched(once);
    expect(seen.options?.resourceLimits).toEqual({ maxYoungGenerationSizeMb: 1, maxOldGenerationSizeMb: 64, codeRangeSizeMb: 4, stackSizeMb: 1 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    seen.listeners.error(new Error('ERR_WORKER_OUT_OF_MEMORY'));
    expect(errors).toHaveBeenCalledWith('unimux: conout worker failed', expect.any(Error));
    errors.mockRestore();
  });

  it('replaces an older version of the patch', () => {
    const older = original.replace('{ workerData: workerData }', `{ workerData: workerData, ${patch.MARKER} resourceLimits: { maxYoungGenerationSizeMb: 1, maxOldGenerationSizeMb: 16 } }`);
    expect(patch.isPatched(older)).toBe(false);
    const updated = patch.patchSource(older);
    expect(updated).toBe(patch.patchSource(original));
    expect(updated.match(/unimux: conout worker resourceLimits/g)).toHaveLength(1);
  });

  it('fails loudly when node-pty changed', () => {
    expect(() => patch.patchSource('new Worker(file, { workerData })')).toThrow(/node-pty changed/);
    expect(() => patch.patchSource(`${original}\n${original}`)).toThrow(/exactly one/);
  });

  it('patches a module folder in place, idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unimux-ptypatch-'));
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'lib', 'windowsConoutConnection.js'), `var x = 1;\n${original}\n`);
      expect(patch.patchModule(dir).changed).toBe(true);
      expect(patch.patchModule(dir).changed).toBe(false);
      expect(patch.isPatched(readFileSync(join(dir, 'lib', 'windowsConoutConnection.js'), 'utf8'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is applied to the installed node-pty (postinstall)', () => {
    expect(patch.isPatched(readFileSync(join(root, 'node_modules/node-pty/lib/windowsConoutConnection.js'), 'utf8'))).toBe(true);
  });
});
