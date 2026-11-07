// WebKit compatibility of the Tauri bridge (PLAN W2): what WKWebView lacks is filled in before the app runs, Chromium is left
// alone, and the WebGL pool is sized for WebKit's 16-context cap.
import { describe, expect, it, vi } from 'vitest';
import { installCompat, PASTE_GUARD_MS, uuidFromBytes, webviewEngineFor, type CompatGlobal } from '../src/renderer/src/bridge/webkitCompat';
import { MAX_WEBGL_CONTEXTS, MAX_WEBGL_CONTEXTS_WEBKIT, maxWebglContexts, WEBKIT_WEBGL_CONTEXTS } from '../src/shared/terminalLimits';
import { MAX_CELLS } from '../src/shared/layout';
import { DRAG_SELECTOR, installMacDrag, isDragTarget, NO_DRAG_SELECTOR } from '../src/renderer/src/bridge/macDrag';

type Listener = (event: never) => void;

function fakeGlobal(extra: Partial<CompatGlobal> = {}) {
  const listeners = new Map<string, Listener[]>();
  let clock = 0;
  const timers: { at: number; cb: () => void; id: number }[] = [];
  let timerId = 0;
  const g: CompatGlobal = {
    addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener as Listener]); },
    setTimeout: (cb, ms) => { const id = ++timerId; timers.push({ at: clock + ms, cb, id }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    performance: { now: () => clock },
    ...extra,
  };
  const fire = (type: string, event: object) => { for (const l of listeners.get(type) ?? []) l(event as never); };
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.cb(); }
  };
  const tick = (ms: number) => { clock += ms; };
  return { g, fire, advance, tick, listeners };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('engine', () => {
  it('is WebKit only on macOS (the Tauri app; Electron never loads the bridge)', () => {
    expect(webviewEngineFor('darwin')).toBe('webkit');
    expect(webviewEngineFor('win32')).toBe('chromium');
    expect(webviewEngineFor('linux')).toBe('chromium');
  });
});

describe('requestIdleCallback', () => {
  it('keeps a native one', () => {
    const native = vi.fn(() => 1);
    const { g } = fakeGlobal({ requestIdleCallback: native, cancelIdleCallback: vi.fn() });
    expect(installCompat(g, 'darwin').requestIdleCallback).toBe('native');
    expect(g.requestIdleCallback).toBe(native);
  });

  it('polyfills with a macrotask, a 50 ms budget, didTimeout and cancel', () => {
    const { g, advance } = fakeGlobal();
    expect(installCompat(g, 'darwin').requestIdleCallback).toBe('polyfill');
    const seen: { didTimeout: boolean; left: number }[] = [];
    g.requestIdleCallback!((d) => seen.push({ didTimeout: d.didTimeout, left: d.timeRemaining() }), { timeout: 1500 });
    const cancelled = vi.fn();
    const id = g.requestIdleCallback!(cancelled);
    g.cancelIdleCallback!(id);
    g.cancelIdleCallback!(9999);
    expect(seen).toEqual([]);
    advance(1);
    expect(seen).toEqual([{ didTimeout: false, left: 50 }]);
    expect(cancelled).not.toHaveBeenCalled();
    // A callback that waited past its timeout says so.
    g.requestIdleCallback!((d) => seen.push({ didTimeout: d.didTimeout, left: d.timeRemaining() }), { timeout: 0 });
    advance(5);
    expect(seen[1].didTimeout).toBe(true);
  });
});

describe('crypto.randomUUID', () => {
  it('formats 16 bytes as RFC 4122 version 4', () => {
    expect(uuidFromBytes(new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidFromBytes(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('is added from getRandomValues when missing, kept when native', () => {
    const crypto: CompatGlobal['crypto'] = { getRandomValues: (a) => globalThis.crypto.getRandomValues(a as never) };
    const { g } = fakeGlobal({ crypto });
    expect(installCompat(g, 'darwin').randomUUID).toBe('polyfill');
    const ids = new Set(Array.from({ length: 200 }, () => crypto.randomUUID!()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    const native = () => 'native';
    const { g: g2 } = fakeGlobal({ crypto: { randomUUID: native } });
    expect(installCompat(g2, 'darwin').randomUUID).toBe('native');
    expect(g2.crypto!.randomUUID).toBe(native);
    expect(installCompat(fakeGlobal().g, 'darwin').randomUUID).toBe('missing');
  });
});

describe('AudioContext resume (WebKit only)', () => {
  class FakeContext {
    state = 'suspended';
    resumed = 0;
    private onState: (() => void) | null = null;
    resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); }
    addEventListener(_type: string, cb: () => void) { this.onState = cb; }
    close() { this.state = 'closed'; this.onState?.(); }
  }

  it('resumes suspended and interrupted contexts on the next gesture, stays a real subclass', () => {
    const { g, fire } = fakeGlobal({ AudioContext: FakeContext as never });
    expect(installCompat(g, 'darwin').audioResume).toBe(true);
    const Ctor = g.AudioContext as unknown as typeof FakeContext;
    const a = new Ctor();
    const b = new Ctor();
    expect(a).toBeInstanceOf(FakeContext);
    b.state = 'interrupted';
    fire('pointerdown', {});
    expect([a.resumed, b.resumed]).toEqual([1, 1]);
    fire('keydown', {});
    expect(a.resumed).toBe(1); // running now: left alone
    const c = new Ctor();
    c.close();
    fire('touchend', {});
    expect(c.resumed).toBe(0);
  });

  it('leaves Chromium alone', () => {
    const { g, listeners } = fakeGlobal({ AudioContext: FakeContext as never });
    const report = installCompat(g, 'win32');
    expect(report).toEqual({ engine: 'chromium', requestIdleCallback: 'polyfill', randomUUID: 'missing', audioResume: false, pasteGuard: false });
    expect(g.AudioContext).toBe(FakeContext);
    expect([...listeners.keys()]).toEqual([]);
  });
});

describe('Cmd+V pastes once (WebKit only)', () => {
  const key = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string; defaultPrevented: boolean }> = {}) =>
    ({ metaKey: true, ctrlKey: false, altKey: false, code: 'KeyV', defaultPrevented: true, ...over });
  const paste = () => ({ prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });

  it("drops the menu's paste after a Cmd+V the page handled", () => {
    const { g, fire, tick } = fakeGlobal();
    expect(installCompat(g, 'darwin').pasteGuard).toBe(true);
    fire('keydown', key());
    const p = paste();
    fire('paste', p);
    expect([p.prevented, p.stopped]).toEqual([true, true]);
    // Only once: a second paste event (e.g. the Edit menu clicked with the mouse) goes through.
    const again = paste();
    fire('paste', again);
    expect(again.prevented).toBe(false);
    // Too late to belong to the key press.
    fire('keydown', key());
    tick(PASTE_GUARD_MS + 1);
    const late = paste();
    fire('paste', late);
    expect(late.prevented).toBe(false);
  });

  it('lets the paste through when the page did not handle the key (text fields) or for other keys', () => {
    const { g, fire } = fakeGlobal();
    installCompat(g, 'darwin');
    fire('keydown', key({ defaultPrevented: false }));
    const p = paste();
    fire('paste', p);
    expect(p.prevented).toBe(false);
    fire('keydown', key());
    fire('keydown', key({ code: 'KeyA' }));
    const q = paste();
    fire('paste', q);
    expect(q.prevented).toBe(false);
    fire('keydown', key({ ctrlKey: true }));
    const r = paste();
    fire('paste', r);
    expect(r.prevented).toBe(false);
  });
});

describe('WebGL pool size', () => {
  it('is 64 on Chromium and 12 under WebKit, below its hard cap of 16', () => {
    expect(maxWebglContexts('chromium')).toBe(MAX_WEBGL_CONTEXTS);
    expect(maxWebglContexts('webkit')).toBe(MAX_WEBGL_CONTEXTS_WEBKIT);
    expect(MAX_WEBGL_CONTEXTS_WEBKIT).toBe(12);
    expect(MAX_WEBGL_CONTEXTS_WEBKIT).toBeLessThan(WEBKIT_WEBGL_CONTEXTS);
    // A full grid does not fit: the rest draws through xterm's DOM renderer (planWebgl picks focused and busy cells first).
    expect(MAX_WEBGL_CONTEXTS_WEBKIT).toBeLessThan(MAX_CELLS);
  });

  it('TerminalManager sizes its WebglLimit by the engine', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/renderer/src/terminals/TerminalManager.ts', import.meta.url), 'utf8');
    expect(src).toContain('new WebglLimit(maxWebglContexts(webviewEngine()))');
    const bridge = readFileSync(new URL('../src/renderer/src/bridge/mc.ts', import.meta.url), 'utf8');
    // The shims go in before anything else of the bridge runs.
    expect(bridge.indexOf('installCompat(window')).toBeLessThan(bridge.indexOf('createTauriTransport(boot'));
  });
});

describe('title bar drag area on macOS (WKWebView ignores -webkit-app-region)', () => {
  // A tiny element tree: closest() matches simple tag and class selectors like the DOM would for these elements.
  type El = { tag: string; cls: string[]; parent: El | null; closest(s: string): El | null; contains(o: El | null): boolean };
  const matches = (n: El, selector: string) => selector.split(',').map((s) => s.trim()).some((s) =>
    s.startsWith('.') ? n.cls.includes(s.slice(1)) : s === n.tag);
  const el = (tag: string, cls: string[] = [], parent: El | null = null): El => {
    const n: El = {
      tag, cls, parent,
      closest(s) { for (let x: El | null = n; x; x = x.parent) if (matches(x, s)) return x; return null; },
      contains(o) { for (let x = o; x; x = x.parent) if (x === n) return true; return false; },
    };
    return n;
  };
  const app = el('div', ['app']);
  const bar = el('div', ['titlebar'], app);
  const brand = el('div', ['brand'], bar);
  const label = el('span', [], brand);
  const button = el('button', ['tb-btn'], bar);
  const icon = el('svg', [], button);
  const tab = el('div', ['tab'], bar);
  const pill = el('div', ['update-pill'], bar);
  const grid = el('div', ['grid'], app);
  const gridButton = el('button', [], grid);

  it('drags from the bar and its text, not from its controls or outside it', () => {
    expect(isDragTarget(bar)).toBe(true);
    expect(isDragTarget(label)).toBe(true);
    for (const n of [button, icon, tab, pill, grid, gridButton, null]) expect(isDragTarget(n)).toBe(false);
  });

  it("matches 1.1.4's drag and no-drag rules of the CSS", async () => {
    const { readFileSync } = await import('node:fs');
    const css = ['../src/renderer/src/styles.css', '../src/renderer/src/components/updater.css']
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    const selectors = (value: string) => [...css.matchAll(new RegExp(`([^{}]+)\\{[^}]*-webkit-app-region:\\s*${value};`, 'g'))]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()));
    expect(selectors('drag')).toEqual([DRAG_SELECTOR]);
    const list = NO_DRAG_SELECTOR.split(',').map((s) => s.trim());
    expect(selectors('no-drag').length).toBeGreaterThanOrEqual(8);
    for (const hole of selectors('no-drag')) expect(list).toContain(hole.replace(/^\.titlebar\s+/, ''));
  });

  it('starts a native drag on a press, asks Rust on a double click, and hides both from the page', () => {
    let listener: ((e: never) => void) | null = null;
    let capture: unknown;
    const g = { addEventListener: (_t: string, l: (e: never) => void, o?: unknown) => { listener = l; capture = o; } };
    const actions = { startDragging: vi.fn(() => Promise.resolve()), doubleClick: vi.fn(() => Promise.reject(new Error('denied'))) };
    installMacDrag(g as never, actions);
    expect(capture).toBe(true);
    const press = (target: unknown, detail = 1, button = 0) => {
      const e = { button, detail, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      listener!(e as never);
      return e;
    };
    const first = press(label);
    expect([first.prevented, first.stopped]).toEqual([true, true]);
    expect(actions.startDragging).toHaveBeenCalledTimes(1);
    press(bar, 2);
    expect(actions.doubleClick).toHaveBeenCalledTimes(1);
    press(bar, 3);
    expect(actions.startDragging).toHaveBeenCalledTimes(1);
    const onButton = press(button);
    const rightClick = press(bar, 1, 2);
    expect([onButton.prevented, rightClick.prevented]).toEqual([false, false]);
    expect(actions.startDragging).toHaveBeenCalledTimes(1);
  });

  it('the bridge installs it on macOS only', async () => {
    const { readFileSync } = await import('node:fs');
    const bridge = readFileSync(new URL('../src/renderer/src/bridge/mc.ts', import.meta.url), 'utf8');
    expect(bridge).toMatch(/if \(boot\.platform === 'darwin'\) \{\r?\n\s+installMacDrag\(/);
    expect(bridge).toContain("invoke('mac_title_double_click')");
  });
});
