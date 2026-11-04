// Terminal input modes (mouse / focus / bracketed paste / kitty keyboard) are switched on by the agent CLI with DEC private
// modes and are the CLI's to switch off again. A CLI that dies hard (crash, kill) never does, so the terminal keeps sending
// mouse and focus reports to whatever runs next - the shell prompt then prints them as `[<35;77;38M` garbage.
// These helpers build the reset that is typed around the CLI command (it runs when the CLI returns, however it ended),
// the same reset for the terminal emulator itself, and the guard that stops a mouse-report flood into a shell.

import type { ShellKind } from './types';

/**
 * 1000/1002/1003 mouse tracking, 1005/1006/1015 mouse encodings, 1004 focus reports, 2004 bracketed paste.
 * 9001 (win32-input-mode) is deliberately absent: ConPTY switches it on once at startup and owns it, so clearing it would
 * cost every later program in that shell the key-release events.
 */
export const INPUT_MODE_PARAMS = [1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004] as const;

/** On Windows ConPTY owns 1004 (its focus events feed later programs, e.g. focus-gated notifications): never cleared there. */
const WIN32_PARAMS = INPUT_MODE_PARAMS.filter((m) => m !== 1004);

const paramsFor = (win32: boolean): readonly number[] => (win32 ? WIN32_PARAMS : INPUT_MODE_PARAMS);

/** Mode reset plus "pop one level of kitty keyboard flags". Only CSI sequences: safe to write to a terminal at any time. */
export function inputModesOff(win32: boolean): string {
  return `\x1b[?${paramsFor(win32).join(';')}l\x1b[<u`;
}

/** The reset for macOS / Linux (all modes, including focus reports). */
export const INPUT_MODES_OFF = inputModesOff(false);

/**
 * Full mode reset of the terminal emulator for the manual "reset terminal" action: input modes, application cursor keys and
 * keypad, visible cursor, default attributes. Never touches the buffer, so scrollback survives. `inAlternateScreen` adds the
 * leave-alternate-screen request (only then: DECRC of an unmatched save would move the cursor).
 */
export function terminalModeReset(inAlternateScreen: boolean, win32 = false): string {
  return `${inputModesOff(win32)}\x1b[?1l\x1b>\x1b[?25h\x1b[0m${inAlternateScreen ? '\x1b[?1049l' : ''}`;
}

const psEsc = () => `[char]27+'[?${WIN32_PARAMS.join(';')}l'+[char]27+'[<u'`;

/**
 * The typed line that runs the CLI and then switches the input modes off, however the CLI ended:
 * - PowerShell: `try { cli } finally { ... }` - the finally block also runs after Ctrl+C and after a terminating error
 *   (a plain `; tail` is skipped by Ctrl+C);
 * - cmd: `cli & powershell ...` (cmd has no ESC literal, so a throwaway PowerShell writes it; `&` runs after any exit);
 * - bash / zsh: `trap : INT; cli; printf ...; trap - INT` (a no-op INT handler keeps the list going when the CLI is killed by
 *   SIGINT; without it the shell abandons the rest of the line).
 * One line, the CLI command verbatim inside. Prints nothing visible. Windows shells never clear `?1004` (see WIN32_PARAMS).
 * `exitUrl` (1.1.4, agent cells with an MCP role): the tail also posts the CLI's exit code to the local hook server, so main
 * learns that the CLI ended even when no window shows the cell (curl, which Windows 10+ and macOS ship).
 */
export function withResetTail(cli: string, shell: ShellKind = 'pwsh', exitUrl?: string): string {
  const url = exitUrl && EXIT_URL.test(exitUrl) ? exitUrl : undefined;
  if (shell === 'cmd') {
    // `call` expands %^errorlevel% only when it runs, after the CLI (a plain %errorlevel% is expanded when the line is read).
    const post = url ? `call curl.exe -s --noproxy * -m 2 -X POST ${url}/%^errorlevel% >nul 2>&1 & ` : '';
    return `${cli} & ${post}powershell -NoProfile -NonInteractive -Command "[Console]::Write(${psEsc()})" 2>nul`;
  }
  if (shell === 'zsh' || shell === 'bash') {
    const reset = `printf '\\033[?${INPUT_MODE_PARAMS.join(';')}l\\033[<u'`;
    if (!url) return `trap : INT; ${cli}; ${reset}; trap - INT`;
    return `trap : INT; ${cli}; __mc_exit=$?; curl -s --noproxy '*' -m 2 -X POST '${url}/'$__mc_exit >/dev/null 2>&1; ${reset}; trap - INT`;
  }
  // 1.1.5: the CLI's exit code is kept for the prompt's D mark (shellIntegration.ts): `$?` after the tail is always true.
  if (!url) return `try { ${cli} } finally { $global:__unimuxExit = $LASTEXITCODE; [Console]::Write(${psEsc()}) }`;
  // The post comes first in every shell (cmd needs it before its PowerShell); the CLI's exit code is kept for the prompt.
  return `try { ${cli} } finally { $__mcExit = $LASTEXITCODE; curl.exe -s --noproxy '*' -m 2 -X POST "${url}/$__mcExit" *> $null; [Console]::Write(${psEsc()}); $global:LASTEXITCODE = $__mcExit; $global:__unimuxExit = $__mcExit }`;
}

/** The only URLs the tail posts to: the local hook server's exit route (no quotes or shell characters can come along). */
const EXIT_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/x\/[\w-]{1,64}\/[a-f0-9]{8,64}$/;

/** SGR / normal / X10 mouse reports (`ESC[<Cb;Cx;CyM|m`, `ESC[M` + 3 bytes): what a terminal in mouse-tracking mode writes. */
export function isMouseReport(data: string): boolean {
  return /^\x1b\[(?:<[\d;]*[Mm]|M[\s\S]{3})$/.test(data);
}

const SGR_REPORT_RE = /^\x1b\[<\d+;(\d+);(\d+)[Mm]$/;
const ECHO_RE = /\[(?:<)?\d+;(\d+);(\d+)[Mm]/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[\d;?<>= ]*[A-Za-z]/g;

/** `col;row` of an SGR mouse report, or null (X10 reports and everything else carry no readable position). */
export function reportPosition(data: string): string | null {
  const m = SGR_REPORT_RE.exec(data);
  return m ? `${m[1]};${m[2]}` : null;
}

/**
 * Positions (`col;row`) of the printed copies of mouse reports in the output (`^[[<35;12;6M`, or `[555;12;6M` once PSReadLine
 * ate part of it). Control sequences are stripped first, so a real escape sequence never counts and syntax colouring between
 * the characters of an echo does not hide it. Which of them really are echoes is for the guard to say (see below).
 */
export function echoCandidates(output: string): string[] {
  return [...output.replace(CSI_RE, '').matchAll(ECHO_RE)].map((m) => `${m[1]};${m[2]}`);
}

/** More mouse reports than this per second, that a shell prints back, are a flood. */
export const MOUSE_FLOOD_PER_SECOND = 15;
/** Different positions among the printed copies that prove it (a pointer drifting across cells, not one repeated literal). */
export const MOUSE_ECHO_PROOF = 3;
const WINDOW_MS = 1000;
const MATCH_MS = 3000;
const CAP = 400;

interface Stamp { t: number; pos: string | null }

/**
 * Stops mouse reports from flooding a shell. A TUI that tracks the mouse legitimately receives far more than 15 motion or
 * wheel reports a second, so the rate alone never trips it. The proof is that the reports come back as printed text: output
 * showing the very positions that were just sent, at several different positions. A literal `[<35;77;38M` in a file the TUI
 * shows, or a split colour code `[38;5;123m`, does not carry those positions. It never trips while the terminal shows the
 * alternate screen (a TUI, not a prompt, is the receiver). Clock injected for tests.
 */
export class MouseFloodGuard {
  private sent: Stamp[] = [];
  private echoes: Array<{ t: number; pos: string }> = [];
  tripped = false;

  /** True while recent reports make a scan of the output for echoes worthwhile (keeps the scan off the hot path). */
  watching(now: number): boolean {
    return !this.tripped && this.sent.length > 0 && now - this.sent[this.sent.length - 1].t < MATCH_MS;
  }

  /** A mouse report (raw terminal data) is about to be forwarded. Returns true when it must be dropped instead. */
  report(now: number, data: string, inAlternateScreen = false): boolean {
    if (this.tripped) return true;
    prune(this.sent, now, MATCH_MS);
    prune(this.echoes, now, MATCH_MS);
    if (this.sent.length < CAP) this.sent.push({ t: now, pos: reportPosition(data) });
    if (inAlternateScreen) return false;
    const recent = this.sent.filter((s) => now - s.t <= WINDOW_MS).length;
    const distinct = new Set(this.echoes.filter((e) => now - e.t <= MATCH_MS).map((e) => e.pos));
    if (recent > MOUSE_FLOOD_PER_SECOND && distinct.size >= MOUSE_ECHO_PROOF) {
      this.tripped = true;
      return true;
    }
    return false;
  }

  /** Output of the pty arrived: remember the printed reports that show a position sent a moment ago. */
  output(now: number, text: string, inAlternateScreen = false): void {
    if (inAlternateScreen || !this.watching(now)) return;
    const sentPositions = new Set(this.sent.map((s) => s.pos));
    for (const pos of echoCandidates(text)) {
      if (sentPositions.has(pos) && this.echoes.length < CAP) this.echoes.push({ t: now, pos });
    }
  }

  reset(): void {
    this.sent = [];
    this.echoes = [];
    this.tripped = false;
  }
}

function prune(list: Array<{ t: number }>, now: number, maxAge: number): void {
  let i = 0;
  while (i < list.length && now - list[i].t > maxAge) i++;
  if (i) list.splice(0, i);
}
