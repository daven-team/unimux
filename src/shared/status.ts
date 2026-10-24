// Per-cell agent status. Precise signals (Claude hooks, Codex notify and its approval OSC 9) win; otherwise (and until the
// first hook arrives) a heuristic:
// after the user submits (Enter), non-echo output means "working", and silence after that
// means the agent finished and is "waiting" for the user. Nothing is inferred before a turn was
// observed in this session, so restored/resumed agents never start out as "waiting".

// Signal priority per cell kind (the most reliable one decides, the next ones only fill gaps):
//   Claude:  hooks (PermissionRequest / AskUserQuestion / Elicitation = needs you at once, Stop = done, StopFailure = error,
//            tool hooks = working with the tool's name) > the shell's prompt marks (the CLI ended) > silence nets.
//   Codex:   notify (turn end) + its approval OSC 9 > the shell's prompt marks > output heuristics with timeouts.
//   Shell:   prompt marks (OSC 133 / 633: command running vs at the prompt, exit code) > output heuristics.
import { CodexThreads, type BoundThread } from './codexHooks';
import type { ShellMarkKind } from './shellIntegration';

export type CellStatus = 'idle' | 'working' | 'waiting' | 'exited';

export type StatusDetailKind =
  /** working: a tool runs (PreToolUse). */
  | 'tool'
  /** working: a subagent runs (SubagentStart). */
  | 'subagent'
  /** working: the context is being compacted (PreCompact). */
  | 'compact'
  /** working: the turn ended but background tasks still run (Stop with background_tasks). */
  | 'background'
  /** waiting (attention): a permission dialog (PermissionRequest, Notification permission_prompt). */
  | 'permission'
  /** waiting (attention): AskUserQuestion. */
  | 'question'
  /** waiting (attention): an MCP server asks for input (Elicitation). */
  | 'elicitation'
  /** waiting (attention): another question for the user (agent_needs_input, a stale usage-limit resume, a Codex approval). */
  | 'input'
  /** waiting: the user pressed Esc / Ctrl-C and no turn end followed. */
  | 'interrupted'
  /** shell: a command runs (OSC 133 C, or Enter at a marked prompt). */
  | 'command'
  /** shell: the last command ended with a non-zero exit code. */
  | 'exit-code'
  /** agent cell: the agent CLI ended and the prompt of its shell is back. */
  | 'cli-exited';

/** The short reason of the current status (the card shows it as secondary text, see statusDetail.ts). Never any message text. */
export interface StatusDetail {
  kind: StatusDetailKind;
  /** Tool name (tool, permission), subagent type (subagent). */
  tool?: string;
  /** Exit code (exit-code, cli-exited). */
  code?: number;
}

export function sameDetail(a: StatusDetail | undefined, b: StatusDetail | undefined): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && a.tool === b.tool && a.code === b.code);
}

const SAFE_NAME = /^[\w.:@/-]{1,80}$/;

/** A tool name as reported by a hook, shortened for a card (mcp__server__tool -> server/tool); undefined for anything odd. */
export function shortToolName(name: unknown): string | undefined {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return undefined;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]}/${mcp[2]}` : name;
}
/**
 * prompt = UserPromptSubmit, stop = Stop, stopbg = Stop while background tasks still run, notify = permission/question,
 * busy = tool or subagent activity, fail = StopFailure (the turn ended with an API error), session = SessionStart,
 * idle = Notification idle_prompt (Claude has sat at its prompt for a minute), compact / compacted = Pre/PostCompact.
 */
export type HookEvent = 'prompt' | 'stop' | 'stopbg' | 'notify' | 'busy' | 'fail' | 'session' | 'idle' | 'compact' | 'compacted';
export type StatusCause = 'heuristic' | 'hook';
/** Why the cell is waiting: the turn finished (Stop / silence), the agent needs an answer, or the turn failed. */
export type StatusReason = 'done' | 'attention' | 'error';

/** Diagnostics that travel with a hook event (never any message text). */
export interface HookInfo {
  /** Stop: number of listed background tasks and how many of them are not clearly finished. */
  tasks?: number;
  active?: number;
  /** Stop: distinct task status strings. */
  statuses?: string[];
  /** Stop: distinct task types (shell, agent...). */
  types?: string[];
  /** Stop: the payload said stop_hook_active, i.e. Claude was continuing because a Stop hook blocked the stop. */
  continuation?: boolean;
  /** Stop: running tasks of workflow type (a dynamic workflow keeps the session busy for hours, often silently). */
  workflows?: number;
  /** Stop: `background_tasks` was absent or not an array (registry unreachable): "unknown", never "nothing runs". */
  tasksUnknown?: boolean;
  /** busy: SubagentStop, which never reopens a closed turn. */
  subagent?: boolean;
  /** StopFailure: the error code. */
  error?: string;
  /** SessionStart: startup | resume | clear | compact | fork. */
  source?: string;
  /** Stop of a Codex cell (its notify hook: the turn completed). */
  codex?: boolean;
  /** Codex notify: the turn that completed; one alert per turn. */
  turnId?: string;
  /** Codex notify: the conversation (thread) that reported; a sub-agent's thread is not the cell's. */
  threadId?: string;
  /** Listener side: the turn the alert belongs to (undefined = no per-turn dedupe, i.e. hook-driven Claude). */
  turn?: string;
  /** notify: what the user is asked (PermissionRequest, AskUserQuestion, Elicitation, a Notification type). */
  need?: 'permission' | 'question' | 'elicitation' | 'input';
  /** notify: fired the moment the question opened (not a Notification that comes ~6 s later), so no answer grace applies. */
  immediate?: boolean;
  /** busy / notify: the tool's name (PreToolUse, PostToolUse, PermissionRequest). */
  tool?: string;
  /** busy / notify: the tool call's id; the end of the call that opened a question answers it. */
  toolUseId?: string;
  /** busy: PostToolUse / PostToolUseFailure / PermissionDenied: the tool call ended. */
  toolEnd?: boolean;
  /** busy: SubagentStart (with `subagent`). */
  subagentStart?: boolean;
  /** busy: the subagent's type (SubagentStart). */
  agentType?: string;
  /** busy: ElicitationResult: the user answered an MCP server's question. */
  answered?: boolean;
  /** compact / compacted: manual (/compact) or auto. */
  trigger?: 'manual' | 'auto';
}

export const ECHO_MS = 250;
/** Output right after a focus report / mouse report (a click on the cell) is the agent redrawing, not working. */
export const FOCUS_ECHO_MS = 1000;
/** Output separated by more than this starts a new activity run. */
export const GAP_MS = 1500;
/** An uninterrupted output run this long means the agent is busy (e.g. its "Working (12s)" timer). */
export const SUSTAIN_MS = 3000;
/** Ticks further apart than this mean the machine slept or the window was throttled. */
export const SUSPEND_MS = 10_000;
/** A hooked agent that is silent this long while "working" lost its Stop (killed subagent, crash). */
export const STALL_MS = 30_000;
/**
 * Silence net while Claude reported background tasks at its last Stop (it starts a new turn itself when they finish).
 * Short on purpose: after a restart Claude may still list tasks of the previous session as running.
 */
export const BG_STALL_MS = 4 * 60_000;
/**
 * Silence net while Claude reported a running dynamic workflow at its last Stop. Workflows stay quiet for hours (their
 * agents fire no hooks in this session), so the net is long and ends silently: the real end comes as Claude's next turn.
 */
export const WORKFLOW_STALL_MS = 6 * 60 * 60_000;
/** Tool hooks arriving this soon after a Stop / StopFailure are its late siblings (curl requests race), not a new turn. */
export const END_GRACE_MS = 3000;
/** A permission notification this soon after the user answered a prompt (or submitted) is the old prompt's late hook. */
export const ANSWER_GRACE_MS = 600;
/** Silence after the user pressed Esc / Ctrl-C on a hooked, working agent. */
export const INTERRUPT_QUIET_MS = 4000;
/**
 * A window minimize / restore, a tab switch or a wake from sleep makes the agent redraw (or the terminal replay output):
 * for this long such output neither starts a "working" run nor revives a waiting cell.
 */
export const ENV_QUIET_MS = 8000;
/** Silence net of a Codex cell whose notify hook works: its turn-end hook did not come (command line too long, curl failed). */
export const CODEX_QUIET_MS = 8000;
/**
 * A Codex notify only STARTS a pending turn end. It is committed (alert, session binding) at the first quiet gap of this
 * length in the (non-echo) output after it: a finished turn repaints briefly (final message, "Worked for", status bar) and
 * then goes quiet.
 */
export const CODEX_GAP_MS = 1200;
/**
 * The gap has to begin within this long after the notify. Output that keeps going without such a gap (a spinner, a parent
 * still working after a sub-agent's notify) means the notify was mid-turn: no alert, no binding, the thread is a sub-agent's.
 */
export const CODEX_WINDOW_MS = 4000;
/** A failed turn (usage limit) is the last thing Codex prints: waiting follows after this much silence. */
export const FAILURE_QUIET_MS = 1500;
/** A shell command that ran at least this long ends in "waiting" (worth a look); a shorter one just returns to idle. */
export const SHELL_LONG_MS = 5000;
/** A prompt this soon after Ctrl-C / Esc ends an interrupted command: idle, and its exit code is no failure. */
export const SHELL_INTERRUPT_MS = 3000;
/** An agent CLI that ends with no key pressed for this long while it was working crashed (or was killed). */
export const AGENT_EXIT_QUIET_MS = 5000;

/** Focus-in / focus-out and mouse reports: what a click on the cell makes the terminal write to the agent. */
export function isFocusOrMouseReport(data: string): boolean {
  return /^\x1b\[(?:[IO]|<[\d;]*[Mm]|M[\s\S]{3})$/.test(data);
}

/** Replies the terminal itself writes to the pty (focus reports, cursor/device reports, mouse) are not user input. */
export function isUserInput(data: string): boolean {
  // OSC/DCS replies end with BEL or ST, so a typed Alt+P / Alt+] (a bare ESC prefix) still counts.
  return !/^\x1b(?:\[(?:[IO]|\??[\d;]*[Rcn]|<[\d;]*[Mm]|M[\s\S]{3})|\][\s\S]*(?:\x07|\x1b\\)|P[\s\S]*\x1b\\)$/.test(data);
}

/**
 * Notify only for a real transition seen in this session: working -> waiting, or a live agent hook.
 * A hooked agent is judged by its hooks only: a silence-based "waiting" (lost Stop, background-task net, Esc) never alerts.
 */
export function shouldNotify(prev: CellStatus, next: CellStatus, cause: StatusCause, hooked = false): boolean {
  if (next !== 'waiting' || prev === 'waiting' || prev === 'exited') return false;
  if (hooked && cause !== 'hook') return false;
  return cause === 'hook' || prev === 'working';
}

/** renotify = a Stop that continued after an earlier Stop (stop_hook_active): the real end of the turn alerts again. */
export type HookResult = 'applied' | 'ignored' | 'renotify';
/** What ended a "working" state on a tick: the plain / background / Esc silence net, or a plain heuristic quiet window. */
export type StallKind = 'plain' | 'bg' | 'workflow' | 'interrupt' | 'heuristic' | 'codex' | 'error' | 'turn-end' | 'idle';

export class StatusTracker {
  status: CellStatus = 'idle';
  lastCause: StatusCause = 'heuristic';
  /** Why the cell last became "waiting" (stays at the last value while working). */
  lastReason: StatusReason = 'done';
  /** Error code of the last waiting-with-error: a StopFailure code or 'usage-limit' (Codex output). */
  lastError: string | undefined;
  /** Set by the last tick that moved the cell from working to waiting. */
  lastStallKind: StallKind | null = null;
  private lastInput = -Infinity;
  private lastFocus = -Infinity;
  private lastOutput = -Infinity;
  private lastTick = -Infinity;
  private activityStart = -Infinity;
  private interruptAt = -Infinity;
  private armed = false;
  private hooked = false;
  private turnObserved = false;
  private waitingFromNotify = false;
  private background = false;
  /**
   * The background mode was entered for a dynamic workflow named in the Stop payload: the long, silent net applies.
   * Other background tasks keep the short net (bgGuard may extend it while the screen shows the wait row).
   */
  private longBackground = false;
  /** Set by the renderer: true while the terminal still shows "Waiting for N dynamic workflow(s)" (src/shared/backgroundWait.ts). */
  bgGuard: (() => boolean) | null = null;
  /** When the current background mode began (the first stopbg after a prompt / Stop); caps the screen veto. */
  private backgroundSince = -Infinity;
  /** Codex cell: its approval OSC 9 is a precise attention signal, its turn end comes from the notify hook once that works. */
  private codexMode = false;
  /** The notify hook delivered an event in this process, so it is trusted to report turn ends. */
  private codexNotified = false;
  private lastTurnId: string | undefined;
  private codexTurn: string | undefined;
  /** Which Codex threads are this cell's and which are sub-agents; the cell's session is bound from committed turn ends only. */
  readonly threads = new CodexThreads();
  /** Called when a committed Codex turn end names a thread the cell's stored session should become. */
  onBind: ((thread: BoundThread) => void) | null = null;
  /** A notify arrived and is waiting for the quiet gap that commits it (see CODEX_GAP_MS); `last` is the latest non-echo output since. */
  private pendingEnd: { at: number; last: number; turnId?: string; threadId?: string } | null = null;
  private renotifyDue = false;
  /** Bumped by every `reset` (a new process): alert keys of an earlier process never match. */
  private generation = 0;
  /** A finished Codex turn was reopened by sustained output (a queued turn): a new alert key. */
  private reopenSeq = 0;
  /** User turns started in this process (Enter); the dedupe key of heuristic alerts. */
  private turnSeq = 0;
  private lastEnv = -Infinity;
  /** A failure line was seen in the output of the running turn; the next waiting becomes an error. */
  private pendingFailure: string | null = null;
  /** A Stop / StopFailure ended the turn; only a prompt, a background-mode Stop or a permission notification reopens it. */
  private turnEnded = false;
  private endedAt = -Infinity;
  private answeredAt = -Infinity;
  /** The short reason of the current status (tool, permission, exit code...); see StatusDetail. */
  detail: StatusDetail | undefined;
  /** The tool call whose end answers the open question (the PreToolUse before a PermissionRequest, an AskUserQuestion call). */
  private questionToolUse: string | undefined;
  /** The last PreToolUse: its id becomes questionToolUse when a PermissionRequest for the same tool follows. */
  private lastPre: { tool: string; id: string } | undefined;
  /** The tool call the detail names: its end clears the detail (parallel calls of other tools do not). */
  private detailToolUse: string | undefined;
  // ── shell prompt marks (OSC 133 / 633, see shellIntegration.ts) ──
  /** The cell launches an agent CLI in its shell (Claude / Codex profile); kept across `reset`. */
  private agentCell = false;
  /** The agent CLI of this process ended and its shell prompt is back: from now on the cell is judged as a shell. */
  private agentGone = false;
  /** Prompt marks arrived in this process: a shell cell's status comes from them. */
  private marked = false;
  /** The shell reports C (command start) itself; without it (cmd.exe, no PSReadLine) Enter at the prompt starts a command. */
  private markedStart = false;
  private atPrompt = false;
  private commandRunning = false;
  private commandSince = -Infinity;
  private lastExitCode: number | undefined;
  private promptsSeen = 0;
  private agentLaunched = false;
  private lastInterruptKey = -Infinity;
  /** A hook or notify of the agent CLI arrived in this process: it runs. */
  private agentSeen = false;
  /** A compaction runs (PreCompact without its PostCompact yet); /compact is manual. */
  private compacting: 'manual' | 'auto' | null = null;
  /** The quiet "waiting" came from a precise signal (idle_prompt, the end of /compact): output never revives it. */
  private quietPrecise = false;
  /** Set by the renderer: true while a full-screen program (or an agent typed by hand) runs in the shell, where marks say nothing. */
  interactiveGuard: (() => boolean) | null = null;

  constructor(private readonly quietMs = 2000) {}

  /** Marks the cell as one that launches an agent CLI (its first command); kept across `reset`. */
  setAgent(on: boolean): void {
    this.agentCell = on;
  }

  /** The cell is judged as a shell: a shell profile, or an agent cell whose CLI ended. */
  private get shellMode(): boolean {
    return !this.agentCell || this.agentGone;
  }

  /** Precise signals drive this cell: Claude hooks, or Codex whose notify hook has reported. */
  get isHooked(): boolean {
    return this.hooked || this.codexNotified;
  }

  /**
   * How long the cell has been in background mode (0 when it is not). The screen veto (bgGuard) holds only below
   * WORKFLOW_STALL_MS of it: the wait row is frozen in the transcript, so it cannot keep the cell working forever.
   */
  backgroundFor(now: number): number {
    return this.background ? now - this.backgroundSince : 0;
  }

  /** Marks a Codex cell (profile); kept across `reset`. */
  setCodex(on: boolean): void {
    this.codexMode = on;
  }

  /** Key of the turn an alert belongs to, so a turn alerts once; undefined for hook-driven (Claude) cells. */
  get turnKey(): string | undefined {
    if (this.hooked) return undefined;
    return `g${this.generation}:${this.codexTurn ?? `s:${this.turnSeq}`}${this.reopenSeq ? `:r${this.reopenSeq}` : ''}`;
  }

  /** True once after a tick that committed a Codex turn end on a cell that already waited (the end must alert again). */
  takeRenotify(): boolean {
    const due = this.renotifyDue;
    this.renotifyDue = false;
    return due;
  }

  /** Real user keystroke. `submitted` = it contained Enter. */
  input(now: number, submitted: boolean): void {
    if (this.status === 'exited') return;
    this.lastInput = now;
    if (submitted) {
      this.armed = true;
      this.turnObserved = true;
      this.turnSeq++;
      this.codexTurn = undefined;
      this.pendingFailure = null;
      this.pendingEnd = null; // the user went on: whatever that notify was, it no longer decides anything
      if (!this.hooked && !this.shellMode) this.detail = undefined; // a new Codex turn (hooks name Claude's own work)
    }
    if (submitted && this.status === 'working') this.answeredAt = now;
    // A marked shell that reports no command start itself (cmd.exe): Enter at its prompt starts the command.
    if (submitted && this.shellMode && this.marked && !this.markedStart && this.atPrompt) {
      this.commandStarted(now);
      return;
    }
    if (this.status !== 'waiting') return;
    if (this.hooked) {
      // Any key answers a permission prompt / question (digits, Esc, Enter); the silence net ends it if nothing follows.
      if (this.waitingFromNotify) {
        this.waitingFromNotify = false;
        this.questionToolUse = undefined;
        this.lastOutput = now;
        this.answeredAt = now;
        this.detail = undefined;
        this.set('working', 'heuristic');
      }
      // Waiting after Stop: UserPromptSubmit decides (an empty Enter must not fake work).
      return;
    }
    if (submitted) this.status = 'idle';
  }

  /**
   * Something the terminal itself wrote to the pty (focus-in / focus-out when the user clicks the cell, mouse reports):
   * not a keystroke, and the redraw it makes the agent do is not work.
   */
  terminalReply(now: number): void {
    if (this.status === 'exited') return;
    this.lastFocus = now;
  }

  /** Esc / Ctrl-C while a hooked agent works: Claude sends no Stop for an interrupt, so check for silence soon. */
  interrupt(now: number): void {
    this.lastInterruptKey = now;
    if (this.status === 'working' && this.isHooked && !this.background) this.interruptAt = now;
  }

  /**
   * The window was minimized / restored / hidden / resized, a tab was switched or the machine woke up. The agent's redraw
   * that follows (or a replay) is not work: it must not start a run, so a waiting cell cannot flip to working and alert again.
   */
  environment(now: number): void {
    if (this.status === 'exited') return;
    this.lastEnv = now;
    if (this.status !== 'working') {
      this.lastOutput = -Infinity;
      this.activityStart = -Infinity;
    }
  }

  /** A failure line appeared in the live output of a Codex turn (its usage limit): the next waiting is an error, not "done". */
  failure(code: string): void {
    if (this.status === 'exited' || !this.turnObserved) return;
    if (this.status === 'working' || this.armed) this.pendingFailure = code;
  }

  output(now: number): void {
    if (this.status === 'exited') return;
    // A marked shell says itself whether a command runs: output decides nothing, except inside a full-screen program (or an
    // agent typed by hand), where the marks only say "a command runs" and the output heuristic below judges it.
    if (this.shellMode && this.marked && !(this.commandRunning && this.interactiveGuard?.())) {
      if (this.commandRunning) this.lastOutput = now;
      return;
    }
    // Keystroke echo / prompt redraw / focus redraw. A working agent's spinner must still count while the user types,
    // but a background-mode cell is idle at its prompt: everything it prints right after a key or a click is a redraw.
    const redraw = now - this.lastInput < ECHO_MS || now - this.lastFocus < FOCUS_ECHO_MS;
    if (redraw && (this.status !== 'working' || this.background)) return;
    // Window / tab / wake redraws never start a run, unless the user just submitted (armed) or the agent is already working.
    if (now - this.lastEnv < ENV_QUIET_MS && !this.armed && this.status !== 'working') return;
    // A pending notify: a quiet gap before this output committed it (the tick had not run yet); output that never gets a gap means it was mid-turn.
    if (this.pendingEnd) {
      if (this.gapDone(now)) this.commitEnd();
      else if (now - this.pendingEnd.at > CODEX_WINDOW_MS + CODEX_GAP_MS) this.cancelPending();
      else this.pendingEnd.last = now;
    }
    if (now - this.lastOutput > GAP_MS) this.activityStart = now;
    this.lastOutput = now;
    // Hooks own the status, except to recover from a silence-based "waiting" that turned out premature (a quiet but precise
    // one, idle_prompt or the end of /compact, is no guess).
    if (this.hooked && !(this.status === 'waiting' && this.lastCause === 'heuristic' && !this.quietPrecise)) return;
    if (this.armed) {
      this.status = 'working';
      return;
    }
    // Recover from a premature "waiting" (pause or notification mid-turn): an agent that keeps
    // redrawing for SUSTAIN_MS is clearly still working. Needs a turn started in this session.
    if (this.turnObserved && now - this.activityStart >= SUSTAIN_MS) {
      // A Codex turn end that a notify (or a failure line) reported is reopened by sustained output too: a queued message,
      // or the failure line was only part of the turn. It is a new turn for the alerts.
      if (this.codexMode && this.status === 'waiting' && this.lastCause === 'hook' && this.lastReason !== 'attention') {
        this.reopenSeq++;
        this.codexTurn = undefined;
        this.pendingFailure = null;
      }
      this.set('working', 'heuristic');
      this.armed = true;
    }
  }

  hook(event: HookEvent, now: number, info?: HookInfo): HookResult {
    if (this.status === 'exited' || this.agentGone) return 'ignored'; // late hooks of a CLI that already ended
    this.agentSeen = true;
    if (event === 'session') return this.sessionStart(now, info?.source);
    if (info?.codex) return this.codexNotice(now, info);
    if (event === 'idle') return this.idlePrompt(now);
    if (event === 'compact' || event === 'compacted') return this.compaction(event, now, info);
    this.hooked = true;
    this.turnObserved = true;
    this.armed = false;
    if ((event === 'busy' || event === 'notify') && !info?.toolEnd && info?.tool && info.toolUseId) this.lastPre = { tool: info.tool, id: info.toolUseId };
    if (event === 'busy') {
      // A parallel tool finishing must not hide a prompt that still needs the user; the end of the very call that asked does
      // (another hook or another device approved it), and so does the answer to an MCP server's question.
      if (this.status === 'waiting' && this.waitingFromNotify) {
        const answered = info?.answered === true || (info?.toolEnd === true && !!info.toolUseId && info.toolUseId === this.questionToolUse);
        if (!answered) return 'ignored';
        this.answeredAt = now;
      }
      // Late tool hooks that trail a Stop must not reopen the finished turn (the curl requests race), and neither must a
      // background subagent finishing minutes later. After the grace window a tool hook is real work: a Stop hook that
      // blocked the stop (decision: block) or a lost UserPromptSubmit means the turn continues without a prompt.
      else if (this.turnEnded && (info?.subagent || now - this.endedAt < END_GRACE_MS)) return 'ignored';
    }
    // A permission notification right after the user answered a prompt is the answered prompt's late hook. Questions reported
    // the moment they open (PermissionRequest, AskUserQuestion, Elicitation) are never late.
    if (event === 'notify' && !info?.immediate && this.status === 'working' && now - this.answeredAt < ANSWER_GRACE_MS) return 'ignored';
    const alreadyEnded = this.status === 'waiting' && this.turnEnded;
    this.hookDetail(event, info);
    this.waitingFromNotify = event === 'notify';
    this.lastOutput = now;
    if (event === 'prompt') this.interruptAt = -Infinity;
    if (event === 'stopbg') {
      if (!this.background) this.backgroundSince = now;
      this.background = true;
      this.longBackground = (info?.workflows ?? 0) > 0;
    } else if (event !== 'busy') {
      this.background = false;
      this.longBackground = false;
    }
    if (event === 'prompt' || event === 'stopbg' || event === 'notify' || event === 'busy') this.turnEnded = false;
    else if (event === 'stop' || event === 'fail') {
      this.turnEnded = true;
      this.endedAt = now;
    }
    if (event === 'prompt' || event === 'busy' || event === 'stopbg') this.set('working', 'hook');
    else this.set('waiting', 'hook', event === 'notify' ? 'attention' : event === 'fail' ? 'error' : 'done', event === 'fail' ? info?.error : undefined);
    return event === 'stop' && info?.continuation && alreadyEnded ? 'renotify' : 'applied';
  }

  /** The detail an applied hook event leaves (see StatusDetail). */
  private hookDetail(event: HookEvent, info?: HookInfo): void {
    if (event === 'notify') {
      const kind = info?.need ?? 'input';
      // The Notification that follows a question (~6 s later) only repeats it: the question keeps its own detail.
      if (!info?.immediate && this.waitingFromNotify && this.detail) return;
      // AskUserQuestion also raises a PermissionRequest for itself: it stays the question it is.
      if (this.waitingFromNotify && this.detail?.kind === 'question' && kind === 'permission' && info?.tool === this.lastPre?.tool) return;
      const tool = shortToolName(info?.tool);
      this.detail = { kind, ...(tool && kind === 'permission' ? { tool } : {}) };
      if (info?.immediate) this.questionToolUse = kind === 'question' ? info.toolUseId : kind === 'permission' && info.tool && this.lastPre?.tool === info.tool ? this.lastPre.id : undefined;
      return;
    }
    this.questionToolUse = undefined;
    if (event === 'busy') {
      if (info?.subagentStart) {
        const name = shortToolName(info.agentType);
        this.detail = { kind: 'subagent', ...(name ? { tool: name } : {}) };
        this.detailToolUse = undefined;
      } else if (info?.subagent) {
        if (this.detail?.kind === 'subagent') this.detail = undefined;
      } else if (info?.answered) {
        this.detail = undefined;
      } else if (info?.toolEnd) {
        if (this.detail?.kind === 'tool' && (!info.toolUseId || info.toolUseId === this.detailToolUse)) this.detail = undefined;
        if (this.detail && this.detail.kind !== 'tool' && this.detail.kind !== 'subagent') this.detail = undefined; // an answered question
      } else {
        const tool = shortToolName(info?.tool);
        if (tool) {
          this.detail = { kind: 'tool', tool };
          this.detailToolUse = info?.toolUseId;
        } else if (this.detail?.kind !== 'tool' && this.detail?.kind !== 'subagent') this.detail = undefined;
      }
      return;
    }
    this.detail = event === 'stopbg' ? { kind: 'background' } : undefined;
    this.detailToolUse = undefined;
  }

  /**
   * Notification idle_prompt: Claude has sat at its prompt for about a minute without background agents. A cell still
   * "working" lost its turn end (an interrupt, a hook that never arrived): it waits, quietly (nothing finished just now).
   */
  private idlePrompt(now: number): HookResult {
    this.hooked = true;
    if (this.status !== 'working' || this.background || this.waitingFromNotify) return 'ignored';
    this.turnEnded = true;
    this.endedAt = now;
    this.armed = false;
    this.interruptAt = -Infinity;
    this.detail = undefined;
    this.lastStallKind = 'idle';
    this.set('waiting', 'heuristic', 'done');
    this.quietPrecise = true;
    return 'applied';
  }

  /**
   * PreCompact / PostCompact. An automatic compaction belongs to a running turn (it only names the work); /compact is a
   * command of its own: working while it runs, back at the prompt when it is done, and no Stop follows it.
   */
  private compaction(event: 'compact' | 'compacted', now: number, info?: HookInfo): HookResult {
    this.hooked = true;
    if (event === 'compact') {
      if (this.waitingFromNotify) return 'ignored';
      const manual = info?.trigger === 'manual';
      if (!manual && this.status !== 'working') return 'ignored';
      this.compacting = manual ? 'manual' : 'auto';
      this.lastOutput = now;
      this.detail = { kind: 'compact' };
      if (this.status !== 'working') {
        this.turnObserved = true;
        this.turnEnded = false;
        this.set('working', 'hook');
      }
      return 'applied';
    }
    const manual = this.compacting === 'manual' || info?.trigger === 'manual';
    this.compacting = null;
    if (this.detail?.kind === 'compact') this.detail = undefined;
    if (!manual || this.status !== 'working' || this.background) {
      this.lastOutput = now;
      return 'applied';
    }
    this.turnEnded = true;
    this.endedAt = now;
    this.armed = false;
    this.set('waiting', 'heuristic', 'done'); // quiet: the user just typed /compact and watches it
    this.quietPrecise = true;
    return 'applied';
  }

  // ── shell prompt marks ────────────────────────────────────────────────────

  /**
   * An OSC 133 / 633 mark of the cell's shell (see shellIntegration.ts). In a shell cell C starts a command (working) and the
   * next A ends it (idle, or waiting after a long one); in an agent cell the first command is the CLI, and a prompt after it
   * means the CLI ended. D carries the exit code for the A that follows.
   */
  shellMark(kind: ShellMarkKind, now: number, code?: number): void {
    if (this.status === 'exited') return;
    this.marked = true;
    if (kind === 'D') {
      this.lastExitCode = code;
      return;
    }
    if (kind === 'B') {
      this.atPrompt = true;
      return;
    }
    if (kind === 'C') {
      this.markedStart = true;
      this.commandStarted(now);
      return;
    }
    this.atPrompt = true;
    if (!this.shellMode) this.agentPrompt(now);
    else if (this.commandRunning) this.commandEnded(now);
  }

  private commandStarted(now: number): void {
    this.atPrompt = false;
    this.lastExitCode = undefined;
    if (!this.shellMode) {
      this.agentLaunched = true;
      return;
    }
    if (this.commandRunning) return;
    this.commandRunning = true;
    this.commandSince = now;
    this.turnObserved = true;
    this.armed = true;
    this.lastOutput = now;
    this.detail = { kind: 'command' };
    this.set('working', 'hook');
  }

  private commandEnded(now: number): void {
    const ran = now - this.commandSince;
    this.commandRunning = false;
    this.armed = false;
    const interrupted = now - this.lastInterruptKey < SHELL_INTERRUPT_MS;
    const code = this.lastExitCode;
    this.detail = code && !interrupted ? { kind: 'exit-code', code } : undefined;
    // A long command that ended is something to look at (the old "waiting" of a shell); a quick one or Ctrl-C is just the prompt.
    if (ran >= SHELL_LONG_MS && !interrupted) this.set('waiting', 'heuristic', 'done');
    else this.set('idle', 'heuristic');
  }

  /** A prompt of an agent cell's shell: the one before the launch, or the CLI ended (cleanly, by /exit, or it crashed). */
  private agentPrompt(now: number): void {
    this.promptsSeen++;
    // Without C marks (cmd.exe) the second prompt counts, once the CLI showed it was running (a hook, a turn): a transient
    // prompt that is redrawn on Enter (oh-my-posh) must not end it at the launch.
    const launched = this.agentLaunched || (!this.markedStart && this.promptsSeen >= 2 && (this.agentSeen || this.turnObserved));
    if (!launched) return;
    const code = this.lastExitCode;
    // Ended while working with nobody touching the keyboard: a crash, worth an error. /exit, Ctrl-C twice or a finished
    // session are the user's own doing.
    const crashed = this.status === 'working' && now - this.lastInput > AGENT_EXIT_QUIET_MS && now - this.lastInterruptKey > AGENT_EXIT_QUIET_MS;
    this.agentGone = true;
    this.hooked = false;
    this.codexNotified = false;
    this.waitingFromNotify = false;
    this.background = false;
    this.longBackground = false;
    this.pendingEnd = null;
    this.pendingFailure = null;
    this.interruptAt = -Infinity;
    this.armed = false;
    this.turnEnded = false;
    this.questionToolUse = undefined;
    this.detail = { kind: 'cli-exited', ...(code ? { code } : {}) };
    if (crashed) this.set('waiting', 'hook', 'error', 'cli-exited');
    else this.set('idle', 'heuristic');
  }

  /**
   * SessionStart (startup / resume / clear / compact / fork): the previous conversation's background tasks are no
   * longer ours, so background mode ends. A cell that was only "working" for those tasks goes to waiting quietly
   * (no alert: the user switched conversations, nothing finished). A compaction happens mid-turn, so it keeps the status.
   */
  private sessionStart(now: number, source?: string): HookResult {
    const wasBackground = this.background;
    this.background = false;
    this.longBackground = false;
    this.interruptAt = -Infinity;
    if (!wasBackground) return 'applied';
    if (source !== 'compact' && this.status === 'working') {
      this.waitingFromNotify = false;
      this.turnEnded = true;
      this.set('waiting', 'heuristic', 'done'); // silent: nothing finished, the conversation was switched
    } else {
      this.lastOutput = now; // the shorter silence net starts counting now
    }
    return 'applied';
  }

  /**
   * Codex notify (agent-turn-complete): the turn ended successfully. One event per turn id; from now on this cell's silence
   * is only a slow safety net (see `tick`), because the precise end of a turn is reported.
   */
  private codexNotice(now: number, info: HookInfo): HookResult {
    this.codexNotified = true;
    this.turnObserved = true;
    if (info.turnId && (info.turnId === this.lastTurnId || info.turnId === this.pendingEnd?.turnId)) return 'ignored';
    // A thread already seen finishing while the cell kept working is a sub-agent's: it never ends the cell's turn.
    if (info.threadId && this.threads.isSecondary(info.threadId)) return 'ignored';
    // A second notify before the first one committed: the first was not the end of the turn.
    if (this.pendingEnd) this.cancelPending();
    this.pendingEnd = { at: now, last: now, ...(info.turnId ? { turnId: info.turnId } : {}), ...(info.threadId ? { threadId: info.threadId } : {}) };
    return 'applied';
  }

  /** The pending notify saw a quiet gap that began within the window: the turn really ended. */
  private gapDone(now: number): boolean {
    const p = this.pendingEnd;
    return !!p && now - p.last >= CODEX_GAP_MS && p.last - p.at <= CODEX_WINDOW_MS;
  }

  /** The notify was followed by output without a gap: the turn was still running, so its thread is a sub-agent's (never the cell's own). */
  private cancelPending(): void {
    const p = this.pendingEnd;
    this.pendingEnd = null;
    if (p?.threadId) this.threads.markSecondary(p.threadId);
  }

  /** A quiet gap followed the notify: the turn really ended. */
  private commitEnd(): void {
    const p = this.pendingEnd;
    if (!p) return;
    this.pendingEnd = null;
    // The cell already waits on a precise signal (an approval prompt, the previous turn's end, a failure line) but the agent
    // went on: a queued message, or the answer to the prompt. The new turn end must still alert, which a plain "waiting" would not.
    const renotify = this.status === 'waiting' && this.lastCause === 'hook' && (this.lastReason === 'attention' || this.lastReason === 'error' || (this.lastReason === 'done' && this.lastTurnId !== undefined));
    this.lastTurnId = p.turnId ?? this.lastTurnId;
    this.codexTurn = p.turnId ? `n:${p.turnId}` : undefined;
    this.pendingFailure = null;
    this.interruptAt = -Infinity;
    this.armed = false;
    this.lastStallKind = 'turn-end';
    this.detail = undefined;
    this.set('waiting', 'hook', 'done');
    if (renotify) this.renotifyDue = true;
    const bound = this.threads.commit(p.threadId);
    if (bound) this.onBind?.(bound);
  }

  /**
   * Terminal notification (OSC 9 / bell). Ignored once precise hooks drive the status. A Codex cell is launched so that OSC 9
   * only ever means "approval / question for you" (turn ends come from notify), so it is a precise "attention".
   */
  osc9(): HookResult {
    if (this.status === 'exited' || this.hooked || !this.turnObserved || this.agentGone) return 'ignored';
    if (this.codexMode) {
      // An approval can also come after a turn end that was committed a moment ago (a queued turn): it is "needs you" either way.
      const working = this.status === 'working';
      const finished = this.status === 'waiting' && this.lastReason !== 'attention';
      if (!working && !finished) return 'ignored';
      this.armed = false;
      this.agentSeen = true;
      this.detail = { kind: 'input' };
      this.set('waiting', 'hook', 'attention');
      return finished ? 'renotify' : 'applied';
    }
    this.armed = false;
    this.set('waiting', 'heuristic');
    return 'applied';
  }

  /** The process of the cell ended; `code` is its exit code (a non-zero one is shown and drawn as an error). */
  exited(code?: number): void {
    this.status = 'exited';
    this.pendingEnd = null;
    this.background = false;
    this.longBackground = false;
    this.detail = code ? { kind: 'exit-code', code } : undefined;
    this.commandRunning = false;
  }

  /**
   * 1.0.7: the prompt marks of a replayed history (a terminal handed over to another window, or adopted again): the shell
   * that is still running was last seen at its prompt (A / B) or running a command (C). The new tracker starts from that,
   * so the first command after a move is exact instead of guessed from output. Nothing is alerted.
   */
  replayedMarks(marks: { last: ShellMarkKind; sawStart: boolean; prompts: number }, now: number): void {
    if (this.status === 'exited') return;
    this.marked = true;
    if (marks.sawStart) this.markedStart = true;
    if (!this.shellMode) {
      // An agent cell: a C was its CLI's launch; a prompt after a C means the CLI already ended back to its shell.
      if (marks.last === 'C') this.agentLaunched = true;
      else if (marks.sawStart) this.agentGone = true;
      else this.promptsSeen = Math.max(this.promptsSeen, marks.prompts);
      if (!this.shellMode) { this.atPrompt = marks.last !== 'C'; return; }
    }
    if (marks.last === 'C') {
      this.atPrompt = false;
      if (this.commandRunning) return;
      this.commandRunning = true;
      this.commandSince = now;
      this.turnObserved = true;
      this.armed = true;
      this.lastOutput = now;
      this.detail = { kind: 'command' };
      this.set('working', 'hook');
      return;
    }
    if (marks.last === 'A' || marks.last === 'B') {
      this.atPrompt = true;
      if (this.shellMode && this.commandRunning) {
        this.commandRunning = false;
        this.armed = false;
        this.detail = undefined;
        if (this.status === 'working') this.set('idle', 'heuristic');
      }
    }
  }

  reset(): void {
    this.status = 'idle';
    this.detail = undefined;
    this.questionToolUse = this.lastPre = this.detailToolUse = undefined;
    this.agentGone = this.marked = this.markedStart = this.atPrompt = this.commandRunning = this.agentLaunched = this.agentSeen = false;
    this.commandSince = this.lastInterruptKey = -Infinity;
    this.lastExitCode = undefined;
    this.promptsSeen = 0;
    this.compacting = null;
    this.quietPrecise = false;
    this.armed = false;
    this.hooked = false;
    this.turnObserved = false;
    this.waitingFromNotify = false;
    this.background = false;
    this.longBackground = false;
    this.turnEnded = false;
    this.endedAt = this.answeredAt = -Infinity;
    this.lastReason = 'done';
    this.lastError = undefined;
    this.lastStallKind = null;
    this.codexNotified = false;
    this.pendingEnd = null;
    this.renotifyDue = false;
    this.reopenSeq = 0;
    this.generation++;
    this.lastTurnId = this.codexTurn = undefined;
    this.turnSeq = 0;
    this.pendingFailure = null;
    this.lastEnv = -Infinity;
    this.lastInput = this.lastFocus = this.lastOutput = this.activityStart = this.lastTick = this.interruptAt = -Infinity;
  }

  tick(now: number): CellStatus {
    // After sleep / throttled timers the silence is not the agent's: restart the quiet window.
    if (this.lastTick > -Infinity && now - this.lastTick > SUSPEND_MS) {
      if (this.lastOutput > -Infinity) this.lastOutput = now;
      if (this.interruptAt > -Infinity) this.interruptAt = now;
      this.environment(now); // the redraws after a wake are not work
    }
    this.lastTick = now;
    if (this.pendingEnd && this.status !== 'exited') {
      if (this.gapDone(now)) this.commitEnd();
      else if (now - this.pendingEnd.at > CODEX_WINDOW_MS + CODEX_GAP_MS) this.cancelPending();
    }
    // A marked shell's command runs until its prompt is back, however quiet it is (a full-screen program is judged by output).
    if (this.status === 'working' && this.shellMode && this.commandRunning && !this.interactiveGuard?.()) return this.status;
    if (this.status === 'working') {
      // Hooked agents get a long net (lost Stop, killed subagent) and a short one after Esc/Ctrl-C.
      const kind: StallKind = this.pendingFailure ? 'error'
        : this.hooked ? (this.background ? (this.longBackground ? 'workflow' : 'bg') : this.interruptAt > -Infinity ? 'interrupt' : 'plain')
        : this.codexNotified ? (this.interruptAt > -Infinity ? 'interrupt' : 'codex') : 'heuristic';
      const quiet = kind === 'heuristic' ? this.quietMs : kind === 'bg' ? BG_STALL_MS : kind === 'workflow' ? WORKFLOW_STALL_MS
        : kind === 'interrupt' ? INTERRUPT_QUIET_MS : kind === 'error' ? FAILURE_QUIET_MS : kind === 'codex' ? CODEX_QUIET_MS : STALL_MS;
      const since = this.isHooked ? Math.max(this.lastOutput, this.interruptAt) : this.lastOutput;
      if (now - since >= quiet) {
        // The terminal still shows Claude Code waiting for its workflow: the run goes on, the net starts over (for at most
        // WORKFLOW_STALL_MS of background mode; after that the net ends the run normally, a bg net with one alert).
        if ((kind === 'bg' || kind === 'workflow') && this.backgroundFor(now) < WORKFLOW_STALL_MS && this.bgGuard?.()) {
          this.lastOutput = now;
          return this.status;
        }
        const failure = this.pendingFailure;
        this.armed = false;
        this.background = false;
        this.longBackground = false;
        this.interruptAt = -Infinity;
        this.pendingFailure = null;
        this.lastStallKind = kind;
        this.detail = kind === 'interrupt' ? { kind: 'interrupted' } : undefined;
        this.detailToolUse = this.questionToolUse = undefined;
        // The background net ending, a lost Codex notify and a failure line are real ends of the turn that no hook reported:
        // alert once, late rather than never. Esc / plain silence of a hooked cell stays quiet.
        if (failure) this.set('waiting', 'hook', 'error', failure);
        else this.set('waiting', kind === 'bg' || kind === 'codex' ? 'hook' : 'heuristic');
      }
    }
    return this.status;
  }

  private set(status: CellStatus, cause: StatusCause, reason: StatusReason = 'done', error?: string): void {
    this.status = status;
    this.quietPrecise = false;
    this.lastCause = cause;
    if (status === 'waiting') {
      this.lastReason = reason;
      this.lastError = reason === 'error' ? error ?? 'unknown' : undefined;
    }
  }
}

export interface StatusCounts {
  working: number;
  waiting: number;
  exited: number;
  /** 1.0.7: how many of the exited ended with a non-zero code (absent = none); see statusCountsOf. */
  failed?: number;
}

export function aggregate(list: Iterable<CellStatus>): StatusCounts {
  const c: StatusCounts = { working: 0, waiting: 0, exited: 0 };
  for (const s of list) if (s !== 'idle') c[s]++;
  return c;
}
