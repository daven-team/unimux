import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHROMIUM_WEBGL_CONTEXTS, MAX_WEBGL_CONTEXTS, MAX_WEBGL_CONTEXTS_WEBKIT, maxWebglContexts } from '../src/shared/terminalLimits';
import { MAX_CELLS } from '../src/shared/layout';
import { nextLossCount, pickPrewarm, planWebgl, WEBGL_BUSY_MS, WEBGL_EVICT_MS, WEBGL_HEALTHY_MS, WEBGL_HOLD_MS, WEBGL_MIN_LIMIT, WEBGL_PREWARM_RESERVE, WEBGL_RECOVER_MS, webglBackoff, WebglLimit, webglPrewarmReserve, type WebglCandidate } from '../src/shared/webglPool';

const NOW = 100_000;
const c = (id: string, hasWebgl: boolean, attached: boolean, extra: Partial<WebglCandidate> = {}): WebglCandidate => ({ id, hasWebgl, attached, shownAt: 0, ...extra });
const busy = { outputAt: NOW - 100 };
const old = { changedAt: NOW - WEBGL_HOLD_MS - 1 };

describe('WebGL context pool', () => {
  it('serves a shown terminal from a free slot', () => {
    expect(planWebgl([c('a', true, true), c('b', false, true)], 3, NOW)).toEqual({ grant: ['b'], release: [] });
  });

  it('takes the context of the least recently shown parked terminal at the limit', () => {
    const all = [c('a', true, true), c('b', true, false, { shownAt: 5 }), c('c', true, false, { shownAt: 2 }), c('d', false, true)];
    expect(planWebgl(all, 3, NOW)).toEqual({ grant: ['d'], release: ['c'] });
  });

  it('gives back the excess of parked terminals when the limit was lowered', () => {
    const all = [c('a', true, false, { shownAt: 1 }), c('b', true, false, { shownAt: 2 }), c('c', true, false, { shownAt: 3 })];
    expect(planWebgl(all, 1, NOW)).toEqual({ grant: [], release: ['a', 'b'] });
  });

  it('keeps contexts of parked terminals while nobody on screen needs one', () => {
    expect(planWebgl([c('a', true, false), c('b', true, true)], 2, NOW)).toEqual({ grant: [], release: [] });
  });

  it('never swaps between equally quiet shown terminals', () => {
    const all = [c('a', true, true, old), c('b', true, true, old), c('c', false, true)];
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: [], release: [] });
  });

  it('a busy shown terminal takes the context of the quietest settled one on screen', () => {
    const all = [c('a', true, true, { ...old, outputAt: NOW - WEBGL_BUSY_MS - 10 }), c('b', true, true, { ...old, outputAt: NOW - 50 }), c('c', false, true, busy)];
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: ['c'], release: ['a'] });
  });

  it('the focused terminal comes first and never loses its context', () => {
    const all = [c('a', true, true, { ...old, focused: true }), c('b', true, true, { ...old, ...busy }), c('c', false, true, { focused: false }), c('d', false, true, { focused: true })];
    // Only one is really focused at a time; the plan still never takes the context of a terminal marked focused.
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: ['d'], release: ['b'] });
  });

  it('hysteresis: a context held for less than WEBGL_HOLD_MS stays, and a terminal that just lost one waits', () => {
    const fresh = [c('a', true, true, { changedAt: NOW - 1000 }), c('b', false, true, busy)];
    expect(planWebgl(fresh, 1, NOW)).toEqual({ grant: [], release: [] });
    const justLost = [c('a', true, true, old), c('b', false, true, { ...busy, changedAt: NOW - 1000 })];
    expect(planWebgl(justLost, 1, NOW)).toEqual({ grant: [], release: [] });
  });

  it('moves at most one context between shown terminals per plan', () => {
    const all = [c('a', true, true, old), c('b', true, true, old), c('c', false, true, busy), c('d', false, true, busy)];
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: ['c'], release: ['a'] });
  });

  it('skips a terminal that is backing off after a lost context', () => {
    expect(planWebgl([c('a', false, true, { blockedUntil: NOW + 1 }), c('b', false, true)], 4, NOW)).toEqual({ grant: ['b'], release: [] });
  });

  it('a 20-cell grid gets 20 contexts after a long run of swaps settles, with no swap back', () => {
    // Simulates a plan every second: MAX_WEBGL_CONTEXTS slots, 20 shown cells: everyone has one after the first plan.
    const cells = Array.from({ length: 20 }, (_, i) => c(`c${i}`, false, true, busy));
    const plan = planWebgl(cells, MAX_WEBGL_CONTEXTS, NOW);
    expect(plan.grant).toHaveLength(20);
    expect(plan.release).toEqual([]);
  });

  it('a short pool converges without thrashing: each cell moves at most once per hold period', () => {
    // 16 slots, 20 shown cells; the busy set rotates every second. Count how often each cell gains or loses a context.
    const state = new Map(Array.from({ length: 20 }, (_, i) => [`c${i}`, { has: false, changedAt: undefined as number | undefined }]));
    const moves = new Map<string, number[]>();
    for (let t = 0; t < 60; t++) {
      const now = NOW + t * 1000;
      const cands = [...state].map(([id, s], i) => c(id, s.has, true, { changedAt: s.changedAt, outputAt: (i + t) % 5 === 0 ? now - 10 : now - 10_000 }));
      const plan = planWebgl(cands, 16, now);
      expect(plan.release.length).toBeLessThanOrEqual(1);
      for (const id of [...plan.release, ...plan.grant]) {
        const s = state.get(id)!;
        if (t > 0) moves.set(id, [...(moves.get(id) ?? []), now]);
        s.has = plan.grant.includes(id);
        s.changedAt = now;
      }
    }
    for (const times of moves.values()) for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(WEBGL_HOLD_MS);
    expect([...state.values()].filter((s) => s.has)).toHaveLength(16);
  });

  it('backs off after lost contexts: 2 s doubling up to a minute', () => {
    expect([1, 2, 3, 6, 10].map(webglBackoff)).toEqual([2000, 4000, 8000, 60_000, 60_000]);
  });

  it('every cell of the largest grid fits, below the limit the app gives WebView2', () => {
    expect(MAX_WEBGL_CONTEXTS).toBeGreaterThanOrEqual(MAX_CELLS);
    expect(MAX_WEBGL_CONTEXTS).toBeLessThan(CHROMIUM_WEBGL_CONTEXTS);
    expect(readFileSync('src-tauri/crates/unimux-app/src/windows.rs', 'utf8')).toContain(`--max-active-webgl-contexts=${CHROMIUM_WEBGL_CONTEXTS} `);
  });

  it('the loss back-off settles at its maximum: only a context that lived WEBGL_HEALTHY_MS starts the count over', () => {
    // A context that is lost again right after every maximal back-off (60 s + xterm's 3 s report delay) keeps the maximum.
    let losses = 0;
    let t = 0;
    for (let i = 0; i < 12; i++) {
      const grantedAt = t;
      t += 3000;
      losses = nextLossCount(losses, grantedAt, t);
      t += webglBackoff(losses);
    }
    expect(losses).toBe(12);
    expect(webglBackoff(losses)).toBe(60_000);
    expect(nextLossCount(losses, t, t + WEBGL_HEALTHY_MS + 1)).toBe(1);
    expect(nextLossCount(losses, t, t + WEBGL_HEALTHY_MS - 1)).toBe(13);
  });

  it('learns the real limit from evictions: held contexts minus the evictions of one burst', () => {
    const limit = new WebglLimit(24);
    // 24 held, Chromium allows 16: creating the last 8 evicted 8 (the lost ones still count as held until xterm gives them up).
    for (let i = 0; i < 8; i++) limit.lost(1000 + i * 10, 24, 1000 + i * 10 - 5);
    expect(limit.limit).toBe(16);
  });

  it('ignores losses long after a grant (a GPU reset) and never goes below the minimum', () => {
    const limit = new WebglLimit(24);
    expect(limit.lost(10_000, 20, 10_000 - WEBGL_EVICT_MS - 1)).toBe(false);
    expect(limit.limit).toBe(24);
    for (let i = 0; i < 10; i++) limit.lost(20_000 + i, 6, 20_000);
    expect(limit.limit).toBe(WEBGL_MIN_LIMIT);
  });

  it('separate bursts start their own count', () => {
    const limit = new WebglLimit(24);
    limit.lost(1000, 20, 999);
    expect(limit.limit).toBe(19);
    limit.lost(1000 + WEBGL_EVICT_MS + 1000, 19, 1000 + WEBGL_EVICT_MS + 999);
    expect(limit.limit).toBe(18);
  });

  it('grows back by one per quiet period, up to the pool size', () => {
    const limit = new WebglLimit(24);
    limit.lost(1000, 23, 999);
    limit.lost(1001, 23, 999);
    expect(limit.limit).toBe(21);
    expect(limit.recover(1000 + WEBGL_RECOVER_MS - 1)).toBe(false);
    expect(limit.recover(1001 + WEBGL_RECOVER_MS)).toBe(true);
    expect(limit.recover(1002 + WEBGL_RECOVER_MS)).toBe(false);
    expect(limit.recover(1001 + 2 * WEBGL_RECOVER_MS)).toBe(true);
    expect(limit.recover(1001 + 3 * WEBGL_RECOVER_MS)).toBe(true);
    expect(limit.limit).toBe(24);
    expect(limit.recover(1001 + 9 * WEBGL_RECOVER_MS)).toBe(false);
  });

  it('released and disposed contexts are lost explicitly first, so Chromium counts what we count', () => {
    const source = readFileSync('src/renderer/src/terminals/TerminalManager.ts', 'utf8');
    expect(source).toMatch(/getExtension\('WEBGL_lose_context'\)\?\.loseContext\(\);/);
    expect(source).toMatch(/loseGl\(webglGl\);\n\s*try \{ webgl\.dispose\(\);/);
    // A disposed terminal loses its context, then the addon goes with the terminal (no DOM renderer for a terminal that goes).
    expect(source).toMatch(/loseGl\(gl\);\n\s*try \{ e\.term\.dispose\(\); \}/);
    expect(source).not.toMatch(/\.webgl\?\.dispose\(\)/);
  });

  it('prewarms the most recently shown parked terminal, never shown ones in their order, none on screen or backing off', () => {
    const all = [c('shown', false, true), c('n1', false, false), c('n2', false, false), c('back', false, false, { shownAt: 9, blockedUntil: NOW + 1 }), c('held', true, false, { shownAt: 8 })];
    expect(pickPrewarm(all, 64, NOW)).toBe('n1');
    expect(pickPrewarm([...all, c('recent', false, false, { shownAt: 5 })], 64, NOW)).toBe('recent');
    expect(pickPrewarm([c('shown', false, true)], 64, NOW)).toBeNull();
  });

  it('prewarming leaves room for a full grid, and does nothing when the limit was lowered', () => {
    const held = (n: number) => Array.from({ length: n }, (_, i) => c(`h${i}`, true, i < 4));
    expect(WEBGL_PREWARM_RESERVE).toBeGreaterThanOrEqual(MAX_CELLS);
    expect(pickPrewarm([...held(MAX_WEBGL_CONTEXTS - WEBGL_PREWARM_RESERVE - 1), c('p', false, false)], MAX_WEBGL_CONTEXTS, NOW)).toBe('p');
    expect(pickPrewarm([...held(MAX_WEBGL_CONTEXTS - WEBGL_PREWARM_RESERVE), c('p', false, false)], MAX_WEBGL_CONTEXTS, NOW)).toBeNull();
    expect(pickPrewarm([...held(4), c('p', false, false)], 16, NOW)).toBeNull();
  });

  it('Chromium keeps the 1.1.4 reserve; WebKit, whose pool is smaller than a full grid, keeps half of it free instead', () => {
    const held = (n: number) => Array.from({ length: n }, (_, i) => c(`h${i}`, true, i < 2));
    expect(webglPrewarmReserve('chromium', MAX_WEBGL_CONTEXTS)).toBe(WEBGL_PREWARM_RESERVE);
    expect(webglPrewarmReserve('chromium', 16)).toBe(WEBGL_PREWARM_RESERVE);
    const limit = maxWebglContexts('webkit');
    expect(limit).toBe(MAX_WEBGL_CONTEXTS_WEBKIT);
    const reserve = webglPrewarmReserve('webkit', limit);
    expect(reserve).toBe(6);
    // With the fixed reserve WebKit would never prewarm (12 - 20 < 0).
    expect(pickPrewarm([c('p', false, false)], limit, NOW)).toBeNull();
    expect(pickPrewarm([c('p', false, false)], limit, NOW, reserve)).toBe('p');
    expect(pickPrewarm([...held(limit - reserve - 1), c('p', false, false)], limit, NOW, reserve)).toBe('p');
    expect(pickPrewarm([...held(limit - reserve), c('p', false, false)], limit, NOW, reserve)).toBeNull();
    // A pool lowered by evictions keeps prewarming, with half of it free.
    expect(webglPrewarmReserve('webkit', 8)).toBe(4);
    expect(pickPrewarm([...held(3), c('p', false, false)], 8, NOW, webglPrewarmReserve('webkit', 8))).toBe('p');
    expect(pickPrewarm([...held(4), c('p', false, false)], 8, NOW, webglPrewarmReserve('webkit', 8))).toBeNull();
  });

  it('TerminalManager prewarms with the reserve of its engine', () => {
    const source = readFileSync('src/renderer/src/terminals/TerminalManager.ts', 'utf8');
    expect(source).toMatch(/pickPrewarm\(this\.webglCandidates\(\), limit, now, webglPrewarmReserve\(webviewEngine\(\), limit\)\)/);
    expect(source.match(/pickPrewarm\(/g)).toHaveLength(1);
  });
});
