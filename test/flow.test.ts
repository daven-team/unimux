import { describe, expect, it } from 'vitest';
import { ACTIVE_WINDOW_MS, alignedDelay, BULK_COALESCE_MS, coalesceDelay, ECHO_COALESCE_MS, ECHO_WINDOW_MAX_MS, ECHO_WINDOW_MS, EchoClock, FlowGate, HIGH_WATER, LOW_WATER, MAX_TAIL_CHUNKS, TailBuffer } from '../src/ptyhost/flow';
import { OutputBatcher } from '../src/ptyhost/batch';
import { unpackHostMessage, type HostToRendererPort } from '../src/shared/ipc';

describe('TailBuffer', () => {
  it('matches the naive (tail + data).slice(-limit) for random chunks', () => {
    for (const limit of [1, 7, 100, 1000]) {
      const buf = new TailBuffer(limit);
      let naive = '';
      let seed = limit;
      for (let i = 0; i < 300; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const chunk = String.fromCharCode(97 + (i % 26)).repeat(seed % 40);
        buf.push(chunk);
        naive = (naive + chunk).slice(-limit);
        if (i % 17 === 0) expect(buf.toString()).toBe(naive);
      }
      expect(buf.toString()).toBe(naive);
    }
  });

  it('keeps a chunk larger than the limit cut to the newest characters', () => {
    const buf = new TailBuffer(4);
    buf.push('abcdefgh');
    expect(buf.toString()).toBe('efgh');
    buf.push('ij');
    expect(buf.toString()).toBe('ghij');
  });

  it('does not grow without bound', () => {
    const buf = new TailBuffer(1000);
    for (let i = 0; i < 10_000; i++) buf.push('x'.repeat(100));
    expect((buf as unknown as { chunks: string[] }).chunks.length).toBeLessThan(25);
  });

  it('ignores empty pushes', () => {
    const buf = new TailBuffer(5);
    buf.push('');
    expect(buf.toString()).toBe('');
  });
});

describe('FlowGate', () => {
  it('pauses at the high watermark and resumes at the low one', () => {
    const g = new FlowGate();
    expect(g.sent(HIGH_WATER - 1)).toBe(false);
    expect(g.sent(1)).toBe(true);
    expect(g.paused).toBe(true);
    expect(g.sent(500)).toBe(false); // already paused
    expect(g.acked(HIGH_WATER - LOW_WATER - 1)).toBe(false);
    expect(g.acked(600)).toBe(true);
    expect(g.paused).toBe(false);
  });

  it('never lets pending go negative and ignores acks while running', () => {
    const g = new FlowGate();
    expect(g.acked(10_000)).toBe(false);
    expect(g.inFlight).toBe(0);
    expect(g.sent(10)).toBe(false);
    expect(g.inFlight).toBe(10);
  });

  it('release lifts a pause but keeps the in-flight count', () => {
    const g = new FlowGate();
    g.sent(HIGH_WATER);
    g.release();
    expect(g.paused).toBe(false);
    expect(g.inFlight).toBe(HIGH_WATER);
    expect(g.sent(1)).toBe(true);
  });

  it('reset reports a pause that has to be lifted', () => {
    const g = new FlowGate();
    g.sent(HIGH_WATER);
    expect(g.reset()).toBe(true);
    expect(g.paused).toBe(false);
    expect(g.reset()).toBe(false);
    expect(g.sent(HIGH_WATER - 1)).toBe(false);
  });
});

describe('coalesceDelay', () => {
  it('is short right after the user typed and longer for bulk output', () => {
    expect(coalesceDelay(1000, 900, true)).toBe(ECHO_COALESCE_MS);
    expect(coalesceDelay(1000, 900, false)).toBe(ECHO_COALESCE_MS);
    expect(coalesceDelay(1000, 100, true)).toBe(BULK_COALESCE_MS);
    expect(coalesceDelay(1000, -Infinity, true)).toBe(BULK_COALESCE_MS);
  });

  it('keeps the echo delay for as long as the echo window of the terminal', () => {
    expect(coalesceDelay(1000, 700, true)).toBe(BULK_COALESCE_MS);
    expect(coalesceDelay(1000, 700, true, 420)).toBe(ECHO_COALESCE_MS);
    expect(coalesceDelay(1000, 500, true, 420)).toBe(BULK_COALESCE_MS);
  });
});

describe('EchoClock', () => {
  /** Keys typed `gap` ms apart, each answered `answer` ms later; returns the clock's time afterwards. */
  function typeAnswered(clock: EchoClock, start: number, keys: number, answer: number, gap = 1000): number {
    let t = start;
    for (let i = 0; i < keys; i++) {
      clock.keystroke(t);
      clock.output(t + answer);
      t += gap;
    }
    return t;
  }

  it('starts with the local window and keeps it for terminals that answer quickly', () => {
    const clock = new EchoClock();
    expect(clock.window).toBe(ECHO_WINDOW_MS);
    typeAnswered(clock, 0, 20, 3);
    expect(clock.answerMs).toBeCloseTo(3);
    expect(clock.window).toBe(ECHO_WINDOW_MS);
    const nearby = new EchoClock(); // a server about 60 ms away
    typeAnswered(nearby, 0, 20, 60);
    expect(nearby.window).toBe(ECHO_WINDOW_MS);
  });

  // An SSH server 200 ms away: before, every echo that came after a pause in typing missed the fixed 150 ms window.
  it('widens the window to about twice the round trip of a slow server, and narrows it again', () => {
    const clock = new EchoClock();
    let t = typeAnswered(clock, 0, 1, 200);
    expect(clock.window).toBe(420);
    t = typeAnswered(clock, t, 30, 120);
    expect(clock.answerMs).toBeCloseTo(120, 0);
    expect(clock.window).toBeGreaterThan(120 + 50);
    typeAnswered(clock, t, 30, 5);
    expect(clock.window).toBe(ECHO_WINDOW_MS);
  });

  it('measures fast typing from the oldest key still waiting for its echo', () => {
    const clock = new EchoClock();
    clock.keystroke(0);
    clock.keystroke(80); // typed before the first echo came back
    clock.output(200);
    clock.output(280); // the second echo: no key waits any more
    expect(clock.answerMs).toBe(200);
    clock.keystroke(300);
    clock.output(500);
    expect(clock.answerMs).toBe(200);
  });

  it('does not take output long after a keystroke for its echo, and caps the window', () => {
    const clock = new EchoClock();
    clock.keystroke(0); // a password character: no echo
    clock.output(5000); // something else, much later
    expect(clock.answerMs).toBeNull();
    clock.keystroke(6000);
    clock.keystroke(6000 + ECHO_WINDOW_MAX_MS + 1); // the first key went unanswered for too long: measure from this one
    clock.output(6000 + ECHO_WINDOW_MAX_MS + 101);
    expect(clock.answerMs).toBe(100);
    typeAnswered(clock, 20_000, 50, ECHO_WINDOW_MAX_MS - 1);
    expect(clock.window).toBe(ECHO_WINDOW_MAX_MS);
    expect(ECHO_WINDOW_MAX_MS).toBeLessThanOrEqual(ACTIVE_WINDOW_MS);
  });
});

describe('alignedDelay', () => {
  it('puts bulk flushes on a shared grid and leaves the echo delay alone', () => {
    expect(alignedDelay(1000, ECHO_COALESCE_MS)).toBe(ECHO_COALESCE_MS);
    for (let now = 0; now < 50; now++) {
      const delay = alignedDelay(now, BULK_COALESCE_MS);
      expect((now + delay) % BULK_COALESCE_MS).toBe(0);
      expect(delay).toBeGreaterThanOrEqual(BULK_COALESCE_MS / 2);
      expect(delay).toBeLessThanOrEqual(BULK_COALESCE_MS * 1.5);
    }
  });
});

describe('TailBuffer with many tiny chunks', () => {
  it('joins them into one piece and keeps the same text', () => {
    const buf = new TailBuffer(100_000);
    let naive = '';
    for (let i = 0; i < 5000; i++) { buf.push('x' + (i % 10)); naive += 'x' + (i % 10); }
    expect(buf.pieces).toBeLessThanOrEqual(MAX_TAIL_CHUNKS);
    expect(buf.toString()).toBe(naive.slice(-100_000));
    const small = new TailBuffer(50);
    let tail = '';
    for (let i = 0; i < 2000; i++) { small.push(String(i)); tail = (tail + String(i)).slice(-50); }
    expect(small.toString()).toBe(tail);
  });
});

describe('OutputBatcher', () => {
  it('posts one message per turn, single output unchanged, several as a batch in order', () => {
    const posted: HostToRendererPort[] = [];
    const queue: Array<() => void> = [];
    const batcher = new OutputBatcher((m) => posted.push(m), (fn) => queue.push(fn));
    batcher.data('a', 'one');
    queue.shift()!();
    expect(posted).toEqual([{ t: 'data', id: 'a', data: 'one' }]);
    batcher.data('a', 'two');
    batcher.data('b', 'three');
    batcher.data('a', 'four');
    expect(queue).toHaveLength(1);
    queue.shift()!();
    expect(posted[1]).toEqual({ t: 'dataBatch', items: [['a', 'two'], ['b', 'three'], ['a', 'four']] });
    expect(unpackHostMessage(posted[1])).toEqual([
      { t: 'data', id: 'a', data: 'two' }, { t: 'data', id: 'b', data: 'three' }, { t: 'data', id: 'a', data: 'four' },
    ]);
    // An explicit flush (before an exit) empties the queue; the scheduled one then has nothing left.
    batcher.data('c', 'last');
    batcher.flush();
    queue.shift()!();
    expect(posted).toHaveLength(3);
    batcher.data('d', 'gone');
    batcher.drop();
    queue.shift()!();
    expect(posted).toHaveLength(3);
  });

  it('posts a typed echo at once, together with the output queued before it', () => {
    const posted: HostToRendererPort[] = [];
    const queue: Array<() => void> = [];
    const batcher = new OutputBatcher((m) => posted.push(m), (fn) => queue.push(fn));
    batcher.data('agent', 'stream');
    batcher.data('ssh', 'e', true);
    expect(posted).toEqual([{ t: 'dataBatch', items: [['agent', 'stream'], ['ssh', 'e']] }]);
    batcher.data('ssh', 'x', true);
    expect(posted[1]).toEqual({ t: 'data', id: 'ssh', data: 'x' });
    for (const fn of queue.splice(0)) fn();
    expect(posted).toHaveLength(2);
  });
});
