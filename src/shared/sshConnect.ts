// The connecting card of an SSH cell (1.0.4): what one connect attempt went through (phases, a short log) as pure helpers.
// The renderer feeds session and prompt events into reduceConnectAttempt and draws connectCardView; no DOM or Node imports.
// 1.0.5: the card covers every state of a cell that is not connected (connecting, failed, cancelled, disconnected); the raw
// terminal only shows while the shell is open, and the app never writes its own status lines into it.
import { sshErrorText, type Localized, type SshErrorCode, type SshPhase, type SshPrompt, type SshSessionState } from './ssh';

export type ConnectStepId = 'connect' | 'hostKey' | 'login' | 'shell';
export type ConnectStepState = 'pending' | 'active' | 'done' | 'failed' | 'stopped';
/** What the card says: on the way, failed before the shell, cancelled by the user, or the open session ended. */
export type ConnectCardKind = 'connecting' | 'failed' | 'cancelled' | 'disconnected';
/** The phases of a connect as the card lists them: reach the server, verify its key, sign in, open the shell. */
export const CONNECT_STEPS: readonly ConnectStepId[] = ['connect', 'hostKey', 'login', 'shell'];
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
  /** When each step reached so far began (index into CONNECT_STEPS): the card shows how long the finished ones took. */
  stepAt: number[];
  /** The remote shell opened: from now on the terminal is the cell until the session ends ("Rozłączono" on the card). */
  shell: boolean;
  /** When the shell opened (how long the session lasted, once it ends). */
  shellAt?: number;
  /** When the attempt or the session ended (failed, cancelled, closed). */
  endedAt?: number;
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

const STEP_OF_PHASE: Partial<Record<SshPhase, number>> = { verifying: 1, authenticating: 2, connected: 3 };
export function stepOfPhase(phase: SshPhase): number {
  return STEP_OF_PHASE[phase] ?? 0;
}

const NETWORK: readonly SshErrorCode[] = ['dns', 'refused', 'unreachable', 'protocol'];
const HOST_KEY: readonly SshErrorCode[] = ['hostKeyRejected', 'hostKeyChanged'];
const LOGIN: readonly SshErrorCode[] = ['auth', 'passphrase', 'keyLocked', 'keyMissing'];

/** The step an error belongs to: the network fails the connect, the host key its check, credentials the login, a refused shell the shell. */
export function failedStepOf(error: SshErrorCode | undefined, reached: number): number {
  if (error && NETWORK.includes(error)) return 0;
  if (error && HOST_KEY.includes(error)) return 1;
  if (error && LOGIN.includes(error)) return 2;
  if (error === 'shellDenied') return 3;
  return reached;
}

const entry = (at: number, text: Localized, tone: ConnectLogEntry['tone'] = 'info'): ConnectLogEntry => ({ at, tone, text });
const withLog = (attempt: ConnectAttempt, ...entries: ConnectLogEntry[]): ConnectAttempt =>
  ({ ...attempt, log: [...attempt.log, ...entries].slice(-CONNECT_LOG_MAX) });

/** The attempt moved on to `step` (never back): the steps it passes start now. */
function reach(attempt: ConnectAttempt, step: number, at: number): ConnectAttempt {
  if (step <= attempt.step) return attempt;
  const stepAt = [...attempt.stepAt];
  for (let i = attempt.step + 1; i <= step; i++) stepAt[i] = at;
  return { ...attempt, step, stepAt };
}

const fresh = (at: number, ctx: ConnectContext): ConnectAttempt => ({
  since: at, phase: 'connecting', step: 0, stepAt: [at], shell: false, cancelled: false, banner: false,
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
    const reached = reach(prev, ev.prompt.kind === 'hostKey' ? 1 : 2, ev.at);
    return withLog({ ...reached, promptId: ev.prompt.id }, ...promptEntries(ev.at, ev.prompt));
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
      return withLog({ ...reach(attempt, 1, at), phase }, entry(at, { key: 'Połączono z {endpoint}, sprawdzanie klucza hosta', params: { endpoint: ctx.endpoint } }, 'ok'));
    case 'authenticating':
      return withLog({ ...reach(attempt, 2, at), phase }, entry(at, { key: 'Klucz hosta zweryfikowany' }, 'ok'), ...loginEntries(at, ctx));
    case 'connected':
      return withLog({ ...reach(attempt, 3, at), phase, shell: true, shellAt: at, endedAt: undefined }, entry(at, { key: 'Zalogowano, powłoka gotowa' }, 'ok'));
    case 'error':
      // A cancel can end the attempt with an error (the login loop answers "cancelled"): before the shell it stays a cancel.
      if (!attempt.shell && (attempt.cancelled || state.error === 'cancelled')) return withLog({ ...attempt, phase, cancelled: true, promptId: undefined, endedAt: at }, entry(at, { key: 'Anulowano' }));
      return withLog({ ...attempt, phase, failedStep: attempt.shell ? undefined : failedStepOf(state.error, attempt.step), promptId: undefined, endedAt: at },
        entry(at, sshErrorText(state.error ?? 'unknown', ctx), 'error'));
    case 'closed':
      // Closed before the shell opened: the user cancelled (Anuluj, Rozłącz); after the shell: the session ended.
      return withLog({ ...attempt, phase, cancelled: !attempt.shell, promptId: undefined, endedAt: at }, entry(at, { key: attempt.shell ? 'Rozłączono' : 'Anulowano' }));
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

export interface ConnectStepView {
  id: ConnectStepId;
  state: ConnectStepState;
  label: Localized;
  /** How long a finished step took (ms), when the renderer saw it begin and end. */
  ms?: number;
}

export interface ConnectCardView {
  kind: ConnectCardKind;
  steps: ConnectStepView[];
  /** After the shell was open: the session's own row, ended cleanly or with an error, and how long it lasted. */
  session?: { state: 'done' | 'failed'; label: Localized; ms?: number };
  /** A red card: the connect failed or the open session ended with an error. */
  failed: boolean;
  /** The attempt is over: "Połącz ponownie" and "Zamknij komórkę" instead of "Anuluj". */
  ended: boolean;
  status: Localized;
  error?: Localized;
  /** The clock of the attempt: from `since`, frozen at `until` once it is over (no clock after a reload). */
  since?: number;
  until?: number;
}

function stepLabel(id: ConnectStepId, ctx: ConnectContext): Localized {
  switch (id) {
    case 'connect': return ctx.endpoint ? { key: 'Połączenie z {endpoint}', params: { endpoint: ctx.endpoint } } : { key: 'Połączenie z serwerem' };
    case 'hostKey': return { key: 'Weryfikacja klucza hosta' };
    case 'login': return ctx.user ? { key: 'Logowanie jako {user}', params: { user: ctx.user } } : { key: 'Logowanie' };
    default: return { key: 'Otwarcie powłoki' };
  }
}

function stepsAt(current: number, at: ConnectStepState, attempt: ConnectAttempt | undefined, ctx: ConnectContext): ConnectStepView[] {
  return CONNECT_STEPS.map((id, i) => {
    const state: ConnectStepState = i < current ? 'done' : i > current ? 'pending' : at;
    const begin = attempt?.stepAt[i];
    const end = attempt?.stepAt[i + 1];
    const ms = state === 'done' && begin !== undefined && end !== undefined ? Math.max(0, end - begin) : undefined;
    return { id, state, label: stepLabel(id, ctx), ...(ms !== undefined ? { ms } : {}) };
  });
}

const clockOf = (attempt: ConnectAttempt | undefined, ended: boolean): Pick<ConnectCardView, 'since' | 'until'> =>
  attempt ? { since: attempt.since, ...(ended ? { until: attempt.endedAt ?? attempt.since } : {}) } : {};

export function connectCardView(attempt: ConnectAttempt | undefined, session: Pick<SshSessionState, 'phase' | 'error' | 'exitCode'> | undefined, prompt: SshPrompt | undefined, ctx: ConnectContext): ConnectCardView {
  const kind = connectCardKind(attempt, session, prompt);
  const last = CONNECT_STEPS.length - 1;
  if (kind === 'disconnected') {
    // The shell was open: every phase of the connect is done; the session row says how it ended and how long it lasted.
    const failed = session?.phase === 'error';
    const error: Localized | undefined = failed ? sshErrorText(session?.error ?? 'unknown', ctx)
      : session?.exitCode !== undefined ? { key: 'Sesja zakończona (kod {code})', params: { code: session.exitCode } } : undefined;
    const ms = attempt?.shellAt !== undefined && attempt.endedAt !== undefined ? Math.max(0, attempt.endedAt - attempt.shellAt) : undefined;
    const label: Localized = ms !== undefined ? { key: 'Sesja trwała {duration}', params: { duration: formatDuration(ms) } } : { key: 'Sesja zakończona' };
    const row: NonNullable<ConnectCardView['session']> = { state: failed ? 'failed' : 'done', label, ...(ms !== undefined ? { ms } : {}) };
    return { kind, steps: stepsAt(last + 1, 'done', attempt, ctx), session: row, failed, ended: true, status: { key: 'Rozłączono' }, ...(error ? { error } : {}) };
  }
  const reached = Math.max(attempt?.step ?? 0, session && isConnectingPhase(session.phase) ? stepOfPhase(session.phase) : 0, prompt ? (prompt.kind === 'hostKey' ? 1 : 2) : 0);
  if (kind === 'cancelled') {
    const current = Math.min(reached, last);
    return { kind, steps: stepsAt(current, 'stopped', attempt, ctx), failed: false, ended: true, status: { key: 'Anulowano' }, ...clockOf(attempt, true) };
  }
  if (kind === 'failed') {
    const current = attempt?.failedStep ?? failedStepOf(session?.error, reached);
    return { kind, steps: stepsAt(current, 'failed', attempt, ctx), failed: true, ended: true, status: { key: 'Nie udało się połączyć' }, error: sshErrorText(session?.error ?? 'unknown', ctx), ...clockOf(attempt, true) };
  }
  const current = Math.min(reached, last);
  const status: Localized = prompt
    ? prompt.kind === 'hostKey' ? { key: 'Zdecyduj, czy ufasz temu hostowi' } : { key: 'Podaj dane logowania' }
    : session?.phase === 'verifying' ? { key: 'Sprawdzanie klucza hosta…' }
      : session?.phase === 'authenticating' ? { key: 'Logowanie jako {user} i otwieranie powłoki…', params: { user: ctx.user } }
        : { key: 'Łączenie z {endpoint}…', params: { endpoint: ctx.endpoint } };
  return { kind, steps: stepsAt(current, 'active', attempt, ctx), failed: false, ended: false, status, ...clockOf(attempt, false) };
}

/** A duration in units every UI language reads alike: 240 ms, 7 s, 3 min 05 s, 2 h 14 min. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** The running clock of an attempt: 0:07, 1:42, 1:02:05. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
