import { describe, expect, it } from 'vitest';
import {
  BG_STALL_MS, FOCUS_ECHO_MS, INTERRUPT_QUIET_MS, isUserInput, shouldNotify, STALL_MS, StatusTracker,
  type CellStatus, type HookEvent, type HookInfo, type StatusCause,
} from '../src/shared/status';
import { formatEntry, hookDetail, StatusLog, STATUS_LOG_LIMIT } from '../src/shared/statusLog';

interface Change { at: number; from: CellStatus; to: CellStatus; cause: StatusCause; alert: boolean; reason: string }

/** Replays a timeline against one tracker and records every status change plus whether the app would alert for it. */
function sim() {
  const t = new StatusTracker();
  const changes: Change[] = [];
  const watch = (at: number, change: () => void) => {
    const prev = t.status;
    change();
    if (t.status !== prev) changes.push({ at, from: prev, to: t.status, cause: t.lastCause, alert: shouldNotify(prev, t.status, t.lastCause, t.isHooked), reason: t.lastReason });
  };
  return {
    t,
    changes,
    alerts: () => changes.filter((c) => c.alert).length,
    hook: (at: number, ev: HookEvent, info?: HookInfo) => watch(at, () => { t.hook(ev, at, info); }),
    output: (at: number) => watch(at, () => t.output(at)),
    input: (at: number, submitted = false) => watch(at, () => t.input(at, submitted)),
    reply: (at: number) => watch(at, () => t.terminalReply(at)),
    interrupt: (at: number) => watch(at, () => t.interrupt(at)),
    /** Ticks every 400 ms like the app, from `from` to `to`. */
    run: (from: number, to: number) => { for (let n = from; n <= to; n += 400) watch(n, () => { t.tick(n); }); },
  };
}

describe('H1 StopFailure', () => {
  it('a failed turn (weekly limit) ends in waiting with reason error and never goes back to working by itself', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.output(500);
    s.hook(1000, 'fail', { error: 'rate_limit' }); // "You've hit your weekly limit", "Cooked for 1s"
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastCause).toBe('hook');
    expect(s.t.lastReason).toBe('error');
    expect(s.alerts()).toBe(1);
    // Claude keeps a bit of UI activity and a late PostToolUse after the failure
    s.hook(1100, 'busy');
    for (let ms = 1500; ms <= 6000; ms += 500) s.output(ms);
    s.run(1000, 10 * 60_000);
    expect(s.t.status).toBe('waiting');
    expect(s.changes.map((c) => `${c.from}->${c.to}`)).toEqual(['idle->working', 'working->waiting']);
  });

  it('works without a preceding prompt hook (turn started before the hooks were wired)', () => {
    const s = sim();
    s.hook(0, 'fail', { error: 'billing_error' });
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastReason).toBe('error');
    expect(s.changes[0].alert).toBe(true);
  });

  it('typing after a failure does not wake the cell; the next prompt does', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'fail');
    s.input(200, false);
    expect(s.t.status).toBe('waiting');
    s.hook(300, 'prompt');
    expect(s.t.status).toBe('working');
  });

  it('records why the cell is waiting: done / attention / error', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stop', 1);
    expect(t.lastReason).toBe('done');
    t.hook('prompt', 2);
    t.hook('notify', 3);
    expect(t.lastReason).toBe('attention');
    t.hook('prompt', 4);
    t.hook('fail', 5);
    expect(t.lastReason).toBe('error');
    t.hook('prompt', 6);
    expect(t.lastReason).toBe('error'); // stays at the last waiting reason while working
    const h = new StatusTracker(1000);
    h.input(0, true);
    h.output(500);
    h.tick(2000);
    expect(h.status).toBe('waiting');
    expect(h.lastReason).toBe('done');
  });
});

describe('H2 late busy hooks after a plain Stop', () => {
  it('replay: prompt -> tools -> Stop -> trailing PostToolUse / SubagentStop never flip the cell or alert again', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(2000, 'busy');
    s.output(2500);
    s.hook(9000, 'busy');
    s.hook(10_000, 'stop', { tasks: 0, active: 0, statuses: [] });
    s.hook(10_050, 'busy'); // PostToolUse that trails the Stop
    s.hook(10_300, 'busy'); // SubagentStop
    s.run(10_300, 5 * 60_000);
    expect(s.changes.map((c) => `${c.from}->${c.to}:${c.alert}`)).toEqual(['idle->working:false', 'working->waiting:true']);
    expect(s.t.status).toBe('waiting');
  });

  it('a new prompt reopens the turn and busy hooks work again', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'stop');
    s.hook(200, 'busy');
    s.hook(300, 'prompt'); // also what Claude sends for a turn it starts itself
    s.hook(400, 'busy');
    expect(s.t.status).toBe('working');
    s.hook(500, 'stop');
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(2);
  });

  it('background mode still resumes on busy and ends with a real Stop', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'stopbg', { tasks: 1, active: 1, statuses: ['running'] });
    s.hook(60_000, 'busy');
    expect(s.t.status).toBe('working');
    s.hook(70_000, 'stop');
    s.hook(70_100, 'busy');
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(1);
  });

  it('a permission prompt after a Stop (the agent asks again) reopens the turn for the answer', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'stop');
    s.hook(200, 'notify');
    s.input(300, false);
    expect(s.t.status).toBe('working');
    s.hook(400, 'busy');
    expect(s.t.status).toBe('working');
  });

  it('a hooked cell that stalls (lost Stop) turns waiting silently; non-hooked cells still alert', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.output(1000);
    s.run(1000, 1000 + STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastCause).toBe('heuristic');
    expect(s.alerts()).toBe(0);
    expect(shouldNotify('working', 'waiting', 'heuristic', false)).toBe(true); // Codex / no hooks
    expect(shouldNotify('working', 'waiting', 'hook', true)).toBe(true);
    expect(shouldNotify('idle', 'waiting', 'hook', true)).toBe(true);
  });

  it('Esc on a working hooked cell does not alert either', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.output(1000);
    s.interrupt(2000);
    s.run(2000, 2000 + INTERRUPT_QUIET_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(0);
  });
});

describe('H3 stale background tasks', () => {
  it('the background silence net is 4 minutes and ends in waiting with one late alert', () => {
    expect(BG_STALL_MS).toBe(4 * 60_000);
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stopbg', { tasks: 2, active: 2, statuses: ['running'] }); // stale tasks of the previous session
    s.run(1000, 1000 + BG_STALL_MS - 1000);
    expect(s.t.status).toBe('working');
    s.run(1000 + BG_STALL_MS - 1000, 1000 + BG_STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(1);
    expect(s.t.lastStallKind).toBe('bg');
  });

  it('SessionStart resume / clear / startup / fork end background mode: waiting, no alert', () => {
    for (const source of ['startup', 'resume', 'clear', 'fork']) {
      const s = sim();
      s.hook(0, 'prompt');
      s.hook(1000, 'stopbg', { tasks: 2, active: 2, statuses: ['running'] });
      s.hook(5000, 'session', { source });
      expect(s.t.status, source).toBe('waiting');
      expect(s.alerts(), source).toBe(0);
      // and the next turn uses the ordinary short net again
      s.hook(6000, 'prompt');
      s.run(6000, 6000 + STALL_MS + 1000);
      expect(s.t.status, source).toBe('waiting');
    }
  });

  it('SessionStart compact keeps the working status but drops background mode (short net applies)', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stopbg');
    s.hook(5000, 'session', { source: 'compact' });
    expect(s.t.status).toBe('working');
    s.run(5000, 5000 + STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(0);
  });

  it('SessionStart outside background mode changes nothing', () => {
    for (const status of ['idle', 'working', 'waiting'] as const) {
      const t = new StatusTracker();
      if (status !== 'idle') t.hook('prompt', 0);
      if (status === 'waiting') t.hook('stop', 1);
      t.hook('session', 10, { source: 'resume' });
      expect(t.status).toBe(status);
    }
  });

  it('typing and submitting while background tasks run does not end background mode, and its echo does not extend the net', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stopbg');
    for (let ms = 60_000; ms < 100_000; ms += 400) { s.input(ms, false); s.output(ms + 50); } // typing + echo
    s.input(100_000, true); // Enter: a typed line, Claude has not reported UserPromptSubmit
    s.output(100_050);
    expect(s.t.status).toBe('working');
    // only the prompt hook (or a Stop) ends it: the net still counts from the last real output / hook (t = 1000)
    s.run(100_000, 1000 + BG_STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(1);
  });

  it('Esc / Ctrl-C do not end background mode (Esc Esc is rewind in Claude, so it says nothing about the tasks)', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'stopbg');
    s.interrupt(1000);
    s.interrupt(1500);
    s.run(1500, 1500 + INTERRUPT_QUIET_MS + STALL_MS);
    expect(s.t.status).toBe('working');
  });

  it('background tasks that finish: the self-started turn comes with a prompt hook and a real Stop alerts', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'stopbg', { tasks: 1, active: 1, statuses: ['running'] });
    s.hook(90_000, 'prompt');
    s.hook(95_000, 'stop', { tasks: 1, active: 0, statuses: ['completed'] });
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(1);
  });
});

describe('H4 a click on the cell is not activity', () => {
  it('focus / mouse reports are not user input', () => {
    for (const d of ['\x1b[I', '\x1b[O', '\x1b[<0;12;4M', '\x1b[<0;12;4m', '\x1b[M !!']) expect(isUserInput(d), JSON.stringify(d)).toBe(false);
  });

  it('a permission prompt that is waiting stays waiting through focus and mouse reports', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'notify');
    s.reply(2000); // focus-in
    s.output(2050); // Claude redraws
    s.reply(2100); // mouse click report
    s.output(2150);
    expect(s.t.status).toBe('waiting');
    s.input(3000, false); // a real key answers it
    expect(s.t.status).toBe('working');
  });

  it('a waiting cell after Stop stays waiting for clicks, redraws and an empty Enter', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stop');
    for (let n = 0; n < 20; n++) { s.reply(5000 + n * 2000); s.output(5100 + n * 2000); s.output(5600 + n * 2000); }
    s.input(60_000, true);
    s.run(60_000, 120_000);
    expect(s.t.status).toBe('waiting');
    expect(s.changes.map((c) => c.to)).toEqual(['working', 'waiting']);
  });

  it('a heuristic waiting (after a stall) is not revived by the redraw that follows a click', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.run(0, STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    s.reply(60_000);
    for (let ms = 60_100; ms < 60_000 + FOCUS_ECHO_MS; ms += 100) s.output(ms); // long enough redraw burst, but within the focus window
    expect(s.t.status).toBe('waiting');
  });

  it('a real recovery (the agent keeps drawing long after the click) still works', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.run(0, STALL_MS + 1000);
    s.reply(60_000);
    for (let ms = 70_000; ms <= 74_000; ms += 500) s.output(ms);
    expect(s.t.status).toBe('working');
  });

  it('background mode: the redraw after a click does not extend the silence net', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stopbg');
    for (let ms = 30_000; ms < BG_STALL_MS; ms += 20_000) { s.reply(ms); s.output(ms + 100); s.output(ms + 600); }
    s.run(1000, 1000 + BG_STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
  });

  it('a working cell keeps counting spinner output next to a click (the spinner is real activity)', () => {
    const s = sim();
    s.hook(0, 'prompt');
    for (let ms = 1000; ms <= 100_000; ms += 1000) { if (ms % 7000 === 0) s.reply(ms); s.output(ms); s.run(ms, ms); }
    expect(s.t.status).toBe('working');
  });
});

describe('H5 other flip-flop sources', () => {
  it('a restart (reset) forgets the ended turn and the hooked state', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stop', 1);
    t.reset();
    expect(t.status).toBe('idle');
    expect(t.isHooked).toBe(false);
    t.hook('busy', 10); // first hook of the new process is a tool call
    expect(t.status).toBe('working');
  });

  it('startup redraws of a resumed cell never fake activity (no turn observed)', () => {
    const s = sim();
    s.reply(0);
    for (let ms = 100; ms < 20_000; ms += 400) s.output(ms);
    s.run(0, 60_000);
    expect(s.changes).toEqual([]);
  });

  it('SessionStart on a fresh tracker does not mark it hooked', () => {
    const t = new StatusTracker(1000);
    t.hook('session', 0, { source: 'startup' });
    expect(t.isHooked).toBe(false);
    t.input(10, true);
    t.output(500);
    expect(t.tick(600)).toBe('working'); // the heuristic still works
  });

  it('an exited cell ignores every hook', () => {
    const t = new StatusTracker();
    t.exited();
    for (const ev of ['prompt', 'stop', 'fail', 'session', 'busy'] as const) expect(t.hook(ev, 0)).toBe('ignored');
    expect(t.status).toBe('exited');
  });
});

describe('status log', () => {
  it('keeps the newest 300 entries and formats plain text without message content', () => {
    const log = new StatusLog();
    for (let i = 0; i < 350; i++) log.push({ at: 1_700_000_000_000 + i, cellId: 'c1', from: 'working', to: 'waiting', cause: 'hook', trigger: 'stop', reason: 'done' });
    expect(STATUS_LOG_LIMIT).toBe(300);
    expect(log.size).toBe(300);
    expect(log.list()[0].at).toBe(1_700_000_000_050);
    const lines = log.toText().split('\n');
    expect(lines).toHaveLength(300);
    expect(lines[0]).toBe('2023-11-14T22:13:20.050Z cell=c1 working->waiting cause=hook trigger=stop reason=done');
  });

  it('marks the newest entry of a cell as having raised an alert', () => {
    const log = new StatusLog();
    const base = { from: 'working', to: 'waiting', cause: 'hook', trigger: 'stop' } as const;
    log.push({ ...base, at: 0, cellId: 'a' });
    log.push({ ...base, at: 1, cellId: 'b' });
    log.push({ ...base, at: 2, cellId: 'a' });
    log.markAlert('a');
    expect(log.list().map((e) => !!e.alert)).toEqual([false, false, true]);
    expect(log.toText().split('\n')[2]).toContain(' alert');
  });

  it('formats unchanged and ignored hook events and their diagnostics', () => {
    expect(formatEntry({ at: 0, cellId: 'c', from: 'waiting', to: 'waiting', cause: 'hook', trigger: 'busy', note: 'ignored' }))
      .toBe('1970-01-01T00:00:00.000Z cell=c waiting (unchanged) cause=hook trigger=busy ignored');
    expect(hookDetail({ tasks: 2, active: 1, statuses: ['running', 'completed'] })).toBe('tasks=2 active=1 task_status=running,completed');
    expect(hookDetail({ error: 'rate_limit' })).toBe('error=rate_limit');
    expect(hookDetail({ source: 'resume' })).toBe('source=resume');
    expect(hookDetail()).toBe('');
  });
});

