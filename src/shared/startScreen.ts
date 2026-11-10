// 1.1.5: the start card of an agent cell (Claude Code / Codex). From the spawn request until the agent is up the cell shows a
// card (its provider mark, "Uruchamianie Claude…", a quiet spinner) instead of the shell with the long launch line, and a CLI
// that ends at its start turns it into an error card with the lines it printed. Two parts:
// - the launch line begins with a clear (startClear) that runs in the shell right before the CLI: the screen and scrollback
//   are empty when the CLI starts, so once the card goes the agent's own UI is all there is (the reset tail still runs after);
// - StartWatch (pure, clock injected) follows the terminal: the launch line on screen, then the clear, then the CLI's first
//   visible output (or a hook) is "up"; a shell prompt that comes back is the CLI ending (an error card when it ended before it
//   was up, or with a non-zero code soon after); a safety timeout shows the terminal anyway.
import type { ShellKind } from './types';

/** The card never stays longer than this: a CLI that is slow or silent gets its terminal shown anyway. */
export const START_TIMEOUT_MS = 20_000;
/** The first output must stand this long (no shell prompt back) before the card goes: an instant failure keeps it as an error card. */
export const START_SETTLE_MS = 700;
/** A CLI that ends with a non-zero code this soon after its launch failed to start, even when it drew something first. */
export const START_FAIL_WINDOW_MS = 8_000;
/** The output lines the error card keeps (its "recent output" section) and the error lines it shows at once. */
export const START_TAIL_LINES = 40;
export const START_ERROR_LINES = 4;

/** What the shell runs right before the CLI: clears the screen and the scrollback (ConPTY and xterm alike, ED 2 + ED 3). */
export function startClear(shell: ShellKind = 'pwsh'): string {
  if (shell === 'cmd') return 'cls & ';
  if (shell === 'zsh' || shell === 'bash') return "printf '\\033[H\\033[2J\\033[3J'; ";
  return 'Clear-Host; ';
}

/**
 * 1.2.0, Windows: an agent CLI started as the terminal's own process (no shell, no launch line, no clear) begins its output
 * with OSC AGENT_START_OSC;AGENT_START_PAYLOAD (src-tauri unimux-pty shell_integration.rs): the screen is empty and the CLI
 * comes next, what the clear of the launch line says otherwise.
 */
export const AGENT_START_OSC = 6973;
export const AGENT_START_PAYLOAD = 'agent-start';

const CLEAR_TOKENS =(['pwsh', 'cmd', 'bash'] as const).map((s) => startClear(s).trim());

/** The launch line (its clear prefix) is among these screen lines (wrapped rows already joined). */
export function showsLaunchLine(lines: readonly string[]): boolean {
  return lines.some((line) => CLEAR_TOKENS.some((token) => line.includes(token)));
}

/** The output of a CLI that ended at its start: the last few non-empty lines (the error) and a bounded tail of all of it. */
export function startOutput(lines: readonly string[]): { errorLines: string[]; tail: string[] } {
  const clean: string[] = [];
  for (const raw of lines) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
    if (!line && (!clean.length || !clean[clean.length - 1])) continue; // no leading or doubled blank lines
    clean.push(line);
  }
  while (clean.length && !clean[clean.length - 1]) clean.pop();
  const tail = clean.slice(-START_TAIL_LINES);
  return { errorLines: clean.filter(Boolean).slice(-START_ERROR_LINES), tail };
}

export type StartScreen =
  | { phase: 'starting'; resume: boolean }
  | { phase: 'failed'; code?: number; errorLines: string[]; tail: string[] };

type State = 'off' | 'waiting' | 'launched' | 'shown' | 'up' | 'failed';

/**
 * One start of one agent cell. Every method returns true when the card changed (shown, gone, or became an error card).
 * waiting: spawn requested, the launch line not cleared yet; launched: the clear ran, the CLI has not drawn yet; shown: it
 * drew, the card goes after START_SETTLE_MS; up: the card is gone, an early non-zero end still brings the error card.
 */
export class StartWatch {
  private state: State = 'off';
  private since = 0;
  private launchedAt: number | undefined;
  private visibleAt = 0;
  private upAt = 0;
  private resume = false;
  /** The exit code of the D mark that came right before the prompt (none in cmd). */
  private code: number | undefined;
  private view: StartScreen | null = null;

  /** The card as it is now (the same object until it changes). */
  get screen(): StartScreen | null {
    return this.view;
  }

  /** Before the clear: an erase of the display is worth a look for the launch line. */
  get awaitingClear(): boolean {
    return this.state === 'waiting';
  }

  /** After the clear and before the first output: every parsed chunk is worth a look at the screen. */
  get awaitingOutput(): boolean {
    return this.state === 'launched';
  }

  begin(now: number, resume: boolean): boolean {
    this.state = 'waiting';
    this.since = now;
    this.launchedAt = undefined;
    this.code = undefined;
    this.resume = resume;
    return this.publish();
  }

  /** An erase of the display (ED 2 / ED 3) while the screen shows `hadLaunchLine`: the start clear ran, the CLI comes next. */
  cleared(now: number, hadLaunchLine: boolean): boolean {
    if (this.state !== 'waiting' || !hadLaunchLine) return false;
    this.state = 'launched';
    this.launchedAt = now;
    return false;
  }

  /** Output was parsed after the clear; `visible`: the screen shows something (the CLI drew). */
  output(now: number, visible: boolean): boolean {
    if (this.state !== 'launched' || !visible) return false;
    this.state = 'shown';
    this.visibleAt = now;
    return false;
  }

  /** A hook or notify of the CLI arrived: it runs, the card goes at once. */
  hook(now: number): boolean {
    if (this.state !== 'waiting' && this.state !== 'launched' && this.state !== 'shown') return false;
    this.launchedAt ??= now;
    return this.goUp(now);
  }

  /**
   * A prompt mark of the shell. D carries the exit code of what ran; A is the prompt coming back: the CLI ended. `read` gives
   * the screen lines at that moment (the CLI's output: the clear emptied everything before it).
   */
  shellMark(kind: 'A' | 'B' | 'C' | 'D', code: number | undefined, now: number, read: () => string[]): boolean {
    if (this.state !== 'launched' && this.state !== 'shown' && this.state !== 'up') return false;
    if (kind === 'D') { this.code = code; return false; }
    if (kind !== 'A') return false;
    const code0 = this.code;
    if (this.state === 'up' && !(code0 && now - (this.launchedAt ?? this.upAt) < START_FAIL_WINDOW_MS)) {
      this.state = 'off';
      return this.publish();
    }
    this.state = 'failed';
    const { errorLines, tail } = startOutput(read());
    this.view = { phase: 'failed', ...(code0 ? { code: code0 } : {}), errorLines, tail };
    return true;
  }

  /** The time passed: the settle, the safety timeout, the end of the failure window. */
  tick(now: number): boolean {
    if (this.state === 'shown' && now - this.visibleAt >= START_SETTLE_MS) return this.goUp(now);
    if ((this.state === 'waiting' || this.state === 'launched' || this.state === 'shown') && now - this.since >= START_TIMEOUT_MS) {
      this.state = 'off';
      return this.publish();
    }
    if (this.state === 'up' && now - (this.launchedAt ?? this.upAt) >= START_FAIL_WINDOW_MS) this.state = 'off';
    return false;
  }

  /** When `tick` next has something to decide (undefined: nothing pending). */
  nextAt(): number | undefined {
    if (this.state === 'shown') return Math.min(this.visibleAt + START_SETTLE_MS, this.since + START_TIMEOUT_MS);
    if (this.state === 'waiting' || this.state === 'launched') return this.since + START_TIMEOUT_MS;
    if (this.state === 'up') return (this.launchedAt ?? this.upAt) + START_FAIL_WINDOW_MS;
    return undefined;
  }

  /** The user asked for the terminal ("Pokaż terminal"), or the terminal ended or was reset: no card. */
  stop(): boolean {
    if (this.state === 'off') return false;
    this.state = 'off';
    return this.publish();
  }

  private goUp(now: number): boolean {
    this.state = 'up';
    this.upAt = now;
    return this.publish();
  }

  private publish(): boolean {
    const next: StartScreen | null = this.state === 'waiting' || this.state === 'launched' || this.state === 'shown' ? { phase: 'starting', resume: this.resume } : null;
    const was = this.view;
    if (was?.phase === 'starting' && next?.phase === 'starting' && was.resume === next.resume) return false;
    if (was === null && next === null) return false;
    this.view = next;
    return true;
  }
}
