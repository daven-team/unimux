// Event timelines -> states for the 1.0.7 status signals: PermissionRequest / AskUserQuestion / Elicitation (needs you at
// once), idle_prompt, compaction, tool names, and the shell's prompt marks (OSC 133) for shell and agent cells.
// The timelines follow what Claude Code 2.1.310 really sent (scripts/status-timeline.mjs against a local API mock).
import { describe, expect, it } from 'vitest';
import {
  AGENT_EXIT_QUIET_MS, INTERRUPT_QUIET_MS, SHELL_LONG_MS, shouldNotify, StatusTracker,
  type CellStatus, type HookEvent, type HookInfo, type StatusCause,
} from '../src/shared/status';
import type { ShellMarkKind } from '../src/shared/shellIntegration';

interface Change { at: number; from: CellStatus; to: CellStatus; cause: StatusCause; alert: boolean; reason: string }

function sim(opts: { agent?: boolean; codex?: boolean; interactive?: () => boolean } = {}) {
  const t = new StatusTracker();
  t.setAgent(opts.agent ?? true);
  t.setCodex(opts.codex ?? false);
  if (opts.interactive) t.interactiveGuard = opts.interactive;
  const changes: Change[] = [];
  const watch = (at: number, change: () => void) => {
    const prev = t.status;
    change();
    if (t.status !== prev) changes.push({ at, from: prev, to: t.status, cause: t.lastCause, alert: shouldNotify(prev, t.status, t.lastCause, t.isHooked), reason: t.lastReason });
  };
  return {
    t,
    changes,
    alerts: () => changes.filter((c) => c.alert),
    hook: (at: number, ev: HookEvent, info?: HookInfo) => { let r: string = ''; watch(at, () => { r = t.hook(ev, at, info); }); return r; },
    output: (at: number) => watch(at, () => t.output(at)),
    input: (at: number, submitted = false) => watch(at, () => t.input(at, submitted)),
    interrupt: (at: number) => watch(at, () => { t.input(at, false); t.interrupt(at); }),
    mark: (at: number, kind: ShellMarkKind, code?: number) => watch(at, () => t.shellMark(kind, at, code)),
    run: (from: number, to: number) => { for (let n = from; n <= to; n += 400) watch(n, () => { t.tick(n); }); },
  };
}

/** The shell prompt, then the app types the CLI's command line and PSReadLine reports C. */
function launched(s: ReturnType<typeof sim>, at = 0) {
  s.mark(at, 'D', 0); s.mark(at, 'A'); s.mark(at, 'B');
  s.mark(at + 200, 'C');
}

describe('permission dialogs (PermissionRequest)', () => {
  it('needs you the moment the dialog opens, with the tool, and alerts once even when the Notification follows 6 s later', () => {
    const s = sim();
    launched(s);
    s.hook(10_100, 'prompt');
    s.hook(10_200, 'busy', { tool: 'Bash', toolUseId: 'toolu_1' });
    expect(s.t.detail).toEqual({ kind: 'tool', tool: 'Bash' });
    s.hook(10_400, 'notify', { need: 'permission', immediate: true, tool: 'Bash' });
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastReason).toBe('attention');
    expect(s.t.detail).toEqual({ kind: 'permission', tool: 'Bash' });
    s.output(11_000);
    s.run(10_400, 16_000);
    s.hook(16_400, 'notify', { need: 'permission' }); // Notification permission_prompt, ~6 s later
    expect(s.t.detail).toEqual({ kind: 'permission', tool: 'Bash' });
    expect(s.alerts()).toHaveLength(1);
    expect(s.alerts()[0].reason).toBe('attention');
    s.input(22_000, true); // Enter = allow
    expect(s.t.status).toBe('working');
    expect(s.t.detail).toBeUndefined();
    s.hook(24_900, 'busy', { tool: 'Bash', toolUseId: 'toolu_1', toolEnd: true });
    s.hook(25_000, 'stop', { tasks: 0, active: 0 });
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastReason).toBe('done');
    expect(s.alerts().map((a) => a.reason)).toEqual(['attention', 'done']);
  });

  it('a dialog answered within 6 s (no Notification at all) still showed and alerted "needs you"', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'busy', { tool: 'Bash', toolUseId: 'toolu_1' });
    s.hook(300, 'notify', { need: 'permission', immediate: true, tool: 'Bash' });
    s.input(3900, true);
    s.hook(5900, 'busy', { tool: 'Bash', toolUseId: 'toolu_1', toolEnd: true });
    s.hook(6000, 'stop');
    expect(s.changes.map((c) => c.to)).toEqual(['working', 'waiting', 'working', 'waiting']);
    expect(s.alerts().map((a) => a.reason)).toEqual(['attention', 'done']);
  });

  it('a PermissionRequest right after the user answered another one is a new question, not a late hook', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'notify', { need: 'permission', immediate: true, tool: 'Bash' });
    s.input(2000, true);
    s.hook(2200, 'notify', { need: 'permission', immediate: true, tool: 'Edit' });
    expect(s.t.status).toBe('waiting');
    expect(s.t.detail).toEqual({ kind: 'permission', tool: 'Edit' });
    expect(s.alerts()).toHaveLength(2);
  });

  it('the end of the very tool call that asked answers it (approved elsewhere); a parallel call ending does not', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(50, 'busy', { tool: 'Read', toolUseId: 'toolu_r' });
    s.hook(100, 'busy', { tool: 'Bash', toolUseId: 'toolu_b' });
    s.hook(200, 'notify', { need: 'permission', immediate: true, tool: 'Bash' });
    s.hook(400, 'busy', { tool: 'Read', toolUseId: 'toolu_r', toolEnd: true });
    expect(s.t.status).toBe('waiting');
    s.hook(900, 'busy', { tool: 'Bash', toolUseId: 'toolu_b', toolEnd: true });
    expect(s.t.status).toBe('working');
  });

  it('Esc on the dialog (deny, Claude sends no Stop): quiet waiting after the interrupt net, marked as interrupted', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'busy', { tool: 'Bash', toolUseId: 'toolu_1' });
    s.hook(300, 'notify', { need: 'permission', immediate: true, tool: 'Bash' });
    s.interrupt(5000);
    expect(s.t.status).toBe('working');
    s.run(5000, 5000 + INTERRUPT_QUIET_MS + 400);
    expect(s.t.status).toBe('waiting');
    expect(s.t.detail).toEqual({ kind: 'interrupted' });
    expect(s.alerts()).toHaveLength(1); // only the dialog itself
  });
});

describe('questions and MCP input', () => {
  it('AskUserQuestion needs you at its PreToolUse; its PermissionRequest and PostToolUse follow', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'notify', { need: 'question', immediate: true, tool: 'AskUserQuestion', toolUseId: 'toolu_q' });
    s.hook(120, 'notify', { need: 'permission', immediate: true, tool: 'AskUserQuestion' });
    expect(s.t.status).toBe('waiting');
    s.hook(6100, 'notify', { need: 'permission' }); // Notification permission_prompt about 6 s later
    expect(s.t.detail).toEqual({ kind: 'question' });
    expect(s.alerts()).toHaveLength(1);
    s.hook(9000, 'busy', { tool: 'AskUserQuestion', toolUseId: 'toolu_q', toolEnd: true });
    expect(s.t.status).toBe('working');
    s.hook(9100, 'stop');
    expect(s.alerts().map((a) => a.reason)).toEqual(['attention', 'done']);
  });

  it('Elicitation needs you; ElicitationResult goes back to work', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'busy', { tool: 'mcp__db__query', toolUseId: 'toolu_m' });
    expect(s.t.detail).toEqual({ kind: 'tool', tool: 'db/query' });
    s.hook(200, 'notify', { need: 'elicitation', immediate: true });
    expect(s.t.detail).toEqual({ kind: 'elicitation' });
    s.hook(5000, 'busy', { answered: true });
    expect(s.t.status).toBe('working');
    expect(s.t.detail).toBeUndefined();
  });
});

describe('idle_prompt and compaction', () => {
  it('idle_prompt ends a "working" whose turn end was lost, quietly; it changes nothing on a waiting cell', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.output(1000);
    expect(s.hook(61_000, 'idle')).toBe('applied');
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toHaveLength(0);
    for (let at = 61_000; at < 66_000; at += 200) s.output(at);
    expect(s.t.status).toBe('waiting');
    expect(s.hook(66_000, 'idle')).toBe('ignored');
  });

  it('idle_prompt never ends a background-task run', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'stopbg', { tasks: 1, active: 1 });
    expect(s.t.detail).toEqual({ kind: 'background' });
    expect(s.hook(60_000, 'idle')).toBe('ignored');
    expect(s.t.status).toBe('working');
  });

  it('/compact after a finished turn: working while it runs, back to waiting (no Stop follows), no alert', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'stop');
    s.hook(7_000, 'compact', { trigger: 'manual' });
    expect(s.t.status).toBe('working');
    expect(s.t.detail).toEqual({ kind: 'compact' });
    s.hook(7_100, 'busy', { subagent: true }); // the compaction's own SubagentStop
    s.hook(9_000, 'compacted', { trigger: 'manual' });
    expect(s.t.status).toBe('waiting');
    for (let at = 9_000; at < 14_000; at += 200) s.output(at); // Claude redraws its prompt: that is no new work
    expect(s.t.status).toBe('waiting');
    expect(s.t.detail).toBeUndefined();
    expect(s.alerts()).toHaveLength(1); // the turn's own Stop
  });

  it('an automatic compaction inside a turn keeps it working and only names the work', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'compact', { trigger: 'auto' });
    expect(s.t.detail).toEqual({ kind: 'compact' });
    s.hook(5000, 'compacted', { trigger: 'auto' });
    expect(s.t.status).toBe('working');
    expect(s.t.detail).toBeUndefined();
    expect(s.hook(9000, 'compact', { trigger: 'auto' })).toBe('applied');
    s.hook(9100, 'stop');
    expect(s.hook(9200, 'compact', { trigger: 'auto' })).toBe('ignored'); // not after the turn
  });
});

describe('tool and subagent details', () => {
  it('names the running tool, clears it when that call ends, keeps it when a parallel call ends', () => {
    const s = sim();
    s.hook(0, 'prompt');
    expect(s.t.detail).toBeUndefined();
    s.hook(100, 'busy', { tool: 'Edit', toolUseId: 'a' });
    s.hook(150, 'busy', { tool: 'Grep', toolUseId: 'b' });
    expect(s.t.detail).toEqual({ kind: 'tool', tool: 'Grep' });
    s.hook(200, 'busy', { tool: 'Edit', toolUseId: 'a', toolEnd: true });
    expect(s.t.detail).toEqual({ kind: 'tool', tool: 'Grep' });
    s.hook(300, 'busy', { tool: 'Grep', toolUseId: 'b', toolEnd: true });
    expect(s.t.detail).toBeUndefined();
  });

  it('a background subagent after the Stop neither reopens the turn nor changes its detail', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'busy', { subagent: true, subagentStart: true, agentType: 'Explore' });
    expect(s.t.detail).toEqual({ kind: 'subagent', tool: 'Explore' });
    s.hook(300, 'stop');
    expect(s.hook(5000, 'busy', { subagent: true, subagentStart: true, agentType: 'Explore' })).toBe('ignored');
    expect(s.hook(9000, 'busy', { subagent: true })).toBe('ignored');
    expect(s.t.status).toBe('waiting');
    expect(s.t.detail).toBeUndefined();
  });

  it('odd tool names never reach the detail', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(100, 'busy', { tool: 'rm -rf /; echo', toolUseId: 'a' });
    expect(s.t.detail).toBeUndefined();
  });
});

describe('shell cells with prompt marks', () => {
  it('a silent long command is "working" from C to the next prompt, then waiting; the prompt redraw is no work', () => {
    const s = sim({ agent: false });
    s.mark(0, 'D', 0); s.mark(0, 'A'); s.mark(0, 'B');
    s.output(100);
    s.input(5000, true);
    s.mark(5000, 'C');
    expect(s.t.status).toBe('working');
    expect(s.t.detail).toEqual({ kind: 'command' });
    s.run(5000, 13_000); // no output at all
    expect(s.t.status).toBe('working');
    s.mark(13_900, 'D', 0); s.mark(13_900, 'A');
    s.output(13_950);
    expect(s.t.status).toBe('waiting');
    expect(s.t.detail).toBeUndefined();
    s.run(13_950, 20_000);
    expect(s.t.status).toBe('waiting'); // (decideAlert never alerts for shell cells)
  });

  it('a quick command returns to idle; a failing one keeps its exit code; Ctrl-C is no failure', () => {
    const s = sim({ agent: false });
    s.mark(0, 'A');
    s.mark(1000, 'C');
    s.mark(1100, 'D', 0); s.mark(1100, 'A');
    expect(s.t.status).toBe('idle');
    s.mark(2000, 'C');
    s.mark(2500, 'D', 3); s.mark(2500, 'A');
    expect(s.t.status).toBe('idle');
    expect(s.t.detail).toEqual({ kind: 'exit-code', code: 3 });
    s.mark(3000, 'C');
    s.interrupt(9000);
    s.mark(9100, 'D', 1); s.mark(9100, 'A');
    expect(s.t.status).toBe('idle');
    expect(s.t.detail).toBeUndefined();
    s.mark(10_000, 'C');
    s.mark(10_000 + SHELL_LONG_MS, 'D', 2); s.mark(10_000 + SHELL_LONG_MS, 'A');
    expect(s.t.status).toBe('waiting');
    expect(s.t.detail).toEqual({ kind: 'exit-code', code: 2 });
  });

  it('cmd.exe (no C mark): Enter at the prompt starts the command; an empty Enter is over at once', () => {
    const s = sim({ agent: false });
    s.mark(0, 'D'); s.mark(0, 'A'); s.mark(0, 'B');
    s.input(1000, true);
    expect(s.t.status).toBe('working');
    s.run(1000, 6000);
    expect(s.t.status).toBe('working');
    s.input(4000, true); // Enter inside the running program changes nothing
    s.mark(7000, 'D'); s.mark(7000, 'A');
    expect(s.t.status).toBe('waiting');
    s.input(8000, true);
    s.mark(8050, 'D'); s.mark(8050, 'A');
    expect(s.t.status).toBe('idle');
  });

  it('a full-screen program (or an agent typed by hand) is judged by its output while the marks say it runs', () => {
    let interactive = false;
    const s = sim({ agent: false, interactive: () => interactive });
    s.mark(0, 'A');
    s.input(1000, true);
    s.mark(1000, 'C');
    interactive = true;
    s.output(1200);
    s.run(1200, 4000);
    expect(s.t.status).toBe('waiting'); // silent at its own prompt
    interactive = false;
    s.mark(9000, 'D', 0); s.mark(9000, 'A');
    expect(s.t.status).toBe('waiting');
  });

  it('without any marks the old output heuristic still applies', () => {
    const s = sim({ agent: false });
    s.input(0, true);
    s.output(500);
    expect(s.t.status).toBe('working');
    s.run(500, 3000);
    expect(s.t.status).toBe('waiting');
  });
});

describe('agent cells with prompt marks: the CLI ends', () => {
  it('/exit: the prompt after the CLI is back, idle with "CLI ended", no alert; late hooks are dropped', () => {
    const s = sim();
    launched(s);
    s.hook(1000, 'session', { source: 'startup' });
    s.hook(2000, 'prompt');
    s.hook(2100, 'stop');
    s.input(9000, true); // /exit
    s.mark(9600, 'D', 0); s.mark(9600, 'A'); s.mark(9600, 'B');
    expect(s.t.status).toBe('idle');
    expect(s.t.detail).toEqual({ kind: 'cli-exited' });
    expect(s.hook(9700, 'stop')).toBe('ignored');
    expect(s.alerts()).toHaveLength(1); // the turn's Stop only
  });

  it('the CLI dies in the middle of a turn with nobody at the keyboard: an error alert with its exit code', () => {
    const s = sim();
    launched(s);
    s.input(1000, true);
    s.hook(1000, 'prompt');
    s.output(2000);
    s.mark(2000 + AGENT_EXIT_QUIET_MS + 100, 'D', 1);
    s.mark(2000 + AGENT_EXIT_QUIET_MS + 100, 'A');
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastReason).toBe('error');
    expect(s.t.lastError).toBe('cli-exited');
    expect(s.t.detail).toEqual({ kind: 'cli-exited', code: 1 });
    expect(s.alerts().map((a) => a.reason)).toEqual(['error']);
  });

  it('Ctrl-C twice to quit in the middle of a turn: idle, no alert', () => {
    const s = sim();
    launched(s);
    s.input(1000, true);
    s.hook(1000, 'prompt');
    s.interrupt(4000);
    s.interrupt(4300);
    s.mark(4800, 'D', 0); s.mark(4800, 'A');
    expect(s.t.status).toBe('idle');
    expect(s.alerts()).toHaveLength(0);
  });

  it('without C marks (cmd.exe) a prompt redrawn at the launch is no exit; a prompt after the CLI ran is', () => {
    const s = sim();
    s.mark(0, 'D'); s.mark(0, 'A'); s.mark(0, 'B');
    s.mark(150, 'A'); // transient prompt redraw on Enter
    expect(s.t.detail).toBeUndefined();
    s.hook(2000, 'session', { source: 'startup' });
    s.mark(30_000, 'D'); s.mark(30_000, 'A');
    expect(s.t.detail).toEqual({ kind: 'cli-exited' });
  });

  it('after the CLI ended the cell is a shell; a restart (reset) makes it an agent cell again', () => {
    const s = sim();
    launched(s);
    s.hook(1000, 'session', { source: 'startup' });
    s.mark(5000, 'D', 0); s.mark(5000, 'A');
    s.mark(6000, 'C');
    expect(s.t.status).toBe('working');
    s.t.reset();
    expect(s.t.detail).toBeUndefined();
    launched(s, 10_000);
    s.hook(11_000, 'prompt');
    expect(s.t.status).toBe('working');
    expect(s.t.isHooked).toBe(true);
  });

  it('a Codex approval is "needs you" with an input detail', () => {
    const s = sim({ codex: true });
    s.input(0, true);
    s.output(300);
    expect(s.t.osc9()).toBe('applied');
    expect(s.t.status).toBe('waiting');
    expect(s.t.detail).toEqual({ kind: 'input' });
  });
});
