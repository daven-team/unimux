import { describe, expect, it } from 'vitest';
import { formatElapsed, nextTurn, turnDuration, turnTook, type TurnMark, type TurnPhase } from '../src/shared/turnTimer';

const run = (steps: Array<[TurnPhase, number]>): TurnMark | undefined => steps.reduce<TurnMark | undefined>((mark, [phase, at]) => nextTurn(mark, phase, at), undefined);

describe('turn timer', () => {
  it('keeps one turn across a permission prompt and ends it on a result', () => {
    const mark = run([['work', 1000], ['ask', 5000], ['work', 9000], ['stop', 61_000]]);
    expect(mark?.since).toBe(1000);
    expect(turnTook(mark)).toBe(60_000);
    // The detail of the same wait arrives late as a question: the turn reopens, paused, with its start.
    expect(nextTurn(mark, 'ask', 62_000)).toEqual({ since: 1000, paused: true });
    // Working after a finished turn starts a new one.
    expect(nextTurn(nextTurn(mark, 'rest', 70_000), 'ask', 71_000)?.endedAt).toBe(61_000);
    expect(nextTurn(mark, 'work', 80_000)).toEqual({ since: 80_000 });
  });

  it('formats the running time and the length of a turn', () => {
    expect(formatElapsed(192_000)).toBe('3:12');
    expect(formatElapsed(3_792_000)).toBe('1:03:12');
    expect(turnDuration(40_000)).toEqual({ key: '{n} s', params: { n: 40 } });
    expect(turnDuration(4 * 60_000)).toEqual({ key: '{n} min', params: { n: 4 } });
    expect(turnDuration(65 * 60_000)).toEqual({ key: '{h} godz. {m} min', params: { h: 1, m: 5 } });
  });
});
