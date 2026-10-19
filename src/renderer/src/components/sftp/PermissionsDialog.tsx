// "Uprawnienia…" of the remote pane (0.9.9): an octal field and an owner/group/others x read/write/execute grid kept in sync
// both ways, the special bits, a symbolic preview, and for folders "Zastosuj do zawartości" with one value for folders and one
// for files (with the counts from the server before anything changes). A mixed selection shows the common bits; a bit that
// differs is indeterminate and stays as it is per entry until it is clicked.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  commonMode, modeFromPermissions, octalMode, parseOctalMode, PERM_MASK, sftpErrorText,
  type ChmodCount, type ChmodResult,
} from '../../../../shared/sftp';
import { PERM_GRID, SPECIAL_BITS, symbolicPreview, toggleModeBit, type PaneEntry } from '../../../../shared/sftpView';
import type { MessageKey } from '../../../../shared/i18n';
import { useI18n } from '../../i18n';
import { toast } from '../../store';
import { useSftpStore } from '../../sftpStore';
import { IX } from '../icons';

const WHO: Record<'owner' | 'group' | 'others', MessageKey> = { owner: 'Właściciel', group: 'Grupa', others: 'Inni' };
const RIGHTS: MessageKey[] = ['Odczyt', 'Zapis', 'Wykonanie'];
const SPECIAL_LABELS: MessageKey[] = ['setuid', 'setgid', 'sticky'];

function Check({ checked, indeterminate, disabled, label, onChange }: { checked: boolean; indeterminate: boolean; disabled?: boolean; label: string; onChange(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked && !indeterminate} disabled={disabled} onChange={onChange} />;
}

export function PermissionsDialog({ sessionId, entries, onClose }: { sessionId: string; entries: PaneEntry[]; onClose(changed: boolean): void }) {
  const { tr } = useI18n();
  const initial = useMemo(() => {
    const modes = entries.map((e) => modeFromPermissions(e.permissions)).filter((m): m is number => m !== null);
    const common = commonMode(modes);
    return { bits: common.bits, mask: modes.length ? PERM_MASK & ~common.mixed : 0 };
  }, [entries]);
  const [state, setState] = useState(initial);
  const [octal, setOctal] = useState(() => (initial.mask === PERM_MASK ? octalMode(initial.bits) : ''));
  const [octalError, setOctalError] = useState(false);
  const hasFolders = entries.some((e) => e.kind === 'dir');
  const [recursive, setRecursive] = useState(false);
  const [dirText, setDirText] = useState('755');
  const [fileText, setFileText] = useState('644');
  const [count, setCount] = useState<ChmodCount | null | 'loading' | 'error'>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<ChmodResult | null>(null);
  const progress = useSftpStore((st) => (running ? st.opProgress[running] : undefined));
  const errorText = (code: Parameters<typeof sftpErrorText>[0]) => { const t = sftpErrorText(code); return tr(t.key, t.params); };

  // The counts of a recursive change come from the server before anything changes.
  useEffect(() => {
    if (!recursive) { setCount(null); return; }
    let live = true;
    setCount('loading');
    void window.mc.sftp.chmodCount(sessionId, entries.map((e) => e.path), true).then((r) => { if (live) setCount(r.ok ? r.value : 'error'); }, () => { if (live) setCount('error'); });
    return () => { live = false; };
  }, [recursive, sessionId, entries]);

  const setFromGrid = (next: { bits: number; mask: number }) => {
    setState(next);
    setOctal(next.mask === PERM_MASK ? octalMode(next.bits) : '');
    setOctalError(false);
  };
  const onOctal = (text: string) => {
    setOctal(text);
    const v = parseOctalMode(text);
    setOctalError(text.trim() !== '' && v === null);
    if (v !== null) setState({ bits: v, mask: PERM_MASK });
  };
  const dirMode = parseOctalMode(dirText), fileMode = parseOctalMode(fileText);
  const canApply = !running && !result && (recursive ? dirMode !== null && fileMode !== null && typeof count === 'object' && count !== null : state.mask !== 0 && !octalError);

  const apply = async () => {
    if (!canApply) return;
    const opId = crypto.randomUUID();
    setRunning(opId);
    const r = await window.mc.sftp.chmod(sessionId, {
      paths: entries.map((e) => e.path), opId,
      set: recursive ? null : { bits: state.bits, mask: state.mask },
      recursive: recursive ? { dirMode: dirMode!, fileMode: fileMode! } : null,
    }).catch(() => ({ ok: false as const, error: 'failed' as const }));
    useSftpStore.setState((st) => { const { [opId]: _gone, ...rest } = st.opProgress; return { opProgress: rest }; });
    setRunning(null);
    if (!r.ok) { toast(errorText(r.error), 'error'); return; }
    if (!r.value.errors.length && !r.value.cancelled) { toast(tr('Zmieniono uprawnienia: {count}', { count: r.value.changed }), 'info'); onClose(true); return; }
    setResult(r.value);
  };
  const cancel = () => {
    if (running) { void window.mc.sftp.cancelOp(sessionId, running); return; }
    onClose(!!result);
  };

  const title = entries.length === 1 ? tr('Uprawnienia: {name}', { name: entries[0].name }) : tr('Uprawnienia ({count} elementów)', { count: entries.length });
  const gridDisabled = recursive || !!running || !!result;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose(!!result); }}>
      <div className="modal sftp-perms" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); cancel(); } if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') { e.preventDefault(); void apply(); } }}>
        <div className="modal-head"><h3>{title}</h3><button type="button" className="btn ghost icon" aria-label={tr('Zamknij')} disabled={!!running} onClick={() => onClose(!!result)}><IX /></button></div>
        <div className="modal-body">
          <div className={`sftp-perms-main${gridDisabled ? ' off' : ''}`}>
            <label className="sftp-perms-octal">
              <span>{tr('Wartość ósemkowa')}</span>
              <input className="input mono" data-field="octal" value={octal} maxLength={4} inputMode="numeric" spellCheck={false} disabled={gridDisabled} autoFocus
                placeholder={symbolicPreview(state.bits, state.mask).includes('?') ? '???' : undefined} onChange={(e) => onOctal(e.target.value)} />
              <code className="sftp-perms-symbolic" data-field="symbolic">{symbolicPreview(state.bits, state.mask)}</code>
            </label>
            {octalError && <div className="ssh-error" role="alert">{tr('Wpisz 3 lub 4 cyfry od 0 do 7, np. 644 lub 0755')}</div>}
            <table className="sftp-perms-grid">
              <thead><tr><th />{RIGHTS.map((r) => <th key={r}>{tr(r)}</th>)}</tr></thead>
              <tbody>
                {PERM_GRID.map((row) => (
                  <tr key={row.who} data-who={row.who}>
                    <th scope="row">{tr(WHO[row.who])}</th>
                    {row.bits.map((bit, i) => (
                      <td key={bit} title={(state.mask & bit) ? undefined : tr('Różne wartości w zaznaczeniu - pozostaną bez zmian')}>
                        <Check checked={(state.bits & bit) !== 0} indeterminate={(state.mask & bit) === 0} disabled={gridDisabled}
                          label={`${tr(WHO[row.who])} ${tr(RIGHTS[i])}`} onChange={() => setFromGrid(toggleModeBit(state, bit))} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sftp-perms-special">
              <span className="muted">{tr('Bity specjalne')}</span>
              {SPECIAL_BITS.map((bit, i) => (
                <label key={bit} className="check">
                  <Check checked={(state.bits & bit) !== 0} indeterminate={(state.mask & bit) === 0} disabled={gridDisabled} label={tr(SPECIAL_LABELS[i])} onChange={() => setFromGrid(toggleModeBit(state, bit))} />
                  <code>{tr(SPECIAL_LABELS[i])}</code>
                </label>
              ))}
            </div>
          </div>
          {hasFolders && (
            <div className="sftp-perms-recursive">
              <label className="check"><input type="checkbox" data-field="recursive" checked={recursive} disabled={!!running || !!result} onChange={(e) => setRecursive(e.target.checked)} /> {tr('Zastosuj do zawartości')}</label>
              {recursive && <>
                <p className="ssh-card-hint">{tr('Foldery i wszystko w nich: foldery dostaną pierwszą wartość, pliki drugą. Dowiązania są pomijane.')}</p>
                <div className="sftp-perms-masks">
                  <label><span>{tr('Foldery')}</span><input className="input mono" data-field="dirMode" value={dirText} maxLength={4} disabled={!!running || !!result} onChange={(e) => setDirText(e.target.value)} />
                    <code>{dirMode === null ? '' : symbolicPreview(dirMode, PERM_MASK)}</code></label>
                  <label><span>{tr('Pliki')}</span><input className="input mono" data-field="fileMode" value={fileText} maxLength={4} disabled={!!running || !!result} onChange={(e) => setFileText(e.target.value)} />
                    <code>{fileMode === null ? '' : symbolicPreview(fileMode, PERM_MASK)}</code></label>
                </div>
                {(dirMode === null || fileMode === null) && <div className="ssh-error" role="alert">{tr('Wpisz 3 lub 4 cyfry od 0 do 7, np. 644 lub 0755')}</div>}
                <div className="sftp-perms-count" data-field="count" role="status">
                  {count === 'loading' ? tr('Liczenie…') : count === 'error' ? tr('Operacja nie powiodła się') : count ? <>
                    {tr('Zostanie zmienionych: folderów {dirs}, plików {files}', { dirs: count.dirs, files: count.files })}
                    {count.links > 0 && <span className="muted"> · {tr('Dowiązania są pomijane')}</span>}
                  </> : null}
                </div>
              </>}
            </div>
          )}
          {running && (
            <div className="sftp-perms-progress" role="status">
              {tr('Zmienianie uprawnień… {done} z {total}', { done: progress?.done ?? 0, total: progress?.total ?? 0 })}
              <div className="sftp-progress"><span style={{ width: `${progress && progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0}%` }} /></div>
            </div>
          )}
          {result && (
            <div className="sftp-perms-result" role="alert">
              <div>{tr('Zmieniono uprawnienia: {count}', { count: result.changed })}{result.cancelled ? ` · ${tr('Przerwano po {count} zmianach', { count: result.changed })}` : ''}</div>
              {result.errors.length > 0 && <>
                <div className="sftp-error">{tr('Nie udało się zmienić uprawnień ({count})', { count: result.errors.length })}</div>
                <ul className="sftp-perms-errors">
                  {result.errors.map((e) => <li key={e.path}><code>{e.path}</code> <span className="muted">{errorText(e.error)}</span></li>)}
                </ul>
              </>}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={cancel}>{result ? tr('Zamknij') : tr('Anuluj')}</button>
          {!result && <button type="button" className="btn primary" disabled={!canApply} onClick={() => void apply()}>{tr('Zastosuj')}</button>}
        </div>
      </div>
    </div>
  );
}
