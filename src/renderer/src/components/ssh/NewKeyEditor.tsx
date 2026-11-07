// A new key (spec 7.1, 7.2, 10.2): generate, import a file (picker or drop) or paste. Imports are drafts held in main;
// the pasted private text is cleared right after it was sent and when the paste mode is left, passphrases on submit.
// The editor stays mounted while the SSH view is open; a draft that was never stored is discarded when the pane shows something else or the view closes.
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { DEFAULT_KEY_BITS, draftErrorKey, formDirty, KEY_SIZES, READ_ONLY_VAULT_HINT, newKeyProblem, type DraftResult, type SshKeyType } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { toast } from '../../store';
import { showSshDetail } from '../../ssh';
import { useSshStore } from '../../sshStore';
import { Select } from '../Select';
import { useClearWhenHidden, useReportDirty, withoutPaneGuard } from './paneVisibility';

type Mode = 'generate' | 'file' | 'paste';
type Draft = Extract<DraftResult, { ok: true }>;

export function NewKeyEditor({ initialMode }: { initialMode?: Mode }) {
  const { tr } = useI18n();
  const storage = useSshStore((st) => st.vault?.storage);
  const readOnly = useSshStore((st) => !!st.vault?.readOnly);
  const [mode, setMode] = useState<Mode>(initialMode ?? 'generate');
  const [type, setType] = useState<SshKeyType>('ed25519');
  const [bits, setBits] = useState(DEFAULT_KEY_BITS.ed25519);
  const [label, setLabel] = useState('');
  const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [savePassphrase, setSavePassphrase] = useState(false);
  const [privateText, setPrivateText] = useState('');
  const [publicText, setPublicText] = useState('');
  const [certText, setCertText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // D4: a hidden pane keeps the label, comment and draft, never a typed passphrase or a pasted private key.
  useClearWhenHidden(() => { setPassphrase(''); setRepeat(''); setPrivateText(''); });
  useReportDirty(formDirty([label, comment, passphrase, repeat, privateText, publicText, certText, draft?.draftId]));
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft?.draftId ?? null;
  // Unmount = the pane shows another item or the view closed (after a stored key draftRef is already null): drop the draft in main.
  useEffect(() => () => { if (draftRef.current) window.mc.ssh.discardDraft(draftRef.current); }, []);

  const done = (keyId: string) => { draftRef.current = null; setDraft(null); withoutPaneGuard(() => showSshDetail({ kind: 'key', keyId })); };
  const takeDraft = (r: DraftResult | { ok: false; error: 'cancelled' }) => {
    if (!r.ok) { const key = draftErrorKey(r.error); setError(key ? tr(key) : null); return; }
    setError(null);
    setDraft(r);
    if (!label.trim()) setLabel(r.comment || tr('Klucz'));
  };
  const cancelDraft = () => {
    if (draft) window.mc.ssh.discardDraft(draft.draftId);
    setDraft(null); setPassphrase(''); setSavePassphrase(false); setError(null);
  };
  const generate = async () => {
    const problem = newKeyProblem({ label, passphrase, repeat });
    if (problem) { setError(tr(problem)); return; }
    setBusy(true);
    setError(null);
    const value = passphrase;
    setPassphrase(''); setRepeat('');
    const r = await window.mc.ssh.generateKey({ label: label.trim(), type, bits: type === 'ed25519' ? undefined : bits, comment: comment.trim() || undefined, passphrase: value || undefined, savePassphrase: !!value && savePassphrase });
    setBusy(false);
    if (r.ok) done(r.key.id); else setError(tr(draftErrorKey(r.error) ?? 'Nieznany błąd SSH'));
  };
  const pasteDraft = async () => {
    const text = privateText;
    setPrivateText('');
    setBusy(true);
    takeDraft(await window.mc.ssh.draftFromText({ privateKey: text, publicKey: publicText.trim() || undefined, certificate: certText.trim() || undefined }));
    setBusy(false);
  };
  const fromFile = async (load: Promise<DraftResult | { ok: false; error: 'cancelled' }>) => {
    setBusy(true);
    takeDraft(await load);
    setBusy(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    const failed = () => setError(tr('Nie udało się odczytać pliku'));
    if (!file) return failed();
    void window.mc.pathsForFiles([file]).then(([path]) => {
      if (path) void fromFile(window.mc.ssh.draftFromFile(path));
      else failed();
    }, failed);
  };
  const unlock = async () => {
    if (!draft || !passphrase) return;
    const value = passphrase;
    setPassphrase('');
    setBusy(true);
    const r = await window.mc.ssh.unlockDraft(draft.draftId, value);
    setBusy(false);
    if (r.ok) setSavePassphrase(false);
    takeDraft(r);
  };
  const commit = async () => {
    if (!draft) return;
    if (draft.duplicateOf) { window.mc.ssh.discardDraft(draft.draftId); done(draft.duplicateOf); return; }
    setBusy(true);
    const r = await window.mc.ssh.commitDraft({ draftId: draft.draftId, label: label.trim() || tr('Klucz'), savePassphrase });
    setBusy(false);
    if (r.ok) done(r.key.id);
    else setError(tr(r.error === 'failed' ? 'Nie udało się zapisać zmian' : draftErrorKey(r.error) ?? 'Nieznany błąd SSH'));
  };
  const copyPublic = (text: string) => { window.mc.clipboardWrite(text); toast(tr('Skopiowano klucz publiczny')); };

  if (readOnly) {
    return (
      <div className="ssh-editor">
        <h2>{tr('Nowy klucz')}</h2>
        <div className="ssh-banner-warn">{tr(READ_ONLY_VAULT_HINT)}</div>
      </div>
    );
  }

  const modes: Array<[Mode, 'Wygeneruj klucz' | 'Importuj z pliku' | 'Wklej klucz']> = [['generate', 'Wygeneruj klucz'], ['file', 'Importuj z pliku'], ['paste', 'Wklej klucz']];
  return (
    <div className="ssh-editor">
      <h2>{tr('Nowy klucz')}</h2>
      {storage === 'unavailable' && <div className="ssh-banner-warn">{tr('Szyfrowanie systemowe jest niedostępne - klucze i hasła są trzymane tylko do zamknięcia aplikacji')}</div>}
      <div className="ssh-segmented" role="tablist">
        {modes.map(([m, text]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} disabled={!!draft || busy} onClick={() => { if (m !== 'paste') setPrivateText(''); setMode(m); setError(null); }}>
            {tr(text)}
          </button>
        ))}
      </div>
      {error && <div className="ssh-error" role="alert">{error}</div>}
      {!draft && mode === 'generate' && <>
        <div className="ssh-section">
          <div className="ssh-row">
            <label className="ssh-field grow"><span>{tr('Typ')}</span>
              <Select className="select" value={type} onChange={(e) => { const t = e.target.value as SshKeyType; setType(t); setBits(DEFAULT_KEY_BITS[t]); }}>
                <option value="ed25519">Ed25519</option><option value="ecdsa">ECDSA</option><option value="rsa">RSA</option>
              </Select></label>
            {type !== 'ed25519' && <label className="ssh-field grow"><span>{tr('Rozmiar')}</span>
              <Select className="select" value={bits} onChange={(e) => setBits(Number(e.target.value))}>
                {KEY_SIZES[type].map((b) => <option key={b} value={b}>{type === 'rsa' && b === 2048 ? `${b} (${tr('zgodność ze starszymi serwerami')})` : String(b)}</option>)}
              </Select></label>}
          </div>
          <label className="ssh-field"><span>{tr('Etykieta')}</span><input className="input" data-field="newKeyLabel" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></label>
          <label className="ssh-field"><span>{tr('Komentarz')}</span><input className="input" value={comment} maxLength={200} placeholder="unimux@..." spellCheck={false} onChange={(e) => setComment(e.target.value)} /></label>
        </div>
        <div className="ssh-section">
          <div className="ssh-row">
            <label className="ssh-field grow"><span>{tr('Hasło klucza')}</span><input className="input" type="password" autoComplete="off" value={passphrase} maxLength={1024} onChange={(e) => setPassphrase(e.target.value)} /></label>
            <label className="ssh-field grow"><span>{tr('Powtórz hasło klucza')}</span><input className="input" type="password" autoComplete="off" value={repeat} maxLength={1024} onChange={(e) => setRepeat(e.target.value)} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={savePassphrase} disabled={!passphrase} onChange={(e) => setSavePassphrase(e.target.checked)} /> {tr('Zapisz hasło klucza')}</label>
        </div>
        <div className="ssh-actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void generate()}>{tr('Wygeneruj klucz')}</button></div>
      </>}
      {!draft && mode === 'file' && (
        <div className={`ssh-drop ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
          onDrop={onDrop}>
          <span>{tr('Upuść tutaj plik klucza prywatnego')}</span>
          <button type="button" className="btn" disabled={busy} onClick={() => void fromFile(window.mc.ssh.pickKeyFile())}>{tr('Wybierz plik...')}</button>
        </div>
      )}
      {!draft && mode === 'paste' && <>
        <div className="ssh-section">
          <label className="ssh-field"><span>{tr('Klucz prywatny')}</span><textarea className="input mono" rows={6} spellCheck={false} autoComplete="off" value={privateText} onChange={(e) => setPrivateText(e.target.value)} /></label>
          <label className="ssh-field"><span>{tr('Klucz publiczny (opcjonalnie)')}</span><textarea className="input mono" rows={2} spellCheck={false} value={publicText} onChange={(e) => setPublicText(e.target.value)} /></label>
          <label className="ssh-field"><span>{tr('Certyfikat (opcjonalnie)')}</span><textarea className="input mono" rows={2} spellCheck={false} value={certText} onChange={(e) => setCertText(e.target.value)} /></label>
        </div>
        <div className="ssh-actions"><button type="button" className="btn primary" disabled={!privateText.trim() || busy} onClick={() => void pasteDraft()}>{tr('Dalej')}</button></div>
      </>}
      {draft?.needsPassphrase && <>
        <div className="ssh-section">
          <label className="ssh-field"><span>{tr('Hasło klucza')}</span><input className="input" type="password" autoComplete="off" autoFocus value={passphrase} maxLength={1024} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void unlock(); }} /></label>
        </div>
        <div className="ssh-actions">
          <button type="button" className="btn primary" disabled={!passphrase || busy} onClick={() => void unlock()}>{tr('Dalej')}</button>
          <button type="button" className="btn" onClick={cancelDraft}>{tr('Anuluj')}</button>
        </div>
      </>}
      {draft && !draft.needsPassphrase && <>
        {draft.duplicateOf && <div className="ssh-card-hint">{tr('Ten klucz już jest w sejfie')}</div>}
        {draft.certificateWarning && <div className="ssh-card-hint">{tr('Certyfikat jest zapisany, ale logowanie certyfikatem nie jest jeszcze obsługiwane')}</div>}
        <div className="ssh-section">
          <dl className="ssh-facts"><dt>{tr('Typ')}</dt><dd>{draft.type}</dd><dt>{tr('Rozmiar')}</dt><dd>{draft.bits}</dd><dt>{tr('Odcisk')}</dt><dd><code className="ssh-fingerprint">{draft.fingerprint}</code></dd></dl>
          {draft.publicKey && <div className="ssh-field"><span>{tr('Klucz publiczny')}</span>
            <pre className="ssh-public">{draft.publicKey}</pre>
            <div className="ssh-row"><button type="button" className="btn" onClick={() => copyPublic(draft.publicKey!)}>{tr('Kopiuj klucz publiczny')}</button></div>
          </div>}
          {!draft.duplicateOf && <label className="ssh-field"><span>{tr('Etykieta')}</span><input className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} /></label>}
          {draft.encrypted && !draft.duplicateOf && <label className="check"><input type="checkbox" checked={savePassphrase} onChange={(e) => setSavePassphrase(e.target.checked)} /> {tr('Zapisz hasło klucza')}</label>}
        </div>
        <div className="ssh-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void commit()}>{tr('Zapisz')}</button>
          <button type="button" className="btn" onClick={cancelDraft}>{tr('Anuluj')}</button>
        </div>
      </>}
    </div>
  );
}
