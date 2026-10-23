// The connecting card of an SSH cell (1.0.4): what one connect attempt went through (steps, a short log) as pure helpers.
// The renderer feeds session and prompt events into reduceConnectAttempt and draws connectCardView; no DOM or Node imports.
// 1.0.5: the card covers every state of a cell that is not connected (connecting, failed, cancelled, disconnected); the raw
// terminal only shows while the shell is open.
import { sshErrorText, type Localized, type SshErrorCode, type SshPhase, type SshPrompt, type SshSessionState } from './ssh';

export type ConnectStepId = 'connect' | 'login' | 'terminal';
export type ConnectStepState = 'pending' | 'active' | 'done' | 'failed' | 'stopped';
/** What the card says: on the way, failed before the shell, cancelled by the user, or the open session ended. */
export type ConnectCardKind = 'connecting' | 'failed' | 'cancelled' | 'disconnected';
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
  /** The remote shell opened: from now on the terminal is the cell until the session ends ("Rozłączono" on the card). */
  shell: boolean;
  failedStep?: number;
  /** "Anuluj" while connecting: the end that follows is a cancel, not a failure. */
  cancelled: boolean;
  promptId?: string;
  banner: boolean;
  log: ConnectLogEntry[];
}

export type ConnectEvent =
  | { kind: 'start'; at: number; ctx: ConnectContext }
  | { kind: 'session'; at: number; state: SshSessionState; ctx: ConnectContext }
  | { kind: 'prompt'; at: number; prompt: SshPrompt | null }
  | { kind: 'cancel' };

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
  since: at, phase: 'connecting', step: 0, shell: false, cancelled: false, banner: false,
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
  if (ev.kind === 'cancel') return prev && !prev.cancelled && !prev.shell && isConnectingPhase(prev.phase) ? { ...prev, cancelled: true } : prev;
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
      // A cancel can end the attempt with an error (the login loop answers "cancelled"): before the shell it stays a cancel.
      if (!attempt.shell && (attempt.cancelled || state.error === 'cancelled')) return withLog({ ...attempt, phase, cancelled: true, promptId: undefined }, entry(at, { key: 'Anulowano' }));
      return withLog({ ...attempt, phase, failedStep: attempt.shell ? undefined : failedStepOf(state.error, attempt.step), promptId: undefined },
        entry(at, sshErrorText(state.error ?? 'unknown', ctx), 'error'));
    case 'closed':
      // Closed before the shell opened: the user cancelled (Anuluj, Rozłącz); after the shell: the session ended.
      return withLog({ ...attempt, phase, cancelled: !attempt.shell, promptId: undefined }, entry(at, { key: attempt.shell ? 'Rozłączono' : 'Anulowano' }));
    default:
      return attempt;
  }
}

/** The card covers the terminal whenever the cell is not connected (idle has its own card) or a login question is open. */
export function connectCardShown(session: Pick<SshSessionState, 'phase'> | undefined, prompt: SshPrompt | undefined): boolean {
  if (prompt) return true;
  const phase = session?.phase;
  return isConnectingPhase(phase) || phase === 'error' || phase === 'closed';
}

/** Which state the card shows; a session that ended without an attempt in the renderer (after a reload) counts by its phase. */
export function connectCardKind(attempt: ConnectAttempt | undefined, session: Pick<SshSessionState, 'phase' | 'error'> | undefined, prompt: SshPrompt | undefined): ConnectCardKind {
  const phase = session?.phase;
  if (prompt || (phase !== 'error' && phase !== 'closed')) return 'connecting';
  if (attempt?.shell) return 'disconnected';
  if (attempt?.cancelled || session?.error === 'cancelled') return 'cancelled';
  if (phase === 'error') return 'failed';
  return attempt ? 'cancelled' : 'disconnected';
}

export interface ConnectCardView {
  kind: ConnectCardKind;
  steps: Array<{ id: ConnectStepId; state: ConnectStepState }>;
  /** 0..1: how far the track is filled (up to the active or failed step). */
  progress: number;
  /** A red card: the connect failed or the open session ended with an error. */
  failed: boolean;
  /** The attempt is over: "Połącz ponownie" and "Zamknij komórkę" instead of "Anuluj". */
  ended: boolean;
  status: Localized;
  error?: Localized;
}

const stepsAt = (current: number, at: ConnectStepState): ConnectCardView['steps'] =>
  CONNECT_STEPS.map((id, i) => ({ id, state: i < current ? 'done' : i > current ? 'pending' : at }));

export function connectCardView(attempt: ConnectAttempt | undefined, session: Pick<SshSessionState, 'phase' | 'error' | 'exitCode'> | undefined, prompt: SshPrompt | undefined, ctx: ConnectContext): ConnectCardView {
  const kind = connectCardKind(attempt, session, prompt);
  const last = CONNECT_STEPS.length - 1;
  if (kind === 'disconnected') {
    // The shell was open: every step was done; an error marks the terminal red, a clean end (exit) leaves it done.
    const failed = session?.phase === 'error';
    const error: Localized | undefined = failed ? sshErrorText(session?.error ?? 'unknown', ctx)
      : session?.exitCode !== undefined ? { key: 'Sesja zakończona (kod {code})', params: { code: session.exitCode } } : undefined;
    return { kind, steps: stepsAt(last, failed ? 'failed' : 'done'), progress: 1, failed, ended: true, status: { key: 'Rozłączono' }, ...(error ? { error } : {}) };
  }
  const reached = Math.max(attempt?.step ?? 0, session && isConnectingPhase(session.phase) ? stepOfPhase(session.phase) : 0, prompt && prompt.kind !== 'hostKey' ? 1 : 0);
  if (kind === 'cancelled') {
    const current = Math.min(reached, last);
    return { kind, steps: stepsAt(current, 'stopped'), progress: current / last, failed: false, ended: true, status: { key: 'Anulowano' } };
  }
  if (kind === 'failed') {
    const current = attempt?.failedStep ?? failedStepOf(session?.error, reached);
    return { kind, steps: stepsAt(current, 'failed'), progress: current / last, failed: true, ended: true, status: { key: 'Nie udało się połączyć' }, error: sshErrorText(session?.error ?? 'unknown', ctx) };
  }
  const current = Math.min(reached, last);
  const status: Localized = prompt
    ? prompt.kind === 'hostKey' ? { key: 'Zdecyduj, czy ufasz temu hostowi' } : { key: 'Podaj dane logowania' }
    : session?.phase === 'verifying' ? { key: 'Sprawdzanie klucza hosta…' }
      : session?.phase === 'authenticating' ? { key: 'Logowanie jako {user} i otwieranie powłoki…', params: { user: ctx.user } }
        : { key: 'Łączenie z {endpoint}…', params: { endpoint: ctx.endpoint } };
  return { kind, steps: stepsAt(current, 'active'), progress: current / last, failed: false, ended: false, status };
}
