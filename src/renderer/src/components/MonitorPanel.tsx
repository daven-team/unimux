// The Monitor panel (1.0.6): what loads the computer. Every 2 s while the panel is mounted and the window visible, main takes one
// process snapshot; the app's own processes and each running cell's process tree (shell, agent, their children, the console
// host) are listed with CPU and memory, busiest first. A cell can be shown or restarted; a process of a cell's tree can be ended.
import { useEffect, useState } from 'react';
import { cellLabel } from '../../../shared/agentWork';
import { formatBytes, formatCpu, MONITOR_INTERVAL_MS, type MonitorAppRow, type MonitorCell, type MonitorRow, type MonitorSample } from '../../../shared/monitor';
import { findCell, getProfile } from '../../../shared/state';
import { shownProfileName } from '../../../shared/profiles';
import { focusCell, restartCell } from '../actions';
import { useI18n } from '../i18n';
import { askChoice, toast, useStore } from '../store';
import { IRestart, IView, IX } from './icons';
import { PanelEmpty } from './PanelEmpty';
import './monitorPanel.css';

/** Samples while mounted; a hidden window (minimized, another app in front on macOS) pauses until it is visible again. */
function useMonitorSample(): { sample: MonitorSample | null; failed: boolean; refresh: () => void } {
  const [sample, setSample] = useState<MonitorSample | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const tick = async () => {
      timer = undefined;
      if (stopped || running || document.hidden) return;
      running = true;
      const next = await window.mc.monitorSample().catch(() => null);
      running = false;
      if (stopped) return;
      if (next?.ok) { setSample(next); setFailed(false); } else setFailed(true);
      if (!document.hidden) timer = setTimeout(() => void tick(), MONITOR_INTERVAL_MS);
    };
    const onVisible = () => { if (!document.hidden && !timer) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [nonce]);
  return { sample, failed, refresh: () => setNonce((n) => n + 1) };
}

function Usage({ cpu, mem }: { cpu: number; mem: number }) {
  return (
    <>
      <span className={`monitor-cpu ${cpu >= 25 ? 'hot' : cpu >= 5 ? 'warm' : ''}`}>{formatCpu(cpu)}</span>
      <span className="monitor-mem">{formatBytes(mem)}</span>
    </>
  );
}

export function MonitorPanel() {
  const { tr } = useI18n();
  const { sample, failed, refresh } = useMonitorSample();
  const s = useStore((st) => st.s);
  const sessionTitles = useStore((st) => st.ui.sessionTitles);

  const appLabel = (row: MonitorAppRow): string => {
    switch (row.kind) {
      case 'main': return tr('Proces główny');
      case 'renderer': return tr('Okno aplikacji');
      case 'gpu': return tr('Grafika (GPU)');
      case 'ptyhost': return tr('Terminale (Pty Host)');
      case 'sftphost': return tr('SFTP (SFTP Host)');
      case 'dbhost': return tr('Bazy danych (DB Host)');
      case 'utility': return tr('Usługa: {name}', { name: row.name });
      default: return tr('Proces pomocniczy: {name}', { name: row.name });
    }
  };
  const cellInfo = (cellId: string) => {
    const found = findCell(s, cellId);
    if (!found) return null;
    // The grid and the cell's number tell apart cells with the same name (three "Wiersz polecenia" cells of one project).
    const name = cellLabel(found.cell, sessionTitles, shownProfileName(getProfile(s, found.cell.profileId), s.settings.shell, tr));
    const index = found.tab.cells.findIndex((c) => c.id === cellId) + 1;
    // 1.0.7: the grid first: in a narrow panel the project name (the same for most rows) is what gets cut off.
    return { label: `${index}. ${name}`, project: `${found.tab.name} · ${found.project.name}`, session: !!found.cell.session };
  };
  const kill = async (cell: MonitorCell, row: MonitorRow, label: string) => {
    const choice = await askChoice(
      tr('Zakończyć proces {name} (PID {pid})?', { name: row.name, pid: row.pid }),
      tr('Proces zostanie zamknięty od razu, bez zapisywania. Należy do komórki {cell}.', { cell: label }),
      [{ label: tr('Zakończ proces'), value: 'kill', danger: true }],
    );
    if (choice !== 'kill') return;
    if (!(await window.mc.monitorKill(row.pid))) toast(tr('Nie zakończono procesu: już nie działa albo nie należy do komórki.'), 'error');
    refresh();
  };

  if (!sample) {
    return (
      <div className="monitor" aria-busy={!failed}>
        <PanelEmpty><p>{failed ? tr('Nie udało się odczytać procesów.') : tr('Odczytuję procesy...')}</p></PanelEmpty>
      </div>
    );
  }
  const cells = sample.cells.flatMap((cell) => { const info = cellInfo(cell.cellId); return info ? [{ cell, info }] : []; });
  return (
    <div className="monitor">
      <div className="monitor-total" title={tr('Odświeżane co 2 s, gdy panel jest otwarty. 100% to cały procesor ({cores} rdzeni logicznych).', { cores: sample.cores })}>
        {tr('Razem: {cpu} CPU, {mem}', { cpu: formatCpu(sample.cpu), mem: formatBytes(sample.mem) })}
        {failed && <span className="monitor-stale"> · {tr('Nie udało się odczytać procesów.')}</span>}
      </div>
      <div className="monitor-scroll">
        <div className="monitor-section">{tr('Komórki')}</div>
        {!cells.length && <PanelEmpty><p>{tr('Żadna komórka nie jest uruchomiona.')}</p></PanelEmpty>}
        {cells.map(({ cell, info }) => (
          <div key={cell.cellId} className="monitor-cell" data-cell={cell.cellId}>
            <div className="monitor-cell-head">
              <div className="monitor-name">
                <span className="monitor-cell-label" title={info.label}>{info.label}</span>
                <span className="monitor-project" title={info.project}>{info.project}</span>
              </div>
              <Usage cpu={cell.cpu} mem={cell.mem} />
              <span className="monitor-actions">
                <button type="button" title={tr('Pokaż komórkę')} aria-label={tr('Pokaż komórkę')} onClick={() => focusCell(cell.cellId)}><IView /></button>
                <button type="button" title={tr('Uruchom ponownie')} aria-label={tr('Uruchom ponownie')} onClick={() => { restartCell(cell.cellId, info.session ? 'resume' : 'new'); refresh(); }}><IRestart /></button>
              </span>
            </div>
            {cell.rows.map((row) => (
              <div key={row.pid} className="monitor-row" title={`${row.name} · PID ${row.pid}`}>
                <span className="monitor-proc" style={{ paddingLeft: 8 + row.depth * 10 }}>{row.name}</span>
                <Usage cpu={row.cpu} mem={row.mem} />
                <span className="monitor-actions">
                  {!/^(openconsole|conhost)(\.exe)?$/i.test(row.name) && (
                    <button type="button" title={tr('Zakończ proces')} aria-label={`${tr('Zakończ proces')} ${row.name}`} onClick={() => void kill(cell, row, info.label)}><IX /></button>
                  )}
                </span>
              </div>
            ))}
          </div>
        ))}
        <div className="monitor-section">{tr('Aplikacja')}</div>
        {sample.app.map((row) => (
          <div key={row.pid} className="monitor-row app" title={`${row.name} · PID ${row.pid}`}>
            <span className="monitor-proc">{appLabel(row)}</span>
            <Usage cpu={row.cpu} mem={row.mem} />
            <span className="monitor-actions" />
          </div>
        ))}
      </div>
    </div>
  );
}
