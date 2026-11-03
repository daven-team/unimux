import { useEffect, useRef, useState } from 'react';
import type { LoginState, LoginTarget } from '../../../shared/accounts';
import { swapErrorKey } from '../../../shared/swapMessages';
import { useI18n } from '../i18n';
import { useUsage } from '../usage';
import { closeModal, setUi } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { IX } from './icons';
import { RefreshIcon } from './Spinner';

const CLOSE_AFTER_SUCCESS_MS = 1200;

/** Sign-in window: runs the provider's login command in an embedded terminal and follows the main process' progress. */
export function AuthModal({ provider, target }: { provider: 'claude' | 'codex'; target: LoginTarget }) {
  const { tr } = useI18n();
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  /** Why the main process refused to start the login (a swap runs or is unresolved), if it did. */
  const [refusal, setRefusal] = useState<'busy' | 'pending' | 'backup' | 'restore' | 'readOnly' | null>(null);
  /** `backup` refusal: the outgoing main account whose sign-in could not be backed up. */
  const [refusalEmail, setRefusalEmail] = useState('');
  // The latest state may arrive before startLogin resolves, so it is matched to the session at render time.
  const [state, setState] = useState<LoginState | null>(null);
  // A first main Claude login (nothing detected when the window opened) gets "sign in" instead of "sign in again".
  const { providers, setAside = [] } = useUsage();
  const [hadMain] = useState(() => providers.some((usage) => usage.provider === 'claude' && usage.active && usage.status !== 'signedOut'));
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Per-effect locals: a StrictMode re-run must not share them with the cleaned-up run.
    let cancelled = false;
    let session: string | null = null;
    let pty: string | null = null;
    const off = window.mc.on('auth:state', (s) => setState(s));
    void window.mc.startLogin({ provider, target }).then((res) => {
      if (!res.ok) {
        if (!cancelled) {
          setStartFailed(true);
          if (res.error === 'busy' || res.error === 'pending' || res.error === 'backup' || res.error === 'restore' || res.error === 'readOnly') setRefusal(res.error);
          setRefusalEmail(res.email ?? '');
        }
        return;
      }
      if (cancelled) {
        // Closed before the session was created: cancel it as soon as it exists.
        window.mc.cancelLogin(res.sessionId);
        return;
      }
      session = res.sessionId;
      pty = res.ptyId;
      terminals.ensure(res.ptyId, { fontSize: 13, agent: false });
      setSessionId(res.sessionId);
      setPtyId(res.ptyId);
    }).catch(() => {
      if (!cancelled) setStartFailed(true);
    });
    return () => {
      cancelled = true;
      off();
      if (session) window.mc.cancelLogin(session); // harmless after success
      if (pty) terminals.dispose(pty);
    };
  }, [provider, target]);

  useEffect(() => {
    const el = container.current;
    if (!ptyId || !el) return;
    terminals.attach(ptyId, el);
    terminals.focus(ptyId);
    return () => terminals.detach(ptyId, el);
  }, [ptyId]);

  const current = state && state.sessionId === sessionId ? state : null;
  const status = startFailed ? 'failed' : current?.status ?? 'waiting';

  useEffect(() => {
    if (status !== 'success') return;
    const timer = setTimeout(closeModal, CLOSE_AFTER_SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const title = provider === 'codex'
    ? target.type === 'new' ? tr('Dodaj konto Codex') : tr('Zaloguj się do Codex')
    : target.type === 'new' ? tr('Dodaj konto Claude') : target.type === 'main' && !hadMain ? tr('Zaloguj się do Claude') : tr('Zaloguj ponownie do Claude');
  const email = current?.email ?? '';
  const waiting = status === 'waiting';
  /** Login refused up front: no terminal session exists, so only the refusal message is shown. */
  const refused = startFailed && refusal !== null;
  /** `restore` refusal: the set-aside card the login was for, named when its e-mail is known. */
  const parkedEmail = target.type === 'account' ? setAside.find((card) => card.recordId === target.id)?.email : undefined;

  let line: string;
  if (status === 'success') line = email ? tr('Zalogowano jako {email}', { email }) : tr('Zalogowano.');
  else if (status === 'duplicate' && email) line = tr('To konto jest już dodane ({email}).', { email });
  else if (status === 'mismatch' && email && current?.expected) line = tr('Zalogowano jako {email}, a ta karta należy do {expected}. Nic nie zmieniono.', { email, expected: current.expected });
  else if (status === 'mismatch' && current?.expected) line = tr('Zalogowano na inne konto niż {expected}. Nic nie zmieniono.', { expected: current.expected });
  else if (startFailed && refusal === 'readOnly') line = tr('Nie można zapisać nowego logowania: pliku kont aplikacji nie da się bezpiecznie odczytać. Napraw albo usuń ten plik (szczegóły w panelu limitów) i uruchom aplikację ponownie.');
  else if (startFailed && refusal === 'backup') line = refusalEmail
    ? tr('Nie udało się zapisać kopii obecnego logowania ({email}), więc logowanie nie zostało rozpoczęte. Spróbuj za chwilę.', { email: refusalEmail })
    : tr('Nie udało się zapisać kopii obecnego logowania, więc logowanie nie zostało rozpoczęte. Spróbuj za chwilę.');
  else if (startFailed && refusal === 'restore') line = parkedEmail
    ? tr('Nie udało się przywrócić poprzedniego logowania karty {expected}. Karta została odłożona i nie będzie odnawiana, a aplikacja ponowi przywracanie.', { expected: parkedEmail })
    : tr('Nie udało się przywrócić poprzedniego logowania tej karty. Karta została odłożona i nie będzie odnawiana, a aplikacja ponowi przywracanie.');
  else if (startFailed && refusal) line = tr(swapErrorKey(refusal));
  else if (status === 'failed' && current?.error === 'restore') line = current.expected
    ? tr('Nie udało się przywrócić poprzedniego logowania karty {expected}. Karta została odłożona i nie będzie odnawiana, a aplikacja ponowi przywracanie.', { expected: current.expected })
    : tr('Nie udało się przywrócić poprzedniego logowania tej karty. Karta została odłożona i nie będzie odnawiana, a aplikacja ponowi przywracanie.');
  else if (status === 'failed' || status === 'duplicate' || status === 'mismatch') {
    line = current?.error === 'timeout' ? tr('Upłynął czas na logowanie.')
      : current?.error === 'identity' && current.expected ? tr('Nie udało się potwierdzić, na jakie konto zalogowano kartę {expected}. Poprzednie logowanie karty zostało przywrócone.', { expected: current.expected })
        : current?.error === 'identity' ? tr('Nie udało się odczytać konta po zalogowaniu.')
        : tr('Logowanie nie powiodło się.');
  } else line = tr('Czekam na logowanie…');

  return (
    <div className="modal auth">
      <div className="modal-head">
        <h3>{title}</h3>
        <button className="btn ghost icon" onClick={closeModal} aria-label={tr('Zamknij')}><IX /></button>
      </div>
      {!refused && <div className="auth-note muted">{tr('Dokończ logowanie w przeglądarce. Okno zamknie się samo, gdy logowanie się powiedzie.')}</div>}
      {!refused && <div className="auth-terminal" ref={container} />}
      <div className={`auth-status ${waiting ? 'wait' : status === 'success' ? 'ok' : 'bad'}`}>
        {waiting && <RefreshIcon spinning />}
        <span>{line}</span>
      </div>
      <div className="modal-foot">
        {status === 'mismatch' && !!current?.expected && <button className="btn primary" onClick={() => setUi({ modal: { kind: 'auth', provider, target: { type: 'new' } } })}>{tr('Dodaj jako nowe konto')}</button>}
        <button className="btn" onClick={closeModal}>{waiting ? tr('Anuluj') : tr('Zamknij')}</button>
      </div>
    </div>
  );
}
