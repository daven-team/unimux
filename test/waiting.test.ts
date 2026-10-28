import { describe, expect, it } from 'vitest';
import {
  entriesFromKey, needsYou, nextMark, normalizeWaitMark, seeMark, stepWaiting, waitAge, waitingCount, waitingEntries, waitingKey,
  waitKindOf, waitText, waitTone, type WaitMark,
} from '../src/shared/waiting';
import { DETACHED_FILE_SHORTCUTS, DETACHED_GRID_SHORTCUTS } from '../src/shared/detached';
import { resolveShortcuts, SHORTCUT_DEFS } from '../src/shared/shortcuts';
import { translate } from '../src/shared/i18n';

describe('what a cell waits for', () => {
  it('reads permissions, questions, input requests and interruptions from the status detail', () => {
    expect(waitKindOf('waiting', { kind: 'permission', tool: 'Bash' }, undefined)).toEqual({ kind: 'permission', tool: 'Bash' });
    expect(waitKindOf('waiting', { kind: 'permission' }, undefined)).toEqual({ kind: 'permission' });
    expect(waitKindOf('waiting', { kind: 'question' }, undefined)).toEqual({ kind: 'question' });
    expect(waitKindOf('waiting', { kind: 'elicitation' }, undefined)).toEqual({ kind: 'elicitation' });
    expect(waitKindOf('waiting', { kind: 'input' }, undefined)).toEqual({ kind: 'input' });
    expect(waitKindOf('waiting', { kind: 'interrupted' }, undefined)).toEqual({ kind: 'interrupted' });
  });

  it('tells a finished turn, a failed command, an error and a limit apart', () => {
    expect(waitKindOf('waiting', undefined, undefined)).toEqual({ kind: 'done' });
    expect(waitKindOf('waiting', { kind: 'exit-code', code: 0 }, undefined)).toEqual({ kind: 'done' });
    expect(waitKindOf('waiting', { kind: 'exit-code', code: 2 }, undefined)).toEqual({ kind: 'failed', code: 2 });
    expect(waitKindOf('waiting', undefined, 'server_error')).toEqual({ kind: 'error', error: 'server_error' });
    expect(waitKindOf('waiting', undefined, 'usage-limit')).toEqual({ kind: 'limit', error: 'usage-limit' });
    expect(waitKindOf('waiting', undefined, 'rate_limit')).toEqual({ kind: 'limit', error: 'rate_limit' });
    // A failure wins over the detail that came with it.
    expect(waitKindOf('waiting', { kind: 'permission', tool: 'Bash' }, 'overloaded')?.kind).toBe('error');
  });

  it('never lists working or idle cells, and only failed exits of ended cells', () => {
    expect(waitKindOf('working', { kind: 'tool', tool: 'Edit' }, undefined)).toBeNull();
    expect(waitKindOf('idle', undefined, undefined)).toBeNull();
    // A shell at its prompt after a failed command is not a request for the user.
    expect(waitKindOf('idle', { kind: 'exit-code', code: 1 }, undefined)).toBeNull();
    expect(waitKindOf('exited', undefined, undefined)).toBeNull();
    expect(waitKindOf('exited', { kind: 'exit-code', code: 0 }, undefined)).toBeNull();
    expect(waitKindOf('exited', { kind: 'exit-code', code: 137 }, undefined)).toEqual({ kind: 'failed', code: 137 });
    expect(waitKindOf('exited', { kind: 'cli-exited', code: 1 }, undefined)).toEqual({ kind: 'failed', code: 1 });
  });
});

describe('since when it waits and whether it was seen', () => {
  it('keeps the same mark (and its time) while the cell waits for the same thing', () => {
    const first = nextMark(undefined, 'waiting', { kind: 'permission', tool: 'Bash' }, undefined, 1000)!;
    expect(first).toEqual({ kind: 'permission', tool: 'Bash', since: 1000 });
    expect(nextMark(first, 'waiting', { kind: 'permission', tool: 'Bash' }, undefined, 5000)).toBe(first);
  });

  it('starts a new wait for something else and ends it when the cell works again', () => {
    const done = nextMark(undefined, 'waiting', undefined, undefined, 1000)!;
    const asked = nextMark(done, 'waiting', { kind: 'question' }, undefined, 2000)!;
    expect(asked).toEqual({ kind: 'question', since: 2000 });
    const other = nextMark(nextMark(undefined, 'waiting', { kind: 'permission', tool: 'Bash' }, undefined, 1)!, 'waiting', { kind: 'permission', tool: 'Edit' }, undefined, 9);
    expect(other?.since).toBe(9);
    expect(nextMark(asked, 'working', { kind: 'tool', tool: 'Edit' }, undefined, 3000)).toBeUndefined();
  });

  it('drops a finished turn once seen, but keeps a question until it is answered', () => {
    const done = nextMark(undefined, 'waiting', undefined, undefined, 1000)!;
    expect(needsYou(done)).toBe(true);
    const seen = seeMark(done, 4000);
    expect(seen.seenAt).toBe(4000);
    expect(needsYou(seen)).toBe(false);
    // Seeing twice keeps the first moment (the same object).
    expect(seeMark(seen, 9000)).toBe(seen);
    const question = seeMark(nextMark(undefined, 'waiting', { kind: 'permission' }, undefined, 1000)!, 2000);
    expect(needsYou(question)).toBe(true);
    for (const kind of ['error', 'limit', 'failed', 'interrupted'] as const) expect(needsYou({ kind, since: 1, seenAt: 2 })).toBe(false);
    expect(needsYou(undefined)).toBe(false);
  });

  it('a seen mark that waits for something new needs the user again', () => {
    const seen = seeMark(nextMark(undefined, 'waiting', undefined, undefined, 1000)!, 1500);
    const next = nextMark(seen, 'waiting', undefined, 'usage-limit', 2000)!;
    expect(next.seenAt).toBeUndefined();
    expect(needsYou(next)).toBe(true);
  });

  it('checks a mark reported by another window field by field', () => {
    expect(normalizeWaitMark({ kind: 'permission', since: 5, tool: 'Bash', seenAt: 7 })).toEqual({ kind: 'permission', since: 5, tool: 'Bash', seenAt: 7 });
    expect(normalizeWaitMark({ kind: 'failed', since: 5, code: 3, extra: 'x' })).toEqual({ kind: 'failed', since: 5, code: 3 });
    expect(normalizeWaitMark({ kind: 'permission', since: 5, tool: '<script>' })).toEqual({ kind: 'permission', since: 5 });
    expect(normalizeWaitMark({ kind: 'nope', since: 5 })).toBeNull();
    expect(normalizeWaitMark({ kind: 'done', since: -1 })).toBeNull();
    expect(normalizeWaitMark({ kind: 'done' })).toBeNull();
    expect(normalizeWaitMark('done')).toBeNull();
    expect(normalizeWaitMark(null)).toBeNull();
  });
});

describe('the list across grids', () => {
  const projects = [
    { id: 'p1', tabs: [{ id: 't1', cells: [{ id: 'a' }, { id: 'b', muted: true }] }, { id: 't2', cells: [{ id: 'c' }] }] },
    { id: 'p2', tabs: [{ id: 't3', cells: [{ id: 'd' }, { id: 'e' }] }] },
  ];
  const marks: Record<string, WaitMark> = {
    a: { kind: 'done', since: 300 },
    b: { kind: 'permission', tool: 'Bash', since: 100 },
    c: { kind: 'question', since: 200 },
    d: { kind: 'done', since: 50, seenAt: 60 },
    e: { kind: 'limit', error: 'usage-limit', since: 200 },
  };

  it('lists who waits, longest first, equal times in grid order, seen turns left out', () => {
    const list = waitingEntries(projects, marks);
    expect(list.map((e) => e.cellId)).toEqual(['b', 'c', 'e', 'a']);
    expect(list[0]).toMatchObject({ cellId: 'b', projectId: 'p1', tabId: 't1', kind: 'permission', tool: 'Bash', muted: true });
    expect(list[2]).toMatchObject({ projectId: 'p2', tabId: 't3', kind: 'limit' });
  });

  it('hides muted cells on request and never counts them in the badge', () => {
    expect(waitingEntries(projects, marks, { hideMuted: true }).map((e) => e.cellId)).toEqual(['c', 'e', 'a']);
    expect(waitingCount(waitingEntries(projects, marks))).toBe(3);
  });

  it('ignores marks of cells that are gone', () => {
    expect(waitingEntries([], marks)).toEqual([]);
  });

  it('round-trips through its key, which changes only with the rows', () => {
    const list = waitingEntries(projects, marks);
    expect(entriesFromKey(waitingKey(list))).toEqual(list);
    expect(waitingKey(waitingEntries(projects, { ...marks }))).toBe(waitingKey(list));
    expect(waitingKey(waitingEntries(projects, { ...marks, c: { kind: 'question', since: 201 } }))).not.toBe(waitingKey(list));
    expect(entriesFromKey('not json')).toEqual([]);
  });

  it('steps to the next and previous waiting cell, wrapping around', () => {
    const list = waitingEntries(projects, marks);
    expect(stepWaiting(list, null, 1)).toBe('b');
    expect(stepWaiting(list, null, -1)).toBe('a');
    expect(stepWaiting(list, 'b', 1)).toBe('c');
    expect(stepWaiting(list, 'a', 1)).toBe('b');
    expect(stepWaiting(list, 'b', -1)).toBe('a');
    // A cell that is not listed (a finished turn just read): the oldest one.
    expect(stepWaiting(list, 'd', 1)).toBe('b');
    // ... unless its place is known: the step goes on from there.
    expect(stepWaiting(list, 'gone', 1, 150)).toBe('c');
    expect(stepWaiting(list, 'gone', 1, 250)).toBe('a');
    expect(stepWaiting(list, 'gone', 1, 999)).toBe('b');
    expect(stepWaiting(list, 'gone', -1, 250)).toBe('e');
    expect(stepWaiting(list, 'gone', -1, 50)).toBe('a');
    // Equal times: the remembered order decides (c and e waited since 200; c was read, so next is e, previous b).
    const order = list.map((e) => e.cellId);
    const without = list.filter((e) => e.cellId !== 'c');
    expect(stepWaiting(without, 'c', 1, 200, order)).toBe('e');
    expect(stepWaiting(without, 'c', -1, 200, order)).toBe('b');
    // The read cell was the last one: wrap around to the oldest; the first one going back: the newest.
    expect(stepWaiting(list.filter((e) => e.cellId !== 'a'), 'a', 1, 300, order)).toBe('b');
    expect(stepWaiting(list.filter((e) => e.cellId !== 'b'), 'b', -1, 100, order)).toBe('a');
    // Cells of the old order that left meanwhile are skipped.
    expect(stepWaiting(list.filter((e) => e.cellId !== 'c' && e.cellId !== 'e'), 'c', 1, 200, order)).toBe('a');
    expect(stepWaiting([], 'b', 1)).toBeNull();
    expect(stepWaiting([{ cellId: 'x', since: 1 }], 'x', 1)).toBe('x');
  });
});

describe('texts of the list', () => {
  it('says what the cell waits for', () => {
    expect(waitText({ kind: 'permission', tool: 'Bash' })).toEqual({ key: 'czeka na zgodę: {tool}', params: { tool: 'Bash' } });
    expect(waitText({ kind: 'question' }).key).toBe('pyta Cię o coś');
    expect(waitText({ kind: 'limit', error: 'usage-limit' }).key).toBe('limit osiągnięty');
    expect(waitText({ kind: 'failed', code: 3 })).toEqual({ key: 'kod wyjścia {code}', params: { code: 3 } });
    expect(translate('en', waitText({ kind: 'done' }).key)).toBe('finished, not seen yet');
  });

  it('says how long, short', () => {
    expect(waitAge(0, 30_000).key).toBe('teraz');
    expect(waitAge(0, 3 * 60_000 + 5000)).toEqual({ key: '{n} min', params: { n: 3 } });
    expect(waitAge(0, 2 * 3600_000)).toEqual({ key: '{n} godz.', params: { n: 2 } });
    expect(waitAge(0, 50 * 3600_000)).toEqual({ key: '{n} d', params: { n: 2 } });
    expect(waitAge(1000, 0).key).toBe('teraz');
    expect(translate('en', '{n} min', { n: 3 })).toBe('3 min');
  });

  it('gives each kind a tone', () => {
    expect(waitTone('permission')).toBe('attention');
    expect(waitTone('error')).toBe('error');
    expect(waitTone('failed')).toBe('error');
    expect(waitTone('done')).toBe('done');
  });
});

describe('shortcuts of the list', () => {
  it('has free defaults for next and previous on every platform, also in detached windows', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const r = resolveShortcuts({}, platform);
      expect(r.combos['waiting.next'], platform).toBeTruthy();
      expect(r.combos['waiting.prev'], platform).toBeTruthy();
      const taken = SHORTCUT_DEFS.filter((d) => d.id !== 'waiting.next' && JSON.stringify(r.combos[d.id]) === JSON.stringify(r.combos['waiting.next']));
      expect(taken).toEqual([]);
    }
    expect(DETACHED_GRID_SHORTCUTS.has('waiting.next')).toBe(true);
    expect(DETACHED_FILE_SHORTCUTS.has('waiting.prev')).toBe(true);
  });
});
