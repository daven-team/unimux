// The logic of the "Zespół AI" panel (1.1.2): groups, threads, the agent filter and the quick-action texts.
import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentTask, AutomationEvent } from '../src/shared/automation';
import {
  activityOf, agentStuck, groupTasks, messageThreads, NEVER_STARTED_MS, openPrerequisites, polishPlural, reassignInput, resultText, stateSince, stuckAgents, taskStuck,
  teamCounts, threadMessages, type AgentHealth, type Stuck,
} from '../src/shared/teamPanel';

const task = (id: string, status: AgentTask['status'], at: number, extra: Partial<AgentTask> = {}): AgentTask => ({
  id, projectId: 'p', cellId: 'api', fromCellId: 'lead', title: id, prompt: `do ${id}`, status, delivery: 'native', createdAt: at, updatedAt: at, ...extra,
});
const message = (id: string, from: string | undefined, to: string, at: number, read = false): AgentMessage => ({
  id, projectId: 'p', fromCellId: from, toCellId: to, text: id, delivery: 'native', createdAt: at, ...(read ? { readAt: at + 1 } : {}),
});

describe('task groups', () => {
  const tasks = [
    task('q-old', 'queued', 1), task('q-new', 'queued', 5), task('b', 'blocked', 3), task('p1', 'in_progress', 2), task('p2', 'in_progress', 4),
    task('done', 'completed', 6), task('gone', 'cancelled', 7), task('web', 'queued', 8, { cellId: 'web', fromCellId: 'api' }),
  ];
  it('in progress (newest first), open (blocked first, then queued oldest first), done (newest first)', () => {
    const groups = groupTasks(tasks);
    expect(groups.map((g) => [g.id, g.tasks.map((t) => t.id)])).toEqual([
      ['progress', ['p2', 'p1']], ['open', ['b', 'q-old', 'q-new', 'web']], ['done', ['gone', 'done']],
    ]);
  });
  it('filters by an agent that works on or assigned the task, and keeps empty groups', () => {
    expect(groupTasks(tasks, 'web').map((g) => g.tasks.map((t) => t.id))).toEqual([[], ['web'], []]);
    expect(groupTasks(tasks, 'api').flatMap((g) => g.tasks).length).toBe(tasks.length);
    expect(groupTasks([], 'x').map((g) => g.tasks.length)).toEqual([0, 0, 0]);
  });
  it('names the prerequisites that have not completed', () => {
    const all = [task('a', 'completed', 1), task('b', 'in_progress', 1), task('c', 'queued', 1, { dependsOn: ['a', 'b', 'missing'] })];
    expect(openPrerequisites(all[2], all)).toEqual([{ id: 'b', task: all[1] }, { id: 'missing', task: undefined }]);
    expect(openPrerequisites(all[0], all)).toEqual([]);
  });
  it('counts open tasks and unread messages, per agent when filtered', () => {
    const messages = [message('m1', 'lead', 'api', 1), message('m2', 'api', 'lead', 2, true), message('m3', undefined, 'web', 3)];
    expect(teamCounts(tasks, messages)).toEqual({ openTasks: 6, unread: 2 });
    expect(teamCounts(tasks, messages, 'web')).toEqual({ openTasks: 1, unread: 1 });
  });
});

describe('message threads', () => {
  const messages = [
    message('m1', 'lead', 'api', 10, true), message('m2', 'api', 'lead', 20, true), message('m3', 'qa', 'lead', 30),
    message('m4', undefined, 'web', 40), message('m5', 'lead', 'api', 50),
  ];
  it('one thread per agent, a message between agents in both, the user in the recipient only, recent first', () => {
    const threads = messageThreads(messages);
    expect(threads.map((t) => [t.cellId, t.count, t.unread, t.last.id])).toEqual([
      ['api', 3, 1, 'm5'], ['lead', 4, 1, 'm5'], ['web', 1, 1, 'm4'], ['qa', 1, 0, 'm3'],
    ]);
  });
  it('a thread reads oldest first; null is every message', () => {
    expect(threadMessages([...messages].reverse(), 'api').map((m) => m.id)).toEqual(['m1', 'm2', 'm5']);
    expect(threadMessages(messages, null)).toHaveLength(5);
  });
});

describe('activity and quick actions', () => {
  it('lists the newest activity of the project, of one agent when filtered, up to the limit', () => {
    const events: AutomationEvent[] = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, projectId: i === 9 ? 'other' : 'p', action: 'message', detail: `d${i}`, cellId: i % 2 ? 'a' : 'b', createdAt: i }));
    expect(activityOf(events, 'p').map((e) => e.id)).toEqual(['e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e2', 'e1', 'e0']);
    expect(activityOf(events, 'p', 'a', 2).map((e) => e.id)).toEqual(['e7', 'e5']);
  });
  it('copies a result as plain lines and reassigns a closed task as a new one', () => {
    expect(resultText({ summary: ' Added the endpoint. ', files: ['a.ts'], tests: ['npm test: ok'], branch: 'feat/x', commit: 'abc' }))
      .toBe('Added the endpoint.\n\nfeat/x @ abc\n\n- a.ts\n\n- npm test: ok');
    expect(resultText({ summary: 'Done', files: [], tests: [] })).toBe('Done');
    expect(reassignInput(task('t', 'cancelled', 1, { dependsOn: ['x'] }))).toEqual({ cellId: 'api', title: 't', prompt: 'do t' });
  });
});

describe('stuck tasks (1.1.4)', () => {
  const T0 = 1_000_000;
  const running: AgentHealth = { open: true, connected: true, runtime: 'working' };
  it('a queued task whose agent never connected is stuck only after 90 s since the task, the agent start and the baseline', () => {
    const q = task('q', 'queued', T0);
    const off: AgentHealth = { open: true, connected: false, runtime: 'starting' };
    expect(taskStuck(q, off, T0 + NEVER_STARTED_MS)).toBeNull();
    expect(taskStuck(q, off, T0 + NEVER_STARTED_MS + 1)).toEqual({ kind: 'never-started' });
    expect(taskStuck(q, { ...off, startedAt: T0 + 60_000 }, T0 + NEVER_STARTED_MS + 1)).toBeNull();
    expect(taskStuck(q, off, T0 + NEVER_STARTED_MS + 1, T0 + 30_000)).toBeNull();
    expect(taskStuck(q, { ...off, connected: true }, T0 + 10 * NEVER_STARTED_MS)).toBeNull();
    // In progress: the agent connected once; a dropped connection alone is no reason.
    expect(taskStuck(task('p', 'in_progress', T0), off, T0 + 10 * NEVER_STARTED_MS)).toBeNull();
  });
  it('an ended CLI (with its exit code), a closed or archived cell, and an agent waiting for the user', () => {
    const p = task('p', 'in_progress', T0);
    expect(taskStuck(p, { ...running, cliExited: true, exitCode: 1 }, T0)).toEqual({ kind: 'ended', code: 1 });
    expect(taskStuck(p, { ...running, runtime: 'exited' }, T0)).toEqual({ kind: 'ended' });
    expect(taskStuck(p, { ...running, cliExited: true, exitCode: 0 }, T0)).toEqual({ kind: 'ended' });
    expect(taskStuck(p, undefined, T0)).toEqual({ kind: 'closed' });
    expect(taskStuck(p, { open: false, archived: true, connected: false }, T0)).toEqual({ kind: 'closed', archived: true });
    expect(taskStuck(p, { ...running, runtime: 'needs_attention' }, T0)).toEqual({ kind: 'waiting' });
    expect(taskStuck(p, running, T0 + 3_600_000)).toBeNull();
  });
  it('closed tasks are never stuck', () => {
    expect(taskStuck(task('d', 'completed', T0), undefined, T0)).toBeNull();
    expect(taskStuck(task('c', 'cancelled', T0), { open: true, connected: false, cliExited: true }, T0)).toBeNull();
  });
  it('the banner groups the stuck tasks per agent (oldest first) and leaves out tasks waiting for the user', () => {
    const tasks = [task('b2', 'queued', 5), task('a1', 'in_progress', 3, { cellId: 'web' }), task('b1', 'queued', 1), task('w', 'in_progress', 2, { cellId: 'qa' }), task('ok', 'queued', 4, { cellId: 'lead' })];
    const stuck = new Map<string, Stuck>([['b2', { kind: 'never-started' }], ['b1', { kind: 'never-started' }], ['a1', { kind: 'ended', code: 1 }], ['w', { kind: 'waiting' }]]);
    expect(stuckAgents(tasks, stuck)).toEqual([
      { cellId: 'api', kind: 'never-started', taskIds: ['b1', 'b2'] },
      { cellId: 'web', kind: 'ended', code: 1, taskIds: ['a1'] },
    ]);
    expect(stuckAgents(tasks, new Map([['a1', { kind: 'closed', archived: true }]]))).toEqual([{ cellId: 'web', kind: 'closed', archived: true, taskIds: ['a1'] }]);
  });
  it('an agent row shows its most serious reason', () => {
    const tasks = [task('a', 'queued', 1), task('b', 'in_progress', 2), task('c', 'queued', 3, { cellId: 'web' })];
    expect(agentStuck('api', tasks, new Map<string, Stuck>([['a', { kind: 'never-started' }], ['b', { kind: 'ended', code: 2 }], ['c', { kind: 'closed' }]]))).toEqual({ kind: 'ended', code: 2 });
    expect(agentStuck('api', tasks, new Map<string, Stuck>([['a', { kind: 'never-started' }]]))).toEqual({ kind: 'never-started' });
    expect(agentStuck('lead', tasks, new Map<string, Stuck>([['a', { kind: 'never-started' }]]))).toBeNull();
  });
  it('time in the state, a reassignment to another agent and the Polish plural', () => {
    expect(stateSince(task('q', 'queued', 10, { updatedAt: 50 }))).toBe(10);
    expect(stateSince(task('p', 'in_progress', 10, { updatedAt: 50 }))).toBe(50);
    expect(reassignInput(task('t', 'queued', 1), 'web')).toEqual({ cellId: 'web', title: 't', prompt: 'do t' });
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 102, 112].map(polishPlural)).toEqual(['one', 'few', 'few', 'many', 'many', 'many', 'many', 'many', 'few', 'many', 'few', 'many']);
  });
});
