// 1.2.6: Claude Code (2.1.328+) arms an automatic continue when a session hits the usage limit and cancels it when the
// signed-in account changes meanwhile (unimux or cswap swapped the main login): "Automatic continue stopped · your login
// changed or ended · send a prompt to continue" (or "Workflow paused · ..."). Its Notification hook reaches the renderer as
// `notify` with `loginChanged` (src-tauri hooks/payload.rs). Any human prompt resumes the session on the current login, so
// unimux sends `continue` itself, once, when the setting is on, the login has room and the cell is idle at an empty prompt.
// This file is the pure part; renderer/loginResume.ts runs it.
import type { TargetState } from './agentPrompt';
import { cardState, effectivePercent, type ProviderUsage } from './usage';

/** The prompt that resumes the session or workflow. */
export const LOGIN_RESUME_PROMPT = 'continue';
/** A notification whose send had to wait (old usage data, the swap not finished) is retried until this long after it. */
export const LOGIN_RESUME_RETRY_MS = 2 * 60_000;
/** Never two automatic sends to one cell within this time (a login that keeps changing must not loop). */
export const LOGIN_RESUME_COOLDOWN_MS = 2 * 60_000;

/** `settings.resumeAfterLoginChange`: only `false` turns it off. */
export const loginResumeOn = (settings: { resumeAfterLoginChange?: boolean }): boolean => settings.resumeAfterLoginChange !== false;

/**
 * The Claude account a cell runs on. Cells start with the app's environment, so every Claude cell uses the live login (the
 * card marked as Claude Code's main one); before the first read that is the `claude:main` card, if any.
 */
export function cellAccount(providers: readonly ProviderUsage[]): ProviderUsage | undefined {
  return providers.find((u) => u.provider === 'claude' && u.active) ?? providers.find((u) => u.provider === 'claude' && u.accountId === 'claude:main');
}

export type AccountVerdict = 'ok' | 'signedOut' | 'limit';

/** Whether the account can take the prompt: signed in and below 100% in every window; unknown numbers do not block. */
export function accountVerdict(account: ProviderUsage | undefined, nowMs: number): AccountVerdict {
  if (!account) return 'ok';
  if (account.status === 'signedOut' || account.status === 'forbidden' || cardState(account) === 'expired') return 'signedOut';
  if (account.windows.some((w) => effectivePercent(w, nowMs) >= 100)) return 'limit';
  return 'ok';
}

export type LoginResumeVerdict = 'send' | 'off' | 'busy' | AccountVerdict;

/**
 * What to do with a login-changed notification now. `state` is the cell's TargetState before the notification is applied:
 * `ready` and `limit` (the turn that armed the automatic continue ended at the usage limit) take the prompt; anything else
 * (typing, working, a question, a queue...) is left to the user.
 */
export function loginResumeVerdict(input: { enabled: boolean; state: TargetState; providers: readonly ProviderUsage[]; nowMs: number }): LoginResumeVerdict {
  if (!input.enabled) return 'off';
  if (input.state !== 'ready' && input.state !== 'limit') return 'busy';
  const account = accountVerdict(cellAccount(input.providers), input.nowMs);
  return account === 'ok' ? 'send' : account;
}
