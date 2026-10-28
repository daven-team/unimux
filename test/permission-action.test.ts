import { describe, expect, it } from 'vitest';
import {
  dialogReady, isPermissionAnswer, isPermissionToken, mayAnswer, noticeActions, permissionAsk, permissionKeys, type PermissionCellState,
} from '../src/shared/permissionAction';
import { notificationActions } from '../src/main/notifyOptions';
import { routeMessage } from '../src/shared/detached';

const claude = (patch: Partial<PermissionCellState> = {}): PermissionCellState => ({
  status: 'waiting', reason: 'attention', detail: { kind: 'permission', tool: 'Bash' }, hooked: true, agent: true, codex: false, ...patch,
});
const codex = (patch: Partial<PermissionCellState> = {}): PermissionCellState => ({
  status: 'waiting', reason: 'attention', detail: { kind: 'input' }, hooked: false, agent: true, codex: true, ...patch,
});

/** Claude Code 2.x permission dialog (boxed and unboxed forms). */
const CLAUDE_BOXED = [
  'some output above',
  '╭──────────────────────────────────────────╮',
  '│ Bash command                              │',
  '│   rm -rf node_modules                     │',
  '│ Do you want to proceed?                   │',
  '│ ❯ 1. Yes                                  │',
  "│   2. Yes, and don't ask again for rm      │",
  '│   3. No, and tell Claude what to do differently (esc) │',
  '╰──────────────────────────────────────────╯',
];
const CLAUDE_PLAIN = [
  ' Edit file',
  ' Do you want to make this edit to a.ts?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No, and tell Claude what to do differently (esc)',
];
const CODEX = [
  'Would you like to run the following command?',
  '  $ rm -rf build',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for this command (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  'Press enter to confirm or esc to cancel',
];

describe('permissionAsk', () => {
  it('answers a hooked Claude permission with a known tool and a Codex approval', () => {
    expect(permissionAsk(claude())).toBe('claude');
    expect(permissionAsk(codex())).toBe('codex');
  });

  it('refuses everything else: other states, questions, unknown tool, plan approval, shells, unhooked Claude', () => {
    expect(permissionAsk(claude({ status: 'working' }))).toBeNull();
    expect(permissionAsk(claude({ reason: 'done' }))).toBeNull();
    expect(permissionAsk(claude({ detail: { kind: 'question' } }))).toBeNull();
    expect(permissionAsk(claude({ detail: { kind: 'elicitation' } }))).toBeNull();
    expect(permissionAsk(claude({ detail: { kind: 'permission' } }))).toBeNull();
    expect(permissionAsk(claude({ detail: { kind: 'permission', tool: 'ExitPlanMode' } }))).toBeNull();
    expect(permissionAsk(claude({ detail: undefined }))).toBeNull();
    expect(permissionAsk(claude({ hooked: false }))).toBeNull();
    expect(permissionAsk(claude({ agent: false }))).toBeNull();
    expect(permissionAsk(codex({ detail: { kind: 'permission', tool: 'Bash' } }))).toBeNull();
    expect(permissionAsk(codex({ status: 'exited' }))).toBeNull();
  });
});

describe('dialogReady', () => {
  it('finds the dialog with the plain Yes highlighted', () => {
    expect(dialogReady(CLAUDE_BOXED)).toBe(true);
    expect(dialogReady(CLAUDE_PLAIN)).toBe(true);
    expect(dialogReady(CODEX)).toBe(true);
    expect(dialogReady(CLAUDE_PLAIN.map((l) => l.replace('❯', '>')))).toBe(true); // ASCII pointer fallback
    // A short session draws the dialog high up a tall screen: the empty rows below do not push it out.
    expect(dialogReady([...CLAUDE_PLAIN, ...Array.from({ length: 40 }, () => '')])).toBe(true);
  });

  it('refuses a moved highlight, a broader first option, a missing No and a dialog that scrolled away', () => {
    const moved = CLAUDE_PLAIN.map((l) => l.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes, allow', ' ❯ 2. Yes, allow'));
    expect(dialogReady(moved)).toBe(false);
    expect(dialogReady([' ❯ 1. Yes, and auto-accept edits', '   2. Yes, and manually approve edits', '   3. No, keep planning'])).toBe(false);
    expect(dialogReady([' ❯ 1. Yes, clear context and auto-accept edits', '   3. No, keep planning'])).toBe(false);
    expect(dialogReady([' ❯ 1. Yes'])).toBe(false);
    expect(dialogReady([])).toBe(false);
    // Text the agent printed higher up does not count: only the bottom of the screen is searched.
    expect(dialogReady([...CLAUDE_PLAIN, ...Array.from({ length: 30 }, () => 'output')])).toBe(false);
    // No option above the highlighted Yes does not count either.
    expect(dialogReady(['   3. No', ' ❯ 1. Yes'])).toBe(false);
  });
});

describe('mayAnswer', () => {
  const ok = { token: 'abc.4', current: 'abc.4', state: claude(), screen: CLAUDE_PLAIN };
  it('needs the same token, the same state and the dialog on screen', () => {
    expect(mayAnswer(ok)).toBe(true);
    expect(mayAnswer({ ...ok, token: 'abc.3' })).toBe(false); // something changed since the notification
    expect(mayAnswer({ ...ok, current: null })).toBe(false);
    expect(mayAnswer({ ...ok, token: 42 })).toBe(false);
    expect(mayAnswer({ ...ok, token: 'a b', current: 'a b' })).toBe(false);
    expect(mayAnswer({ ...ok, state: claude({ status: 'working' }) })).toBe(false);
    expect(mayAnswer({ ...ok, screen: ['$ '] })).toBe(false);
  });
});

describe('permissionKeys', () => {
  it('is Enter / Esc, as win32-input-mode key events in a ConPTY cell', () => {
    expect(permissionKeys('allow', false)).toBe('\r');
    expect(permissionKeys('deny', false)).toBe('\x1b');
    expect(permissionKeys('allow', true)).toBe('\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_');
    expect(permissionKeys('deny', true)).toBe('\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_');
  });
});

describe('notification buttons', () => {
  it('only a single cell needing you gets buttons; Allow / Deny only with a token', () => {
    expect(noticeActions({ event: 'attention', cells: 1, enabled: true, token: 'x.1' })).toEqual({ actions: 'answer', token: 'x.1' });
    expect(noticeActions({ event: 'attention', cells: 1, enabled: true, token: null })).toEqual({ actions: 'show' });
    expect(noticeActions({ event: 'attention', cells: 2, enabled: true, token: 'x.1' })).toEqual({});
    expect(noticeActions({ event: 'done', cells: 1, enabled: true, token: 'x.1' })).toEqual({});
    expect(noticeActions({ event: 'attention', cells: 1, enabled: false, token: 'x.1' })).toEqual({});
  });

  it('labels the buttons on Windows and macOS only, in the order the action index maps', () => {
    const t = (key: string) => `[${key}]`;
    expect(notificationActions('answer', 'win32', t)).toEqual([{ text: '[Zezwól]', answer: 'allow' }, { text: '[Odrzuć]', answer: 'deny' }, { text: '[Pokaż]' }]);
    expect(notificationActions('show', 'darwin', t)).toEqual([{ text: '[Pokaż]' }]);
    expect(notificationActions('answer', 'linux', t)).toEqual([]);
  });

  it('validates what comes over IPC', () => {
    expect(isPermissionToken('k3j4.12')).toBe(true);
    expect(isPermissionToken('')).toBe(false);
    expect(isPermissionToken('x'.repeat(81))).toBe(false);
    expect(isPermissionAnswer('allow')).toBe(true);
    expect(isPermissionAnswer('yes')).toBe(false);
  });

  it('routes an answer to the window that holds the cell', () => {
    expect(routeMessage('notify:answer', ['c1', 't.1', 'allow'], new Map([['c1', 'w2']]))).toEqual([{ window: 'w2', args: ['c1', 't.1', 'allow'] }]);
    expect(routeMessage('notify:answer', ['c9', 't.1', 'deny'], new Map())).toEqual([{ window: null, args: ['c9', 't.1', 'deny'] }]);
  });
});
