// The login questions of a database session: the SSH tunnel's host key and password / passphrase (the same cards as SSH cells
// and the SFTP view) and the database password. Shown in the panel, in a tab waiting for its session and in the connection form.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DbPrompt } from '../../../../shared/db';
import { enterSubmitsPrompt } from '../../../../shared/ssh';
import { useDbStore } from '../../db/dbClient';
import { useI18n } from '../../i18n';
import { AuthPrompt } from '../ssh/AuthPrompt';
import { HostKeyPrompt } from '../ssh/HostKeyPrompt';
import type { PromptReply } from '../ssh/promptReply';
import '../ssh/ssh.css';

const reply = (sessionId: string) => (r: PromptReply): void => {
  const { promptId } = r;
  if ('cancel' in r && r.cancel) void window.mc.db.answer({ sessionId, promptId, cancel: true });
  else if ('hostKey' in r && r.hostKey) void window.mc.db.answer({ sessionId, promptId, hostKey: r.hostKey });
  else if ('values' in r) void window.mc.db.answer({ sessionId, promptId, values: r.values, ...(r.remember !== undefined ? { remember: r.remember } : {}) });
};

function DbPasswordPrompt({ sessionId, prompt }: { sessionId: string; prompt: Extract<DbPrompt, { kind: 'dbPassword' }> }) {
  const { tr } = useI18n();
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const storage = useDbStore((st) => st.vault?.storage ?? 'unavailable');
  const ref = useRef(value);
  ref.current = value;
  useEffect(() => () => { ref.current = ''; }, []);
  const submit = () => { void window.mc.db.answer({ sessionId, promptId: prompt.id, values: [value], remember }); setValue(''); };
  const cancel = () => { void window.mc.db.answer({ sessionId, promptId: prompt.id, cancel: true }); setValue(''); };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const target = e.target as HTMLInputElement;
    if (e.key === 'Enter' && enterSubmitsPrompt(target)) { e.preventDefault(); submit(); }
    else if (e.key === 'Enter' && target.tagName === 'INPUT') e.preventDefault();
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  return (
    <form className="ssh-prompt db-password-prompt" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={onKey}>
      <div className="ssh-card-title">{tr('Hasło do bazy {name}', { name: prompt.connectionName })}</div>
      <div className="ssh-card-hint">{`${prompt.user}@${prompt.endpoint}`}</div>
      {prompt.retry && <div className="ssh-error" role="alert">{tr('Nieprawidłowe hasło')}</div>}
      <label className="ssh-field">
        <input className="input" type="password" autoComplete="off" spellCheck={false} autoFocus value={value} maxLength={4096} onChange={(e) => setValue(e.target.value)} />
      </label>
      {prompt.canSave && (
        <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {tr('Zapisz hasło')}
          {storage === 'unavailable' && <span className="muted"> ({tr('do zamknięcia aplikacji')})</span>}
        </label>
      )}
      <div className="ssh-actions">
        <button type="submit" className="btn small primary">{tr('Połącz')}</button>
        <button type="button" className="btn small" onClick={cancel}>{tr('Anuluj')}</button>
      </div>
    </form>
  );
}

/** The open question of a session, or nothing. */
export function DbLogin({ sessionId }: { sessionId: string | null | undefined }) {
  const prompt = useDbStore((st) => (sessionId ? st.prompts[sessionId] ?? null : null));
  const storage = useDbStore((st) => (st.vault?.storage === 'unavailable' ? 'unavailable' : st.vault?.storage === 'keychain' ? 'keychain' : 'dpapi'));
  if (!sessionId || !prompt) return null;
  const respond = reply(sessionId);
  return (
    <div className={`db-login${prompt.kind === 'hostKey' && prompt.reason === 'changed' ? ' danger' : ''}`} role="dialog">
      {prompt.kind === 'dbPassword' ? <DbPasswordPrompt key={prompt.id} sessionId={sessionId} prompt={prompt} />
        : prompt.kind === 'hostKey' ? <HostKeyPrompt key={prompt.id} cellId={sessionId} prompt={prompt} respond={respond} />
          : <AuthPrompt key={prompt.id} cellId={sessionId} prompt={prompt} storage={storage} respond={respond} />}
    </div>
  );
}
