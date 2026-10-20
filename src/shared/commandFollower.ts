// The command line of one SSH terminal for the autocomplete: follows what the user types at the remote shell's prompt
// (from the first keystroke after the prompt, or from the shell's own OSC 133 prompt mark), decides when the suggestion
// popup shows, handles its keys and records the lines the user runs. Only a line the shell echoed after its prompt is
// recorded, so a password typed with echo off is never kept. DOM-free: the terminal is xterm's (or a test's) through the
// small TermLike view; the renderer glue is terminals/sshAutocomplete.ts.
import { anchorAtCursor, atBottom, cursorBelowLine, cursorOnLine, isClassicShellPrompt, isShellPrompt, readCommandLine, readSubmittedLine, relocateAnchor, type BufferLike, type LineAnchor } from './commandLine';
import { captureCommand } from './commandHistory';
import { classifyInput, completionKeys, ghostText, popupKey, predictLine, suggestCommands, type KeyLike, type Suggestion, type SuggestSource } from './commandSuggest';
import { isUserInput } from './status';

/** Output newer than this when the user starts a line: a program is still printing, so the line is not followed. */
export const SETTLE_MS = 80;
/** An edit is read back once its echo is parsed; with no echo at all (echo off) it is read after this anyway. */
export const ECHO_WAIT_MS = 350;
/** An echo unlike the line foreseen (predictLine) is taken as it is once the shell was quiet this long (looked at ECHO_WAIT_MS after it). */
export const QUIET_MS = 300;
/**
 * After Enter the line is read once the cursor left it: by then every echo of it arrived and the shell drew it the way it
 * runs it (without its own inline suggestion or a transient right prompt). Not left within this time: not recorded.
 */
export const SUBMIT_WAIT_MS = 3000;

export interface MarkerLike { readonly line: number; readonly isDisposed: boolean; dispose(): void }

/** What the follower uses of xterm's Terminal. */
export interface TermLike {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: BufferLike; readonly normal: BufferLike };
  registerMarker(cursorYOffset?: number): MarkerLike;
  input(data: string, wasUserInput?: boolean): void;
}

export interface AutocompleteView {
  items: Suggestion[];
  /** The item chosen with the arrows; -1 = none yet. */
  selected: number;
  /** The rest of the chosen (or top) suggestion, drawn after the cursor; '' = none (also when no cell is free for it). */
  ghost: string;
  /** Blank cells after the cursor where the ghost text may be drawn. */
  room: number;
  /** The cursor cell in the viewport and the terminal's size in cells. */
  col: number;
  row: number;
  cols: number;
  rows: number;
  /** Where the command starts on the cursor's row (the popup's text lines up with it). */
  startCol: number;
}

export interface FollowerEnv {
  /** The cell's host; null when it has none (any more). */
  hostId(): string | null;
  /** Settings: SSH command suggestions are on (off: nothing is suggested or recorded). */
  enabled(): boolean;
  /** The terminal is on screen and has the keyboard. */
  shown(): boolean;
  /** What may be suggested for the host (history and snippets); the same array while nothing changed. */
  sources(hostId: string): readonly SuggestSource[];
  /** The host's most recent command (a repeat of it is not recorded). */
  lastCommand(hostId: string): string | undefined;
  remember(hostId: string, command: string): void;
  /** The popup changed (null: hidden). */
  publish(view: AutocompleteView | null): void;
  /** A monotonic clock in ms. */
  now(): number;
}

const sameView = (a: AutocompleteView | null, b: AutocompleteView | null): boolean =>
  a === b || (!!a && !!b && a.items === b.items && a.selected === b.selected && a.ghost === b.ghost && a.room === b.room
    && a.col === b.col && a.row === b.row && a.cols === b.cols && a.rows === b.rows && a.startCol === b.startCol);

type LineState = 'idle' | 'tracking' | 'lost';
type Read = { before: string; after: string; atEnd: boolean; room: number };
type MarkedLine = { marker: MarkerLike; col: number; prompt: string };

/**
 * `idle`: no line yet (the next keystroke after the output settled starts one at the cursor, if a shell prompt is left of
 * it); `tracking`: the line is followed from its anchor; `lost`: the line can no longer be told apart (typed while a program
 * printed, not at a shell prompt, a redraw that moved the prompt away, the shell's history search) until Enter. A line lost
 * at a program's own prompt (a pager's `:`, a question) starts again once that prompt is gone and a shell prompt is back,
 * and switching the screen (a full-screen program started or ended) starts over: a pager quit with `q` takes no Enter.
 */
export class CommandLineFollower {
  view: AutocompleteView | null = null;
  private state: LineState = 'idle';
  private marker: MarkerLike | null = null;
  private col = 0;
  private prompt = '';
  /** Lost at a program's prompt: that line, so the shell's prompt coming back without an Enter is noticed. */
  private away: MarkedLine | null = null;
  /** The popup may show: set by typing and erasing; cleared by Esc, cursor and history keys, Tab, blur and an insertion. */
  private wanted = false;
  private outputAt = -Infinity;
  private inserting = false;
  private last: Read | null = null;
  /** The typed line once the input sent so far is echoed (predictLine); undefined = all of it was read back, null = not foreseeable. */
  private expected: string | null | undefined;
  /** Inputs sent on followed lines, and how many of them a parsed write came after. */
  private inputs = 0;
  private answered = 0;
  /** A suggestion accepted while the echo of earlier input was on its way: inserted once the line is read with it. */
  private queued: string | null = null;
  private memo: { sources: readonly SuggestSource[]; typed: string; items: Suggestion[] } | null = null;
  private submitted: (MarkedLine & { hostId: string; until: number }) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly term: TermLike, private readonly env: FollowerEnv) {}

  dispose(): void {
    clearTimeout(this.timer);
    this.reset();
    this.submitted?.marker.dispose();
    this.submitted = null;
  }

  /** A keydown while the popup may be open; true = consumed (the shell must not get it). */
  key(ev: KeyLike): boolean {
    if (!this.view) return false;
    const action = popupKey(ev, { selected: this.view.selected, count: this.view.items.length, ghost: !!this.view.ghost });
    if (action.kind === 'pass') {
      if (action.hide) this.close();
      return false;
    }
    if (action.kind === 'select') this.select(action.index);
    else if (action.kind === 'accept') this.accept(action.index);
    else this.close();
    return true;
  }

  /**
   * Inserts a suggestion into the command line in place of what was typed (it is not run: Enter runs it). While typed input
   * is not echoed yet, the line it replaces is not known: it goes in once the echo is read (more typing cancels it).
   */
  accept(index: number): void {
    const item = this.view?.items[index];
    this.close();
    if (!item || this.state !== 'tracking') return;
    if (this.last && this.synced(this.last)) this.expected = undefined;
    if (this.expected === undefined) this.insert(item.text);
    else this.queued = item.text;
  }

  /** Esc, blur, a key that leaves the line to the shell: the popup closes until the next typed character. */
  close(): void {
    this.wanted = false;
    this.queued = null;
    this.publish(null);
  }

  /** The terminal switched between the normal and the alternate screen: what was typed in a full-screen program is no command line. */
  screenChanged(): void {
    this.reset();
  }

  /** User input on its way to the shell (xterm onData). */
  input(data: string): void {
    if (!isUserInput(data)) return;
    if (this.inserting) { this.later(); return; }
    this.queued = null;
    if (!this.env.enabled()) return this.reset();
    const kind = classifyInput(data);
    if (kind === 'submit') return this.submit();
    if (kind === 'abort') return this.reset();
    if (kind === 'lose') return this.lose(null);
    if (kind === 'text' || kind === 'erase' || kind === 'recall' || kind === 'complete') {
      if (this.state === 'idle') this.start(false);
      else if (this.state === 'lost' && this.away) this.retry(this.away);
    }
    if (this.state !== 'tracking') return;
    this.inputs++;
    this.expected = predictLine(this.expected === undefined ? this.last?.before ?? '' : this.expected, data);
    this.wanted = kind === 'text' || kind === 'erase';
    if (!this.wanted) this.publish(null);
    this.later();
  }

  /** A write was parsed (never called in the middle of one): echoes arrived, the shell may have moved on. */
  parsed(): void {
    this.outputAt = this.env.now();
    this.answered = this.inputs;
    this.checkSubmitted();
    this.refresh();
    // An echo still awaited (or one unlike the foreseen line) is looked at again once the shell is quiet.
    if (this.state === 'tracking' && this.expected !== undefined) this.later();
  }

  /** OSC 133 (shell integration): B ends the prompt, so the line starts there; A, C and D mean no line is being typed. */
  promptMark(payload: string): void {
    const mark = payload.split(';')[0];
    if (mark === 'B') {
      const anchor = anchorAtCursor(this.term.buffer.active);
      this.reset();
      if (anchor) this.track(anchor);
    } else if (mark === 'A' || mark === 'C' || mark === 'D') this.reset();
  }

  /** Reads the line again and shows (or hides) the popup. */
  refresh(): void {
    if (this.state !== 'tracking') return this.publish(null);
    const read = this.read();
    if (!read) return this.publish(null);
    this.last = read;
    if (this.expected !== undefined && this.synced(read)) {
      this.expected = undefined;
      const queued = this.queued;
      this.queued = null;
      if (queued !== null && read.atEnd) return this.insert(queued);
    }
    const hostId = this.env.hostId();
    const buffer = this.term.buffer.active;
    if (!hostId || !this.wanted || !read.atEnd || !read.before.trim() || !atBottom(buffer) || !this.env.enabled() || !this.env.shown()) return this.publish(null);
    const sources = this.env.sources(hostId);
    if (this.memo?.sources !== sources || this.memo.typed !== read.before) this.memo = { sources, typed: read.before, items: suggestCommands(read.before, sources) };
    const items = this.memo.items;
    if (!items.length) return this.publish(null);
    const chosen = this.view && this.view.selected >= 0 ? this.view.items[this.view.selected]?.text : undefined;
    const selected = chosen === undefined ? -1 : items.findIndex((i) => i.text === chosen);
    this.publish({
      items, selected, ghost: this.ghostOf(items[Math.max(0, selected)]), room: read.room,
      col: buffer.cursorX, row: buffer.cursorY, cols: this.term.cols, rows: this.term.rows,
      startCol: this.marker?.line === buffer.baseY + buffer.cursorY ? this.col : 0,
    });
  }

  private select(index: number): void {
    const view = this.view;
    if (!view || !this.last) return;
    const selected = Math.max(-1, Math.min(index, view.items.length - 1));
    this.publish({ ...view, selected, ghost: this.ghostOf(view.items[Math.max(0, selected)]) });
  }

  /**
   * The ghost text as it is drawn: none where no cell after the cursor is free (the shell draws its own inline suggestion
   * there, or a right-hand prompt leaves no room), so → is never taken for a completion the user cannot see.
   */
  private ghostOf(item: Suggestion | undefined): string {
    return this.last && this.last.room > 0 ? ghostText(this.last.before, item) : '';
  }

  /**
   * Every input sent so far shows in `read`: it is the line foreseen, or the shell answered the last input and showed
   * something else (taken as it is once quiet for QUIET_MS; at once when nothing could be foreseen).
   */
  private synced(read: Read): boolean {
    if (this.expected === undefined || this.expected === read.before) return true;
    if (this.answered < this.inputs) return false;
    return this.expected === null || this.env.now() - this.outputAt >= QUIET_MS;
  }

  private insert(text: string): void {
    const typed = this.last?.before;
    if (typed === undefined) return;
    const target = /^\s*/.exec(typed)![0] + text;
    const keys = completionKeys(typed, target);
    if (!keys) return;
    this.inputs++;
    this.expected = target;
    this.inserting = true;
    try { this.term.input(keys, true); } finally { this.inserting = false; }
  }

  /**
   * The first keystroke of a line: it starts at the cursor when the output settled and a shell prompt is left of it (`strict`:
   * a classic one, see isClassicShellPrompt). Not while the Enter before is still unechoed: the cursor is on that line yet.
   */
  private start(strict: boolean): void {
    const s = this.submitted;
    const pending = !!s && this.env.now() < s.until && cursorOnLine(this.term.buffer.normal, this.lineOf(s));
    const anchor = !pending && this.env.now() - this.outputAt >= SETTLE_MS ? anchorAtCursor(this.term.buffer.active) : null;
    if (anchor && (strict ? isClassicShellPrompt : isShellPrompt)(anchor.prompt)) this.track(anchor);
    else this.lose(anchor);
  }

  /** Lost at a program's prompt: once that line is gone (the pager quit, the program printed on), the line may start again. */
  private retry(away: MarkedLine): void {
    if (!readCommandLine(this.term.buffer.active, this.lineOf(away), this.term.cols).ok) this.start(true);
  }

  private track(anchor: LineAnchor): void {
    this.marker?.dispose();
    this.marker = this.markAt(anchor);
    this.col = anchor.col;
    this.prompt = anchor.prompt;
    this.state = 'tracking';
    this.last = null;
  }

  /** No line until Enter; `at` (a settled program prompt left of the cursor) is watched for the shell coming back. */
  private lose(at: LineAnchor | null): void {
    this.reset();
    this.state = 'lost';
    if (at) this.away = { marker: this.markAt(at), col: at.col, prompt: at.prompt };
  }

  private markAt(anchor: LineAnchor): MarkerLike {
    const buffer = this.term.buffer.active;
    return this.term.registerMarker(anchor.row - (buffer.baseY + buffer.cursorY));
  }

  private lineOf(line: MarkedLine): LineAnchor {
    return { row: line.marker.isDisposed ? -1 : line.marker.line, col: line.col, prompt: line.prompt };
  }

  private anchor(): LineAnchor | null {
    const line = this.marker && !this.marker.isDisposed ? this.marker.line : -1;
    return line >= 0 ? { row: line, col: this.col, prompt: this.prompt } : null;
  }

  /** The line as it is now; a prompt drawn again elsewhere moves the anchor, a line that cannot be read any more is dropped. */
  private read(): Read | null {
    const anchor = this.anchor();
    if (!anchor) { this.drop(); return null; }
    const buffer = this.term.buffer.active;
    const read = readCommandLine(buffer, anchor, this.term.cols);
    if (read.ok) return read;
    if (read.reason === 'alternate') return null;
    const moved = relocateAnchor(buffer, anchor, this.term.cols);
    if (moved) {
      this.track(moved);
      const again = readCommandLine(buffer, moved, this.term.cols);
      if (again.ok) return again;
    }
    this.drop();
    return null;
  }

  /** A line with text on it stays unknown until Enter; an empty one starts again with the next keystroke. */
  private drop(): void {
    const typed = !!this.last && !!(this.last.before + this.last.after).trim();
    if (typed) this.lose(null);
    else this.reset();
  }

  /** Enter: the line is recorded once the shell moved on from it (see SUBMIT_WAIT_MS). */
  private submit(): void {
    const hostId = this.env.hostId();
    if (this.state === 'tracking' && this.anchor() && this.marker && hostId) {
      this.checkSubmitted();
      this.submitted?.marker.dispose();
      this.submitted = { marker: this.marker, col: this.col, prompt: this.prompt, hostId, until: this.env.now() + SUBMIT_WAIT_MS };
      this.marker = null;
    }
    this.reset();
  }

  private checkSubmitted(): void {
    const s = this.submitted;
    if (!s) return;
    const anchor = this.lineOf(s);
    const done = cursorBelowLine(this.term.buffer.normal, anchor);
    if (!done && this.env.now() < s.until) return;
    this.submitted = null;
    if (done && this.env.enabled()) {
      const line = readSubmittedLine(this.term.buffer.normal, anchor, this.term.cols);
      // Text after the shell's prompt is what the shell echoed: input typed with echo off never shows up there.
      const command = captureCommand(line, { echoed: !!line?.trim(), last: this.env.lastCommand(s.hostId) });
      if (command) this.env.remember(s.hostId, command);
    }
    s.marker.dispose();
  }

  private reset(): void {
    this.state = 'idle';
    this.marker?.dispose();
    this.marker = null;
    this.away?.marker.dispose();
    this.away = null;
    this.last = null;
    this.expected = undefined;
    this.queued = null;
    this.wanted = false;
    this.publish(null);
  }

  private later(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), ECHO_WAIT_MS);
  }

  private publish(view: AutocompleteView | null): void {
    if (sameView(this.view, view)) return;
    this.view = view;
    this.env.publish(view);
  }
}
