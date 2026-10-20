// One key of the vault (spec 10.2, 7.4, D6, D9). Public parts are shown and copied. The private key goes to a file through main,
// or is shown after an explicit, confirmed "Pokaż klucz prywatny" (0.9.2): the text lives only in PrivateKeySection's state and
// is dropped on "Ukryj klucz", when the pane goes hidden or closes, on another key and after 2 minutes. "Zastąp klucz prywatny"
// sends a pasted key to main, which parses and stores it; the form is cleared on submit.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PaneActive, useClearWhenHidden, useReportDirty, withoutPaneGuard } from './paneVisibility';
import { draftErrorKey, formDirty, READ_ONLY_VAULT_HINT, hostsUsingKey, labelFieldValue, replaceKeyErrorKey, type KeyError, type SshKeyInfo } from '../../../../shared/ssh';
import { identitiesUsingKey, removeKeyQuestion } from '../../../../shared/sshIdentity';
import type { MessageKey } from '../../../../shared/i18n';
import { useI18n } from '../../i18n';
import { askChoice, toast, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { showSshDetail } from '../../ssh';

/** How long a revealed private key stays on screen. */
export const REVEAL_MS = 2 * 60_000;

/** A failed change of a stored key is a write failure, not a failed generation. */
const changeErrorKey = (error: KeyError): MessageKey | null => (error === 'failed' ? 'Nie udało się zapisać zmian' : draftErrorKey(error));

export function KeyEditor({ keyId }: { keyId: string }) {
  const { tr } = useI18n();
  const key = useSshStore((st) => st.vault?.keys.find((k) => k.id === keyId));
  const readOnly = useSshStore((st) => !!st.vault?.readOnly);
  const allHosts = useStore((st) => st.s.sshHosts);
  const identities = useStore((st) => st.s.sshIdentities);
  // Hosts that sign in with this key directly or through their identity.
  const hosts = useMemo(() => hostsUsingKey(allHosts, keyId, identities), [allHosts, keyId, identities]);
  // Identities that carry this key (also the ones no host uses yet): deleting the key takes it from them.
  const keyIdentities = useMemo(() => identitiesUsingKey(identities, keyId).sort((a, b) => a.label.localeCompare(b.label)), [identities, keyId]);
  const [label, setLabel] = useState(key?.label ?? '');
  const labelFocused = useRef(false);
  // A rename elsewhere or a late vault push shows up unless the user is typing in the field.
  const storedLabel = key?.label ?? '';
  useEffect(() => { setLabel((field) => labelFieldValue({ field, stored: storedLabel, focused: labelFocused.current })); }, [storedLabel]);
  const [certificate, setCertificate] = useState('');
  const [passphrase, setPassphrase] = useState('');
  useClearWhenHidden(() => setPassphrase(''));
  useReportDirty(label.trim() !== storedLabel || formDirty([certificate, passphrase]));
  const [error, setError] = useState<string | null>(null);
  if (!key) return <div className="ssh-editor"><p className="ssh-card-hint">{tr('Klucz przypisany do hosta nie istnieje')}</p></div>;

  const change = async (p: Promise<{ ok: true } | { ok: false; error: KeyError }>): Promise<boolean> => {
    const r = await p;
    const message = r.ok ? null : changeErrorKey(r.error);
    setError(message ? tr(message) : null);
    return r.ok;
  };
  const saveLabel = () => {
    const next = label.trim();
    if (!next) { setLabel(key.label); return; }
    if (next !== key.label) void change(window.mc.ssh.updateKey({ id: key.id, label: next }));
  };
  const exportKey = async () => {
    const r = await window.mc.ssh.exportPrivateKey(key.id);
    if (r.ok || r.error === 'cancelled') { setError(null); return; }
    setError(tr(r.error === 'locked' ? 'Nie można odczytać klucza na tym komputerze' : r.error === 'notFound' ? 'Klucz przypisany do hosta nie istnieje' : 'Nie udało się zapisać pliku'));
  };
  const remove = async () => {
    const question = removeKeyQuestion(key.label, hosts.length, keyIdentities.length);
    if (await askChoice(tr(question.key, question.params), '', [{ label: tr('Usuń klucz'), value: 'yes', danger: true }]) !== 'yes') return;
    if ((await window.mc.ssh.removeKey(key.id)).ok) withoutPaneGuard(() => showSshDetail(null));
    else setError(tr('Nie udało się zapisać zmian'));
  };
  const copyPublic = () => { window.mc.clipboardWrite(key.publicKey); toast(tr('Skopiowano klucz publiczny')); };

  return (
    <div className="ssh-editor">
      <h2>{key.label}</h2>
      {readOnly && <div className="ssh-banner-warn">{tr(READ_ONLY_VAULT_HINT)}</div>}
      {key.locked && <div className="ssh-error">{tr('Nie można odczytać tego sekretu na tym komputerze. Usuń go i dodaj ponownie.')}</div>}
      {key.ephemeral && <div className="ssh-card-hint">{tr('do zamknięcia aplikacji')}</div>}
      {error && <div className="ssh-error" role="alert">{error}</div>}
      <div className="ssh-section">
        <label className="ssh-field"><span>{tr('Etykieta')}</span>
          <input className="input" value={label} maxLength={80} disabled={readOnly} onChange={(e) => setLabel(e.target.value)} onFocus={() => { labelFocused.current = true; }} onBlur={() => { labelFocused.current = false; saveLabel(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </label>
        <dl className="ssh-facts">
          <dt>{tr('Typ')}</dt><dd>{key.type}</dd>
          <dt>{tr('Rozmiar')}</dt><dd>{key.bits}</dd>
          <dt>{tr('Odcisk')}</dt><dd><code className="ssh-fingerprint">{key.fingerprint}</code></dd>
          <dt>{tr('Komentarz')}</dt><dd>{key.comment || '-'}</dd>
        </dl>
      </div>
      <div className="ssh-section">
        <div className="ssh-field"><span>{tr('Klucz publiczny')}</span>
          <pre className="ssh-public">{key.publicKey}</pre>
          <div className="ssh-row"><button type="button" className="btn" onClick={copyPublic}>{tr('Kopiuj klucz publiczny')}</button></div>
        </div>
      </div>
      <PrivateKeySection keyInfo={key} readOnly={readOnly} onExport={() => void exportKey()} />
      <div className="ssh-section">
        <div className="ssh-field"><span>{tr('Certyfikat')}</span>
          {key.certificate && <span className="ssh-card-hint">{tr('Certyfikat jest zapisany, ale logowanie certyfikatem nie jest jeszcze obsługiwane')}</span>}
          {key.certificate && <pre className="ssh-public">{key.certificate}</pre>}
          {!readOnly && <>
            <textarea className="input mono" rows={2} value={certificate} spellCheck={false} onChange={(e) => setCertificate(e.target.value)} />
            <div className="ssh-row">
              <button type="button" className="btn" disabled={!certificate.trim()} onClick={() => void change(window.mc.ssh.updateKey({ id: key.id, certificate: certificate.trim() })).then((ok) => ok && setCertificate(''))}>{tr('Zastąp certyfikat')}</button>
              {key.certificate && <button type="button" className="btn" onClick={() => void change(window.mc.ssh.updateKey({ id: key.id, certificate: null }))}>{tr('Usuń certyfikat')}</button>}
            </div>
          </>}
        </div>
        {key.encrypted && !readOnly && <div className="ssh-field"><span>{tr('Hasło klucza')}</span>
          {key.passphraseSaved
            ? <div className="ssh-row"><button type="button" className="btn" onClick={() => void change(window.mc.ssh.updateKey({ id: key.id, passphrase: { forget: true } }))}>{tr('Zapomnij zapisane hasło')}</button></div>
            : <div className="ssh-row"><input className="input grow" type="password" autoComplete="off" value={passphrase} maxLength={1024} onChange={(e) => setPassphrase(e.target.value)} />
                <button type="button" className="btn" disabled={!passphrase || key.locked} onClick={() => { const value = passphrase; setPassphrase(''); void change(window.mc.ssh.updateKey({ id: key.id, passphrase: { save: value } })); }}>{tr('Zapisz hasło klucza')}</button></div>}
        </div>}
        <div className="ssh-field"><span>{tr('Hosty używające klucza')}</span>
          {hosts.length ? <ul className="ssh-list">{hosts.map((h) => <li key={h.id}><button type="button" className="btn small ghost" onClick={() => showSshDetail({ kind: 'host', hostId: h.id })}>{h.label}</button></li>)}</ul> : <span className="ssh-card-hint">-</span>}
        </div>
        {keyIdentities.length > 0 && <div className="ssh-field ssh-key-identities"><span>{tr('Tożsamości używające klucza')}</span>
          <ul className="ssh-list">{keyIdentities.map((i) => <li key={i.id}><button type="button" className="btn small ghost" onClick={() => showSshDetail({ kind: 'identity', identityId: i.id })}>{i.label}</button></li>)}</ul>
        </div>}
      </div>
      {!readOnly && <div className="ssh-actions">
        <span className="grow" />
        <button type="button" className="btn danger" onClick={() => void remove()}>{tr('Usuń klucz')}</button>
      </div>}
    </div>
  );
}

/** "Klucz prywatny": show (after a confirmation), copy, hide, save to a file, replace. */
function PrivateKeySection({ keyInfo, readOnly, onExport }: { keyInfo: SshKeyInfo; readOnly: boolean; onExport: () => void }) {
  const { tr } = useI18n();
  const active = useContext(PaneActive);
  const activeRef = useRef(active);
  activeRef.current = active;
  const keyIdRef = useRef(keyInfo.id);
  keyIdRef.current = keyInfo.id;
  const [revealed, setRevealed] = useState<string | null>(null);
  const shownText = useRef<HTMLTextAreaElement>(null);
  const [replacing, setReplacing] = useState(false);
  const [text, setText] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [savePassphrase, setSavePassphrase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);
  useClearWhenHidden(() => { setRevealed(null); setText(''); setPassphrase(''); });
  useReportDirty(formDirty([text, passphrase]));
  // Another key in the same editor (the pane is keyed by key, this is a second guard) never shows the previous key's text.
  useEffect(() => () => { setRevealed(null); setText(''); setPassphrase(''); }, [keyInfo.id]);
  useEffect(() => {
    if (revealed === null) return;
    const timer = setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealed]);
  // The section sits low in the pane: the shown key scrolls into view.
  const isShown = revealed !== null;
  useEffect(() => { if (isShown) shownText.current?.closest('.ssh-private')?.scrollIntoView({ block: 'nearest' }); }, [isShown]);

  const reveal = async () => {
    const choice = await askChoice(tr('Pokazać klucz prywatny?'), tr('Klucz prywatny pojawi się na ekranie. Każdy, kto go zobaczy albo skopiuje, może się nim logować na serwery, które mu ufają.'),
      [{ label: tr('Pokaż'), value: 'yes', primary: true }]);
    if (choice !== 'yes') return;
    const asked = keyInfo.id;
    const r = await window.mc.ssh.revealPrivateKey(asked);
    // The pane went to the background or shows another key since: the text is not shown there.
    if (!activeRef.current || keyIdRef.current !== asked) return;
    if (r.ok) { setError(null); setRevealed(r.privateKey); }
    else setError(tr(r.error === 'locked' ? 'Nie można odczytać klucza na tym komputerze' : 'Klucz przypisany do hosta nie istnieje'));
  };
  const copy = () => {
    if (revealed === null) return;
    window.mc.clipboardWriteSecret(revealed)
      .then((ok) => { if (ok) toast(tr('Skopiowano klucz prywatny')); else throw new Error('refused'); })
      .catch(() => toast(tr('Nie udało się skopiować klucza prywatnego'), 'error'));
  };
  const cancelReplace = () => { setReplacing(false); setText(''); setPassphrase(''); setSavePassphrase(false); };
  const replace = async () => {
    if (!text.trim() || busy) return;
    const choice = await askChoice(tr('Zastąpić klucz prywatny {name}?', { name: keyInfo.label }), tr('Obecny klucz prywatny zostanie usunięty z sejfu. Etykieta i hosty, które go używają, zostają.'),
      [{ label: tr('Zastąp klucz'), value: 'yes', danger: true }]);
    if (choice !== 'yes') return;
    const privateKey = text, typed = passphrase;
    setText('');
    setPassphrase('');
    setBusy(true);
    const r = await window.mc.ssh.replacePrivateKey({ id: keyInfo.id, privateKey, ...(typed ? { passphrase: typed } : {}), savePassphrase: !!typed && savePassphrase });
    setBusy(false);
    if (!r.ok) { setNotice(null); setError(tr(replaceKeyErrorKey(r.error))); return; }
    setError(null);
    setRevealed(null);
    setReplacing(false);
    setSavePassphrase(false);
    const replaced = r.publicKeyChanged
      ? tr('Zastąpiono klucz prywatny. Klucz publiczny jest inny: dodaj go do authorized_keys na serwerach, które używają tego klucza.')
      : tr('Zastąpiono klucz prywatny. Klucz publiczny się nie zmienił.');
    setNotice({ text: r.certificateRemoved ? `${replaced} ${tr('Zapisany certyfikat usunięto, bo należał do poprzedniego klucza.')}` : replaced, warn: r.publicKeyChanged });
  };

  return (
    <div className="ssh-section ssh-private">
      <div className="ssh-field"><span>{tr('Klucz prywatny')}</span>
        {revealed === null ? (
          <div className="ssh-row ssh-row-wrap">
            <button type="button" className="btn ssh-reveal" disabled={keyInfo.locked} onClick={() => void reveal()}>{tr('Pokaż klucz prywatny')}</button>
            <button type="button" className="btn" disabled={keyInfo.locked} onClick={onExport}>{tr('Zapisz klucz prywatny do pliku...')}</button>
            {!replacing && <button type="button" className="btn ssh-replace" disabled={readOnly} title={readOnly ? tr(READ_ONLY_VAULT_HINT) : undefined} onClick={() => { setNotice(null); setReplacing(true); }}>{tr('Zastąp klucz prywatny')}</button>}
          </div>
        ) : (
          <>
            <textarea ref={shownText} className="input mono ssh-private-text" readOnly rows={8} wrap="off" spellCheck={false} autoComplete="off" value={revealed} aria-label={tr('Klucz prywatny')} />
            {keyInfo.encrypted && <span className="ssh-card-hint">{tr('Klucz jest chroniony hasłem, więc pokazany tekst jest zaszyfrowany.')}</span>}
            <span className="ssh-card-hint">{tr('Klucz zniknie z ekranu po 2 minutach, a skopiowany klucz zniknie ze schowka po minucie.')}</span>
            <div className="ssh-row">
              <button type="button" className="btn" onClick={copy}>{tr('Kopiuj')}</button>
              <button type="button" className="btn ssh-hide" onClick={() => setRevealed(null)}>{tr('Ukryj klucz')}</button>
            </div>
          </>
        )}
      </div>
      {replacing && !readOnly && (
        <div className="ssh-field ssh-replace-form"><span>{tr('Nowy klucz prywatny')}</span>
          <textarea className="input mono" rows={6} spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          <label className="ssh-field"><span>{tr('Hasło klucza (jeśli jest zaszyfrowany)')}</span>
            <input className="input" type="password" autoComplete="off" value={passphrase} maxLength={1024} onChange={(e) => setPassphrase(e.target.value)} />
          </label>
          <label className="check"><input type="checkbox" checked={savePassphrase} disabled={!passphrase} onChange={(e) => setSavePassphrase(e.target.checked)} /> {tr('Zapisz hasło klucza')}</label>
          <div className="ssh-row">
            <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={() => void replace()}>{tr('Zastąp klucz prywatny')}</button>
            <button type="button" className="btn" onClick={cancelReplace}>{tr('Anuluj')}</button>
          </div>
        </div>
      )}
      {notice && <div className={notice.warn ? 'ssh-banner-warn' : 'ssh-card-hint'} role="status">{notice.text}</div>}
      {error && <div className="ssh-error" role="alert">{error}</div>}
    </div>
  );
}
