// 1.0.9: "Zezwól" / "Odrzuć" in the OS notification of a permission request. Answering from outside the terminal is only safe
// while the cell is still in exactly the dialog the notification was raised for, so every rule here errs on the side of "do
// nothing, just show the cell". The renderer owns the status tracker and the terminal buffer, so it decides (see
// TerminalManager.answerPermission); main only shows the buttons and relays the click.
//
// Why keys and not the PermissionRequest hook's decision: Claude Code runs that hook when it is about to ask and waits for it,
// so holding the request open until the user clicks would keep the dialog from showing in the terminal. The hook answers at
// once (204, no decision) and the answer is typed into the dialog instead.
import type { CellStatus, StatusDetail, StatusReason } from './status';
import { encodeWin32Key } from './win32input';

export type PermissionAnswer = 'allow' | 'deny';

/** What a single-cell "needs you" notification may offer: Allow / Deny / Show, or only Show. */
export type NoticeActions = 'answer' | 'show';

export interface PermissionCellState {
  status: CellStatus;
  reason: StatusReason;
  detail: StatusDetail | undefined;
  /** Precise hooks drive the cell (Claude Code's PermissionRequest or Notification permission_prompt). */
  hooked: boolean;
  /** An agent cell (never a shell or SSH session). */
  agent: boolean;
  codex: boolean;
}

/**
 * Tools whose permission dialog has a first option broader than "Yes" (ExitPlanMode: "Yes, and auto-accept edits"): never
 * answered from a notification. The screen check below would refuse them as well; this keeps the button from being offered.
 */
const NEVER_ALLOW_TOOLS = new Set(['ExitPlanMode']);

/**
 * Which agent's dialog the cell shows, or null when the cell is not in a permission state that may be answered from outside:
 * - Claude: hook-driven, waiting with reason attention, detail `permission` with a known tool (Claude Code 2.1.78+ hooks).
 *   A permission_prompt Notification without a tool name (older versions, curl hooks) could also be a sandbox network prompt
 *   or a plan approval: only "Pokaż" then.
 * - Codex: its approval OSC 9 (waiting, attention, detail `input`).
 */
export function permissionAsk(s: PermissionCellState): 'claude' | 'codex' | null {
  if (!s.agent || s.status !== 'waiting' || s.reason !== 'attention' || !s.detail) return null;
  if (s.codex) return s.detail.kind === 'input' ? 'codex' : null;
  if (!s.hooked || s.detail.kind !== 'permission' || !s.detail.tool || NEVER_ALLOW_TOOLS.has(s.detail.tool)) return null;
  return 'claude';
}

/** The dialog's selected first option is exactly "Yes" (Claude) or "Yes, proceed" (Codex), optionally with a key hint "(y)". */
const SELECTED_YES = /^[\s│┃|]*[❯›>▶]\s*1[.)]\s+Yes(?:,\s*proceed)?(?:\s+\([^()]{1,16}\))?\s*[│┃|]?\s*$/;
/** A "No ..." option of the same dialog (Claude: "3. No, and tell Claude what to do differently (esc)", Codex the same with Codex). */
const NO_OPTION = /^[\s│┃|]*[❯›>▶]?\s*[2-9][.)]\s+No\b/;
/** Only the last drawn rows of the screen are searched: a dialog is drawn last, output higher up is not a dialog. */
export const DIALOG_ROWS = 24;

/**
 * True when the bottom of the terminal screen shows a permission dialog whose highlighted option is the plain "Yes", with a
 * "No" option below it. Enter then means exactly "Yes" and Esc means "No" in both Claude Code and Codex. Anything else (the
 * user moved the highlight, a plan approval, the dialog already gone, a different question) is false.
 */
export function dialogReady(screen: readonly string[]): boolean {
  // The bottom of what is drawn: a short session draws its dialog high up a tall screen, with empty rows below it.
  let end = screen.length;
  while (end > 0 && !screen[end - 1].trim()) end--;
  const lines = screen.slice(Math.max(0, end - DIALOG_ROWS), end);
  const yes = lines.findIndex((line) => SELECTED_YES.test(line));
  if (yes < 0) return false;
  return lines.slice(yes + 1).some((line) => NO_OPTION.test(line));
}

/**
 * The keys that answer the dialog: Enter on the highlighted "Yes", or Esc for "No". In a ConPTY cell with win32-input-mode
 * the keys go as key events (down and up), like the keyboard sends them.
 */
export function permissionKeys(answer: PermissionAnswer, win32: boolean): string {
  if (!win32) return answer === 'allow' ? '\r' : '\x1b';
  const code = answer === 'allow' ? 'Enter' : 'Escape';
  const key = { code, key: code, ctrlKey: false, altKey: false, shiftKey: false };
  return `${encodeWin32Key({ ...key, type: 'keydown' })}${encodeWin32Key({ ...key, type: 'keyup' })}`;
}

/**
 * The buttons of one notification: only a notification about a single cell that needs the user gets any (a combined one
 * names several cells). With a token (the cell's dialog may be answered) Zezwól / Odrzuć / Pokaż, otherwise only Pokaż.
 */
export function noticeActions(n: { event: string; cells: number; enabled: boolean; token: string | null }): { actions?: NoticeActions; token?: string } {
  if (!n.enabled || n.event !== 'attention' || n.cells !== 1) return {};
  return n.token ? { actions: 'answer', token: n.token } : { actions: 'show' };
}

const TOKEN = /^[\w.:-]{1,80}$/;

export function isPermissionToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

export function isPermissionAnswer(value: unknown): value is PermissionAnswer {
  return value === 'allow' || value === 'deny';
}

/**
 * Whether a click on "Zezwól" / "Odrzuć" may type into the cell: the token of the notification is the cell's current one
 * (no status or detail change and no keystroke since it was raised), the cell is still in an answerable permission state and
 * its screen shows the dialog with "Yes" highlighted. False means: do nothing but show the cell.
 */
export function mayAnswer(input: { token: unknown; current: string | null; state: PermissionCellState; screen: readonly string[] }): boolean {
  return isPermissionToken(input.token) && input.current !== null && input.token === input.current
    && permissionAsk(input.state) !== null && dialogReady(input.screen);
}
