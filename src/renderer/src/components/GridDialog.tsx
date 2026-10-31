import { Select } from './Select';
import { RoleSelect } from './RoleSelect';
import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import {
  createLayout, describeLayout, layoutForCount, layoutFromRows, MAX_COLS, MAX_ROWS, mergeRect, rowCountsOf, unmergeAll, type GridLayout,
} from '../../../shared/layout';
import { ensureShellProfile, getProfile, uid, upsertPreset } from '../../../shared/state';
import { normalizeTemplateCell, TEMPLATE_LIMITS, templatesFor } from '../../../shared/gridTemplates';
import { cellSourcePatch, cellSourceValue, type SshHost } from '../../../shared/ssh';
import { CLI_NAMES, missingCli, missingClis, type CliStatusMap } from '../../../shared/cliStatus';
import { profileName, profileOptionLabel } from '../cliUi';
import type { PresetCell } from '../../../shared/types';
import { offerInstall, openTab, showCliInstructions } from '../actions';
import { askChoice, askText, closeModal, toast, update, useStore } from '../store';
import { deleteTemplate, resolveTemplateCells, templateMenuItems } from '../templates';
import { openMenu, openMenuAt } from './ContextMenu';
import { IChevron, ISnippet, IX } from './icons';

const QUICK = [1, 2, 4, 6, 9, 12];
const ROW_TEMPLATES = [[2, 1], [1, 2], [3, 2], [2, 3], [3, 1], [1, 3], [4, 2], [2, 2, 1]];

export function GridDialog({ projectId }: { projectId: string }) {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const project = s.projects.find((p) => p.id === projectId);
  const defaultProfile = s.settings.lastProfileId;
  const hosts = s.sshHosts;
  const shellProfileId = ensureShellProfile(s).profileId;
  const [layout, setLayout] = useState<GridLayout>(createLayout(2, 2));
  const [cells, setCells] = useState<PresetCell[]>(() => Array.from({ length: 20 }, () => ({ profileId: defaultProfile, worktree: false })));
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  // The first "create" with a missing CLI only arms the banner; the second one creates the grid anyway.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (project) void window.mc.isGitRepo(project.path).then(setIsRepo);
  }, [project?.path]);
  const usedProfiles = cells.slice(0, layout.areas.length).map((cell) => getProfile(s, cell.profileId));
  const lacking = missingClis(usedProfiles, cliStatus);
  const lackingCells = usedProfiles.filter((profile) => missingCli(profile, cliStatus)).length;
  const lackingKey = lacking.join();
  useEffect(() => setArmed(false), [lackingKey]);

  if (!project) return null;
  const presets = templatesFor(s.presets, projectId);
  const snippets = s.snippets.filter((x) => !x.projectId || x.projectId === projectId);
  const n = layout.areas.length;

  const pickSize = (c: number, r: number) => {
    setLayout(createLayout(c, r));
    setSelected(new Set());
  };
  const setCell = (i: number, patch: Partial<PresetCell>) => setCells((cs) => cs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  /** Prompt and worktree do not apply to SSH cells (spec 10.4), so bulk changes of them skip those cells. */
  const setAllAgents = (patch: Partial<PresetCell>) => setCells((cs) => cs.map((x) => (x.sshHostId ? x : { ...x, ...patch })));
  const sourcePatch = (value: string, previous?: PresetCell): Partial<PresetCell> => cellSourcePatch(value, previous, hosts, shellProfileId);

  const merge = () => {
    const areas = [...selected].map((i) => layout.areas[i]);
    if (areas.length < 2) return;
    const col = Math.min(...areas.map((a) => a.col));
    const row = Math.min(...areas.map((a) => a.row));
    setLayout(mergeRect(layout, {
      col, row,
      colSpan: Math.max(...areas.map((a) => a.col + a.colSpan)) - col,
      rowSpan: Math.max(...areas.map((a) => a.row + a.rowSpan)) - row,
    }));
    setSelected(new Set());
  };

  const open = () => {
    if (lackingCells > 0 && !armed) { setArmed(true); return; }
    closeModal();
    if (cells.slice(0, n).some((c) => c.sshHostId)) update((st) => ensureShellProfile(st).s);
    // 1.1.1: cell folders are relative to the project root (or absolute); a missing one falls back to the root with a note.
    const tabName = name.trim() || undefined;
    void resolveTemplateCells(project.path, cells.slice(0, n)).then((resolved) => openTab(projectId, layout, resolved, tabName));
  };

  const savePreset = async () => {
    const presetName = await askText(tr('Nazwa szablonu'), name || `${describeLayout(layout)} ${cells[0].sshHostId ? tr('SSH') : profileName(getProfile(s, cells[0].profileId), tr)}`);
    if (!presetName?.trim()) return;
    const scope = await askChoice(tr('Gdzie zapisać szablon?'), tr('Szablon globalny jest dostępny we wszystkich projektach.'), [
      { label: tr("Tylko ten projekt"), value: 'project' },
      { label: tr("Globalnie"), value: 'global', primary: true },
    ]);
    if (!scope) return;
    if (s.presets.length >= TEMPLATE_LIMITS.count) { toast(tr('Osiągnięto limit szablonów ({count}). Usuń któryś, żeby zapisać nowy.', { count: TEMPLATE_LIMITS.count }), 'error'); return; }
    const saved = cells.slice(0, n).map((c) => normalizeTemplateCell(c) ?? { profileId: c.profileId, worktree: false });
    const preset = { id: uid(), name: presetName.trim().slice(0, TEMPLATE_LIMITS.name), layout, cells: saved, ...(scope === 'project' ? { projectId } : {}) };
    update((st) => upsertPreset(st, preset));
  };

  const loadPreset = (id: string) => {
    const p = s.presets.find((x) => x.id === id);
    if (!p) return;
    setLayout(p.layout);
    // A preset can name a host that was deleted since: that cell becomes a plain shell cell here.
    const known = (c: PresetCell): PresetCell => (c.sshHostId && !hosts.some((h) => h.id === c.sshHostId) ? { ...c, sshHostId: undefined } : c);
    setCells((cs) => cs.map((x, i) => (p.cells[i] ? known(p.cells[i]) : { ...x, name: undefined, prompt: undefined, dir: undefined, muted: undefined })));
    setSelected(new Set());
    if (!name.trim()) setName(p.name);
  };

  const hc = hover?.c ?? (layout.rowCounts ? 0 : layout.cols);
  const hr = hover?.r ?? (layout.rowCounts ? 0 : layout.rows);
  const rows = rowCountsOf(layout);
  const setRows = (next: number[]) => {
    setLayout(layoutFromRows(next));
    setSelected(new Set());
  };

  return (
    <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h3>{tr('Nowy grid')} · {project.name}</h3>
        <button className="btn ghost icon" onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <div className="presets">
          {QUICK.map((q) => (
            <button key={q} className="btn small" onClick={() => { setLayout(layoutForCount(q)); setSelected(new Set()); }}>
              {describeLayout(layoutForCount(q))}
            </button>
          ))}
          <span className="muted" style={{ alignSelf: 'center', margin: '0 4px' }}>·</span>
          {ROW_TEMPLATES.map((t) => (
            <button key={t.join('+')} className={`btn small ${describeLayout(layout) === t.join('+') ? 'primary' : ''}`} onClick={() => setRows(t)} title={tr("Rzędy o różnej liczbie komórek")}>
              {t.join('+')}
            </button>
          ))}
          {presets.length > 0 && <span className="muted" style={{ alignSelf: 'center', margin: '0 4px' }}>·</span>}
          {presets.map((p) => (
            <span key={p.id} className="btn small grid-template-chip" onClick={() => loadPreset(p.id)}
              onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, templateMenuItems(p, projectId)); }}
              title={`${p.projectId ? tr('Szablon projektu') : tr('Szablon globalny')} · ${describeLayout(p.layout)}\n${tr('Kliknij, aby wczytać · prawy klik: zmień nazwę, zaktualizuj, usuń')}`}>
              {p.name}
              <span onClick={(e) => { e.stopPropagation(); void deleteTemplate(p.id); }} title={tr('Usuń szablon')} style={{ opacity: 0.6, display: 'grid' }}>
                <IX />
              </span>
            </span>
          ))}
        </div>

        <div className="grid-dialog">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <div className="picker" onMouseLeave={() => setHover(null)}>
              {Array.from({ length: MAX_ROWS }, (_, r) =>
                Array.from({ length: MAX_COLS }, (_, c) => (
                  <div key={`${c}-${r}`} className={`f ${c < hc && r < hr ? 'on' : ''}`}
                    onMouseEnter={() => setHover({ c: c + 1, r: r + 1 })} onClick={() => pickSize(c + 1, r + 1)} />
                )),
              )}
            </div>
            <div className="big-size">{hover ? `${hover.c} × ${hover.r}` : describeLayout(layout).replace('×', ' × ')}</div>
            <div className="row">
              <button className="btn small" disabled={selected.size < 2} onClick={merge}>{tr("Scal")}</button>
              <button className="btn small" onClick={() => setLayout(unmergeAll(layout))}>{tr("Rozdziel")}</button>
              <button className="btn small" onClick={() => setSelected(new Set())}>{tr("Wyczyść")}</button>
            </div>
            <div className="muted" style={{ fontSize: 11, textAlign: 'center' }}>{tr("Kliknij komórki w podglądzie, żeby zaznaczyć je do scalenia.")}</div>
            <div className="row-editor">
              <div className="section-title" style={{ margin: 0 }}>{tr("Rzędy")}</div>
              {rows.map((count, r) => (
                <div key={r} className="re-row">
                  <span className="muted">{tr('Rząd {number}', { number: r + 1 })}</span>
                  <span className="stepper">
                    <button onClick={() => setRows(rows.map((x, j) => (j === r ? Math.max(1, x - 1) : x)))} disabled={count <= 1}>−</button>
                    <b>{count}</b>
                    <button onClick={() => setRows(rows.map((x, j) => (j === r ? Math.min(MAX_COLS, x + 1) : x)))} disabled={count >= MAX_COLS}>+</button>
                  </span>
                  <button className="re-del" title={tr("Usuń rząd")} disabled={rows.length <= 1} onClick={() => setRows(rows.filter((_, j) => j !== r))}><IX /></button>
                </div>
              ))}
              {rows.length < MAX_ROWS && (
                <button className="btn small ghost" onClick={() => setRows([...rows, rows[rows.length - 1] ?? 1])}>{tr("+ dodaj rząd")}</button>
              )}
            </div>
          </div>

          <div className="preview" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0,1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0,1fr))` }}>
            {layout.areas.map((a, i) => {
              const prof = getProfile(s, cells[i].profileId);
              const sshHost = cells[i].sshHostId ? hosts.find((h) => h.id === cells[i].sshHostId) : undefined;
              return (
                <div
                  key={i}
                  className={`pc ${selected.has(i) ? 'sel' : ''}`}
                  style={{ gridColumn: `${a.col + 1} / span ${a.colSpan}`, gridRow: `${a.row + 1} / span ${a.rowSpan}`, cursor: 'pointer' }}
                  onClick={() => setSelected((sel) => {
                    const next = new Set(sel);
                    next.has(i) ? next.delete(i) : next.add(i);
                    return next;
                  })}
                >
                  <div className="pc-head">
                    <span className="n">{i + 1}</span>
                    <span className="nm">{cells[i].name || sshHost?.label || tr('Komórka {number}', { number: i + 1 })}</span>
                    <span className="pill" style={{ color: prof.color, background: prof.color + '1f' }}>{cells[i].sshHostId ? tr('SSH') : profileName(prof, tr)}</span>
                  </div>
                  <div className="pc-body">
                    {cells[i].prompt && prof.cli !== 'shell' && !cells[i].sshHostId ? (
                      <span className="pc-prompt">› {cells[i].prompt}</span>
                    ) : (
                      <>
                        <span className="ln" style={{ width: '62%' }} />
                        <span className="ln" style={{ width: '40%' }} />
                      </>
                    )}
                    {cells[i].worktree && !cells[i].sshHostId && <span className="pc-wt">⎇ worktree</span>}
                    {cells[i].dir && !cells[i].worktree && !cells[i].sshHostId && <span className="pc-wt grid-template-dir" title={cells[i].dir}>{cells[i].dir}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <span className="section-title" style={{ margin: 0, flex: 1 }}>{tr("Komórki")}</span>
          <Select className="select" value="" onChange={(e) => e.target.value && setCells((cs) => cs.map((x) => ({ ...x, ...sourcePatch(e.target.value, x) })))}>
            <option value="">{tr("profil dla wszystkich…")}</option>
            {s.profiles.map((p) => <option key={p.id} value={p.id}>{profileOptionLabel(p, cliStatus, tr)}</option>)}
            {hosts.length > 0 && <option value="#ssh" disabled>{tr('Hosty SSH')}</option>}
            {hosts.map((h) => <option key={h.id} value={`ssh:${h.id}`}>{h.label}</option>)}
          </Select>
          {snippets.length > 0 && (
            <button className="btn" onClick={(e) => openMenuAt(e.currentTarget, [
              { header: tr("Prompt startowy dla wszystkich") },
              ...snippets.map((sn) => ({ label: sn.name, onClick: () => setAllAgents({ prompt: sn.text }) })),
              { sep: true as const },
              { label: tr("Wyczyść prompty"), onClick: () => setAllAgents({ prompt: undefined }) },
            ])}>
              <ISnippet />  {tr("Prompt dla wszystkich")} <IChevron />
            </button>
          )}
          {isRepo && <label className="check"><input type="checkbox" onChange={(e) => setAllAgents({ worktree: e.target.checked })} />  {tr("worktree dla wszystkich")}</label>}
        </div>

        <div className="cell-table">
          <span className="hd" />
          <span className="hd">{tr("Nazwa")}</span>
          <span className="hd">{tr("Profil")}</span>
          <span className="hd">{tr('Rola / MCP')}</span>
          <span className="hd">{tr("Prompt startowy")}</span>
          <span className="hd" title={tr('Folder startowy: względny do katalogu projektu albo ścieżka bezwzględna')}>{tr('Folder')}</span>
          <span className="hd">{isRepo ? 'Worktree' : ''}</span>
          {layout.areas.map((_, i) => (
            <CellRow
              key={i}
              index={i}
              cell={cells[i]}
              profiles={s.profiles}
              cliStatus={cliStatus}
              snippets={snippets}
              isRepo={!!isRepo}
              hosts={hosts}
              onChange={(patch) => setCell(i, patch)}
              onSource={(value) => setCells((cs) => cs.map((x, j) => (j === i ? { ...x, ...sourcePatch(value, x) } : x)))}
            />
          ))}
        </div>

        <input className="input" placeholder={tr("Nazwa zakładki (opcjonalnie)")} value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && open()} />
        {lacking.length > 0 && (
          <div className={`cli-banner ${armed ? 'armed' : ''}`} role="alert">
            <span className="grow">
              {tr('Brak w systemie: {names}. Komórki ({count}) pokażą ekran instalacji zamiast terminala.', { names: lacking.map((cli) => CLI_NAMES[cli]).join(', '), count: lackingCells })}
              {armed && <> <b>{tr('Zainstaluj albo kliknij ponownie, aby mimo to utworzyć grid.')}</b></>}
            </span>
            {lacking.map((cli) => (
              <span key={cli} className="row" style={{ gap: 6 }}>
                <button className="btn small primary" onClick={() => offerInstall(cli)}>{tr('Zainstaluj')}{lacking.length > 1 ? ` ${CLI_NAMES[cli]}` : ''}</button>
                <button className="btn small" onClick={() => showCliInstructions(cli)}>{tr('Pokaż instrukcję')}{lacking.length > 1 ? ` ${CLI_NAMES[cli]}` : ''}</button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => void savePreset()}>{tr('Zapisz jako szablon…')}</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>{tr("Anuluj")}</button>
        <button className="btn white" onClick={open}>{armed && lackingCells > 0 ? tr('Utwórz mimo to ({count})', { count: n }) : tr('Otwórz grid ({count})', { count: n })}</button>
      </div>
    </div>
  );
}

function CellRow({ index, cell, profiles, hosts, cliStatus, snippets, isRepo, onChange, onSource }: {
  index: number;
  cell: PresetCell;
  profiles: Array<{ id: string; name: string; cli: 'claude' | 'codex' | 'shell' }>;
  hosts: SshHost[];
  cliStatus: CliStatusMap;
  snippets: Array<{ id: string; name: string; text: string }>;
  isRepo: boolean;
  onChange: (patch: Partial<PresetCell>) => void;
  onSource: (value: string) => void;
}) {
  const { tr } = useI18n();
  const isSsh = !!cell.sshHostId;
  const isShell = isSsh || profiles.find((p) => p.id === cell.profileId)?.cli === 'shell';
  return (
    <>
      <span className="num">{index + 1}</span>
      <input className="input" placeholder={tr("np. backend")} value={cell.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} />
      <Select className="select" value={cellSourceValue(cell)} onChange={(e) => onSource(e.target.value)}>
        {profiles.map((p) => <option key={p.id} value={p.id}>{profileOptionLabel(p, cliStatus, tr)}</option>)}
        {hosts.length > 0 && <option value="#ssh" disabled>{tr('Hosty SSH')}</option>}
        {hosts.map((h) => <option key={h.id} value={`ssh:${h.id}`}>{h.label}</option>)}
      </Select>
      {isSsh ? <span /> : <RoleSelect value={cell.role} disabled={isShell} onChange={(role) => onChange({ role })} />}
      {isSsh ? <span /> : (
        <span className="prompt-wrap">
          <input
            className="input"
            disabled={isShell}
            placeholder={isShell ? tr("nie dotyczy PowerShella") : tr("pierwsza wiadomość dla agenta (opcjonalnie)")}
            value={isShell ? '' : (cell.prompt ?? '')}
            title={cell.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
          {!isShell && snippets.length > 0 && (
            <button className="btn snip-btn" title={tr("Wstaw snippet")} onClick={(e) => openMenuAt(e.currentTarget, [
              { header: tr("Wstaw snippet") },
              ...snippets.map((sn) => ({ label: sn.name, onClick: () => onChange({ prompt: sn.text }) })),
            ])}>
              <ISnippet />  {tr("Snippet")} <IChevron />
            </button>
          )}
        </span>
      )}
      {isSsh ? <span /> : (
        <input className="input" placeholder={tr('katalog projektu')} value={cell.worktree ? '' : (cell.dir ?? '')} disabled={cell.worktree}
          title={cell.worktree ? tr('Komórka z worktree startuje w swoim worktree') : tr('Folder startowy: względny do katalogu projektu albo ścieżka bezwzględna')}
          onChange={(e) => onChange({ dir: e.target.value || undefined })} />
      )}
      <span className="wt">{isRepo && !isSsh && <input type="checkbox" checked={cell.worktree} onChange={(e) => onChange({ worktree: e.target.checked })} />}</span>
    </>
  );
}
