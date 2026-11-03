import { useEffect, useRef, useState } from 'react';
import { nodeMajor, NPM_NODE_MIN, type InstallOptions, type InstallReason, type InstallState } from '../../../shared/cliInstall';
import { CLI_NAMES, type CliId, type InstallMethod } from '../../../shared/cliStatus';
import { recheckCli, showCliInstructions } from '../actions';
import { useI18n } from '../i18n';
import { askChoice, getUi, setUi, toast, useStore } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { useUsage } from '../usage';
import { IX } from './icons';
import { RefreshIcon } from './Spinner';

/** Closes the install window (and drops the terminal with it). */
export const closeInstall = (): void => setUi({ install: null });

type Session = { sessionId: string; ptyId: string };

/** After a successful install opened for a login: how long the result stays on screen before that login starts. */
const CONTINUE_AFTER_MS = 1500;

const METHOD_NAMES: Record<InstallMethod, string> = { native: '', winget: 'WinGet', brew: 'Homebrew', npm: 'npm' };

/**
 * Guided install of a missing agent CLI. Step 1 lists only the methods that can work on this computer, each with its
 * exact command; nothing runs before "Zainstaluj". Step 2 runs the command in a visible embedded terminal and follows
 * the main process' progress. The renderer only ever names {cli, method}; main owns the command text.
 */
export function InstallModal({ cli }: { cli: CliId }) {
  const { tr } = useI18n();
  const name = CLI_NAMES[cli];
  const [options, setOptions] = useState<InstallOptions | null | undefined>(undefined);
  const [method, setMethod] = useState<InstallMethod | null>(null);
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<InstallState | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  /** This instance is on screen; a start that resolves after it was closed is cancelled instead of adopted. */
  const mounted = useRef(false);
  /** The user cancelled while the start request was still in flight. */
  const cancelWhileStarting = useRef(false);
  const { providers } = useUsage();
  /** The login this window was opened for (the CLI was missing); it starts by itself once the install succeeded. */
  const then = useStore((st) => st.ui.install?.then);

  const loadOptions = () => {
    setOptions(undefined);
    void window.mc.installOptions(cli).then((result) => {
      setOptions(result);
      setMethod((current) => (current && result?.options.some((o) => o.method === current) ? current : result?.options[0]?.method ?? null));
    }).catch(() => setOptions(null));
  };

  useEffect(() => {
    // The latest state may arrive before startInstall resolves, so it is matched to the session at render time.
    mounted.current = true;
    const off = window.mc.on('install:state', (next) => setState(next));
    loadOptions();
    // An install that is already running (window reopened, or opened while one started) is shown, not refused as "busy".
    void window.mc.installCurrent().then((active) => {
      if (!active || active.cli !== cli || !mounted.current || sessionRef.current) return;
      terminals.ensure(active.ptyId, { fontSize: 13, agent: false });
      sessionRef.current = { sessionId: active.sessionId, ptyId: active.ptyId };
      setSession(sessionRef.current);
      setMethod(active.method);
      setOptions((current) => current ?? { cli, options: [{ method: active.method, command: active.command }] });
    }).catch(() => undefined);
    return () => {
      mounted.current = false;
      off();
      const active = sessionRef.current;
      if (active) { window.mc.cancelInstall(active.sessionId); terminals.dispose(active.ptyId); } // harmless after the end
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli]);

  const live = session && state && state.sessionId === session.sessionId ? state : null;
  const status: 'choose' | 'running' | 'succeeded' | 'failed' = !session ? 'choose' : live?.status ?? 'running';
  const locked = starting || status === 'running';

  useEffect(() => {
    // The pending login (`then`) stays with the window.
    setUi((ui) => ({ install: { cli, locked, ...(ui.install?.cli === cli && ui.install.then ? { then: ui.install.then } : {}) } }));
  }, [cli, locked]);

  const succeeded = live?.status === 'succeeded';
  useEffect(() => {
    if (!succeeded || !then) return;
    const timer = setTimeout(() => setUi({ install: null, modal: { kind: 'auth', provider: then.provider, target: then.target } }), CONTINUE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [succeeded, then]);

  useEffect(() => {
    const el = container.current;
    if (!session || !el) return;
    terminals.attach(session.ptyId, el);
    terminals.focus(session.ptyId);
    return () => terminals.detach(session.ptyId, el);
  }, [session, status === 'choose']);

  const dropSession = () => {
    const active = sessionRef.current;
    if (active) terminals.dispose(active.ptyId);
    sessionRef.current = null;
    setSession(null);
    setState(null);
  };

  const begin = async (chosen: InstallMethod) => {
    if (starting) return;
    setRefusal(null);
    cancelWhileStarting.current = false;
    setStarting(true);
    dropSession();
    let result: Awaited<ReturnType<typeof window.mc.startInstall>>;
    try { result = await window.mc.startInstall({ cli, method: chosen }); } catch { result = { ok: false, error: 'spawn' }; }
    setStarting(false);
    if (!result.ok) { setRefusal(result.error); return; }
    // The window may have been closed while the request was in flight.
    if (!mounted.current || cancelWhileStarting.current) { window.mc.cancelInstall(result.sessionId); return; }
    const next = { sessionId: result.sessionId, ptyId: result.ptyId };
    terminals.ensure(next.ptyId, { fontSize: 13, agent: false });
    sessionRef.current = next;
    setSession(next);
  };

  const requestClose = async () => {
    if (!locked) { closeInstall(); return; }
    const choice = await askChoice(tr('Przerwać instalację?'), tr('Instalacja {name} zostanie przerwana, a uruchomione procesy zatrzymane.', { name }), [
      { label: tr('Kontynuuj'), value: 'continue' },
      { label: tr('Przerwij instalację'), value: 'stop', danger: true },
    ]);
    if (choice !== 'stop') return;
    const active = sessionRef.current;
    if (active) window.mc.cancelInstall(active.sessionId);
    else cancelWhileStarting.current = true;
    closeInstall();
  };

  const chooseAnother = () => { dropSession(); loadOptions(); };

  const needsLogin = !providers.some((usage) => usage.provider === cli && usage.status !== 'signedOut');
  const login = () => setUi({ install: null, modal: { kind: 'auth', provider: then?.provider ?? cli, target: then?.target ?? { type: 'main' } } });
  const recheck = async () => {
    await recheckCli(cli);
    if (getUi().cliStatus[cli]?.state === 'found') { toast(tr('Wykryto: {name}', { name })); closeInstall(); }
    else toast(tr('Nadal nie znaleziono: {name}', { name }));
  };
  const copyDir = (dir: string) => {
    window.mc.clipboardWrite(dir);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const methodLabel = (m: InstallMethod) => (m === 'native' ? tr('Oficjalny instalator') : METHOD_NAMES[m]);
  const methodText = (m: InstallMethod) => {
    if (m === 'native') return tr('Skrypt instalacyjny producenta. Instaluje w katalogu użytkownika, bez uprawnień administratora.');
    if (m === 'npm') return tr('Instalacja globalna przez npm.');
    return tr('Menedżer pakietów systemu. Aktualizacje wykonujesz ręcznie.');
  };
  const reasonText = (reason: InstallReason, dir?: string): string => {
    switch (reason) {
      case 'network': return tr('Nie udało się pobrać instalatora. Sprawdź połączenie z internetem i spróbuj ponownie.');
      case 'proxy': return tr('Pobieranie zostało odrzucone (błąd 403 albo strona HTML zamiast instalatora). Zwykle blokuje je sieć firmowa lub proxy.');
      case 'permission': return tr('Brak uprawnień do zapisu w katalogu docelowym. Wybierz oficjalny instalator, który instaluje w katalogu użytkownika (nie używaj sudo).');
      case 'npmMissing': return tr('Nie znaleziono npm. Zainstaluj Node.js albo wybierz inny sposób instalacji.');
      case 'policy': return tr('Zasady wykonywania skryptów blokują uruchomienie. Wybierz inny sposób instalacji albo skorzystaj z instrukcji.');
      case 'notOnPath': return dir
        ? tr('Instalator zakończył się bez błędu, ale polecenie „{command}” nadal nie jest widoczne. Sprawdź katalog {dir} i dodaj go do PATH.', { command: cli, dir })
        : tr('Instalator zakończył się bez błędu, ale polecenie „{command}” nadal nie jest widoczne. Dodaj katalog instalacji do PATH i sprawdź ponownie.', { command: cli });
      case 'timeout': return tr('Instalacja trwała zbyt długo i została przerwana.');
      case 'aborted': return tr('Instalacja została przerwana w terminalu (Ctrl+C).');
      default: return tr('Polecenie zakończyło się błędem. Szczegóły są w terminalu.');
    }
  };
  const refusalText = (code: string) => (code === 'busy' ? tr('Inna instalacja jest w toku. Poczekaj, aż się zakończy.')
    : code === 'unavailable' ? tr('Ten sposób instalacji nie jest dostępny na tym komputerze.') : tr('Nie udało się uruchomić instalacji.'));

  const title = tr('Zainstaluj {name}', { name });
  const chosenOption = options?.options.find((option) => option.method === method);
  const npmSelected = method === 'npm' && options?.options.some((option) => option.method === 'npm');
  const major = nodeMajor(options?.nodeVersion);

  return (
    <div className="modal install" role="dialog" aria-label={title}>
      <div className="modal-head">
        <h3>{title}</h3>
        <button className="btn ghost icon" onClick={() => void requestClose()} aria-label={tr('Zamknij')}><IX /></button>
      </div>

      {status === 'choose' && (
        <div className="install-body">
          <div className="install-step">{tr('Wybierz sposób')}</div>
          {options === undefined && <div className="auth-status wait"><RefreshIcon spinning /><span>{tr('Sprawdzam, co jest dostępne…')}</span></div>}
          {options === null && <div className="auth-note muted">{tr('Nie udało się sprawdzić, co jest dostępne. Skorzystaj z oficjalnej instrukcji.')}</div>}
          {options && options.options.length === 0 && <div className="auth-note muted">{tr('Na tym komputerze nie ma sposobu na automatyczną instalację. Skorzystaj z oficjalnej instrukcji.')}</div>}
          {options && options.options.length > 0 && (
            <>
              <div className="auth-note muted install-lead">{tr('Wybierz sposób instalacji. Polecenie uruchomi się w widocznym terminalu, bez uprawnień administratora.')}</div>
              <div className="install-options" role="radiogroup" aria-label={tr('Wybierz sposób')}>
                {options.options.map((option) => (
                  <label key={option.method} className={`install-option${option.method === method ? ' selected' : ''}`} data-method={option.method}>
                    <input type="radio" name="install-method" checked={option.method === method} onChange={() => setMethod(option.method)} />
                    <span className="install-option-main">
                      <span className="install-option-name">{methodLabel(option.method)}{option.method === 'native' && <span className="install-tag">{tr('zalecany')}</span>}</span>
                      <span className="install-option-text muted">{methodText(option.method)}</span>
                      <code className="install-cmd">{option.command}</code>
                    </span>
                  </label>
                ))}
              </div>
              {npmSelected && cli === 'claude' && (
                <div className="auth-note muted">
                  {tr('Claude Code przez npm wymaga Node.js 22 lub nowszego.')}{' '}
                  {options.nodeVersion && (major !== undefined && major < NPM_NODE_MIN
                    ? <span className="install-warn">{tr('Wykryty Node.js {version} jest starszy niż 22, instalacja może się nie udać.', { version: options.nodeVersion })}</span>
                    : tr('Wykryto Node.js {version}.', { version: options.nodeVersion }))}
                </div>
              )}
            </>
          )}
          {refusal && <div className="auth-status bad"><span>{refusalText(refusal)}</span></div>}
        </div>
      )}

      {status !== 'choose' && (
        <>
          {status === 'running' && <div className="auth-note muted">{tr('Postęp widać w terminalu poniżej. Nie zamykaj okna, dopóki instalacja trwa.')}</div>}
          {chosenOption && <div className="install-ran"><code className="install-cmd">{chosenOption.command}</code></div>}
          <div className="auth-terminal" ref={container} />
          {status === 'running' && <div className="auth-status wait"><RefreshIcon spinning /><span>{tr('Instaluję {name}…', { name })}</span></div>}
          {live?.status === 'succeeded' && (
            <div className="install-result">
              <div className="auth-status ok"><span>{live.version ? tr('Zainstalowano {name} {version}', { name, version: live.version }) : tr('Zainstalowano {name}.', { name })}</span></div>
              {then && <div className="auth-status wait"><RefreshIcon spinning /><span>{tr('Za chwilę uruchomi się logowanie…')}</span></div>}
              {cli === 'claude' && method === 'native' && live.dir && (
                <div className="install-pathnote muted">
                  <span>{tr('Aby używać „{command}” także w innych terminalach, dodaj katalog {dir} do PATH.', { command: cli, dir: live.dir })}</span>
                  <button className="btn small" onClick={() => copyDir(live.dir as string)}>{copied ? tr('Skopiowano') : tr('Kopiuj katalog')}</button>
                </div>
              )}
            </div>
          )}
          {live?.status === 'failed' && (
            <div className="install-result">
              <div className="auth-status bad"><span><strong>{tr('Instalacja nie powiodła się')}.</strong> {reasonText(live.reason, live.dir)}</span></div>
              {live.reason === 'notOnPath' && live.dir && (
                <div className="install-pathnote muted">
                  <code className="install-cmd inline">{live.dir}</code>
                  <button className="btn small" onClick={() => copyDir(live.dir as string)}>{copied ? tr('Skopiowano') : tr('Kopiuj katalog')}</button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="modal-foot">
        {status === 'choose' && (
          <>
            <button className="btn" onClick={() => showCliInstructions(cli)}>{tr('Pokaż instrukcję')}</button>
            <button className="btn" onClick={closeInstall}>{tr('Anuluj')}</button>
            <button className="btn primary install-go" disabled={!method || starting || !options} onClick={() => method && void begin(method)}>{starting ? tr('Sprawdzam…') : tr('Zainstaluj')}</button>
          </>
        )}
        {status === 'running' && <button className="btn install-stop" onClick={() => void requestClose()}>{tr('Przerwij instalację')}</button>}
        {live?.status === 'succeeded' && (
          <>
            <button className="btn" onClick={closeInstall}>{tr('Zamknij')}</button>
            {(needsLogin || !!then) && <button className="btn primary install-login" onClick={login}>{tr('Zaloguj się do {name}', { name })}</button>}
          </>
        )}
        {live?.status === 'failed' && (
          <>
            <button className="btn" onClick={() => showCliInstructions(cli)}>{tr('Pokaż instrukcję')}</button>
            {live.reason === 'notOnPath' && <button className="btn" onClick={() => void recheck()}>{tr('Sprawdź ponownie')}</button>}
            <button className="btn" onClick={chooseAnother}>{tr('Wybierz inny sposób')}</button>
            <button className="btn" onClick={closeInstall}>{tr('Zamknij')}</button>
            {method && <button className="btn primary install-retry" onClick={() => void begin(method)}>{tr('Spróbuj ponownie')}</button>}
          </>
        )}
      </div>
    </div>
  );
}
