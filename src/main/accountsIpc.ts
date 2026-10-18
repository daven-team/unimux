// The accounts, login and usage IPC (0.9.3): every channel that changes something only answers the app window (R9, the same
// sender check as ssh:* via isFromWindow). A foreign sender gets the refusal shape the handler already returns for an
// invalid call and the handler never runs. Read-only getters stay open. No Electron imports, so it is tested in Node.
import type { IpcMain } from 'electron';

export interface AccountIpcHandlers {
  getUsage(): unknown;
  refreshUsage(): unknown;
  startLogin(request: unknown): unknown;
  cancelLogin(id: unknown): void;
  removeAccount(id: unknown): unknown;
  makeMain(id: unknown): unknown;
  adoptCopy(id: unknown): unknown;
  swapPending(): unknown;
  clearSwapPending(): unknown;
  dismissNotice(id: unknown): unknown;
}

type InvokeName = Exclude<keyof AccountIpcHandlers, 'cancelLogin'>;

/** Invoke channels that change something (a login, a swap, a removal, a network refresh, a dismissed notice). */
export const GUARDED_ACCOUNT_CHANNELS = {
  'usage:refresh': 'refreshUsage', 'auth:start': 'startLogin', 'accounts:remove': 'removeAccount', 'accounts:makeMain': 'makeMain',
  'accounts:adoptCopy': 'adoptCopy', 'accounts:clearSwapPending': 'clearSwapPending', 'accounts:dismissNotice': 'dismissNotice',
} as const satisfies Record<string, InvokeName>;

/** Sends (no answer) that change something. */
export const GUARDED_ACCOUNT_SENDS = { 'auth:cancel': 'cancelLogin' } as const satisfies Record<string, keyof AccountIpcHandlers>;

/** Read-only getters, open to any sender: the usage snapshot and whether an interrupted swap is unresolved. */
export const OPEN_ACCOUNT_CHANNELS = { 'usage:get': 'getUsage', 'accounts:swapPending': 'swapPending' } as const satisfies Record<string, InvokeName>;

export type GuardedAccountChannel = keyof typeof GUARDED_ACCOUNT_CHANNELS;

/** What a foreign sender gets on a guarded invoke channel: the handler's own "invalid" answer (usage: the state, not refreshed). */
export function accountRefusal(channel: GuardedAccountChannel, handlers: Pick<AccountIpcHandlers, 'getUsage'>): unknown {
  switch (channel) {
    case 'usage:refresh': return handlers.getUsage();
    case 'auth:start': return { ok: false, error: 'invalid request' };
    case 'accounts:remove': return { ok: false };
    case 'accounts:makeMain': return { ok: false, error: 'invalid' };
    case 'accounts:adoptCopy': return { ok: false, error: 'invalid' };
    case 'accounts:clearSwapPending': return { ok: false };
    case 'accounts:dismissNotice': return undefined;
  }
}

/** Open channels answered at once, even while the startup recovery runs (the usage snapshot only reads memory). */
const UNGATED_OPEN_CHANNELS: ReadonlySet<string> = new Set(['usage:get']);

/**
 * `ready` (0.9.4): the startup recovery of an interrupted swap or activation and the account migration. The window opens
 * before they finish, so every channel that could start a swap, a "Set as main", a login, a removal or a reconcile (and the
 * swap-pending answer, which the recovery changes) waits for it; the sender is checked at once.
 * `stopped` (0.9.6): true once the app quits. No new account work starts then (the quit waits for a running swap only): a
 * guarded channel answers with its refusal, also when the call was still waiting for `ready`.
 */
export function registerAccountIpc(ipc: Pick<IpcMain, 'handle' | 'on'>, handlers: AccountIpcHandlers, allowed: (event: { sender: unknown }) => boolean, ready: Promise<unknown> = Promise.resolve(), stopped: () => boolean = () => false): void {
  const afterReady = <T>(run: () => T): Promise<Awaited<T>> => ready.then(run, run) as Promise<Awaited<T>>;
  for (const [channel, name] of Object.entries(OPEN_ACCOUNT_CHANNELS)) {
    ipc.handle(channel, () => (UNGATED_OPEN_CHANNELS.has(channel) ? handlers[name]() : afterReady(() => handlers[name]())));
  }
  for (const [channel, name] of Object.entries(GUARDED_ACCOUNT_CHANNELS) as Array<[GuardedAccountChannel, InvokeName]>) {
    const handler = handlers[name] as (payload?: unknown) => unknown;
    const refusal = () => accountRefusal(channel, handlers);
    ipc.handle(channel, (event, payload) => (allowed(event) && !stopped() ? afterReady(() => (stopped() ? refusal() : handler(payload))) : refusal()));
  }
  // A cancel still runs while quitting: it only stops work.
  for (const [channel, name] of Object.entries(GUARDED_ACCOUNT_SENDS)) {
    ipc.on(channel, (event, payload) => { if (allowed(event)) void afterReady(() => handlers[name](payload)).catch(() => undefined); });
  }
}
