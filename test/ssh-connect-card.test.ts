import { describe, expect, it } from 'vitest';
import type { SshPhase, SshPrompt, SshSessionState } from '../src/shared/ssh';
import {
  CONNECT_LOG_MAX, connectCardKind, connectCardShown, connectCardView, failedStepOf, reduceConnectAttempt, type ConnectAttempt, type ConnectContext, type ConnectEvent,
} from '../src/shared/sshConnect';

const ctx: ConnectContext = { host: 'box.lan', endpoint: 'box.lan:2222', user: 'ola', keyLabel: 'laptop', savedPassword: true };
const state = (phase: SshPhase, extra: Partial<SshSessionState> = {}): SshSessionState => ({ cellId: 'c', hostId: 'h', phase, since: 1, ...extra });
const session = (phase: SshPhase, extra: Partial<SshSessionState> = {}): ConnectEvent => ({ kind: 'session', at: 10, state: state(phase, extra), ctx });
const hostKey: SshPrompt = { id: 'p1', kind: 'hostKey', endpoint: 'box.lan:2222', keyType: 'ssh-ed25519', fingerprint: 'SHA256:x', reason: 'unknown', knownFingerprints: [], knownTypes: [] };
const password = (id: string, retry = false): SshPrompt => ({ id, kind: 'password', user: 'ola', endpoint: 'box.lan:2222', canSave: true, retry });

const run = (events: ConnectEvent[], from?: ConnectAttempt) => events.reduce<ConnectAttempt | undefined>(reduceConnectAttempt, from);
const keys = (a: ConnectAttempt | undefined) => a?.log.map((e) => e.text.key);

describe('SSH connecting card: attempt log', () => {
  it('logs a full connect from the address to the ready shell', () => {
    const a = run([
      { kind: 'start', at: 1, ctx }, session('connecting'), session('verifying'),
      { kind: 'prompt', at: 11, prompt: hostKey }, { kind: 'prompt', at: 12, prompt: null },
      session('authenticating'), session('connected'),
    ]);
    expect(keys(a)).toEqual([
      'Łączenie z {endpoint}', 'Połączono z {endpoint}, sprawdzanie klucza hosta', 'Nieznany klucz hosta ({type}) - czeka na Twoją decyzję',
      'Odpowiedź wysłana', 'Klucz hosta zweryfikowany', 'Logowanie jako {user}', 'Próba klucza {name}', 'Próba zapisanego hasła', 'Zalogowano, powłoka gotowa',
    ]);
    expect(a?.log[0].text.params).toEqual({ endpoint: 'box.lan:2222' });
    expect(a?.shell).toBe(true);
    expect(a?.step).toBe(2);
  });

  it('adds nothing for a repeated phase and logs the banner once', () => {
    const a = run([{ kind: 'start', at: 1, ctx }, session('connecting'), session('connecting', { serverBanner: 'hi' }), session('connecting', { serverBanner: 'hi' })]);
    expect(keys(a)).toEqual(['Łączenie z {endpoint}', 'Serwer przysłał komunikat powitalny']);
  });

  it('logs a wrong password before asking again, and the same prompt only once', () => {
    const a = run([{ kind: 'start', at: 1, ctx }, session('authenticating'), { kind: 'prompt', at: 2, prompt: password('a') }, { kind: 'prompt', at: 3, prompt: password('a') }, { kind: 'prompt', at: 4, prompt: password('b', true) }]);
    expect(keys(a)?.slice(-3)).toEqual(['Serwer prosi o hasło dla {user}', 'Nieprawidłowe hasło', 'Serwer prosi o hasło dla {user}']);
    expect(a?.log.at(-2)?.tone).toBe('error');
  });

  it('keeps the error text and marks the step that failed', () => {
    const refused = run([{ kind: 'start', at: 1, ctx }, session('error', { error: 'refused' })]);
    expect(refused?.failedStep).toBe(0);
    expect(refused?.log.at(-1)).toMatchObject({ tone: 'error', text: { key: 'Połączenie odrzucone ({endpoint})', params: { endpoint: 'box.lan:2222' } } });
    const auth = run([{ kind: 'start', at: 1, ctx }, session('verifying'), session('authenticating'), session('error', { error: 'auth' })]);
    expect(auth?.failedStep).toBe(1);
    const timeout = run([{ kind: 'start', at: 1, ctx }, session('authenticating'), session('error', { error: 'timeout' })]);
    expect(timeout?.failedStep).toBe(1);
  });

  it('maps error codes to steps', () => {
    expect(failedStepOf('dns', 1)).toBe(0);
    expect(failedStepOf('hostKeyRejected', 1)).toBe(0);
    expect(failedStepOf('keyMissing', 0)).toBe(1);
    expect(failedStepOf('shellDenied', 1)).toBe(2);
    expect(failedStepOf('reset', 1)).toBe(1);
    expect(failedStepOf(undefined, 0)).toBe(0);
  });

  it('a close before the shell is a cancel: the card stays and says so', () => {
    const a = run([{ kind: 'start', at: 1, ctx }, session('verifying'), session('closed')]);
    expect(keys(a)?.at(-1)).toBe('Anulowano');
    expect(a?.cancelled).toBe(true);
    expect(connectCardShown(state('closed'), undefined)).toBe(true);
    expect(connectCardKind(a, state('closed'), undefined)).toBe('cancelled');
  });

  it('Anuluj marks the attempt, so an error that ends it is a cancel and not a failure', () => {
    const a = run([{ kind: 'start', at: 1, ctx }, session('authenticating'), { kind: 'cancel' }, session('error', { error: 'reset' })]);
    expect(a?.cancelled).toBe(true);
    expect(a?.failedStep).toBeUndefined();
    expect(keys(a)?.at(-1)).toBe('Anulowano');
    expect(connectCardKind(a, state('error', { error: 'reset' }), undefined)).toBe('cancelled');
    const loop = run([{ kind: 'start', at: 1, ctx }, session('authenticating'), session('error', { error: 'cancelled' })]);
    expect(connectCardKind(loop, state('error', { error: 'cancelled' }), undefined)).toBe('cancelled');
  });

  it('a cancel does nothing once the shell is open or the attempt is over', () => {
    const open = run([{ kind: 'start', at: 1, ctx }, session('connected')]);
    expect(run([{ kind: 'cancel' }], open)).toBe(open);
    const failed = run([{ kind: 'start', at: 1, ctx }, session('error', { error: 'dns' })]);
    expect(run([{ kind: 'cancel' }], failed)).toBe(failed);
    expect(run([{ kind: 'cancel' }])).toBeUndefined();
  });

  it('a session that ends after the shell opened is a disconnect', () => {
    const a = run([{ kind: 'start', at: 1, ctx }, session('connected'), session('error', { error: 'reset' })]);
    expect(a?.cancelled).toBe(false);
    expect(a?.log.at(-1)?.tone).toBe('error');
    expect(connectCardKind(a, state('error', { error: 'reset' }), undefined)).toBe('disconnected');
    const closed = run([{ kind: 'start', at: 1, ctx }, session('connected'), session('closed')]);
    expect(keys(closed)?.at(-1)).toBe('Rozłączono');
    expect(connectCardKind(closed, state('closed'), undefined)).toBe('disconnected');
  });

  it('starts from what it sees after a reload, and ignores sessions that are not connecting', () => {
    expect(run([session('connected')])).toBeUndefined();
    expect(run([session('error', { error: 'refused' })])).toBeUndefined();
    const a = run([session('authenticating')]);
    expect(keys(a)?.[0]).toBe('Łączenie z {endpoint}');
    expect(a?.step).toBe(1);
  });

  it('a new start forgets the previous attempt', () => {
    const cancelled = run([{ kind: 'start', at: 1, ctx }, session('verifying'), { kind: 'cancel' }, session('closed')]);
    const again = run([{ kind: 'start', at: 20, ctx }], cancelled);
    expect(again).toMatchObject({ since: 20, cancelled: false, step: 0, shell: false });
    expect(again?.failedStep).toBeUndefined();
    expect(again?.log).toHaveLength(1);
  });

  it('caps the log', () => {
    const events: ConnectEvent[] = [{ kind: 'start', at: 1, ctx }, session('authenticating')];
    for (let i = 0; i < 100; i++) events.push({ kind: 'prompt', at: i, prompt: password(`p${i}`, i > 0) });
    expect(run(events)?.log).toHaveLength(CONNECT_LOG_MAX);
  });
});

describe('SSH connecting card: when it shows', () => {
  const started = run([{ kind: 'start', at: 1, ctx }]);
  it('shows in every state that is not connected; only the open shell and idle (its own card) leave it out', () => {
    for (const phase of ['connecting', 'verifying', 'authenticating', 'error', 'closed'] as const) expect(connectCardShown(state(phase), undefined)).toBe(true);
    expect(connectCardShown(state('connected'), undefined)).toBe(false);
    expect(connectCardShown(state('idle'), undefined)).toBe(false);
    expect(connectCardShown(undefined, undefined)).toBe(false);
    expect(connectCardShown(state('verifying'), hostKey)).toBe(true);
    expect(connectCardShown(state('connected'), password('s'))).toBe(true);
  });

  it('tells the kinds apart, also without an attempt (a reloaded renderer)', () => {
    expect(connectCardKind(started, state('connecting'), undefined)).toBe('connecting');
    expect(connectCardKind(started, state('error'), password('x'))).toBe('connecting');
    const failed = run([session('error', { error: 'refused' })], started);
    expect(connectCardKind(failed, state('error', { error: 'refused' }), undefined)).toBe('failed');
    expect(connectCardKind(undefined, state('error', { error: 'refused' }), undefined)).toBe('failed');
    expect(connectCardKind(undefined, state('closed'), undefined)).toBe('disconnected');
  });
});

describe('SSH connecting card: steps and status', () => {
  const started = run([{ kind: 'start', at: 1, ctx }]);
  const states = (v: ReturnType<typeof connectCardView>) => v.steps.map((s) => s.state);

  it('moves the active step with the phase', () => {
    expect(states(connectCardView(started, state('connecting'), undefined, ctx))).toEqual(['active', 'pending', 'pending']);
    expect(connectCardView(started, state('connecting'), undefined, ctx)).toMatchObject({ progress: 0, failed: false, status: { key: 'Łączenie z {endpoint}…' } });
    expect(connectCardView(started, state('verifying'), hostKey, ctx).status.key).toBe('Zdecyduj, czy ufasz temu hostowi');
    const auth = connectCardView(run([session('authenticating')], started), state('authenticating'), undefined, ctx);
    expect(states(auth)).toEqual(['done', 'active', 'pending']);
    expect(auth.progress).toBe(0.5);
    expect(auth.status).toEqual({ key: 'Logowanie jako {user} i otwieranie powłoki…', params: { user: 'ola' } });
    expect(states(connectCardView(started, state('connecting'), password('x'), ctx))).toEqual(['done', 'active', 'pending']);
  });

  it('marks the failed step red with the error text', () => {
    const failed = run([session('authenticating'), session('error', { error: 'auth' })], started);
    const v = connectCardView(failed, state('error', { error: 'auth' }), undefined, ctx);
    expect(states(v)).toEqual(['done', 'failed', 'pending']);
    expect(v).toMatchObject({ failed: true, status: { key: 'Nie udało się połączyć' }, error: { key: 'Logowanie nie powiodło się - sprawdź użytkownika, klucz lub hasło' } });
    const refused = connectCardView(run([session('error', { error: 'refused' })], started), state('error', { error: 'refused' }), undefined, ctx);
    expect(states(refused)).toEqual(['failed', 'pending', 'pending']);
    expect(refused.progress).toBe(0);
    expect(refused.ended).toBe(true);
    expect(connectCardView(started, state('connecting'), undefined, ctx).ended).toBe(false);
  });

  it('a cancel stops at the step it reached, without red', () => {
    const a = run([session('authenticating'), { kind: 'cancel' }, session('closed')], started);
    const v = connectCardView(a, state('closed'), undefined, ctx);
    expect(states(v)).toEqual(['done', 'stopped', 'pending']);
    expect(v).toMatchObject({ kind: 'cancelled', failed: false, ended: true, progress: 0.5, status: { key: 'Anulowano' } });
    expect(v.error).toBeUndefined();
  });

  it('a dropped session says Rozłączono with the reason; a clean end shows the exit code', () => {
    const dropped = run([session('connected'), session('error', { error: 'reset' })], started);
    const v = connectCardView(dropped, state('error', { error: 'reset' }), undefined, ctx);
    expect(states(v)).toEqual(['done', 'done', 'failed']);
    expect(v).toMatchObject({ kind: 'disconnected', failed: true, ended: true, progress: 1, status: { key: 'Rozłączono' } });
    expect(v.error?.key).toBeTruthy();
    const exited = run([session('connected'), session('closed', { exitCode: 0 })], started);
    const e = connectCardView(exited, state('closed', { exitCode: 0 }), undefined, ctx);
    expect(states(e)).toEqual(['done', 'done', 'done']);
    expect(e).toMatchObject({ failed: false, ended: true, error: { key: 'Sesja zakończona (kod {code})', params: { code: 0 } } });
    expect(connectCardView(undefined, state('closed'), undefined, ctx).error).toBeUndefined();
  });
});
