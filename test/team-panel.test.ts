// The logic of the "Zespół AI" panel (1.1.2): groups, threads, the agent filter and the quick-action texts.
import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentTask, AutomationEvent } from '../src/shared/automation';
import { activityOf, groupTasks, messageThreads, openPrerequisites, reassignInput, resultText, teamCounts, threadMessages } from '../src/shared/teamPanel';

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
