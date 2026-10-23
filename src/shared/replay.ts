// The replay of a terminal's output tail (a reloaded renderer, a cell moved to or from a detached window) with the pty sizes it
// was written at. ConPTY output positions the cursor absolutely at the size the pty had then: parsed at another size it lands
// in the wrong places (a command at column 32, new text over old). The receiving xterm therefore takes each recorded size
// before the output of that time is parsed, and is fitted to its own box only afterwards (xterm reflows wrapped lines, the
// pty resize makes the program redraw).

/** From character `at` of the replayed data on, the pty had `cols` x `rows`. */
export interface ReplaySize { at: number; cols: number; rows: number }

export interface ReplaySegment { data: string; cols?: number; rows?: number }

/** Splits the replayed data at its size changes (no sizes: one segment without a size, parsed at the terminal's own). */
export function replaySegments(data: string, sizes: readonly ReplaySize[] | undefined): ReplaySegment[] {
  const valid = (sizes ?? [])
    .filter((s) => Number.isFinite(s.at) && Number.isInteger(s.cols) && Number.isInteger(s.rows) && s.cols > 0 && s.rows > 0)
    .map((s) => ({ ...s, at: Math.max(0, Math.min(data.length, Math.floor(s.at))) }))
    .sort((a, b) => a.at - b.at);
  if (!valid.length) return [{ data }];
  const out: ReplaySegment[] = [];
  if (valid[0].at > 0) out.push({ data: data.slice(0, valid[0].at) });
  valid.forEach((s, i) => {
    const end = i + 1 < valid.length ? valid[i + 1].at : data.length;
    const seg = { data: data.slice(s.at, end), cols: s.cols, rows: s.rows };
    // Several sizes at the same point: only the last one was in effect for what follows.
    if (out.length && out[out.length - 1].cols !== undefined && out[out.length - 1].data === '') out[out.length - 1] = seg;
    else out.push(seg);
  });
  return out;
}

/** The size the pty has at the end of the replay (undefined: not recorded). */
export function finalReplaySize(segments: readonly ReplaySegment[]): { cols: number; rows: number } | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.cols !== undefined && s.rows !== undefined) return { cols: s.cols, rows: s.rows };
  }
  return undefined;
}

export interface ReplayTarget {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
}

/**
 * Queues the segments in order: each resize runs from a write callback, i.e. after everything written before it was parsed
 * and before the next chunk is (xterm calls a chunk's callback before it parses the next one). Everything is queued at once,
 * so output that arrives during the replay is parsed after it. `done` runs once the last segment was parsed.
 */
export function writeReplaySegments(term: ReplayTarget, segments: readonly ReplaySegment[], done: () => void): void {
  for (const s of segments) {
    const { cols, rows } = s;
    if (cols !== undefined && rows !== undefined) term.write('', () => term.resize(cols, rows));
    if (s.data) term.write(s.data);
  }
  term.write('', done);
}
