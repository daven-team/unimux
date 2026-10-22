// The connecting card of an SSH cell (1.0.4): what one connect attempt went through (steps, a short log) as pure helpers.
// The renderer feeds session and prompt events into reduceConnectAttempt and draws connectCardView; no DOM or Node imports.
import { sshErrorText, type Localized, type SshErrorCode, type SshPhase, type SshPrompt, type SshSessionState } from './ssh';

export type ConnectStepId = 'connect' | 'login' | 'terminal';
export type ConnectStepState = 'pending' | 'active' | 'done' | 'failed';
export const CONNECT_STEPS: readonly ConnectStepId[] = ['connect', 'login', 'terminal'];
/** The log keeps the last entries only (a server asking for a password again and again must not grow it without end). */
export const CONNECT_LOG_MAX = 40;

export interface ConnectLogEntry { at: number; tone: 'info' | 'ok' | 'error'; text: Localized }

/** What the log says about a host before it signs in: who, which key and whether a saved password exists. */
export interface ConnectContext { host: string; endpoint: string; user: string; keyLabel?: string; savedPassword?: boolean }

export interface ConnectAttempt {
  since: number;
  /** The last phase seen (a repeated event with the same phase adds nothing to the log). */
  phase: SshPhase;
  /** The step reached so far (index into CONNECT_STEPS). */
  step: number;
  /** The remote shell opened: from now on the terminal is the cell, an ended session shows the bottom bar. */
  shell: boolean;
  failedStep?: number;
  /** "Zamknij" (or a cancel): the card is gone until the next connect. */
  dismissed: boolean;
  promptId?: string;
  banner: boolean;
  log: ConnectLogEntry[];
}

export type ConnectEvent =
  | { kind: 'start'; at: number; ctx: ConnectContext }
  | { kind: 'session'; at: number; state: SshSessionState; ctx: ConnectContext }
  | { kind: 'prompt'; at: number; prompt: SshPrompt | null }
  | { kind: 'dismiss' };

const PRE_SHELL: readonly SshPhase[] = ['connecting', 'verifying', 'authenticating'];
export const isConnectingPhase = (phase: SshPhase | undefined): boolean => !!phase && PRE_SHELL.includes(phase);

export function stepOfPhase(phase: SshPhase): number {
  return phase === 'authenticating' ? 1 : phase === 'connected' ? 2 : 0;
}

const NETWORK: readonly SshErrorCode[] = ['dns', 'refused', 'unreachable', 'protocol', 'hostKeyRejected', 'hostKeyChanged'];
const LOGIN: readonly SshErrorCode[] = ['auth', 'passphrase', 'keyLocked', 'keyMissing'];

/** The step an error belongs to: the network and the host key fail the connect, credentials the login, a refused shell the terminal. */
export function failedStepOf(error: SshErrorCode | undefined, reached: number): number {
  if (error && NETWORK.includes(error)) return 0;
  if (error && LOGIN.includes(error)) return 1;
  if (error === 'shellDenied') return 2;
  return reached;
}

const entry = (at: number, text: Localized, tone: ConnectLogEntry['tone'] = 'info'): ConnectLogEntry => ({ at, tone, text });
const withLog = (attempt: ConnectAttempt, ...entries: ConnectLogEntry[]): ConnectAttempt =>
  ({ ...attempt, log: [...attempt.log, ...entries].slice(-CONNECT_LOG_MAX) });

const fresh = (at: number, ctx: ConnectContext): ConnectAttempt => ({
  since: at, phase: 'connecting', step: 0, shell: false, dismissed: false, banner: false,
  log: [entry(at, { key: 'Łączenie z {endpoint}', params: { endpoint: ctx.endpoint } })],
});

function loginEntries(at: number, ctx: ConnectContext): ConnectLogEntry[] {
  return [
    entry(at, { key: 'Logowanie jako {user}', params: { user: ctx.user } }),
    ...(ctx.keyLabel ? [entry(at, { key: 'Próba klucza {name}', params: { name: ctx.keyLabel } })] : []),
    ...(ctx.savedPassword ? [entry(at, { key: 'Próba zapisanego hasła' })] : []),
  ];
}

function promptEntries(at: number, prompt: SshPrompt): ConnectLogEntry[] {
  switch (prompt.kind) {
    case 'hostKey':
      return prompt.reason === 'changed'
        ? [entry(at, { key: 'Klucz hosta się zmienił ({type}) - czeka na Twoją decyzję', params: { type: prompt.keyType } }, 'error')]
        : [entry(at, { key: 'Nieznany klucz hosta ({type}) - czeka na Twoją decyzję', params: { type: prompt.keyType } })];
    case 'passphrase':
      return [
        ...(prompt.retry ? [entry(at, { key: 'Nieprawidłowe hasło klucza' }, 'error')] : []),
        entry(at, { key: 'Klucz {name} wymaga hasła', params: { name: prompt.keyLabel } }),
      ];
    case 'password':
    case 'sudo':
      return [
        ...(prompt.retry ? [entry(at, { key: 'Nieprawidłowe hasło' }, 'error')] : []),
        entry(at, { key: 'Serwer prosi o hasło dla {user}', params: { user: prompt.user } }),
      ];
    default:
      return [entry(at, { key: 'Serwer prosi o dodatkowe dane' })];
  }
}

/** One event applied to the attempt of a cell; undefined = no card (nothing is connecting and nothing failed while connecting). */
export function reduceConnectAttempt(prev: ConnectAttempt | undefined, ev: ConnectEvent): ConnectAttempt | undefined {
  if (ev.kind === 'start') return fresh(ev.at, ev.ctx);
  if (ev.kind === 'dismiss') return prev && { ...prev, dismissed: true };
  if (ev.kind === 'prompt') {
    if (!prev) return prev;
    if (!ev.prompt) return prev.promptId ? withLog({ ...prev, promptId: undefined }, entry(ev.at, { key: 'Odpowiedź wysłana' })) : prev;
    if (ev.prompt.id === prev.promptId) return prev;
    const step = ev.prompt.kind === 'hostKey' ? prev.step : Math.max(prev.step, 1);
    return withLog({ ...prev, promptId: ev.prompt.id, step }, ...promptEntries(ev.at, ev.prompt));
  }
  const { state, at, ctx } = ev;
  // A reloaded renderer (or a connect it did not start) meets a session already on its way: the log starts from what it sees.
  let attempt = prev;
  if (!attempt) {
    if (!isConnectingPhase(state.phase)) return undefined;
    attempt = fresh(state.since || at, ctx);
  }
  if (state.serverBanner && !attempt.banner) attempt = withLog({ ...attempt, banner: true }, entry(at, { key: 'Serwer przysłał komunikat powitalny' }));
  if (state.phase === attempt.phase) return attempt;
  const phase = state.phase;
  switch (phase) {
    case 'connecting':
      return { ...attempt, phase };
    case 'verifying':
      return withLog({ ...attempt, phase, step: 0 }, entry(at, { key: 'Połączono z {endpoint}, sprawdzanie klucza hosta', params: { endpoint: ctx.endpoint } }, 'ok'));
    case 'authenticating':
      return withLog({ ...attempt, phase, step: 1 }, entry(at, { key: 'Klucz hosta zweryfikowany' }, 'ok'), ...loginEntries(at, ctx));
    case 'connected':
      return withLog({ ...attempt, phase, step: 2, shell: true }, entry(at, { key: 'Zalogowano, powłoka gotowa' }, 'ok'));
    case 'error':
      return withLog({ ...attempt, phase, failedStep: attempt.shell ? undefined : failedStepOf(state.error, attempt.step), promptId: undefined },
        entry(at, sshErrorText(state.error ?? 'unknown', ctx), 'error'));
    case 'closed':
      // Closed before the shell opened: the user cancelled (Zamknij, Rozłącz); the card goes, the bottom bar stays.
      return withLog({ ...attempt, phase, dismissed: attempt.dismissed || !attempt.shell, promptId: undefined }, entry(at, { key: attempt.shell ? 'rozłączono' : 'Anulowano' }));
    default:
      return attempt;
  }
}

/** The card covers the terminal while the session is on its way, a login question is open, or the attempt failed before the shell. */
export function connectCardShown(attempt: ConnectAttempt | undefined, session: Pick<SshSessionState, 'phase'> | undefined, prompt: SshPrompt | undefined): boolean {
  if (attempt?.dismissed) return false;
  if (prompt) return true;
  if (isConnectingPhase(session?.phase)) return true;
  return session?.phase === 'error' && !!attempt && !attempt.shell;
}

export interface ConnectCardView {
  steps: Array<{ id: ConnectStepId; state: ConnectStepState }>;
  /** 0..1: how far the track is filled (up to the active or failed step). */
  progress: number;
  failed: boolean;
  status: Localized;
  error?: Localized;
}

export function connectCardView(attempt: ConnectAttempt | undefined, session: Pick<SshSessionState, 'phase' | 'error'> | undefined, prompt: SshPrompt | undefined, ctx: ConnectContext): ConnectCardView {
  const failed = session?.phase === 'error' && !prompt;
  const reached = Math.max(attempt?.step ?? 0, session ? stepOfPhase(session.phase === 'error' ? 'connecting' : session.phase) : 0, prompt && prompt.kind !== 'hostKey' ? 1 : 0);
  const current = failed ? attempt?.failedStep ?? failedStepOf(session?.error, reached) : Math.min(reached, CONNECT_STEPS.length - 1);
  const steps = CONNECT_STEPS.map((id, i) => ({ id, state: (i < current ? 'done' : i > current ? 'pending' : failed ? 'failed' : 'active') as ConnectStepState }));
  const progress = current / (CONNECT_STEPS.length - 1);
  if (failed) return { steps, progress, failed, status: { key: 'Nie udało się połączyć' }, error: sshErrorText(session?.error ?? 'unknown', ctx) };
  const status: Localized = prompt
    ? prompt.kind === 'hostKey' ? { key: 'Zdecyduj, czy ufasz temu hostowi' } : { key: 'Podaj dane logowania' }
    : session?.phase === 'verifying' ? { key: 'Sprawdzanie klucza hosta…' }
      : session?.phase === 'authenticating' ? { key: 'Logowanie jako {user} i otwieranie powłoki…', params: { user: ctx.user } }
        : { key: 'Łączenie z {endpoint}…', params: { endpoint: ctx.endpoint } };
  return { steps, progress, failed, status };
}
