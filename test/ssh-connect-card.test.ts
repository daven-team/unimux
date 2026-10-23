import { describe, expect, it } from 'vitest';
import type { SshPhase, SshPrompt, SshSessionState } from '../src/shared/ssh';
import {
  CONNECT_LOG_MAX, connectCardKind, connectCardShown, connectCardView, failedStepOf, formatClock, formatDuration, reduceConnectAttempt, type ConnectAttempt, type ConnectContext, type ConnectEvent,
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
    expect(a?.step).toBe(3);
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
    expect(auth?.failedStep).toBe(2);
    const timeout = run([{ kind: 'start', at: 1, ctx }, session('authenticating'), session('error', { error: 'timeout' })]);
    expect(timeout?.failedStep).toBe(2);
  });

  it('maps error codes to steps', () => {
    expect(failedStepOf('dns', 1)).toBe(0);
    expect(failedStepOf('refused', 2)).toBe(0);
    expect(failedStepOf('hostKeyRejected', 2)).toBe(1);
    expect(failedStepOf('hostKeyChanged', 0)).toBe(1);
    expect(failedStepOf('keyMissing', 0)).toBe(2);
    expect(failedStepOf('shellDenied', 1)).toBe(3);
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
    expect(a?.step).toBe(2);
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

describe('SSH connecting card: phases and status', () => {
  const started = run([{ kind: 'start', at: 1, ctx }]);
  const states = (v: ReturnType<typeof connectCardView>) => v.steps.map((s) => s.state);

  it('lists the four phases with their texts and moves the current one with the session', () => {
    const v = connectCardView(started, state('connecting'), undefined, ctx);
    expect(v.steps.map((s) => s.id)).toEqual(['connect', 'hostKey', 'login', 'shell']);
    expect(v.steps.map((s) => s.label)).toEqual([
      { key: 'Połączenie z {endpoint}', params: { endpoint: 'box.lan:2222' } }, { key: 'Weryfikacja klucza hosta' },
      { key: 'Logowanie jako {user}', params: { user: 'ola' } }, { key: 'Otwarcie powłoki' },
    ]);
    expect(states(v)).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(v).toMatchObject({ failed: false, ended: false, since: 1, status: { key: 'Łączenie z {endpoint}…' } });
    expect(v.until).toBeUndefined();
    expect(states(connectCardView(run([session('verifying')], started), state('verifying'), hostKey, ctx))).toEqual(['done', 'active', 'pending', 'pending']);
    expect(connectCardView(started, state('verifying'), hostKey, ctx).status.key).toBe('Zdecyduj, czy ufasz temu hostowi');
    const auth = connectCardView(run([session('authenticating')], started), state('authenticating'), undefined, ctx);
    expect(states(auth)).toEqual(['done', 'done', 'active', 'pending']);
    expect(auth.status).toEqual({ key: 'Logowanie jako {user} i otwieranie powłoki…', params: { user: 'ola' } });
    expect(states(connectCardView(started, state('connecting'), password('x'), ctx))).toEqual(['done', 'done', 'active', 'pending']);
  });

  it('without a host address or user the phases still have a name', () => {
    const bare = { host: '', endpoint: '', user: '' };
    const v = connectCardView(undefined, state('connecting'), undefined, bare);
    expect(v.steps[0].label).toEqual({ key: 'Połączenie z serwerem' });
    expect(v.steps[2].label).toEqual({ key: 'Logowanie' });
    expect(v.since).toBeUndefined(); // no clock after a reload
  });

  it('times the finished phases', () => {
    const a = run([
      { kind: 'start', at: 1000, ctx },
      { kind: 'session', at: 1240, state: state('verifying'), ctx },
      { kind: 'session', at: 1300, state: state('authenticating'), ctx },
    ]);
    const v = connectCardView(a, state('authenticating'), undefined, ctx);
    expect(v.steps.map((s) => s.ms)).toEqual([240, 60, undefined, undefined]);
  });

  it('marks the failed phase red with the error text and freezes the clock', () => {
    const failed = run([session('verifying'), session('authenticating'), { kind: 'session', at: 4000, state: state('error', { error: 'auth' }), ctx }], started);
    const v = connectCardView(failed, state('error', { error: 'auth' }), undefined, ctx);
    expect(states(v)).toEqual(['done', 'done', 'failed', 'pending']);
    expect(v).toMatchObject({ failed: true, ended: true, since: 1, until: 4000, status: { key: 'Nie udało się połączyć' }, error: { key: 'Logowanie nie powiodło się - sprawdź użytkownika, klucz lub hasło' } });
    const refused = connectCardView(run([session('error', { error: 'refused' })], started), state('error', { error: 'refused' }), undefined, ctx);
    expect(states(refused)).toEqual(['failed', 'pending', 'pending', 'pending']);
    expect(refused.ended).toBe(true);
    const changed = connectCardView(run([session('verifying'), session('error', { error: 'hostKeyChanged' })], started), state('error', { error: 'hostKeyChanged' }), undefined, ctx);
    expect(states(changed)).toEqual(['done', 'failed', 'pending', 'pending']);
    const shell = connectCardView(run([session('authenticating'), session('error', { error: 'shellDenied' })], started), state('error', { error: 'shellDenied' }), undefined, ctx);
    expect(states(shell)).toEqual(['done', 'done', 'done', 'failed']);
  });

  it('a cancel stops at the phase it reached, without red', () => {
    const a = run([session('verifying'), session('authenticating'), { kind: 'cancel' }, session('closed')], started);
    const v = connectCardView(a, state('closed'), undefined, ctx);
    expect(states(v)).toEqual(['done', 'done', 'stopped', 'pending']);
    expect(v).toMatchObject({ kind: 'cancelled', failed: false, ended: true, status: { key: 'Anulowano' } });
    expect(v.error).toBeUndefined();
  });

  it('a dropped session says Rozłączono with the reason and how long it lasted; a clean end shows the exit code', () => {
    const dropped = run([{ kind: 'session', at: 100, state: state('connected'), ctx }, { kind: 'session', at: 100 + 8_040_000, state: state('error', { error: 'reset' }), ctx }], started);
    const v = connectCardView(dropped, state('error', { error: 'reset' }), undefined, ctx);
    expect(states(v)).toEqual(['done', 'done', 'done', 'done']);
    expect(v).toMatchObject({ kind: 'disconnected', failed: true, ended: true, status: { key: 'Rozłączono' }, error: { key: 'Połączenie zostało przerwane' } });
    expect(v.session).toEqual({ state: 'failed', label: { key: 'Sesja trwała {duration}', params: { duration: '2 h 14 min' } }, ms: 8_040_000 });
    expect(v.since).toBeUndefined(); // the attempt's clock is gone once the shell was open
    const exited = run([session('connected'), session('closed', { exitCode: 0 })], started);
    const e = connectCardView(exited, state('closed', { exitCode: 0 }), undefined, ctx);
    expect(e).toMatchObject({ failed: false, ended: true, session: { state: 'done' }, error: { key: 'Sesja zakończona (kod {code})', params: { code: 0 } } });
    const reloaded = connectCardView(undefined, state('closed'), undefined, ctx);
    expect(reloaded.error).toBeUndefined();
    expect(reloaded.session).toEqual({ state: 'done', label: { key: 'Sesja zakończona' } });
    // The Pty Host restarting under an open session ends it like a drop.
    const crashed = connectCardView(run([session('connected'), session('error', { error: 'ptyHostCrashed' })], started), state('error', { error: 'ptyHostCrashed' }), undefined, ctx);
    expect(crashed).toMatchObject({ kind: 'disconnected', failed: true, ended: true, error: { key: 'Proces terminali został uruchomiony ponownie' } });
  });

  it('a reconnect after a drop starts a fresh checklist and clock', () => {
    const dropped = run([session('connected'), session('error', { error: 'reset' })], started);
    const again = run([{ kind: 'start', at: 500, ctx }], dropped);
    const v = connectCardView(again, state('connecting'), undefined, ctx);
    expect(v).toMatchObject({ kind: 'connecting', ended: false, since: 500 });
    expect(v.session).toBeUndefined();
  });
});

describe('SSH connecting card: durations', () => {
  it('formats phase and session durations', () => {
    expect(formatDuration(240)).toBe('240 ms');
    expect(formatDuration(7_400)).toBe('7 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatDuration(8_040_000)).toBe('2 h 14 min');
  });
  it('formats the attempt clock', () => {
    expect(formatClock(7_900)).toBe('0:07');
    expect(formatClock(102_000)).toBe('1:42');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00');
  });
});
