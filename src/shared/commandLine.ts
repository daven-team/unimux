// The command line the user types at a remote shell prompt, read back from the terminal buffer (SSH autocomplete).
// The line starts where the user began typing after the prompt (the anchor: a buffer row, a column and the prompt text
// left of it) and ends at the cursor, so shell tab completion and in-line edits are what is read. The prompt text is
// checked on every read: a redrawn screen (Ctrl+L, a completion listing, reverse search) never yields a wrong line.
// Works on a minimal view of xterm's buffer, so it is tested without a DOM.

export interface BufferCellLike {
  getChars(): string;
  isDim(): number;
  isFgPalette(): boolean;
  getFgColor(): number;
}

export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell?(x: number): BufferCellLike | undefined;
}

export interface BufferLike {
  readonly type: 'normal' | 'alternate';
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly viewportY: number;
  getLine(y: number): BufferLineLike | undefined;
}

/** Where a command line starts: an absolute buffer row, the column after the prompt and the prompt text left of it. */
export interface LineAnchor { row: number; col: number; prompt: string }

/** Rows one command line may span; a longer one is not followed. */
export const MAX_COMMAND_ROWS = 40;

export type LineRead =
  | {
    ok: true;
    /** From the anchor to the cursor (what the suggestions match). */
    before: string;
    /** From the cursor to the end of the command, without a right-hand prompt (zsh RPROMPT). */
    after: string;
    /** Nothing but blanks after the cursor: the user types at the end of the line. */
    atEnd: boolean;
    /** Blank cells after the cursor on its row (where ghost text can be drawn without covering anything). */
    room: number;
  }
  | { ok: false; reason: 'alternate' | 'gone' | 'prompt' | 'moved' | 'long' };

/** The viewport shows the bottom of the buffer (the user did not scroll back). */
export const atBottom = (buffer: BufferLike): boolean => buffer.viewportY === buffer.baseY;

/** A candidate anchor at the cursor (before the first typed character is echoed); null in a full-screen program. */
export function anchorAtCursor(buffer: BufferLike): LineAnchor | null {
  if (buffer.type === 'alternate') return null;
  const row = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(row);
  return line ? { row, col: buffer.cursorX, prompt: line.translateToString(false, 0, buffer.cursorX) } : null;
}

/**
 * Cuts a right-hand prompt (zsh RPROMPT, a clock or git segment drawn at the right edge) off the text after the cursor:
 * a run of three or more blanks followed by text that reaches the edge of the row.
 */
export function stripRightPrompt(after: string, reachesEdge: boolean): string {
  const trimmed = after.trimEnd();
  if (!reachesEdge) return trimmed;
  const gap = / {3,}\S/.exec(trimmed);
  return gap ? trimmed.slice(0, gap.index) : trimmed;
}

/** The rest of the logical line from `col` of `row`: the row and its wrapped continuation rows, with the last row's line. */
function restOfLine(buffer: BufferLike, row: number, col: number): { text: string; last: BufferLineLike } | null {
  const first = buffer.getLine(row);
  if (!first) return null;
  let text = first.translateToString(false, col);
  let last = first;
  for (let r = row + 1; r < row + MAX_COMMAND_ROWS; r++) {
    const line = buffer.getLine(r);
    if (!line?.isWrapped) break;
    text += line.translateToString(false);
    last = line;
  }
  return { text, last };
}

const edgeOf = (line: BufferLineLike, cols: number): boolean => line.translateToString(true).length >= cols - 2;

/** Dim text or the palette's bright black: how shells draw their own inline suggestion (zsh-autosuggestions, fish). */
const faint = (cell: BufferCellLike): boolean => cell.isDim() !== 0 || (cell.isFgPalette() && cell.getFgColor() === 8);

/**
 * The text right of the cursor is the shell's own inline suggestion (faint, not typed): every visible cell up to a wider
 * gap (a right-hand prompt after it) is faint. Such text is not part of the command line.
 */
export function shellSuggestionAt(line: BufferLineLike, x: number, cols: number): boolean {
  if (!line.getCell) return false;
  let seen = false;
  for (let c = x, blanks = 0; c < cols && blanks < 3; c++) {
    const cell = line.getCell(c);
    const ch = cell?.getChars() ?? '';
    if (!cell || !ch.trim()) { blanks++; continue; }
    if (!faint(cell)) return false;
    seen = true;
    blanks = 0;
  }
  return seen;
}

/** Reads the command line of `anchor` up to the cursor (and the rest of it after the cursor). */
export function readCommandLine(buffer: BufferLike, anchor: LineAnchor, cols: number): LineRead {
  if (buffer.type === 'alternate') return { ok: false, reason: 'alternate' };
  const first = anchor.row >= 0 ? buffer.getLine(anchor.row) : undefined;
  if (!first) return { ok: false, reason: 'gone' };
  if (first.translateToString(false, 0, anchor.col) !== anchor.prompt) return { ok: false, reason: 'prompt' };
  const cursorRow = buffer.baseY + buffer.cursorY;
  const x = Math.min(buffer.cursorX, cols);
  if (cursorRow < anchor.row || (cursorRow === anchor.row && x < anchor.col)) return { ok: false, reason: 'moved' };
  if (cursorRow - anchor.row >= MAX_COMMAND_ROWS) return { ok: false, reason: 'long' };
  let before = '';
  for (let r = anchor.row; r <= cursorRow; r++) {
    const line = r === anchor.row ? first : buffer.getLine(r);
    // A row between the anchor and the cursor that is not a wrapped continuation: output, not the command line.
    if (!line || (r > anchor.row && !line.isWrapped)) return { ok: false, reason: 'moved' };
    const start = r === anchor.row ? anchor.col : 0;
    before += r === cursorRow ? line.translateToString(false, start, x) : line.translateToString(false, start);
  }
  const cursorLine = buffer.getLine(cursorRow)!;
  if (shellSuggestionAt(cursorLine, x, cols)) return { ok: true, before, after: '', atEnd: true, room: 0 };
  const rest = restOfLine(buffer, cursorRow, x)!;
  const after = stripRightPrompt(rest.text, edgeOf(rest.last, cols));
  const right = x < cols ? cursorLine.translateToString(false, x) : '';
  const blanks = /^ */.exec(right)![0].length;
  // Before a right-hand prompt one blank cell stays free, so the ghost never touches it.
  const room = right.trim() ? Math.max(0, blanks - 1) : Math.max(0, cols - x);
  return { ok: true, before, after, atEnd: !after.trim(), room };
}

/**
 * The whole command line of `anchor`, wherever the cursor is (it may already be on the next row after Enter), trimmed at
 * the end and without a right-hand prompt; null when the prompt is no longer there.
 */
export function readSubmittedLine(buffer: BufferLike, anchor: LineAnchor, cols: number): string | null {
  if (buffer.type === 'alternate' || anchor.row < 0) return null;
  const first = buffer.getLine(anchor.row);
  if (!first || first.translateToString(false, 0, anchor.col) !== anchor.prompt) return null;
  const rest = restOfLine(buffer, anchor.row, anchor.col)!;
  return stripRightPrompt(rest.text, edgeOf(rest.last, cols));
}

/** The cursor left the logical line of `anchor` (the shell echoed the newline after Enter, or printed output). */
export function cursorBelowLine(buffer: BufferLike, anchor: LineAnchor): boolean {
  if (anchor.row < 0) return true;
  let last = anchor.row;
  while (last < anchor.row + MAX_COMMAND_ROWS && buffer.getLine(last + 1)?.isWrapped) last++;
  return buffer.baseY + buffer.cursorY > last;
}

/**
 * The same prompt drawn again on the cursor's line (bash after a completion listing, Ctrl+L, zsh after a background job
 * message): the anchor moves there. Null when the cursor's line does not start with the anchor's prompt text.
 */
export function relocateAnchor(buffer: BufferLike, anchor: LineAnchor, cols: number): LineAnchor | null {
  if (buffer.type === 'alternate' || !anchor.prompt.trim()) return null;
  let row = buffer.baseY + buffer.cursorY;
  for (let up = 0; up < MAX_COMMAND_ROWS && row > 0 && buffer.getLine(row)?.isWrapped; up++) row--;
  if (row === anchor.row) return null;
  const moved = { row, col: anchor.col, prompt: anchor.prompt };
  return readCommandLine(buffer, moved, cols).ok ? moved : null;
}

/** Prompts that ask for a secret: nothing typed there is suggested for or kept, even when it is echoed. */
export const SECRET_PROMPT = /pass(?:word|phrase|code)?|has[łl]o|\bpin\b|token|secret|\botp\b|\b2fa\b|verification|one-time|kennwort|contrase|mot de passe|senha/iu;

/** Read-eval-print loops and tools whose lines are not shell commands (Python, MySQL, psql, SQLite, irb, redis-cli, sftp...). */
const REPL_PROMPT = /^(?:>>>|\.\.\.|mysql>|mariadb \[.*\]>|\S*[=-][#>]|sqlite>|irb\(.*\)[>*]|pry\(.*\)[>*]|\S+:\d+>|s?ftp>|telnet>|jshell>|scala>|ghci>|\((?:gdb|pdb|lldb)\)|in \[\d+\]:)$/i;

/** How POSIX shells and prompt themes end their prompt (`$`, `#`, `%`, zsh / starship arrows, a Powerline glyph). */
const SHELL_END = /(?:[$#%❯➜λ]|[-])$/u;
/** Prompts ending in `>` and similar arrows (PowerShell, cmd, fish) unless they ask for a secret. */
const ARROW_END = /[>»›❭→▶]$/u;

/**
 * Whether the text left of the cursor looks like an interactive shell's prompt (the line typed after it is a command).
 * Questions (`[Y/n]`, `(yes/no)?`, `Password:`), the `>` continuation prompt and REPL prompts are not; any other prompt
 * shape is accepted. A classic shell prompt wins over the secret words (a host or folder may be called `token-service`).
 */
export function isShellPrompt(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || text === '>') return false;
  const last = text.split(/\s+/).pop()!;
  if (REPL_PROMPT.test(last) || REPL_PROMPT.test(text)) return false;
  if (SHELL_END.test(text) || /[➜❯]/u.test(text)) return true;
  if (SECRET_PROMPT.test(text)) return false;
  if (ARROW_END.test(text)) return true;
  // A question waiting for an answer.
  return !/[?:\])]$/.test(text);
}
