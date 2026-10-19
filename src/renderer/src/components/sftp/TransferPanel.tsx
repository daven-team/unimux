// The transfer queue at the bottom of the SFTP view (0.9.8): overall progress, then one row per file with direction, bytes,
// percent, speed and Cancel / Retry / the conflict question. Resizable like the AI team panel: the saved height is only a
// flex basis (a short window shrinks the panel, the panes keep MIN_PANES), drag the top edge or use the arrow keys.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isFinished, overallProgress, sftpErrorText, type TransferItem } from '../../../../shared/sftp';
import { canCancel, canRetry, formatBytes, percentOf } from '../../../../shared/sftpView';
import { rowSlots, rowWindow } from '../../../../shared/virtualRows';
import { useI18n } from '../../i18n';
import { askConflict, cancelBatch, cancelTransfer, clearFinishedTransfers, retryTransfer } from '../../sftp';
import { useSftpStore } from '../../sftpStore';
import { IArrowRight, IDownload, IUpload } from '../icons';
import { BusyRing } from '../Spinner';

const HEIGHT_KEY = 'mc-sftp-transfers-height-v1';
export const MIN_PANEL = 110;
const MIN_PANES = 200;
const DEFAULT_PANEL = 220;
const ROW = 40;

function readHeight(): number | null {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(value) && value >= MIN_PANEL ? Math.round(value) : null;
  } catch { return null; }
}

const STATE_LABEL = { queued: 'w kolejce', running: 'przesyłanie', done: 'gotowe', failed: 'nieudane', cancelled: 'anulowano', conflict: 'konflikt' } as const;

export function TransferPanel() {
  const { tr, language } = useI18n();
  const items = useSftpStore((st) => st.transfers);
  const preparing = useSftpStore((st) => st.preparing);
  const [height, setHeight] = useState<number | null>(readHeight);
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 200 });
  const total = useMemo(() => overallProgress(items), [items]);
  const finished = items.some((i) => isFinished(i.state));
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length > 0]);
  if (!items.length && !preparing.length) return null;
  const percent = total.total > 0 ? Math.floor((total.done / total.total) * 100) : total.finished === total.files ? 100 : 0;
  const slots = rowSlots(rowWindow(view.top, view.height, ROW, items.length), items.length);
  const changeHeight = (next: number, save: boolean) => {
    setHeight(next);
    if (save) try { localStorage.setItem(HEIGHT_KEY, String(next)); } catch { /* not remembered */ }
  };
  return (
    <section ref={section} className="sftp-transfers" aria-label={tr('Transfery')} style={height ? { '--sftp-transfers-height': `${height}px` } as CSSProperties : undefined}>
      <Splitter section={section} height={height} onChange={changeHeight} />
      <div className="sftp-transfers-head">
        <strong>{tr('Transfery')}</strong>
        <span className="muted">{tr('{finished} z {files} plików', { finished: total.finished, files: total.files })} · {formatBytes(total.done, language)} / {formatBytes(total.total, language)}</span>
        <div className="sftp-progress overall" role="progressbar" aria-label={tr('Postęp ogólny')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
        <span className="sftp-percent">{percent}%</span>
        <span className="grow" />
        <button type="button" className="btn small" disabled={!finished} onClick={() => void clearFinishedTransfers()}>{tr('Wyczyść zakończone')}</button>
      </div>
      {preparing.map((b) => (
        <div key={b.batchId} className="sftp-transfer preparing" data-batch-id={b.batchId}>
          <BusyRing className="sftp-spinner small" />
          <div className="sftp-transfer-main"><span className="sftp-transfer-name">{tr('Przygotowywanie transferu ({count})…', { count: b.sources })}</span></div>
          <div className="sftp-transfer-actions"><button type="button" className="btn small" onClick={() => cancelBatch(b.queue, b.batchId)}>{tr('Anuluj')}</button></div>
        </div>
      ))}
      <div ref={list} className="sftp-transfer-list" onScroll={(e) => { const t = e.currentTarget.scrollTop; setView((v) => (v.top === t ? v : { ...v, top: t })); }}>
        {slots.map((slot, n) => slot.kind === 'gap'
          ? <div key={`gap-${n}`} style={{ height: slot.rows * ROW }} aria-hidden />
          : <TransferRow key={items[slot.index].id} item={items[slot.index]} />)}
      </div>
    </section>
  );

}

function TransferRow({ item }: { item: TransferItem }) {
  const { tr, language } = useI18n();
  const p = percentOf(item);
  const error = item.error ? sftpErrorText(item.error) : null;
  const dir = item.direction === 'upload' ? <IUpload /> : item.direction === 'download' ? <IDownload /> : <IArrowRight />;
  const dirLabel = tr(item.direction === 'upload' ? 'Wysyłanie' : item.direction === 'download' ? 'Pobieranie' : item.direction === 'move' || item.direction === 'local-move' ? 'Przenoszenie' : 'Kopiowanie');
  return (
    <div className={`sftp-transfer ${item.state}`} data-transfer-id={item.id} data-state={item.state} title={`${item.source}\n${item.target}`}>
      <span className="sftp-transfer-dir" title={dirLabel} aria-label={dirLabel}>{dir}</span>
      <div className="sftp-transfer-main">
        <div className="sftp-transfer-line">
          <span className="sftp-transfer-name">{item.name}</span>
          <span className="sftp-transfer-state">{item.skipped ? tr('pominięto') : tr(STATE_LABEL[item.state])}</span>
          {error && item.state === 'failed' && <span className="sftp-error">{tr(error.key, error.params)}</span>}
          <span className="grow" />
          <span className="sftp-transfer-bytes">{formatBytes(item.bytesDone, language)} / {formatBytes(item.bytesTotal, language)}</span>
          <span className="sftp-percent">{p}%</span>
          <span className="sftp-transfer-speed">{item.state === 'running' && item.speed > 0 ? `${formatBytes(item.speed, language)}/s` : ''}</span>
        </div>
        <div className="sftp-progress"><span style={{ width: `${p}%` }} /></div>
      </div>
      <div className="sftp-transfer-actions">
        {item.state === 'conflict' && <button type="button" className="btn small" onClick={() => void askConflict(item)}>{tr('Rozwiąż')}</button>}
        {canCancel(item) && <button type="button" className="btn small" onClick={() => cancelTransfer(item)}>{tr('Anuluj')}</button>}
        {canRetry(item) && <button type="button" className="btn small" onClick={() => void retryTransfer(item)}>{tr('Ponów')}</button>}
      </div>
    </div>
  );
}

/** The top edge of the panel: drag it (up = taller) or ArrowUp/ArrowDown (Shift: bigger steps), Home/End. */
function Splitter({ section, height, onChange }: { section: React.RefObject<HTMLElement | null>; height: number | null; onChange(height: number, save: boolean): void }) {
  const { tr } = useI18n();
  const drag = useRef<{ id: number; y: number; start: number; last: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [measured, setMeasured] = useState({ now: height ?? DEFAULT_PANEL, max: height ?? DEFAULT_PANEL });
  const panes = () => section.current?.parentElement?.querySelector<HTMLElement>(':scope > .sftp-panes') ?? null;
  const maxHeight = () => Math.max(MIN_PANEL, (section.current?.offsetHeight ?? DEFAULT_PANEL) + (panes()?.offsetHeight ?? MIN_PANES) - MIN_PANES);
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const measure = () => setMeasured((m) => { const next = { now: el.offsetHeight, max: maxHeight() }; return next.now === m.now && next.max === m.max ? m : next; });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const other = panes();
    if (other) observer.observe(other);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const clamp = (v: number) => Math.round(Math.max(MIN_PANEL, Math.min(maxHeight(), v)));
  const current = () => section.current?.offsetHeight ?? height ?? DEFAULT_PANEL;
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (d.last !== null) onChange(d.last, true);
  };
  return <div className={`sftp-splitter${dragging ? ' dragging' : ''}`} role="separator" aria-orientation="horizontal" aria-label={tr('Zmień wysokość panelu transferów')}
    aria-valuemin={MIN_PANEL} aria-valuemax={measured.max} aria-valuenow={measured.now} aria-valuetext={tr('{width} pikseli', { width: measured.now })} tabIndex={0}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, y: e.clientY, start: current(), last: null };
      setDragging(true);
    }}
    onPointerMove={(e) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      d.last = clamp(d.start - (e.clientY - d.y));
      onChange(d.last, false);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(e) => {
      const step = e.shiftKey ? 72 : 24;
      const next = e.key === 'ArrowUp' ? current() + step : e.key === 'ArrowDown' ? current() - step : e.key === 'Home' ? MIN_PANEL : e.key === 'End' ? Number.POSITIVE_INFINITY : null;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(clamp(next), true);
    }} />;
}
