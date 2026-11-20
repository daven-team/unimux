// 1.2.6: sends `continue` to a Claude cell whose automatic continue Claude Code stopped because the login changed (see
// shared/loginResume.ts for the rules). Every `cell:hook` of this window passes through `handleCellHook`: a login-changed
// notification for a cell this window holds is answered with the prompt instead of making the cell "needs you"; when it cannot
// go now only because of the account (old usage data right after a swap), the cell shows "needs you" and the send is tried
// once more on the next usage update within LOGIN_RESUME_RETRY_MS, as long as nothing else happened in the cell.
import { cellLabel } from '../../shared/agentWork';
import {
  LOGIN_RESUME_COOLDOWN_MS, LOGIN_RESUME_PROMPT, LOGIN_RESUME_RETRY_MS, loginResumeOn, loginResumeVerdict,
} from '../../shared/loginResume';
import { findCell, getProfile } from '../../shared/state';
import type { HookEvent, HookInfo } from '../../shared/status';
import type { ProviderUsage } from '../../shared/usage';
import { stateHere } from './agentPrompt';
import { profileName } from './cliUi';
import { tr } from './i18n';
import { deliverPrompt, promptPending, typedSinceSettled } from './promptQueue';
import { getS, getUi, toast } from './store';
import { terminals } from './terminals/TerminalManager';

let providers: readonly ProviderUsage[] = [];
let listening = false;
/** Cells whose login-changed notification still waits for a usage update (until this Date.now()). */
const pending = new Map<string, number>();
/** When each cell was last sent `continue` by this module (Date.now()). */
const sentAt = new Map<string, number>();

function listen(): void {
  if (listening) return;
  listening = true;
  window.mc.on('usage:state', (next) => { providers = next.providers; retryPending(); });
  void window.mc.getUsage().then((initial) => { if (!providers.length) providers = initial.providers; }).catch(() => undefined);
}

function isClaudeCell(cellId: string): boolean {
  const s = getS();
  const cell = findCell(s, cellId)?.cell;
  return !!cell && !cell.ssh && getProfile(s, cell.profileId).cli === 'claude';
}

function send(cellId: string): void {
  pending.delete(cellId);
  sentAt.set(cellId, Date.now());
  deliverPrompt(cellId, LOGIN_RESUME_PROMPT);
  const s = getS();
  const cell = findCell(s, cellId)?.cell;
  const label = cell ? cellLabel(cell, getUi().sessionTitles, profileName(getProfile(s, cell.profileId), tr)) : cellId;
  toast(tr('Konto zmienione - wysłano „continue” do {cell}', { cell: label }));
}

/** Decides right when the notification comes, before it is applied: true when `continue` went out. */
function tryNow(cellId: string): boolean {
  const now = Date.now();
  if (now - (sentAt.get(cellId) ?? -Infinity) < LOGIN_RESUME_COOLDOWN_MS) return false;
  const verdict = loginResumeVerdict({ enabled: loginResumeOn(getS().settings), state: stateHere(cellId, LOGIN_RESUME_PROMPT), providers, nowMs: now });
  if (verdict === 'send') { send(cellId); return true; }
  if (verdict === 'limit' || verdict === 'signedOut') pending.set(cellId, now + LOGIN_RESUME_RETRY_MS);
  return false;
}

/**
 * A retry after a usage update. The notification made the cell "needs you", so the cell counts as ready when it still waits,
 * no other hook came since (`pending` is dropped on any), the user typed nothing and no prompt is queued or on its way.
 */
function retryPending(): void {
  const now = Date.now();
  for (const [cellId, until] of [...pending]) {
    if (now > until || !terminals.has(cellId) || !isClaudeCell(cellId)) { pending.delete(cellId); continue; }
    const waiting = getUi().statuses[cellId] === 'waiting' && !typedSinceSettled(cellId) && !promptPending(cellId)
      && !findCell(getS(), cellId)?.cell.promptQueue?.items.length;
    if (!waiting) { pending.delete(cellId); continue; }
    const verdict = loginResumeVerdict({ enabled: loginResumeOn(getS().settings), state: 'ready', providers, nowMs: now });
    if (verdict === 'send') send(cellId);
    else if (verdict === 'off') pending.delete(cellId);
  }
}

/** The `cell:hook` handler of a window (the main one and every detached one). */
export function handleCellHook(cellId: string, event: HookEvent, info?: HookInfo): void {
  listen();
  // Anything else in the cell (but the quiet idle reminder) means it moved on: a waiting retry is dropped.
  if (event !== 'idle') pending.delete(cellId);
  if (event === 'notify' && info?.loginChanged === true && terminals.has(cellId) && isClaudeCell(cellId)) {
    try {
      if (tryNow(cellId)) return;
    } catch { /* fall back to today's behaviour: the cell needs the user */ }
  }
  terminals.hook(cellId, event, info);
}
