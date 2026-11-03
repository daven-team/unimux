import { describe, expect, it } from 'vitest';
import { cleanWork, sumWork } from '../src/shared/detached';
import { translate } from '../src/shared/i18n';
import { defaultState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';
import {
  ASK_GRACE_MS, collectUpdateWork, hasUpdateWork, NO_UPDATE_WORK, pendingText, SETTLE_MS, stepUpdateWait, updateBlockers, updateWorkGroups,
  WAIT_MAX_MS, type UpdateWaitState, type UpdateWork, type WorkFacts,
} from '../src/shared/updateWait';
import type { CellStatus } from '../src/shared/status';
import type { WaitMark } from '../src/shared/waiting';

/** Two projects: one grid in the main window, one grid that lives in a detached window (its statuses are mirrored to main). */
function state(): AppState {
  const s = defaultState();
  const layout = { cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 1, row: 0, colSpan: 1, rowSpan: 1 }] };
  s.projects = [
    { id: 'p1', name: 'One', path: 'C:/p1', color: '#fff', archive: [], activeTabId: 't1', tabs: [{ id: 't1', name: 'Main', layout, cells: [
      { id: 'a', profileId: 'claude', name: 'Reviewer' },
      { id: 'b', profileId: 'codex', session: { cli: 'codex', id: 's-b' } },
    ] }] },
    { id: 'p2', name: 'Two', path: 'C:/p2', color: '#fff', archive: [], activeTabId: 't2', tabs: [{ id: 't2', name: 'Away', layout, cells: [
      { id: 'c', profileId: 'claude', name: 'Writer', promptQueue: { items: [{ id: 'q1', text: 'next' }, { id: 'q2', text: 'then' }] } },
      { id: 'd', profileId: 'shell', name: 'Build' },
    ] }] },
  ] as never;
  s.detachedWindows = [{ id: 'w1', target: { kind: 'grid', projectId: 'p2', tabId: 't2' } }] as never;
  return s;
}

const facts = (patch: Partial<WorkFacts> = {}): WorkFacts => ({ state: state(), statuses: {}, sessionTitles: {}, waits: {}, ...patch });
const ask = (since: number): WaitMark => ({ kind: 'permission', since });

describe('what an update would interrupt', () => {
  it('finds nothing when every agent is idle and nothing is open', () => {
    const s = state();
    s.projects[1].tabs[0].cells[0].promptQueue = undefined;
    const work = collectUpdateWork({ ...facts(), state: s });
    expect(work).toEqual(NO_UPDATE_WORK);
    expect(hasUpdateWork(work)).toBe(false);
  });

  it('lists working agents of every window, agents waiting for an answer, queues and MCP tasks with the cell names', () => {
    const s = state();
    s.automation.tasks = [
      { id: 't1', projectId: 'p2', cellId: 'c', title: 'Write docs', prompt: 'x', status: 'in_progress', delivery: 'native', createdAt: 0, updatedAt: 0 },
      { id: 't2', projectId: 'p1', cellId: 'b', title: 'Idle task', prompt: 'x', status: 'in_progress', delivery: 'native', createdAt: 0, updatedAt: 0 },
    ];
    const statuses: Record<string, CellStatus> = { a: 'waiting', b: 'idle', c: 'working', d: 'working' };
    const work = collectUpdateWork({ ...facts(), state: s, statuses, sessionTitles: { 's-b': 'Refactor' }, waits: { a: ask(100), b: { kind: 'done', since: 5 } } });
    // The detached grid's Writer works; the shell cell never counts; a finished turn ("done") is not a question.
    expect(work.working).toEqual([{ cellId: 'c', label: 'Writer' }]);
    expect(work.asking).toEqual([{ cellId: 'a', label: 'Reviewer', since: 100 }]);
    expect(work.queued).toEqual([{ cellId: 'c', label: 'Writer', count: 2, paused: false }]);
    // A task counts only while its agent works or waits for the user.
    expect(work.tasks).toEqual([{ title: 'Write docs', label: 'Writer' }]);
    expect(hasUpdateWork(work)).toBe(true);
  });

  it('counts unsaved files, saves, transfers and database work of this window and the detached windows', () => {
    const away = sumWork([cleanWork({ tx: 1, staged: 0, redis: 0, files: 2, saving: 1 })!, cleanWork({ tx: 0, staged: 1, redis: 0 })!]);
    const work = collectUpdateWork(facts({ unsaved: ['notes.md'], saving: 0, away, local: { tx: 1, staged: 0, redis: 3 }, transfers: 2, swap: false, login: true }));
    expect(work).toMatchObject({ unsaved: ['notes.md'], unsavedAway: 2, saving: 1, transfers: 2, tx: 2, staged: 1, redis: 3, login: true, swap: false });
  });

  it('asks only about things worth knowing: a paused queue alone does not ask', () => {
    expect(hasUpdateWork({ ...NO_UPDATE_WORK, queued: [{ cellId: 'c', label: 'Writer', count: 1, paused: true }] })).toBe(false);
    expect(hasUpdateWork({ ...NO_UPDATE_WORK, unsaved: ['a.ts'] })).toBe(true);
    expect(hasUpdateWork({ ...NO_UPDATE_WORK, staged: 1 })).toBe(true);
    expect(hasUpdateWork({ ...NO_UPDATE_WORK, swap: true })).toBe(true);
  });

  it('keeps the detached windows’ old reports and the editor counts apart', () => {
    expect(cleanWork({ tx: 0, staged: 0, redis: 0, files: 0 })).toBeNull();
    expect(cleanWork({ tx: 0, staged: 0, redis: 0, files: 3 })).toEqual({ tx: 0, staged: 0, redis: 0, files: 3 });
    expect(cleanWork({ tx: 1, staged: 0, redis: 0, files: -1, saving: 'x' })).toEqual({ tx: 1, staged: 0, redis: 0 });
  });
});

describe('the dialog groups', () => {
  const work: UpdateWork = {
    ...NO_UPDATE_WORK,
    working: [{ cellId: 'a', label: 'Reviewer' }, { cellId: 'b', label: 'Refactor' }],
    asking: [{ cellId: 'c', label: 'Writer', since: 0 }],
    queued: [{ cellId: 'a', label: 'Reviewer', count: 2, paused: false }, { cellId: 'e', label: 'Docs', count: 1, paused: true }],
    unsaved: ['index.ts'], unsavedAway: 1, transfers: 1, tx: 1,
  };

  it('groups agents first, then files, transfers and databases, each saying what happens', () => {
    const groups = updateWorkGroups(work);
    expect(groups.map((g) => g.key)).toEqual(['working', 'asking', 'queued', 'paused', 'unsaved', 'transfers', 'tx']);
    expect(groups[0]).toMatchObject({ names: ['Reviewer', 'Refactor'], tone: 'wait', title: { params: { count: 2 } } });
    expect(groups[2].names).toEqual(['Reviewer (2)']);
    expect(groups[3].tone).toBe('kept');
    expect(groups[4]).toMatchObject({ names: ['index.ts', '+1'], tone: 'kept', title: { params: { count: 2 } } });
    expect(translate('en', groups[1].note.key, groups[1].note.params)).toContain('3 min');
    for (const g of groups) {
      expect(translate('en', g.title.key, g.title.params).length).toBeGreaterThan(0);
      expect(translate('de', g.note.key, g.note.params).length).toBeGreaterThan(0);
    }
  });
});

describe('update when they finish', () => {
  const working: UpdateWork = { ...NO_UPDATE_WORK, working: [{ cellId: 'a', label: 'Reviewer' }] };
  const idle = NO_UPDATE_WORK;
  const run = (start: UpdateWaitState, steps: Array<[number, UpdateWork, { downloading?: boolean }?]>) => {
    let st = start;
    const actions: string[] = [];
    for (const [now, work, opts] of steps) {
      const step = stepUpdateWait(st, work, now, opts);
      st = step.state;
      actions.push(step.action);
    }
    return actions;
  };

  it('waits while an agent works and installs once nothing ran for the settle time', () => {
    expect(run({ startedAt: 0 }, [
      [0, working], [1000, working], [2000, idle], [2000 + SETTLE_MS - 1, idle], [2000 + SETTLE_MS, idle],
    ])).toEqual(['wait', 'wait', 'wait', 'wait', 'install']);
  });

  it('starts over when a cell starts working again (a new prompt, the next queued one) during the quiet time', () => {
    expect(run({ startedAt: 0 }, [
      [0, idle], [SETTLE_MS - 500, working], [SETTLE_MS + 100, idle], [SETTLE_MS * 2, idle], [SETTLE_MS * 2 + 100, idle],
    ])).toEqual(['wait', 'wait', 'wait', 'wait', 'install']);
  });

  it('waits for an active queue but never for a paused one', () => {
    const queued: UpdateWork = { ...NO_UPDATE_WORK, queued: [{ cellId: 'a', label: 'Reviewer', count: 1, paused: false }] };
    expect(updateBlockers(queued, 0, 0).map((b) => b.kind)).toEqual(['queued']);
    expect(updateBlockers({ ...NO_UPDATE_WORK, queued: [{ cellId: 'a', label: 'Reviewer', count: 1, paused: true }] }, 0, 0)).toEqual([]);
  });

  it('holds for an agent that waits for the user only during its grace time', () => {
    // Asking before the wait started: the grace time counts from the start of the wait.
    const asking: UpdateWork = { ...NO_UPDATE_WORK, asking: [{ cellId: 'a', label: 'Reviewer', since: -60_000 }] };
    expect(updateBlockers(asking, 0, ASK_GRACE_MS - 1).map((b) => b.kind)).toEqual(['asking']);
    expect(updateBlockers(asking, 0, ASK_GRACE_MS)).toEqual([]);
    // A working agent that starts asking later gets its own grace time from its question.
    const later: UpdateWork = { ...NO_UPDATE_WORK, asking: [{ cellId: 'a', label: 'Reviewer', since: 10 * 60_000 }] };
    expect(updateBlockers(later, 0, 10 * 60_000 + ASK_GRACE_MS - 1)).toHaveLength(1);
    expect(run({ startedAt: 0 }, [
      [0, asking], [ASK_GRACE_MS, asking], [ASK_GRACE_MS + SETTLE_MS, asking],
    ])).toEqual(['wait', 'wait', 'install']);
  });

  it('never installs files, staged edits or MCP tasks away, but waits for transfers, transactions, saves and logins', () => {
    const kept: UpdateWork = { ...NO_UPDATE_WORK, unsaved: ['a.ts'], unsavedAway: 2, staged: 1, tasks: [{ title: 'x', label: 'y' }] };
    expect(updateBlockers(kept, 0, 0)).toEqual([]);
    const held: UpdateWork = { ...NO_UPDATE_WORK, transfers: 1, tx: 1, redis: 1, saving: 1, swap: true, login: true };
    expect(updateBlockers(held, 0, 0).map((b) => b.kind)).toEqual(['saving', 'transfers', 'tx', 'redis', 'swap', 'login']);
  });

  it('waits for a running download before handing over', () => {
    expect(run({ startedAt: 0 }, [
      [0, idle, { downloading: true }], [SETTLE_MS * 2, idle, { downloading: true }], [SETTLE_MS * 2 + 1, idle], [SETTLE_MS * 3 + 1, idle],
    ])).toEqual(['wait', 'wait', 'wait', 'install']);
    expect(pendingText([{ kind: 'download' }]).key).toBe('Aktualizacja po pobraniu');
  });

  it('gives up after the longest wait instead of waiting forever', () => {
    expect(stepUpdateWait({ startedAt: 0 }, working, WAIT_MAX_MS - 1).action).toBe('wait');
    expect(stepUpdateWait({ startedAt: 0 }, working, WAIT_MAX_MS).action).toBe('expire');
  });

  it('counts the agents it waits for in the status bar text (a cell with a queue and a turn counts once)', () => {
    const blockers = updateBlockers({
      ...NO_UPDATE_WORK, working: [{ cellId: 'a', label: 'A' }, { cellId: 'b', label: 'B' }], queued: [{ cellId: 'a', label: 'A', count: 3, paused: false }], transfers: 1,
    }, 0, 0);
    expect(pendingText(blockers)).toEqual({ key: 'Aktualizacja po zakończeniu pracy agentów ({count})', params: { count: 2 } });
    expect(translate('en', 'Aktualizacja po zakończeniu pracy agentów ({count})', { count: 2 })).toBe('Update after the agents finish (2)');
    expect(pendingText(updateBlockers({ ...NO_UPDATE_WORK, transfers: 2 }, 0, 0))).toEqual({ key: 'Aktualizacja po zakończeniu zadań w toku ({count})', params: { count: 1 } });
    expect(pendingText([]).key).toBe('Aktualizacja za chwilę…');
  });

  it('follows a detached window: its cell keeps the update waiting until its mirrored status says the turn ended', () => {
    const base = facts({ statuses: { c: 'working' } });
    const s = base.state;
    s.projects[1].tabs[0].cells[0].promptQueue = undefined;
    const steps: Array<[number, Record<string, CellStatus>]> = [[0, { c: 'working' }], [5000, { c: 'working' }], [6000, { c: 'waiting' }], [6000 + SETTLE_MS, { c: 'waiting' }]];
    let st: UpdateWaitState = { startedAt: 0 };
    const actions = steps.map(([now, statuses]) => {
      const step = stepUpdateWait(st, collectUpdateWork({ ...base, state: s, statuses }), now);
      st = step.state;
      return step.action;
    });
    expect(actions).toEqual(['wait', 'wait', 'wait', 'install']);
  });
});
