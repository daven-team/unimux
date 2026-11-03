import { describe, expect, it } from 'vitest';
import { isCellStatus, isStatusReason, taskbarCounts, taskbarView, type CellRuntime, type TaskbarCell } from '../src/shared/taskbarState';
import { createTaskbar, TASKBAR_DEBOUNCE_MS } from '../src/main/taskbar';

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
  it('only the macOS Dock gets a badge (1.1.2: no Windows overlay)', () => {
    expect(taskbarView({ attention: 2, working: 1 }, on, 'win32')).toEqual({ dock: '' });
    expect(taskbarView({ attention: 12, working: 1 }, on, 'darwin')).toEqual({ dock: '12' });
    expect(taskbarView({ attention: 2, working: 1 }, { taskbarBadge: false }, 'darwin')).toEqual({ dock: '' });
    expect(taskbarView({ attention: 2, working: 1 }, on, 'linux')).toEqual({ dock: '' });
  });

  it('validates reported statuses', () => {
    expect(isCellStatus('waiting')).toBe(true);
    expect(isCellStatus('busy')).toBe(false);
    expect(isStatusReason('attention')).toBe(true);
    expect(isStatusReason(undefined)).toBe(false);
  });
});

function harness(platform = 'darwin') {
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const alive = new Set(['a', 'b']);
  const settings = { taskbarBadge: true };
  const cellList: TaskbarCell[] = [{ id: 'a', agent: true }, { id: 'b', agent: true }];
  const taskbar = createTaskbar({
    platform,
    cells: () => cellList,
    alive: () => alive,
    settings: () => settings,
    setDockBadge: (text) => calls.push(`dock:${text}`),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const tick = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return { taskbar, calls, timers, tick, alive, settings, cellList };
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
    expect(h.calls).toEqual(['dock:1']);
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    expect(h.timers).toHaveLength(0);
    h.taskbar.status('b', { status: 'waiting', reason: 'done' });
    h.taskbar.status('b', { status: 'working' });
    h.tick();
    expect(h.calls).toHaveLength(1);
  });

  it('forgets the statuses of a reloaded window, follows mutes and settings, and reapplies on demand', () => {
    const h = harness();
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' }, 'w1');
    h.taskbar.status('b', { status: 'waiting', reason: 'attention' }, 'main');
    h.tick();
    expect(h.calls).toEqual(['dock:2']);
    h.calls.length = 0;
    h.taskbar.forgetWindow('w1');
    h.tick();
    expect(h.calls).toEqual(['dock:1']);
    h.calls.length = 0;
    h.cellList[1] = { id: 'b', agent: true, muted: true };
    h.taskbar.invalidate();
    h.tick();
    expect(h.calls).toEqual(['dock:']);
    h.calls.length = 0;
    h.taskbar.reapply();
    expect(h.calls).toEqual(['dock:']);
  });

  it('Windows: never touches the OS', () => {
    const h = harness('win32');
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    h.tick();
    expect(h.calls).toEqual([]);
    expect(h.taskbar.view()).toEqual({ dock: '' });
  });

  it('stops after dispose', () => {
    const h = harness();
    h.taskbar.dispose();
    h.taskbar.status('a', { status: 'waiting', reason: 'attention' });
    h.tick();
    expect(h.calls).toEqual([]);
  });
});
