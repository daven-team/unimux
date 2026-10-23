// A replayed output tail carries the pty sizes it was written at (a cell moved to or from a detached window, a reloaded
// renderer): the receiving xterm takes each size before that output is parsed and is fitted to its own box only afterwards.
import { describe, expect, it } from 'vitest';
import { MAX_TAIL_SIZES, TailBuffer } from '../src/ptyhost/flow';
import { OutputChannel } from '../src/ptyhost/output';
import { finalReplaySize, replaySegments, writeReplaySegments, type ReplaySegment } from '../src/shared/replay';

describe('TailBuffer sizes', () => {
  it('records each size change at its position in the stream', () => {
    const t = new TailBuffer(1000);
    t.size(33, 20);
    t.push('narrow ');
    t.size(33, 20); // unchanged: no new mark
    t.push('output');
    t.size(100, 30);
    t.push('wide');
    expect(t.replay()).toEqual({ data: 'narrow outputwide', sizes: [{ at: 0, cols: 33, rows: 20 }, { at: 13, cols: 100, rows: 30 }] });
  });

  it('keeps only the last of several sizes with no output in between (a window drag)', () => {
    const t = new TailBuffer(1000);
    t.size(33, 20);
    t.push('a');
    t.size(40, 20);
    t.size(50, 20);
    t.size(60, 20);
    t.push('b');
    expect(t.replay().sizes).toEqual([{ at: 0, cols: 33, rows: 20 }, { at: 1, cols: 60, rows: 20 }]);
  });

  it('a size change back to the previous size before any output cancels out', () => {
    const t = new TailBuffer(1000);
    t.size(33, 20);
    t.push('a');
    t.size(40, 20);
    t.size(33, 20);
    t.push('b');
    expect(t.replay().sizes).toEqual([{ at: 0, cols: 33, rows: 20 }]);
  });

  it('the size in effect where a trimmed tail starts is moved to its start', () => {
    const t = new TailBuffer(10);
    t.size(33, 20);
    t.push('0123456789');
    t.size(80, 24);
    t.push('abcdef');
    t.size(90, 24);
    t.push('ghij');
    // Kept: "abcdefghij"; the 33-column output is gone, the 80-column one starts the tail.
    expect(t.replay()).toEqual({ data: 'abcdefghij', sizes: [{ at: 0, cols: 80, rows: 24 }, { at: 6, cols: 90, rows: 24 }] });
  });

  it('a size whose output is partly trimmed still applies from the start', () => {
    const t = new TailBuffer(4);
    t.size(33, 20);
    t.push('0123456789');
    expect(t.replay()).toEqual({ data: '6789', sizes: [{ at: 0, cols: 33, rows: 20 }] });
  });

  it('remembers a bounded number of sizes', () => {
    const t = new TailBuffer(1_000_000);
    for (let i = 0; i < MAX_TAIL_SIZES * 2; i++) { t.size(20 + (i % 50), 10 + (i % 7)); t.push('x'); }
    expect(t.replay().sizes.length).toBeLessThanOrEqual(MAX_TAIL_SIZES);
  });

  it('no size known: none is reported', () => {
    const t = new TailBuffer(100);
    t.push('abc');
    expect(t.replay()).toEqual({ data: 'abc', sizes: [] });
  });
});

describe('OutputChannel replay', () => {
  it('reports the sizes its terminal had', () => {
    const sink = { data: () => true, exit: () => undefined };
    const out = new OutputChannel('a', () => sink, { pause: () => undefined, resume: () => undefined }, () => false);
    out.resized(33, 20);
    out.push('C:\\> echo long');
    out.resized(120, 30);
    out.push('\x1b[1;1H');
    expect(out.replay()).toEqual({ data: 'C:\\> echo long\x1b[1;1H', sizes: [{ at: 0, cols: 33, rows: 20 }, { at: 14, cols: 120, rows: 30 }] });
    out.dispose();
  });
});

describe('replaySegments', () => {
  it('splits the data at its sizes', () => {
    expect(replaySegments('aaabbb', [{ at: 0, cols: 33, rows: 20 }, { at: 3, cols: 100, rows: 30 }])).toEqual([
      { data: 'aaa', cols: 33, rows: 20 }, { data: 'bbb', cols: 100, rows: 30 },
    ]);
  });

  it('without sizes (an older host) the data is one segment at the terminal size', () => {
    expect(replaySegments('abc', undefined)).toEqual([{ data: 'abc' }]);
    expect(replaySegments('abc', [])).toEqual([{ data: 'abc' }]);
  });

  it('output before the first size keeps the terminal size, invalid sizes are ignored, offsets are clamped', () => {
    expect(replaySegments('abcdef', [{ at: 2, cols: 40, rows: 10 }, { at: 3, cols: 0, rows: 10 }, { at: 99, cols: 50, rows: 12 }])).toEqual([
      { data: 'ab' }, { data: 'cdef', cols: 40, rows: 10 }, { data: '', cols: 50, rows: 12 },
    ]);
  });

  it('of several sizes at one point the last one wins', () => {
    expect(replaySegments('ab', [{ at: 0, cols: 40, rows: 10 }, { at: 0, cols: 50, rows: 12 }])).toEqual([{ data: 'ab', cols: 50, rows: 12 }]);
  });

  it('the final size is the pty size after the replay', () => {
    expect(finalReplaySize(replaySegments('aaabbb', [{ at: 0, cols: 33, rows: 20 }, { at: 3, cols: 100, rows: 30 }]))).toEqual({ cols: 100, rows: 30 });
    expect(finalReplaySize(replaySegments('abc', undefined))).toBeUndefined();
  });
});

/** A write queue like xterm's: chunks are parsed later, in order, and a chunk's callback runs before the next chunk is parsed. */
class FakeTerm {
  cols = 80;
  rows = 24;
  queue: Array<{ data: string; cb?: () => void }> = [];
  /** What was parsed, with the size it was parsed at. */
  parsed: string[] = [];
  write(data: string, cb?: () => void): void { this.queue.push({ data, cb }); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.parsed.push(`resize ${cols}x${rows}`); }
  run(): void {
    while (this.queue.length) {
      const { data, cb } = this.queue.shift()!;
      if (data) this.parsed.push(`${data}@${this.cols}`);
      cb?.();
    }
  }
}

describe('writeReplaySegments', () => {
  it('parses every segment at its size, and the fit (done) comes only after the whole replay', () => {
    const term = new FakeTerm();
    const segments: ReplaySegment[] = [{ data: 'narrow', cols: 33, rows: 20 }, { data: 'wide', cols: 100, rows: 30 }];
    writeReplaySegments(term, segments, () => { term.parsed.push('done'); term.resize(60, 25); });
    // Nothing happens before the queued writes are parsed: a resize right away would apply to earlier, unparsed output.
    expect(term.parsed).toEqual([]);
    expect(term.cols).toBe(80);
    term.write('live'); // output arriving during the replay
    term.run();
    expect(term.parsed).toEqual(['resize 33x20', 'narrow@33', 'resize 100x30', 'wide@100', 'done', 'resize 60x25', 'live@60']);
  });

  it('output written before the replay is parsed at the old size', () => {
    const term = new FakeTerm();
    term.write('earlier');
    writeReplaySegments(term, [{ data: 'x', cols: 33, rows: 20 }], () => term.parsed.push('done'));
    term.run();
    expect(term.parsed).toEqual(['earlier@80', 'resize 33x20', 'x@33', 'done']);
  });

  it('a replay without sizes is parsed at the terminal size and still reports done', () => {
    const term = new FakeTerm();
    writeReplaySegments(term, [{ data: 'abc' }], () => term.parsed.push('done'));
    term.run();
    expect(term.parsed).toEqual(['abc@80', 'done']);
  });
});
