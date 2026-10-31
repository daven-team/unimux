import { inflateSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { badgeLabel, isCellStatus, isStatusReason, taskbarCounts, taskbarView, type CellRuntime, type TaskbarCell } from '../src/shared/taskbarState';
import { createTaskbar, TASKBAR_DEBOUNCE_MS } from '../src/main/taskbar';
import { BADGE_SCALES, badgePngs, encodePng, renderBadge } from '../src/main/badgeImage';

const cells: TaskbarCell[] = [
  { id: 'a', agent: true }, { id: 'b', agent: true }, { id: 'c', agent: true, muted: true }, { id: 'sh', agent: false }, { id: 'gone', agent: true },
];

describe('taskbarCounts', () => {
  it('counts running agent cells: attention without muted ones, working with them; shells and dead cells never', () => {
    const runtime = new Map<string, CellRuntime>([
      ['a', { status: 'waiting', reason: 'attention' }], ['b', { status: 'working' }], ['c', { status: 'waiting', reason: 'attention' }],
      ['sh', { status: 'working' }], ['gone', { status: 'waiting', reason: 'attention' }],
    ]);
    const alive = new Set(['a', 'b', 'c', 'sh']);
    expect(taskbarCounts(cells, runtime, alive)).toEqual({ attention: 1, working: 1 });
    runtime.set('c', { status: 'working' });
    expect(taskbarCounts(cells, runtime, alive)).toEqual({ attention: 1, working: 2 });
  });

  it('a finished turn or an error is not "waiting for you"', () => {
    const runtime = new Map<string, CellRuntime>([['a', { status: 'waiting', reason: 'done' }], ['b', { status: 'waiting', reason: 'error' }]]);
    expect(taskbarCounts(cells, runtime, new Set(['a', 'b']))).toEqual({ attention: 0, working: 0 });
  });
});

describe('taskbarView', () => {
  const on = { taskbarBadge: true };
  it('maps the counts per platform and setting', () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(3)).toBe('3');
    expect(badgeLabel(10)).toBe('9+');
    expect(taskbarView({ attention: 2, working: 1 }, on, 'win32')).toEqual({ overlay: '2', dock: '' });
    expect(taskbarView({ attention: 12, working: 0 }, on, 'win32')).toEqual({ overlay: '9+', dock: '' });
    expect(taskbarView({ attention: 2, working: 1 }, { taskbarBadge: false }, 'win32')).toEqual({ overlay: null, dock: '' });
    expect(taskbarView({ attention: 12, working: 1 }, on, 'darwin')).toEqual({ overlay: null, dock: '12' });
    expect(taskbarView({ attention: 2, working: 1 }, { taskbarBadge: false }, 'darwin').dock).toBe('');
    expect(taskbarView({ attention: 2, working: 1 }, on, 'linux')).toEqual({ overlay: null, dock: '' });
  });

  it('validates reported statuses', () => {
    expect(isCellStatus('waiting')).toBe(true);
    expect(isCellStatus('busy')).toBe(false);
    expect(isStatusReason('attention')).toBe(true);
    expect(isStatusReason(undefined)).toBe(false);
  });
});

function harness(platform = 'win32') {
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const alive = new Set(['a', 'b']);
  const settings = { taskbarBadge: true };
  const cellList: TaskbarCell[] = [{ id: 'a', agent: true }, { id: 'b', agent: true }];
  let drawn = 0;
  const taskbar = createTaskbar<string>({
    platform,
    cells: () => cellList,
    alive: () => alive,
    settings: () => settings,
    setOverlay: (image, description) => calls.push(`overlay:${image}:${description}`),
    setDockBadge: (text) => calls.push(`dock:${text}`),
    image: (label) => { drawn++; return `img${label}`; },
    describe: (count) => `${count} waiting`,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const tick = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return { taskbar, calls, timers, tick, alive, settings, cellList, drawn: () => drawn };
}

describe('createTaskbar', () => {
  it('debounces a burst of statuses into one update and calls the OS only for what changed', () => {
    const h = harness();
    h.taskbar.status('a', { status: 'working' });
    h.taskbar.status('b', { status: 'working' });
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(TASKBAR_DEBOUNCE_MS);
    expect(h.calls).toEqual([]);
    h.tick();
    expect(h.calls).toEqual(['overlay:img1:1 waiting']);
    // The same status again schedules nothing.
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    expect(h.timers).toHaveLength(0);
    // A change that leaves the view as it is calls nothing.
    h.taskbar.status('b', { status: 'waiting', reason: 'done' });
    h.taskbar.status('b', { status: 'working' });
    h.tick();
    expect(h.calls).toHaveLength(1);
  });

  it('draws each badge once and clears everything when the cells go', () => {
    const h = harness();
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    h.tick();
    h.taskbar.status('a', { status: 'working' });
    h.tick();
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    h.tick();
    expect(h.drawn()).toBe(1);
    h.calls.length = 0;
    h.taskbar.forget('a');
    h.tick();
    expect(h.calls).toEqual(['overlay:null:']);
  });

  it('forgets the statuses of a reloaded window, follows mutes and settings, and reapplies on demand', () => {
    const h = harness();
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' }, 'w1');
    h.taskbar.status('b', { status: 'working' }, 'main');
    h.tick();
    h.calls.length = 0;
    h.taskbar.forgetWindow('w1');
    h.tick();
    expect(h.calls).toEqual(['overlay:null:']);
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' }, 'w1');
    h.tick();
    h.calls.length = 0;
    h.cellList[0] = { id: 'a', agent: true, muted: true };
    h.taskbar.invalidate();
    h.tick();
    expect(h.calls).toEqual(['overlay:null:']);
    h.calls.length = 0;
    h.taskbar.reapply();
    expect(h.calls).toEqual(['overlay:null:', 'dock:']);
  });

  it('macOS: the Dock badge only', () => {
    const h = harness('darwin');
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    h.taskbar.status('b', { status: 'waiting', reason: 'attention' });
    h.tick();
    expect(h.calls).toEqual(['dock:2']);
    expect(h.taskbar.view()).toEqual({ overlay: null, dock: '2' });
  });

  it('stops after dispose', () => {
    const h = harness();
    h.taskbar.dispose();
    h.taskbar.status('a', { status: 'working' });
    h.tick();
    expect(h.calls).toEqual([]);
  });
});

describe('badge image', () => {
  it('draws a red disc with white ink, transparent corners, at the exact pixel size of every scale', () => {
    for (const label of ['1', '7', '9+']) {
      for (const px of [16, 20, 24, 32]) {
        const img = renderBadge(label, px);
        expect(img.length).toBe(px * px * 4);
        expect(img[3]).toBe(0); // corner
        let white = 0;
        let red = 0;
        for (let i = 0; i < img.length; i += 4) {
          if (img[i + 3] < 255) continue;
          if (img[i] > 240 && img[i + 1] > 240 && img[i + 2] > 240) white++;
          else if (img[i] > 200 && img[i + 1] < 80 && img[i + 2] < 80) red++;
        }
        expect(red).toBeGreaterThan(px * px * 0.2);
        expect(white).toBeGreaterThan(px * 0.5);
      }
    }
  });

  it('encodes a valid PNG for every display scale', () => {
    const pngs = badgePngs('3');
    expect(pngs.map((p) => p.scaleFactor)).toEqual([...BADGE_SCALES]);
    expect(pngs.map((p) => p.size)).toEqual([16, 20, 24, 32]);
    for (const { png, size } of pngs) {
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    // The IDAT payload inflates back to the pixels (one filter byte per row).
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const png = encodePng(rgba, 2, 1);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    expect([...inflateSync(png.subarray(41, 41 + idatLength))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
