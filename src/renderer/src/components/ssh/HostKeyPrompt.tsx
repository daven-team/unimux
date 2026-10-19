// Host key decision inside an SSH cell (spec 9 step 4): neutral card for a new host, red card with a confirmation for a changed key.
import { useState } from 'react';
import type { SshPrompt } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { promptReply, type PromptReply } from './promptReply';

/** In a cell (`cellId`) or, with `respond`, anywhere else that shows a login prompt (the SFTP view, 0.9.8). */
export function HostKeyPrompt({ cellId, prompt, respond }: { cellId: string; prompt: Extract<SshPrompt, { kind: 'hostKey' }>; respond?: (reply: PromptReply) => void }) {
  const { tr } = useI18n();
  const [checked, setChecked] = useState(false);
  const send = respond ?? promptReply(cellId);
  const answer = (hostKey: 'once' | 'save' | 'replace') => send({ promptId: prompt.id, hostKey });
  const cancel = () => send({ promptId: prompt.id, cancel: true });
  const fingerprint = <code className="ssh-fingerprint">{prompt.keyType} {prompt.fingerprint}</code>;
  if (prompt.reason === 'changed') {
    return (
      <div className="ssh-prompt" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') cancel(); }}>
        <div className="ssh-card-title danger">{tr('UWAGA: klucz hosta się zmienił')}</div>
        <p className="ssh-card-text">{tr('Ktoś może podszywać się pod ten serwer (atak man-in-the-middle) albo serwer został przeinstalowany.')}</p>
        <div className="ssh-kv"><span>{tr('Poprzedni odcisk')}</span>{prompt.knownFingerprints.map((f) => <code key={f} className="ssh-fingerprint">{f}</code>)}</div>
        <div className="ssh-kv"><span>{tr('Nowy odcisk')}</span>{fingerprint}</div>
        <label className="check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {tr('Sprawdziłem nowy odcisk z administratorem serwera')}</label>
        <div className="ssh-actions">
          <button className="btn small primary" autoFocus onClick={cancel}>{tr('Rozłącz')}</button>
          <button className="btn small danger" disabled={!checked} onClick={() => answer('replace')}>{tr('Zastąp zapisany klucz')}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="ssh-prompt" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') cancel(); }}>
      <div className="ssh-card-title">{tr('Nowy host: {endpoint}', { endpoint: prompt.endpoint })}</div>
      {prompt.reason === 'newType' && <p className="ssh-card-text">{tr('Ten host ma już zapisany klucz innego typu ({types})', { types: prompt.knownTypes.join(', ') })}</p>}
      {fingerprint}
      <div className="ssh-actions">
        <button className="btn small primary" autoFocus onClick={() => answer('save')}>{tr('Zaufaj i zapisz')}</button>
        <button className="btn small" onClick={() => answer('once')}>{tr('Tylko tym razem')}</button>
        <button className="btn small" onClick={cancel}>{tr('Anuluj')}</button>
      </div>
    </div>
  );
}
