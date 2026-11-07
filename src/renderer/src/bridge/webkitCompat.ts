// What the renderer takes from Chromium (Electron 1.1.4, WebView2) and WebKit (WKWebView, the Tauri app on macOS) lacks or does
// differently (PLAN W2). Installed by the bridge (mc.ts) before the app runs, so every module sees the same APIs as in 1.1.4:
// - requestIdleCallback / cancelIdleCallback (background loading, WebGL prewarm): missing in WebKit;
// - crypto.randomUUID (ids of edits, cells, requests): missing where WebKit does not count the page as a secure context;
// - AudioContext resume: a context WebKit holds 'suspended' (or 'interrupted') is resumed on the next user gesture, so alert
//   sounds are not lost (Tauri already turns the autoplay restriction off; this is the safety net);
// - Cmd+V pasted twice: the native Edit menu (macOS) sends `paste:` after the terminal already pasted through the clipboard
//   on keydown; a paste event that follows a Cmd+V keydown the page handled (defaultPrevented) is dropped.
// Chromium has all of them natively, so on Windows only the report is added. Kept free of `window` so tests drive it with fakes.
import type { AppPlatform } from '../../../shared/platform';
import type { WebviewEngine } from '../../../shared/terminalLimits';

export interface CompatReport {
  engine: WebviewEngine;
  requestIdleCallback: 'native' | 'polyfill';
  randomUUID: 'native' | 'polyfill' | 'missing';
  audioResume: boolean;
  pasteGuard: boolean;
}

interface IdleDeadlineLike { didTimeout: boolean; timeRemaining(): number }
type IdleCallback = (deadline: IdleDeadlineLike) => void;

interface AudioContextLike { state: string; resume(): Promise<void>; addEventListener?(type: string, cb: () => void): void }
type AudioContextCtor = new (...args: never[]) => AudioContextLike;

interface KeyLike { metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string; defaultPrevented: boolean }
interface CancelableLike { preventDefault(): void; stopImmediatePropagation(): void }

/** The parts of the page's global object the shims touch. */
export interface CompatGlobal {
  requestIdleCallback?: (cb: IdleCallback, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  crypto?: { randomUUID?: () => string; getRandomValues?<T extends ArrayBufferView>(array: T): T };
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
  addEventListener(type: string, listener: (event: never) => void, options?: boolean | AddEventListenerOptions): void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  performance?: { now(): number };
}

/** Time an idle callback may use, like Chromium's cap for one idle period. */
export const IDLE_BUDGET_MS = 50;
/** A paste event this long after a handled Cmd+V keydown belongs to the same key press (the menu's `paste:`). */
export const PASTE_GUARD_MS = 1000;

export const webviewEngineFor = (platform: AppPlatform): WebviewEngine => (platform === 'darwin' ? 'webkit' : 'chromium');

/** RFC 4122 version 4 from 16 random bytes (what crypto.randomUUID returns). */
export function uuidFromBytes(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function installIdleCallback(g: CompatGlobal): 'native' | 'polyfill' {
  if (typeof g.requestIdleCallback === 'function' && typeof g.cancelIdleCallback === 'function') return 'native';
  const now = () => (g.performance ? g.performance.now() : Date.now());
  const timers = new Map<number, unknown>();
  let nextId = 1;
  g.requestIdleCallback = (cb, options) => {
    const id = nextId++;
    const requested = now();
    const timeout = options?.timeout;
    // After the work queued now (a macrotask), with the budget of one idle period.
    timers.set(id, g.setTimeout(() => {
      timers.delete(id);
      const begin = now();
      cb({ didTimeout: timeout !== undefined && begin - requested >= timeout, timeRemaining: () => Math.max(0, IDLE_BUDGET_MS - (now() - begin)) });
    }, 1));
    return id;
  };
  g.cancelIdleCallback = (id) => {
    if (!timers.has(id)) return;
    g.clearTimeout(timers.get(id));
    timers.delete(id);
  };
  return 'polyfill';
}

function installRandomUUID(g: CompatGlobal): CompatReport['randomUUID'] {
  const crypto = g.crypto;
  if (!crypto) return 'missing';
  if (typeof crypto.randomUUID === 'function') return 'native';
  if (typeof crypto.getRandomValues !== 'function') return 'missing';
  const random = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(crypto, 'randomUUID', { value: () => uuidFromBytes(random(new Uint8Array(16))), configurable: true, writable: true });
  return 'polyfill';
}

function installAudioResume(g: CompatGlobal): boolean {
  const Native = g.AudioContext ?? g.webkitAudioContext;
  if (typeof Native !== 'function') return false;
  const live = new Set<AudioContextLike>();
  // A subclass, so `instanceof AudioContext` and every method stay native.
  const Tracked = class extends (Native as new (...args: unknown[]) => AudioContextLike) {
    constructor(...args: unknown[]) {
      super(...args);
      live.add(this);
      this.addEventListener?.('statechange', () => { if (this.state === 'closed') live.delete(this); });
    }
  };
  g.AudioContext = Tracked as unknown as AudioContextCtor;
  const resumeAll = () => {
    for (const ctx of live) if (ctx.state === 'suspended' || ctx.state === 'interrupted') void ctx.resume().catch(() => {});
  };
  for (const type of ['pointerdown', 'keydown', 'touchend']) g.addEventListener(type, resumeAll, { capture: true, passive: true });
  return true;
}

function installPasteGuard(g: CompatGlobal): boolean {
  const now = () => (g.performance ? g.performance.now() : Date.now());
  let key: KeyLike | null = null;
  let at = 0;
  g.addEventListener('keydown', (e: KeyLike) => {
    key = e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyV' ? e : null;
    at = now();
  }, true);
  g.addEventListener('paste', (e: CancelableLike) => {
    const handled = key !== null && key.defaultPrevented && now() - at < PASTE_GUARD_MS;
    key = null;
    if (!handled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  return true;
}

/** Installs what the engine of `platform` lacks; returns what it did (window.__MC_COMPAT__, checked by the eval-bridge smoke). */
export function installCompat(g: CompatGlobal, platform: AppPlatform): CompatReport {
  const engine = webviewEngineFor(platform);
  const webkit = engine === 'webkit';
  return {
    engine,
    requestIdleCallback: installIdleCallback(g),
    randomUUID: installRandomUUID(g),
    audioResume: webkit && installAudioResume(g),
    pasteGuard: webkit && installPasteGuard(g),
  };
}
