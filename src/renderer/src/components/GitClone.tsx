// "Clone a repository" of the Git panel (Cursor's "Clone Repository"): a small dialog with the address and, for a new project,
// the folder it goes into. `here` clones into the folder of a project that has no repository yet (GitSetup); `new` clones into
// a new folder the user picks and adds it as a project ("..." menu of the panel). Main checks the address and runs git clone.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cloneFolderName, INVALID_CLONE_URL, isCloneUrl, isSafeFolderName } from '../../../shared/git';
import { useI18n } from '../i18n';
import { toast } from '../store';
import { addProjectFolder } from '../actions';
import { refreshGitProbe } from '../git/gitProbe';
import { IX } from './icons';
import { RefreshIcon } from './Spinner';

export type CloneTarget = { kind: 'here'; projectId: string; projectName: string } | { kind: 'new' };

export function GitCloneDialog({ target, onClose }: { target: CloneTarget; onClose(): void }) {
  return createPortal(<CloneDialog target={target} onClose={onClose} />, document.body);
}

function CloneDialog({ target, onClose }: { target: CloneTarget; onClose(): void }) {
  const { tr, errorText } = useI18n();
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState('');
  /** The user typed a folder name: it no longer follows the address. */
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const trimmed = url.trim();
  const validUrl = isCloneUrl(trimmed);
  const folder = nameEdited ? name : validUrl ? cloneFolderName(trimmed) : '';
  const sep = window.mc.platform === 'win32' ? '\\' : '/';
  const destination = parent && folder ? `${parent.replace(/[\\/]+$/, '')}${sep}${folder}` : null;
  const ready = !busy && validUrl && (target.kind === 'here' || (!!parent && isSafeFolderName(folder)));

  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const pickParent = async () => {
    const picked = await window.mc.pickFolder();
    if (picked && alive.current) setParent(picked);
  };

  const clone = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.mc.git.clone(target.kind === 'here' ? { url: trimmed, projectId: target.projectId } : { url: trimmed, parent: parent!, name: folder });
      if (!result.ok) { if (alive.current) setError(result.error); return; }
      toast(tr('Repozytorium zostało sklonowane.'));
      if (target.kind === 'here') void refreshGitProbe(target.projectId);
      else addProjectFolder(result.data.path);
      onClose();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') void clone(); };
  const title = target.kind === 'here' ? tr('Sklonuj repozytorium tutaj') : tr('Klonuj repozytorium');

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal git-clone" role="dialog" aria-modal="true" aria-labelledby="git-clone-title">
        <div className="modal-head">
          <h3 id="git-clone-title">{title}</h3>
          <button className="btn ghost icon" disabled={busy} onClick={close} aria-label={tr('Zamknij')}><IX /></button>
        </div>
        <div className="modal-body">
          {target.kind === 'here' && <p className="muted git-clone-lead">{tr('Repozytorium trafi do folderu projektu „{name}”. Folder musi być pusty.', { name: target.projectName })}</p>}
          <div className="field">
            <label htmlFor="git-clone-url">{tr('Adres repozytorium')}</label>
            <input
              id="git-clone-url" className={`input ${trimmed && !validUrl ? 'invalid' : ''}`} autoFocus spellCheck={false} maxLength={2000} value={url} disabled={busy}
              placeholder="https://github.com/owner/repo.git" onChange={(e) => { setUrl(e.target.value); setError(null); }} onKeyDown={onEnter}
            />
            {trimmed && !validUrl && <span className="git-clone-hint">{tr(INVALID_CLONE_URL)}</span>}
          </div>
          {target.kind === 'new' && <>
            <div className="field">
              <label>{tr('Folder nadrzędny')}</label>
              <div className="git-clone-parent">
                <span className={`git-clone-path ${parent ? '' : 'muted'}`} title={parent ?? undefined}>{parent ?? tr('Nie wybrano folderu')}</span>
                <button className="btn small" disabled={busy} onClick={() => void pickParent()}>{tr('Wybierz…')}</button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="git-clone-name">{tr('Nazwa folderu')}</label>
              <input
                id="git-clone-name" className={`input ${folder && !isSafeFolderName(folder) ? 'invalid' : ''}`} spellCheck={false} maxLength={100} value={folder} disabled={busy}
                onChange={(e) => { setName(e.target.value); setNameEdited(true); setError(null); }} onKeyDown={onEnter}
              />
              {destination && <span className="muted git-clone-small" title={destination}>{tr('Repozytorium trafi do: {path}', { path: destination })}</span>}
            </div>
          </>}
          {busy && <div className="git-clone-progress" role="status"><RefreshIcon spinning />{tr('Klonowanie…')}</div>}
          {error && <div className="git-clone-error" role="alert">{errorText(error)}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" disabled={busy} onClick={close}>{tr('Anuluj')}</button>
          <button className="btn primary" disabled={!ready} onClick={() => void clone()}>{busy && <RefreshIcon spinning />}{tr('Klonuj')}</button>
        </div>
      </div>
    </div>
  );
}
