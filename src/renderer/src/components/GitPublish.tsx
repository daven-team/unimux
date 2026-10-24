// "Publish to GitHub" of the Git panel (VS Code's and Cursor's "Publish Branch"): a small dialog with the repository name and
// its visibility, the GitHub sign-in it needs (the one unimux stored, the GitHub CLI's, or the device flow), and progress and
// errors inline. Main creates the repository, adds it as origin and pushes the branch; the token never comes here.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  folderBaseName, isValidRepoName, sanitizeRepoName, INVALID_NAME,
  type GithubAuthStatus, type GithubDeviceStart, type GithubPublishResult, type GithubResult,
} from '../../../shared/github';
import { newRequestId } from '../../../shared/gitUi';
import { useI18n } from '../i18n';
import { toast } from '../store';
import type { MenuItem } from './ContextMenu';
import { IUpload, IX } from './icons';
import { RefreshIcon } from './Spinner';
import './gitPublish.css';

/** The cloud with an arrow up of VS Code's "Publish Branch". */
export function CloudUploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 12.5H4a3 3 0 0 1-.4-5.97A4.5 4.5 0 0 1 12.3 5.6a3.5 3.5 0 0 1-.3 6.9h-.5" />
      <path d="M8 14V8.5M5.8 10.5 8 8.3l2.2 2.2" />
    </svg>
  );
}

/**
 * Takes the Commit button's place (GitChanges' commitSlot, under the message box) while there is nothing to commit and the
 * repository has no remote. The classes are the Commit button's.
 */
export function GitPublishButton({ disabled, onClick }: { disabled: boolean; onClick(): void }) {
  const { tr } = useI18n();
  return (
    <button className="btn small primary" disabled={disabled} onClick={onClick} title={tr('Utwórz repozytorium na GitHubie i wyślij do niego tę gałąź')}>
      <CloudUploadIcon />{tr('Opublikuj na GitHubie')}
    </button>
  );
}

interface Options {
  projectId: string;
  /** The folder the repository name is suggested from: the project folder (a worktree shares its repository). */
  folder: string;
  branch: string | null;
  opts: { worktree?: string };
  /** Something changed in the repository (published, or created with a failed push): the panel reads it again. */
  onChanged(): void;
}

/** What the "..." menu of the Git panel needs to know for the GitHub entries. */
interface MenuState { hasRemote?: boolean; initial: boolean; branch: string | null; idle: boolean }

/**
 * The dialog and the "published" line of the Git panel. `open` shows the dialog; `menu` gives the "..." menu entries: "Publish to
 * GitHub" while the repository has no remote, and "Sign out of GitHub" while unimux keeps a sign-in (it also signs later pushes).
 */
export function useGitPublish({ projectId, folder, branch, opts, onChanged }: Options): { open(): void; menu(state: MenuState): MenuItem[]; dialog: ReactNode; notice: ReactNode } {
  const { tr, errorText } = useI18n();
  const [shown, setShown] = useState(false);
  const [published, setPublished] = useState<GithubPublishResult | null>(null);
  /** The login of the sign-in unimux stored ('' when unknown), or null when there is none. */
  const [stored, setStored] = useState<string | null>(null);
  const readStored = useCallback(() => {
    window.mc.github.status({ local: true }).then((s) => setStored(s.source === 'stored' ? s.login ?? '' : null), () => undefined);
  }, []);
  useEffect(() => { readStored(); }, [readStored]);
  const open = useCallback(() => setShown(true), []);
  const signOut = async () => {
    try { await window.mc.github.signOut(); toast(tr('Wylogowano z GitHuba.')); }
    catch (e) { toast(tr('Git: {error}', { error: errorText(String(e)) }), 'error'); }
    readStored();
  };
  const menu = (state: MenuState): MenuItem[] => [
    ...(state.hasRemote === false ? [{ label: tr('Opublikuj na GitHubie'), icon: <IUpload />, hint: state.initial ? tr('najpierw commit') : undefined, disabled: !state.idle || state.initial || !state.branch, onClick: open }] : []),
    ...(stored !== null ? [{ label: tr('Wyloguj z GitHuba'), icon: <IX />, hint: stored || undefined, onClick: () => void signOut() }] : []),
  ];
  const dialog = shown ? createPortal(
    <PublishDialog
      projectId={projectId} defaultName={sanitizeRepoName(folderBaseName(folder))} branch={branch} opts={opts}
      onClose={() => { setShown(false); readStored(); }} onChanged={onChanged}
      onPublished={(result) => { setPublished(result); onChanged(); }}
    />,
    document.body,
  ) : null;
  const notice = published && (
    <div className="git-publish-notice" role="status">
      <span className="git-publish-notice-text" title={published.htmlUrl}><CloudUploadIcon />{tr('Opublikowano na GitHubie: {name}', { name: published.fullName })}</span>
      <button className="btn small" onClick={() => window.mc.openExternal(published.htmlUrl)}>{tr('Otwórz na GitHubie')}</button>
      <button className="btn ghost icon small" onClick={() => setPublished(null)} aria-label={tr('Zamknij')} title={tr('Zamknij')}><IX /></button>
    </div>
  );
  return { open, menu, dialog, notice };
}

type Phase = 'form' | 'device' | 'publishing' | 'done';
interface Problem { error: string; detail?: string; url?: string }

function PublishDialog({ projectId, defaultName, branch, opts, onClose, onChanged, onPublished }: {
  projectId: string; defaultName: string; branch: string | null; opts: { worktree?: string };
  onClose(): void; onChanged(): void; onPublished(result: GithubPublishResult): void;
}) {
  const { tr, errorText } = useI18n();
  const [auth, setAuth] = useState<GithubAuthStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [name, setName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [phase, setPhase] = useState<Phase>('form');
  const [device, setDevice] = useState<GithubDeviceStart | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [nameTaken, setNameTaken] = useState(false);
  const [result, setResult] = useState<GithubPublishResult | null>(null);
  /** The repository was created although a later step failed: publishing again would only meet the new remote. */
  const [created, setCreated] = useState(false);
  /** The device flow is being started (main asks GitHub for a code): the sign-in button waits, so a double click starts one flow. */
  const [starting, setStarting] = useState(false);
  const startingNow = useRef(false);
  const alive = useRef(true);
  const flow = useRef<string | null>(null);

  const loadAuth = useCallback(async () => {
    setChecking(true);
    try {
      const status = await window.mc.github.status();
      if (alive.current) setAuth(status);
    } catch (e) { if (alive.current) setProblem({ error: String(e) }); }
    finally { if (alive.current) setChecking(false); }
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadAuth();
    return () => {
      alive.current = false;
      // A sign-in still waiting for the browser ends with the dialog.
      if (flow.current) void window.mc.github.deviceCancel(flow.current);
    };
  }, [loadAuth]);

  const busy = phase === 'publishing';
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const failure = (res: Exclude<GithubResult<unknown>, { ok: true }>): Problem => ({ error: res.error, ...(res.detail ? { detail: res.detail } : {}), ...(res.url ? { url: res.url } : {}) });

  const signIn = async () => {
    if (startingNow.current) return;
    startingNow.current = true;
    setStarting(true);
    setProblem(null);
    setCopied(false);
    try {
      const started = await window.mc.github.deviceStart().finally(() => {
        startingNow.current = false;
        if (alive.current) setStarting(false);
      });
      if (!alive.current) { if (started.ok) void window.mc.github.deviceCancel(started.data.flowId); return; }
      // "cancelled": a newer start replaced this one in main.
      if (!started.ok) { if (started.code !== 'cancelled') setProblem(failure(started)); return; }
      flow.current = started.data.flowId;
      setDevice(started.data);
      setPhase('device');
      const done = await window.mc.github.deviceWait(started.data.flowId);
      if (!alive.current || flow.current !== started.data.flowId) return;
      flow.current = null;
      setDevice(null);
      setPhase('form');
      if (!done.ok && done.code !== 'cancelled') setProblem(failure(done));
      await loadAuth();
    } catch (e) { if (alive.current) { setPhase('form'); setProblem({ error: String(e) }); } }
  };

  const cancelSignIn = () => {
    if (flow.current) void window.mc.github.deviceCancel(flow.current);
    flow.current = null;
    setDevice(null);
    setPhase('form');
  };

  const copyAndOpen = () => {
    if (!device) return;
    window.mc.clipboardWrite(device.userCode);
    window.mc.openExternal(device.verificationUri);
    setCopied(true);
  };

  const signOut = async () => {
    setProblem(null);
    try { await window.mc.github.signOut(); }
    catch (e) { if (alive.current) setProblem({ error: String(e) }); }
    // A GitHub CLI sign-in may still be there.
    if (alive.current) await loadAuth();
  };

  const validName = isValidRepoName(name);
  const canPublish = phase === 'form' && !!auth?.signedIn && validName && !checking && !created;

  const publish = async () => {
    if (!canPublish) return;
    setProblem(null);
    setNameTaken(false);
    setPhase('publishing');
    try {
      const res = await window.mc.github.publish(projectId, { requestId: newRequestId(), name, private: isPrivate, ...opts });
      if (!alive.current) { onChanged(); return; }
      if (res.ok) { setResult(res.data); setPhase('done'); onPublished(res.data); return; }
      setPhase('form');
      setProblem(failure(res));
      if (res.code === 'exists') setNameTaken(true);
      // The repository exists on GitHub now (only the push or the remote failed): the panel shows the new remote.
      if (res.url) { setCreated(true); onChanged(); }
      // A refused sign-in was forgotten in main: show the sign-in choices again.
      if (res.code === 'auth') void loadAuth();
    } catch (e) {
      if (alive.current) { setPhase('form'); setProblem({ error: String(e) }); }
    }
  };

  const ghLink = <button className="btn small" onClick={() => window.mc.openExternal('https://cli.github.com')}>cli.github.com</button>;
  const account = (() => {
    if (checking && !auth) return <div className="gh-publish-account muted"><RefreshIcon spinning />{tr('Sprawdzam logowanie do GitHuba…')}</div>;
    if (auth?.signedIn) {
      return (
        <div className="gh-publish-account">
          <span className="gh-publish-account-name">
            {auth.login ? tr('Konto GitHub: {login}', { login: auth.login }) : tr('Zalogowano do GitHuba')}
            {auth.source === 'gh' && <span className="muted"> · {tr('przez GitHub CLI')}</span>}
          </span>
          {auth.source === 'stored' && <button className="btn ghost small" disabled={busy} onClick={() => void signOut()}>{tr('Wyloguj z GitHuba')}</button>}
        </div>
      );
    }
    return (
      <div className="gh-publish-signin">
        <span>{tr('Nie jesteś zalogowany do GitHuba.')}</span>
        {auth?.deviceFlow ? (
          <div className="gh-publish-actions">
            <button className="btn small primary" disabled={starting} aria-busy={starting} onClick={() => void signIn()}>
              {starting && <RefreshIcon spinning />}{tr('Zaloguj się do GitHuba')}
            </button>
            {auth.storage === 'unavailable' && <span className="muted gh-publish-small">{tr('Logowanie zostanie zapamiętane tylko do zamknięcia aplikacji (szyfrowanie systemowe jest niedostępne).')}</span>}
          </div>
        ) : (
          <>
            <span className="muted gh-publish-small">{tr('Zainstaluj GitHub CLI i zaloguj się poleceniem gh auth login, a potem sprawdź ponownie.')}</span>
            <div className="gh-publish-actions">
              {ghLink}
              <button className="btn small" disabled={checking} onClick={() => void loadAuth()}>{checking ? <RefreshIcon spinning /> : tr('Sprawdź ponownie')}</button>
            </div>
          </>
        )}
      </div>
    );
  })();

  // The detail is a message of ours (git's refusals, translated here) or git's or GitHub's own text (left as it is).
  const problemBox = problem && (
    <div className="gh-publish-error" role="alert">
      <span>{errorText(problem.error)}{problem.detail ? ` (${errorText(problem.detail)})` : ''}</span>
      {problem.url && <button className="btn small" onClick={() => window.mc.openExternal(problem.url!)}>{tr('Otwórz na GitHubie')}</button>}
    </div>
  );

  let body: ReactNode;
  if (phase === 'device' && device) {
    body = (
      <div className="gh-publish-device">
        <span>{tr('Wpisz ten kod na stronie GitHuba:')}</span>
        <code className="gh-publish-code" aria-label={device.userCode}>{device.userCode}</code>
        <button className="btn primary" autoFocus onClick={copyAndOpen}>{tr('Kopiuj i otwórz {url}', { url: device.verificationUri.replace(/^https:\/\//, '') })}</button>
        <span className="gh-publish-wait muted">{copied ? tr('Kod skopiowany. Wklej go na stronie GitHuba.') : null}</span>
        <span className="gh-publish-wait muted"><RefreshIcon spinning />{tr('Czekam na potwierdzenie w przeglądarce…')}</span>
      </div>
    );
  } else if (phase === 'done' && result) {
    body = (
      <div className="gh-publish-done">
        <strong><CloudUploadIcon />{tr('Opublikowano na GitHubie: {name}', { name: result.fullName })}</strong>
        <code className="gh-publish-url">{result.htmlUrl}</code>
      </div>
    );
  } else {
    body = (
      <>
        <p className="muted gh-publish-lead">
          {tr('Na Twoim koncie GitHub powstanie nowe repozytorium. Gałąź {branch} zostanie do niego wysłana i będzie je śledzić.', { branch: branch ?? 'HEAD' })}
          {/* The first branch pushed to an empty repository becomes its default one: in a cell's worktree that is the cell's branch. */}
          {opts.worktree && <> {tr('Panel pokazuje worktree, więc gałąź {branch} zostanie domyślną gałęzią nowego repozytorium.', { branch: branch ?? 'HEAD' })}</>}
        </p>
        <div className="field">
          <label htmlFor="gh-publish-name">{tr('Nazwa repozytorium')}</label>
          <input
            id="gh-publish-name" className={`input ${!validName || nameTaken ? 'invalid' : ''}`} autoFocus spellCheck={false} maxLength={100} value={name} disabled={busy}
            onChange={(e) => { setName(e.target.value); setNameTaken(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void publish(); }}
          />
          {!validName && <span className="gh-publish-hint">{tr(INVALID_NAME)}</span>}
        </div>
        <div className="gh-publish-visibility" role="radiogroup" aria-labelledby="gh-publish-visibility">
          <span id="gh-publish-visibility" className="gh-publish-label">{tr('Widoczność')}</span>
          {([true, false] as const).map((value) => (
            <label key={String(value)} className={`gh-publish-option ${isPrivate === value ? 'selected' : ''}`}>
              <input type="radio" name="gh-publish-visibility" checked={isPrivate === value} disabled={busy} onChange={() => setIsPrivate(value)} />
              <span className="gh-publish-option-main">
                <span className="gh-publish-option-name">{value ? tr('Prywatne repozytorium') : tr('Publiczne repozytorium')}</span>
                <span className="muted gh-publish-small">{value ? tr('Widzisz je tylko Ty i osoby, które zaprosisz.') : tr('Każdy w internecie może je zobaczyć.')}</span>
              </span>
            </label>
          ))}
        </div>
        {account}
        {busy && <div className="gh-publish-progress" role="status"><RefreshIcon spinning />{tr('Tworzę repozytorium na GitHubie i wysyłam gałąź {branch}…', { branch: branch ?? 'HEAD' })}</div>}
      </>
    );
  }

  return (
    <div className="overlay gh-publish-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal gh-publish" role="dialog" aria-modal="true" aria-labelledby="gh-publish-title">
        <div className="modal-head">
          <h3 id="gh-publish-title">{tr('Opublikuj na GitHubie')}</h3>
          <button className="btn ghost icon" disabled={busy} onClick={close} aria-label={tr('Zamknij')}><IX /></button>
        </div>
        <div className="modal-body">
          {body}
          {problemBox}
        </div>
        <div className="modal-foot">
          {phase === 'device' && <button className="btn" onClick={cancelSignIn}>{tr('Anuluj')}</button>}
          {phase === 'done' && result && <>
            <button className="btn" onClick={() => window.mc.openExternal(result.htmlUrl)}>{tr('Otwórz na GitHubie')}</button>
            <button className="btn primary" autoFocus onClick={onClose}>{tr('Zamknij')}</button>
          </>}
          {(phase === 'form' || phase === 'publishing') && <>
            <button className="btn" disabled={busy} onClick={close}>{tr('Anuluj')}</button>
            <button className="btn primary" disabled={!canPublish} onClick={() => void publish()}>
              {busy ? <RefreshIcon spinning /> : <CloudUploadIcon />}{tr('Opublikuj')}
            </button>
          </>}
        </div>
      </div>
    </div>
  );
}
