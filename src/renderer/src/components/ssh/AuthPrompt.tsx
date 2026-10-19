// Passphrase, password and keyboard-interactive prompts inside an SSH cell (spec 10.3). Fields are cleared on submit and unmount.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { enterSubmitsPrompt, type SshPrompt, type SshVaultInfo } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { promptReply, type PromptReply } from './promptReply';

type AuthKind = Extract<SshPrompt, { kind: 'passphrase' | 'password' | 'keyboard' | 'sudo' }>;

/** In a cell (`cellId`) or, with `respond`, anywhere else that shows a login prompt (the SFTP view, 0.9.8). */
export function AuthPrompt({ cellId, prompt, storage, respond }: { cellId: string; prompt: AuthKind; storage: SshVaultInfo['storage']; respond?: (reply: PromptReply) => void }) {
  const { tr } = useI18n();
  const send = respond ?? promptReply(cellId);
  const fields = prompt.kind === 'keyboard' ? prompt.fields : [{ text: '', echo: false }];
  const [values, setValues] = useState<string[]>(() => fields.map(() => ''));
  const [remember, setRemember] = useState(prompt.kind === 'passphrase');
  const valuesRef = useRef(values);
  valuesRef.current = values;
  useEffect(() => () => { valuesRef.current.fill(''); }, []);

  const submit = () => {
    send({ promptId: prompt.id, values, ...(prompt.kind !== 'keyboard' && prompt.kind !== 'sudo' ? { remember } : {}) });
    setValues(fields.map(() => ''));
  };
  // The user's consent to use the host's saved login password for sudo this once (main fills it in, it never reaches the view).
  const useSaved = () => { send({ promptId: prompt.id, values: [''], useSaved: true }); setValues(fields.map(() => '')); };
  const cancel = () => { send({ promptId: prompt.id, cancel: true }); setValues(fields.map(() => '')); };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const target = e.target as HTMLInputElement;
    if (e.key === 'Enter' && enterSubmitsPrompt(target)) { e.preventDefault(); submit(); }
    // A checkbox would submit the form implicitly; a button keeps its own Enter (Anuluj cancels, Połącz submits).
    else if (e.key === 'Enter' && target.tagName === 'INPUT') e.preventDefault();
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  const title = prompt.kind === 'passphrase' ? tr('Hasło do klucza {name}', { name: prompt.keyLabel })
    : prompt.kind === 'password' ? tr('Hasło dla {user}@{endpoint}', { user: prompt.user, endpoint: prompt.endpoint })
      : prompt.kind === 'sudo' ? tr('Hasło sudo dla {user}@{endpoint}', { user: prompt.user, endpoint: prompt.endpoint })
      : prompt.name || tr('Serwer prosi o dodatkowe dane');
  // No safe storage on this computer: "Zapisz hasło" still works, but only in memory until the app quits (D8, L21).
  const memoryOnly = storage === 'unavailable';

  return (
    <form className="ssh-prompt" onSubmit={(e) => { e.preventDefault(); submit(); }} onKeyDown={onKey}>
      <div className="ssh-card-title">{title}</div>
      {prompt.kind === 'keyboard' && prompt.instructions && <p className="ssh-card-text">{prompt.instructions}</p>}
      {prompt.kind !== 'keyboard' && prompt.retry && <div className="ssh-error" role="alert">{tr(prompt.kind === 'passphrase' ? 'Nieprawidłowe hasło klucza' : prompt.kind === 'sudo' ? 'Nieprawidłowe hasło sudo' : 'Nieprawidłowe hasło')}</div>}
      {fields.map((field, i) => (
        <label key={i} className="ssh-field">
          {field.text && <span>{field.text}</span>}
          <input className="input" type={prompt.kind === 'keyboard' && field.echo ? 'text' : 'password'} autoComplete="off" spellCheck={false} autoFocus={i === 0}
            value={values[i] ?? ''} maxLength={1024} onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
        </label>
      ))}
      {prompt.kind === 'passphrase' && (
        <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {tr('Pamiętaj do zamknięcia aplikacji')}</label>
      )}
      {prompt.kind === 'password' && (
        <label className="check" title={memoryOnly ? tr('Bezpieczne przechowywanie haseł jest niedostępne na tym komputerze - hasło zostanie zapamiętane tylko do zamknięcia aplikacji') : undefined}>
          <input type="checkbox" disabled={!prompt.canSave} checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {tr('Zapisz hasło')}
          {memoryOnly && <span className="muted"> ({tr('do zamknięcia aplikacji')})</span>}
        </label>
      )}
      {prompt.kind === 'sudo' && <p className="ssh-card-hint">{tr('Hasło sudo nie jest zapisywane.')}</p>}
      <div className="ssh-actions">
        <button type="submit" className="btn small primary">{tr('Połącz')}</button>
        {prompt.kind === 'sudo' && prompt.canUseSaved && <button type="button" className="btn small" onClick={useSaved}>{tr('Użyj zapisanego hasła logowania')}</button>}
        <button type="button" className="btn small" onClick={cancel}>{tr('Anuluj')}</button>
      </div>
    </form>
  );
}
