import { describe, expect, it, vi } from 'vitest';
import { allCellIds, cellLabel, namesList, shouldConfirmClose, workingAgents } from '../src/shared/agentWork';
import { alertNotice, createAlertBurst, groupAlerts, type AlertItem } from '../src/shared/alertBurst';
import { translate } from '../src/shared/i18n';
import { defaultState, normalizeState, updateSettings } from '../src/shared/state';
import { createTurnRefresh, refreshTargetMatches } from '../src/shared/turnRefresh';
import { createQuitConfirm, sessionEndingNow } from '../src/main/quitConfirm';
import type { AppState } from '../src/shared/types';

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params);

/** A fake clock with timers for the debounce and burst logic. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function stateWithCells(): AppState {
  const s = defaultState();
  s.profiles = [
    { id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#000' },
    { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#000' },
    { id: 'shell', name: 'Shell', cli: 'shell', args: '', color: '#000' },
  ];
  s.projects = [{
    id: 'p1', name: 'Project X', path: 'C:/x', activeTabId: 't1', archive: [],
    tabs: [{
      id: 't1', name: 'Main', layout: { cols: 2, rows: 2 } as never,
      cells: [
        { id: 'a', profileId: 'claude', name: 'Reviewer' },
        { id: 'b', profileId: 'codex', session: { cli: 'codex', id: 's-b' } },
        { id: 'c', profileId: 'claude' },
        { id: 'd', profileId: 'shell', name: 'Build' },
      ],
    }],
  } as never];
  return s;
}

describe('cell labels', () => {
  it('uses the cell name, else the conversation title, else the profile name', () => {
    expect(cellLabel({ name: 'Reviewer', session: { cli: 'claude', id: 's1' } }, { s1: 'Fix login' }, 'Claude Code')).toBe('Reviewer');
    expect(cellLabel({ session: { cli: 'claude', id: 's1' } }, { s1: 'Fix login' }, 'Claude Code')).toBe('Fix login');
    expect(cellLabel({ session: { cli: 'claude', id: 's2' } }, { s1: 'Fix login' }, 'Claude Code')).toBe('Claude Code');
    expect(cellLabel({ name: '  ' }, {}, 'Codex')).toBe('Codex');
  });

  it('lists the first names and counts the rest', () => {
    expect(namesList(['a', 'b'])).toBe('a, b');
    expect(namesList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2');
  });
});

describe('working agents', () => {
  it('counts only Claude and Codex cells whose status is working', () => {
    const s = stateWithCells();
    const statuses = { a: 'working', b: 'working', c: 'waiting', d: 'working' } as const;
    expect(workingAgents(s, allCellIds(s), statuses, { 's-b': 'Refactor' })).toEqual([
      { cellId: 'a', label: 'Reviewer' }, { cellId: 'b', label: 'Refactor' },
    ]);
    // Only the cells asked about.
    expect(workingAgents(s, ['b', 'c'], statuses, {}).map((w) => w.cellId)).toEqual(['b']);
    expect(workingAgents(s, allCellIds(s), { a: 'idle', c: 'exited' }, {})).toEqual([]);
  });

  it('asks only while the setting is on and someone works', () => {
    const s = stateWithCells();
    const working = [{ cellId: 'a', label: 'Reviewer' }];
    expect(shouldConfirmClose(s, working)).toBe(true);
    expect(shouldConfirmClose(s, [])).toBe(false);
    expect(shouldConfirmClose(updateSettings(s, { confirmCloseWorking: false }), working)).toBe(false);
  });

  it('keeps the "do not ask again" setting through a save and defaults to asking', () => {
    const fresh = defaultState();
    expect(fresh.settings.confirmCloseWorking).toBe(true);
    const off = updateSettings(fresh, { confirmCloseWorking: false });
    expect(normalizeState(JSON.parse(JSON.stringify(off)))!.settings.confirmCloseWorking).toBe(false);
    const raw = JSON.parse(JSON.stringify(fresh));
    raw.settings.confirmCloseWorking = 'no';
    expect(normalizeState(raw)!.settings.confirmCloseWorking).toBe(true);
    delete raw.settings.confirmCloseWorking;
    expect(normalizeState(raw)!.settings.confirmCloseWorking).toBe(true);
  });
});

describe('agent notifications', () => {
  const item = (cellId: string, label: string, extra: Partial<AlertItem> = {}): AlertItem => ({
    event: 'done', cellId, label, projectId: 'p1', projectName: 'Project X', tabId: 't1', tabName: 'Main', ...extra,
  });

  it('names the agent and the project and tab, not a slot number', () => {
    expect(alertNotice(en, [item('a', 'Reviewer')])).toEqual({ title: 'Project X · Main', body: 'Reviewer has finished', cellId: 'a' });
    expect(alertNotice(en, [item('a', 'Reviewer', { event: 'attention' })]).body).toBe('Reviewer needs you');
  });

  it('combines a burst into one notification that focuses the first cell', () => {
    const notice = alertNotice(en, [item('a', 'a'), item('b', 'b', { tabId: 't2', tabName: 'Other' }), item('c', 'c')]);
    expect(notice).toEqual({ title: 'Project X', body: '3 agents finished in Project X: a, b, c', cellId: 'a' });
    const across = alertNotice(en, [item('a', 'a'), item('z', 'z', { projectId: 'p2', projectName: 'Y' })]);
    expect(across).toEqual({ title: 'unimux', body: '2 agents finished: a, z', cellId: 'a' });
  });

  it('groups by event and counts each cell once', () => {
    const groups = groupAlerts([item('a', 'a'), item('b', 'b', { event: 'attention' }), item('c', 'c'), item('a', 'a')]);
    expect(groups.map((g) => g.map((i) => `${i.event}:${i.cellId}`))).toEqual([['attention:b'], ['done:c', 'done:a']]);
  });

  it('collects the alerts of about a second into one burst', () => {
    const clock = fakeTimers();
    const emitted: string[][] = [];
    const burst = createAlertBurst<string>((items) => emitted.push(items), clock, 1000);
    burst.push('a');
    clock.advance(400);
    burst.push('b');
    clock.advance(500);
    burst.push('c');
    expect(emitted).toEqual([]);
    clock.advance(100);
    expect(emitted).toEqual([['a', 'b', 'c']]);
    burst.push('d');
    clock.advance(1000);
    expect(emitted).toEqual([['a', 'b', 'c'], ['d']]);
    expect(clock.pending()).toBe(0);
  });
});

describe('refresh after agent turns', () => {
  it('coalesces turn ends per project and worktree into one trailing refresh', () => {
    const clock = fakeTimers();
    const fire = vi.fn();
    const refresh = createTurnRefresh(fire, clock, 1500, 6000);
    refresh.note({ projectId: 'p1' });
    clock.advance(500);
    refresh.note({ projectId: 'p1' });
    refresh.note({ projectId: 'p2' });
    refresh.note({ projectId: 'p1', worktree: 'C:/wt' });
    clock.advance(1499);
    expect(fire).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fire.mock.calls.map((c) => c[0])).toEqual([{ projectId: 'p1' }, { projectId: 'p2' }, { projectId: 'p1', worktree: 'C:/wt' }]);
    clock.advance(10000);
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it('still refreshes within the longest wait while agents keep finishing', () => {
    const clock = fakeTimers();
    const fire = vi.fn();
    const refresh = createTurnRefresh(fire, clock, 1500, 6000);
    for (let i = 0; i < 10; i++) { refresh.note({ projectId: 'p1' }); clock.advance(1000); }
    // Turn ends every second: one refresh at 6 s, then the rest wait for their own trailing delay.
    expect(fire).toHaveBeenCalledTimes(1);
    clock.advance(1500);
    expect(fire).toHaveBeenCalledTimes(2);
    refresh.note({ projectId: 'p1' });
    refresh.dispose();
    clock.advance(5000);
    expect(fire).toHaveBeenCalledTimes(2);
  });
});

describe('quit confirmation', () => {
  function setup(exempt = false) {
    const clock = fakeTimers();
    const ask = vi.fn();
    const quit = vi.fn();
    const confirm = createQuitConfirm({ exempt: () => exempt, ask, quit, setTimer: clock.setTimer, clearTimer: clock.clearTimer }, 3000, 120000);
    return { clock, ask, quit, confirm };
  }

  it('does not hold a quit when no agent works', () => {
    const { confirm, ask } = setup();
    expect(confirm.hold()).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('quits or stays as the user chose', () => {
    const { confirm, ask, quit, clock } = setup();
    confirm.setGuard(true);
    expect(confirm.hold()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    confirm.answer('asking');
    clock.advance(60000);
    expect(quit).not.toHaveBeenCalled();
    confirm.answer('cancel');
    clock.advance(200000);
    expect(quit).not.toHaveBeenCalled();
    expect(confirm.hold()).toBe(true);
    confirm.answer('asking');
    confirm.answer('quit');
    expect(quit).toHaveBeenCalledTimes(1);
    expect(confirm.hold()).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it('a second Close while asking asks again and quits when the renderer stays silent', () => {
    const { confirm, ask, quit, clock } = setup();
    confirm.setGuard(true);
    confirm.hold();
    confirm.answer('asking');
    clock.advance(10000);
    // The dialog got lost: the renderer no longer acknowledges the repeated question.
    expect(confirm.hold()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    clock.advance(2999);
    expect(quit).not.toHaveBeenCalled();
    clock.advance(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a repeated Close that is acknowledged keeps waiting for the answer', () => {
    const { confirm, quit, clock } = setup();
    confirm.setGuard(true);
    confirm.hold();
    confirm.answer('asking');
    confirm.hold();
    confirm.answer('asking');
    clock.advance(5000);
    expect(quit).not.toHaveBeenCalled();
    confirm.answer('cancel');
    expect(quit).not.toHaveBeenCalled();
  });

  it('an acknowledged question holds the quit at most two minutes', () => {
    const { confirm, quit, clock } = setup();
    confirm.setGuard(true);
    confirm.hold();
    confirm.answer('asking');
    clock.advance(60000);
    confirm.hold();
    confirm.answer('asking');
    // The bound is not extended by the repeated question.
    clock.advance(59999);
    expect(quit).not.toHaveBeenCalled();
    clock.advance(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('a session end releases a held quit at once', () => {
    const { confirm, quit } = setup();
    confirm.setGuard(true);
    confirm.hold();
    confirm.answer('asking');
    confirm.release();
    expect(quit).toHaveBeenCalledTimes(1);
    const idle = setup();
    idle.confirm.release();
    expect(idle.quit).not.toHaveBeenCalled();
  });

  it('treats a session end as exempt for about a minute only', () => {
    expect(sessionEndingNow(undefined, 1000)).toBe(false);
    expect(sessionEndingNow(1000, 1000)).toBe(true);
    expect(sessionEndingNow(1000, 60999)).toBe(true);
    expect(sessionEndingNow(1000, 61000)).toBe(false);
  });

  it('never holds a session end or update and does not wait for a silent renderer', () => {
    const exempt = setup(true);
    exempt.confirm.setGuard(true);
    expect(exempt.confirm.hold()).toBe(false);
    const silent = setup();
    silent.confirm.setGuard(true);
    expect(silent.confirm.hold()).toBe(true);
    silent.clock.advance(3000);
    expect(silent.quit).toHaveBeenCalledTimes(1);
    const reloaded = setup();
    reloaded.confirm.setGuard(true);
    reloaded.confirm.rendererGone();
    expect(reloaded.confirm.hold()).toBe(false);
  });
});

describe('which views a turn refreshes', () => {
  it('refreshes the project view for project turns and a worktree view only for its own worktree', () => {
    expect(refreshTargetMatches({ projectId: 'p1' }, 'p1', undefined, true)).toBe(true);
    expect(refreshTargetMatches({ projectId: 'p1' }, 'p2', undefined, true)).toBe(false);
    expect(refreshTargetMatches({ projectId: 'p1', worktree: 'C:\\x\\wt' }, 'p1', undefined, true)).toBe(false);
    expect(refreshTargetMatches({ projectId: 'p1' }, 'p1', 'C:/x/wt', true)).toBe(false);
    expect(refreshTargetMatches({ projectId: 'p1', worktree: 'C:\\X\\WT\\' }, 'p1', 'c:/x/wt', true)).toBe(true);
    expect(refreshTargetMatches({ projectId: 'p1', worktree: '/x/WT' }, 'p1', '/x/wt', false)).toBe(false);
    expect(refreshTargetMatches({ projectId: 'p1', worktree: '/x/wt-2' }, 'p1', '/x/wt', false)).toBe(false);
  });
});
