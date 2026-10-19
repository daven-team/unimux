// The connection form of the "Bazy danych" panel (1.0.0): type, name, colour, group, address, user, password (kept in the DB
// vault; the form only says whether one is saved), database or DB index, TLS, the SSH tunnel through a saved host, read-only
// and the statement timeout. "Testuj połączenie" connects with the typed values (login questions appear here) and says how it went.
import { useMemo, useState } from 'react';
import { DB_DEFAULT_PORT, DB_TLS_MODES, dbConnectionToDraft, validateDbDraft, type DbConnectionDraft, type DbDraftField, type DbKind, type DbPasswordChange, type DbTestResult, type DbTlsMode } from '../../../../shared/db';
import type { MessageKey } from '../../../../shared/i18n';
import { dbErrorMessage, useDbStore } from '../../db/dbClient';
import { useI18n } from '../../i18n';
import { closeModal, toast, useStore } from '../../store';
import { ColorPicker } from '../ColorPicker';
import { IX } from '../icons';
import { Select } from '../Select';
import { DbLogin } from './DbLogin';
import '../ssh/ssh.css';
import './db.css';

/** The texts of the TLS modes: prefer and require encrypt but do not check the certificate. */
export const TLS_LABELS: Record<DbTlsMode, MessageKey> = {
  disable: 'Bez TLS',
  prefer: 'TLS, jeśli serwer obsługuje (bez weryfikacji certyfikatu)',
  require: 'Wymagaj TLS (bez weryfikacji certyfikatu)',
  'verify-full': 'Wymagaj TLS i sprawdzaj certyfikat (plik CA, nazwa hosta)',
};

export function DbConnectionEditor({ connectionId, kind: initialKind }: { connectionId?: string; kind?: DbKind }) {
  const { tr } = useI18n();
  const connection = useStore((st) => st.s.dbConnections.find((c) => c.id === connectionId));
  const all = useStore((st) => st.s.dbConnections);
  const hosts = useStore((st) => st.s.sshHosts);
  const vault = useDbStore((st) => st.vault);
  const groups = useMemo(() => [...new Set(all.map((c) => c.group).filter((g): g is string => !!g))].sort(), [all]);
  const [draft, setDraft] = useState<DbConnectionDraft>(() => dbConnectionToDraft(connection, connection?.kind ?? initialKind ?? 'postgres'));
  const [errors, setErrors] = useState<Partial<Record<DbDraftField, MessageKey>>>({});
  const [password, setPassword] = useState('');
  const [changePassword, setChangePassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<DbTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = !!connection && !!vault?.saved.includes(connection.id) && !clearPassword;
  const locked = !!connection && !!vault?.locked.includes(connection.id);
  const testSession = useDbStore((st) => (testing ? Object.values(st.sessions).find((s) => s.test && st.prompts[s.id])?.id ?? null : null));
  const set = (patch: Partial<DbConnectionDraft>) => { setDraft((d) => ({ ...d, ...patch })); setTest(null); };
  const setKind = (kind: DbKind) => set({
    kind,
    port: draft.port === String(DB_DEFAULT_PORT[draft.kind]) || !draft.port ? String(DB_DEFAULT_PORT[kind]) : draft.port,
    sshDbPort: draft.sshDbPort === String(DB_DEFAULT_PORT[draft.kind]) || !draft.sshDbPort ? String(DB_DEFAULT_PORT[kind]) : draft.sshDbPort,
    user: kind === 'redis' && draft.user === 'postgres' ? '' : kind === 'postgres' && !draft.user ? 'postgres' : draft.user,
    tls: kind === 'redis' && draft.tls === 'prefer' ? 'disable' : draft.tls,
  });
  const field = (name: DbDraftField) => errors[name] && <div className="ssh-error" role="alert">{tr(errors[name]!)}</div>;
  const typedPassword = (changePassword || !saved) && password ? password : null;

  const validate = () => {
    const r = validateDbDraft(draft);
    if (!r.ok) { setErrors(r.errors); return null; }
    setErrors({});
    return r.value;
  };
  const runTest = async () => {
    const value = validate();
    if (!value) return;
    setTesting(true);
    setTest(null);
    try {
      const pw = typedPassword !== null ? { set: typedPassword } : saved && connection ? { saved: connection.id } : null;
      setTest(await window.mc.db.testConnection(value, pw));
    } finally { setTesting(false); }
  };
  const save = async () => {
    const value = validate();
    if (!value || saving) return;
    const change: DbPasswordChange = typedPassword !== null ? { set: typedPassword } : clearPassword ? { clear: true } : { keep: true };
    setSaving(true);
    const r = await window.mc.db.saveConnection(connection ? { ...value, id: connection.id } : value, change);
    setSaving(false);
    if (!r.ok) { toast(tr(r.error === 'readOnly' ? 'Magazyn haseł baz danych jest tylko do odczytu' : 'Nie udało się zapisać zmian'), 'error'); return; }
    setPassword('');
    closeModal();
  };
  const pickCa = async () => { const path = await window.mc.dbPickCaFile(); if (path) set({ caPath: path }); };
  const tunnel = draft.sshHostId !== null;

  return (
    <div className="modal db-editor" role="dialog" aria-label={connection ? connection.name : tr('Nowe połączenie')}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }}>
      <div className="modal-head">
        <h3>{connection ? connection.name : tr('Nowe połączenie')}</h3>
        <button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={closeModal}><IX /></button>
      </div>
      <form className="modal-body ssh-editor db-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="ssh-row">
          <label className="ssh-field"><span>{tr('Typ')}</span>
            <Select className="select" value={draft.kind} data-field="kind" disabled={!!connection} onChange={(e) => setKind(e.target.value as DbKind)}>
              <option value="postgres">PostgreSQL</option>
              <option value="redis">Redis</option>
            </Select>
          </label>
          <label className="ssh-field grow"><span>{tr('Nazwa')}</span>
            <input className="input" data-field="name" value={draft.name} maxLength={80} placeholder={draft.sshHostId ? draft.sshDbHost : draft.host} onChange={(e) => set({ name: e.target.value })} />
          </label>
        </div>
        <div className="ssh-row">
          <label className="ssh-field grow"><span>{tr('Grupa')}</span>
            <input className="input" list="db-groups" data-field="group" value={draft.group} maxLength={60} onChange={(e) => set({ group: e.target.value })} />
            <datalist id="db-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </label>
          <div className="ssh-field"><span>{tr('Kolor')}</span>
            <div className="ssh-row"><ColorPicker value={draft.color ?? '#60a5fa'} label={tr('Kolor')} onChange={(color) => set({ color })} />
              {draft.color && <button type="button" className="btn small ghost" onClick={() => set({ color: undefined })}>{tr('Usuń kolor')}</button>}</div>
          </div>
        </div>

        <div className="ssh-section">
          <label className="ssh-field"><span>{tr('Połącz przez SSH')}</span>
            <Select className="select" value={draft.sshHostId ?? ''} aria-label={tr('Połącz przez SSH')} onChange={(e) => set({ sshHostId: e.target.value || null })}>
              <option value="">{tr('Bez tunelu SSH (połączenie bezpośrednie)')}</option>
              {hosts.map((h) => <option key={h.id} value={h.id}>{`${h.label} (${h.username}@${h.address})`}</option>)}
            </Select>
            {!hosts.length && <span className="ssh-card-hint">{tr('Najpierw dodaj host w widoku SSH')}</span>}
          </label>
          {tunnel ? (
            <>
              <div className="ssh-row">
                <label className="ssh-field grow"><span>{tr('Adres bazy widziany z serwera')}</span>
                  <input className="input" data-field="sshDbHost" value={draft.sshDbHost} spellCheck={false} onChange={(e) => set({ sshDbHost: e.target.value })} />{field('sshDbHost')}
                </label>
                <label className="ssh-field port"><span>{tr('Port')}</span>
                  <input className="input" data-field="sshDbPort" value={draft.sshDbPort} inputMode="numeric" onChange={(e) => set({ sshDbPort: e.target.value })} />{field('sshDbPort')}
                </label>
              </div>
              <span className="ssh-card-hint">{tr('Zwykle 127.0.0.1: baza słucha tylko na serwerze, a połączenie idzie tunelem SSH.')}</span>
            </>
          ) : (
            <div className="ssh-row">
              <label className="ssh-field grow"><span>{tr('Host')}</span>
                <input className="input" data-field="host" value={draft.host} spellCheck={false} onChange={(e) => set({ host: e.target.value })} />{field('host')}
              </label>
              <label className="ssh-field port"><span>{tr('Port')}</span>
                <input className="input" data-field="port" value={draft.port} inputMode="numeric" placeholder={String(DB_DEFAULT_PORT[draft.kind])} onChange={(e) => set({ port: e.target.value })} />{field('port')}
              </label>
            </div>
          )}
        </div>

        <div className="ssh-section">
          <div className="ssh-row">
            <label className="ssh-field grow"><span>{tr('Użytkownik')}</span>
              <input className="input" data-field="user" value={draft.user} spellCheck={false} placeholder={draft.kind === 'redis' ? 'default' : ''} onChange={(e) => set({ user: e.target.value })} />{field('user')}
            </label>
            {draft.kind === 'postgres' ? (
              <label className="ssh-field grow"><span>{tr('Baza danych')}</span>
                <input className="input" data-field="database" value={draft.database} spellCheck={false} placeholder="postgres" onChange={(e) => set({ database: e.target.value })} />{field('database')}
              </label>
            ) : (
              <label className="ssh-field port"><span>{tr('Numer bazy')}</span>
                <input className="input" data-field="dbIndex" value={draft.dbIndex} inputMode="numeric" onChange={(e) => set({ dbIndex: e.target.value })} />{field('dbIndex')}
              </label>
            )}
          </div>
          <div className="ssh-field"><span>{tr('Hasło')}</span>
            {locked && <div className="ssh-card-hint">{tr('Nie można odczytać tego sekretu na tym komputerze. Usuń go i dodaj ponownie.')}</div>}
            {saved && !changePassword ? (
              <div className="ssh-row">
                <span className="db-saved-pw" data-field="passwordSaved">{tr('Hasło zapisane')}</span>
                <button type="button" className="btn small" onClick={() => setChangePassword(true)}>{tr('Zmień')}</button>
                <button type="button" className="btn small ghost" onClick={() => { setClearPassword(true); setPassword(''); }}>{tr('Usuń hasło')}</button>
              </div>
            ) : (
              <input className="input" type="password" data-field="password" autoComplete="off" value={password} maxLength={4096}
                placeholder={tr('Puste: zapytamy przy łączeniu')} onChange={(e) => { setPassword(e.target.value); setTest(null); }} />
            )}
            {vault?.storage === 'unavailable' && <span className="ssh-card-hint">{tr('Bezpieczne przechowywanie haseł jest niedostępne na tym komputerze - hasło nie zostanie zapisane')}</span>}
          </div>
        </div>

        <div className="ssh-section">
          <label className="ssh-field"><span>{tr('TLS')}</span>
            <Select className="select" value={draft.tls} data-field="tls" onChange={(e) => set({ tls: e.target.value as DbTlsMode })}>
              {DB_TLS_MODES.map((m) => <option key={m} value={m}>{tr(TLS_LABELS[m])}</option>)}
            </Select>
          </label>
          {draft.tls === 'verify-full' && (
            <label className="ssh-field"><span>{tr('Certyfikat CA')}</span>
              <div className="ssh-row">
                <input className="input grow mono" data-field="caPath" value={draft.caPath} spellCheck={false} onChange={(e) => set({ caPath: e.target.value })} />
                <button type="button" className="btn small" onClick={() => void pickCa()}>{tr('Wybierz plik…')}</button>
              </div>{field('caPath')}
            </label>
          )}
        </div>

        <div className="ssh-section">
          <label className="check"><input type="checkbox" data-field="readOnly" checked={draft.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />{tr('Tylko do odczytu')}</label>
          <span className="ssh-card-hint">{tr('Bez edycji danych i bez zapytań zmieniających dane (chyba że jednorazowo na to pozwolisz).')}</span>
          {draft.kind === 'postgres' && (
            <label className="ssh-field port db-timeout"><span>{tr('Limit czasu zapytania (s)')}</span>
              <input className="input" data-field="statementTimeout" value={draft.statementTimeout} inputMode="decimal" placeholder={tr('serwera')} onChange={(e) => set({ statementTimeout: e.target.value })} />{field('statementTimeout')}
            </label>
          )}
        </div>

        {testing && <DbLogin sessionId={testSession} />}
        {test && (test.ok
          ? <div className="db-test ok" role="status" data-test="ok">{tr('Połączenie działa')}{test.serverVersion ? ` · ${test.serverVersion}` : ''} · {test.timeMs} ms</div>
          : <div className="db-test error" role="alert" data-test="error">{dbErrorMessage(test.error, test.message, connection?.id)}</div>)}
      </form>
      <div className="modal-foot">
        <button type="button" className="btn" data-action="test" disabled={testing} onClick={() => void runTest()}>{testing ? tr('Testowanie…') : tr('Testuj połączenie')}</button>
        <span className="grow" />
        <button type="button" className="btn" onClick={closeModal}>{tr('Anuluj')}</button>
        <button type="button" className="btn primary" data-action="save" disabled={saving} onClick={() => void save()}>{tr('Zapisz')}</button>
      </div>
    </div>
  );
}
