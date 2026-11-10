// The terminals of cells that mount together are created one per task, the focused cell first (TerminalManager.stage).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messageChannelPost, StagedQueue } from '../src/shared/stagedQueue';

function manual() {
  const tasks: Array<() => void> = [];
  return { tasks, post: (fn: () => void) => { tasks.push(fn); }, runOne: () => tasks.shift()?.() };
}

describe('staged terminal creation', () => {
  it('runs one job per task, the first ones before the rest, the rest in their order', () => {
    const m = manual();
    const q = new StagedQueue(m.post);
    const ran: string[] = [];
    for (const id of ['a', 'b', 'c']) q.add(id, () => ran.push(id));
    q.add('focused', () => ran.push('focused'), true);
    expect(ran).toEqual([]);
    expect(m.tasks).toHaveLength(1);
    m.runOne();
    expect(ran).toEqual(['focused']);
    // The next job waits for a task of its own.
    expect(m.tasks).toHaveLength(1);
    while (m.tasks.length) m.runOne();
    expect(ran).toEqual(['focused', 'a', 'b', 'c']);
    expect(q.size).toBe(0);
  });

  it('several first jobs keep their order before the others', () => {
    const m = manual();
    const q = new StagedQueue(m.post);
    const ran: string[] = [];
    q.add('a', () => ran.push('a'));
    q.add('f1', () => ran.push('f1'), true);
    q.add('f2', () => ran.push('f2'), true);
    while (m.tasks.length) m.runOne();
    expect(ran).toEqual(['f1', 'f2', 'a']);
  });

  it('a cancelled job never runs (an unmount before its turn), and has() follows it', () => {
    const m = manual();
    const q = new StagedQueue(m.post);
    const ran: string[] = [];
    q.add('a', () => ran.push('a'));
    const cancel = q.add('b', () => ran.push('b'));
    expect(q.has('b')).toBe(true);
    cancel();
    cancel();
    expect(q.has('b')).toBe(false);
    while (m.tasks.length) m.runOne();
    expect(ran).toEqual(['a']);
  });

  it('a job that throws does not stop the rest', () => {
    const m = manual();
    const q = new StagedQueue(m.post);
    const ran: string[] = [];
    q.add('bad', () => { throw new Error('x'); });
    q.add('good', () => ran.push('good'));
    expect(() => m.runOne()).toThrow('x');
    while (m.tasks.length) m.runOne();
    expect(ran).toEqual(['good']);
  });

  it('a job added while the queue runs is picked up', () => {
    const m = manual();
    const q = new StagedQueue(m.post);
    const ran: string[] = [];
    q.add('a', () => { ran.push('a'); q.add('late', () => ran.push('late')); });
    while (m.tasks.length) m.runOne();
    expect(ran).toEqual(['a', 'late']);
  });

  it('the MessageChannel post runs callbacks in later tasks, in order', async () => {
    const post = messageChannelPost();
    const ran: number[] = [];
    post(() => ran.push(1));
    post(() => ran.push(2));
    expect(ran).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual([1, 2]);
  });

  it('a cell view shows an existing terminal in its commit and stages a new one, the focused cell first', () => {
    const view = readFileSync('src/renderer/src/components/CellView.tsx', 'utf8');
    expect(view).toMatch(/if \(terminals\.has\(cell\.id\)\) \{ show\(\); return \(\) => terminals\.detach\(cell\.id, el\); \}/);
    expect(view).toMatch(/terminals\.stage\(cell\.id, show, getUi\(\)\.focusedCellId === cell\.id\)/);
    // One staged job creates, shows and starts its cell: the spawn reads the size of the attached (fitted) terminal.
    const show = view.slice(view.indexOf('const show = () => {'), view.indexOf('};', view.indexOf('const show = () => {')));
    expect(show.indexOf('ensureTerminal(cell.id)')).toBeLessThan(show.indexOf('terminals.attach(cell.id, el)'));
    expect(show.indexOf('terminals.attach(cell.id, el)')).toBeLessThan(show.indexOf('ensureStarted(cell.id, true)'));
  });
});
