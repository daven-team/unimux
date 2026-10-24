// The status bar under a connected SSH terminal (1.0.7): the server's system and name, CPU with a sparkline, memory, network,
// the user and the root disk, read over the cell's own connection (shared/sshBar.ts, renderer/sshBar.ts). Runs only while
// the bar is on screen and the window is shown. Hovering the CPU, the user and the disk opens a small card with the details;
// the right-click menu hides the bar here, everywhere, or single items. A narrow cell drops the least important items.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  diskLevel, formatBytes, formatMemory, formatRate, formatUptime, rootDisk, shownBarItems, sparklinePoints, SSH_BAR_INTERVAL_MS, SSH_BAR_PRIORITY,
  type SshBarItem,
} from '../../../../shared/sshBar';
import { updateCell, updateSettings } from '../../../../shared/state';
import { placeTooltip } from '../../../../shared/tooltipPosition';
import type { Cell } from '../../../../shared/types';
import type { MessageKey } from '../../../../shared/i18n';
import { useI18n } from '../../i18n';
import { dropBar, setBarActive, useSshBarStore } from '../../sshBar';
import { useSshStore } from '../../sshStore';
import { toast, update, useStore } from '../../store';
import { isWindowShown, onWindowShown } from '../../windowShown';
import { openMenu, type MenuItem } from '../ContextMenu';
import { ICheck } from '../icons';
import { IEyeOff } from '../menuIcons';
import { OS_ICONS } from './osIcons';
import './sshBar.css';

/** Width the host name keeps at least before other items go. */
const HOST_MIN = 90;

export const BAR_ITEM_LABELS: Record<SshBarItem, MessageKey> = {
  host: 'Host i system', cpu: 'Procesor', mem: 'Pamięć', net: 'Sieć', user: 'Użytkownicy', disk: 'Dysk',
};

/** Shows the bar in every SSH cell again: the setting on and every per-cell hide cleared. */
export function showBarEverywhere(): void {
  update((st) => {
    let next = updateSettings(st, { sshStatusBar: true });
    for (const p of next.projects) for (const t of p.tabs) for (const c of t.cells) if (c.sshBarHidden) next = updateCell(next, c.id, { sshBarHidden: undefined });
    return next;
  });
}

export function setBarItem(item: SshBarItem, on: boolean): void {
  update((st) => {
    const items = { ...(st.settings.sshStatusBarItems ?? {}) };
    if (on) delete items[item]; else items[item] = false;
    return updateSettings(st, { sshStatusBarItems: Object.keys(items).length ? items : undefined });
  });
}

export function SshStatusBar({ cell }: { cell: Cell }) {
  const session = useSshStore((st) => st.sessions[cell.id]);
  const enabled = useStore((st) => st.s.settings.sshStatusBar !== false) && !cell.sshBarHidden;
  const connected = session?.phase === 'connected';
  const since = session?.since;
  // A session that ended or connected again starts over (no rates across sessions, the system asked again).
  useEffect(() => { if (!connected) dropBar(cell.id); }, [cell.id, connected, since]);
  useEffect(() => () => dropBar(cell.id), [cell.id, since]);
  if (!enabled || !connected) return null;
  return <Bar key={since} cell={cell} />;
}

function Bar({ cell }: { cell: Cell }) {
  const { tr, language } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const entry = useSshBarStore((st) => st.bars[cell.id]);
  const host = useStore((st) => st.s.sshHosts.find((h) => h.id === cell.ssh?.hostId));
  const toggles = useStore((st) => st.s.settings.sshStatusBarItems);
  const [onScreen, setOnScreen] = useState(false);
  const [shown, setShown] = useState(isWindowShown);

  useEffect(() => onWindowShown(() => setShown(isWindowShown())), []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setOnScreen(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    const vis = () => setShown(isWindowShown());
    document.addEventListener('visibilitychange', vis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  }, []);
  const active = onScreen && shown;
  useEffect(() => {
    setBarActive(cell.id, active);
    return () => setBarActive(cell.id, false);
  }, [cell.id, active]);

  // A narrow cell drops items from the end of SSH_BAR_PRIORITY (measured: values and host names vary in width).
  const [drop, setDrop] = useState<ReadonlySet<SshBarItem>>(() => new Set());
  const widths = useRef<Partial<Record<SshBarItem, number>>>({});
  const [, setResized] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setResized((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const present: SshBarItem[] = [];
    for (const el of bar.querySelectorAll<HTMLElement>(':scope > [data-item]')) {
      const item = el.dataset.item as SshBarItem;
      present.push(item);
      // The natural width: a host name squeezed by the flex layout must not be measured squeezed (it would then always "fit").
      const text = el.querySelector<HTMLElement>('.ssh-bar-text');
      if (!drop.has(item)) widths.current[item] = el.offsetWidth + (text ? Math.max(0, text.scrollWidth - text.clientWidth) : 0);
    }
    const style = getComputedStyle(bar);
    const gap = parseFloat(style.columnGap) || 0;
    // Each item is checked before its own gap is paid: the k-th item sees k - 1 gaps taken, as the layout has them.
    let room = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const next = new Set<SshBarItem>();
    let full = false;
    for (const item of SSH_BAR_PRIORITY) {
      if (!present.includes(item)) continue;
      // The host name shrinks with an ellipsis down to HOST_MIN.
      const w = item === 'host' ? Math.min(widths.current.host ?? 0, HOST_MIN) : widths.current[item] ?? 0;
      // A dropped item comes back only with a few pixels to spare, so a rate that grows and shrinks by a digit does not make
      // the next item blink in and out every reading.
      const slack = drop.has(item) ? 8 : 0;
      if (!full && w + slack <= room) room -= w + gap; else { full = true; next.add(item); }
    }
    if (next.size !== drop.size || [...next].some((i) => !drop.has(i))) setDrop(next);
  });

  if (entry?.stopped) return null;
  const track = entry?.track ?? null;
  // Nothing on screen until the first answer (a server without sh never shows a bar): an empty line the observer can see.
  if (!track) return <div ref={ref} className="ssh-bar ssh-bar-pending" aria-hidden="true" />;
  const sample = track?.sample;
  const items = new Set(shownBarItems(toggles));
  const name = sample?.host ?? host?.address ?? '';
  const os = track?.os;
  const icon = os && os.id !== 'unknown' ? OS_ICONS[os.id] : null;
  const disk = sample ? rootDisk(sample.disks) : undefined;
  const run = entry?.run;
  const hostTitle = [
    os?.name, sample?.kernel,
    run ? tr('Odczyt co {seconds} s: {ms} ms, {size}', { seconds: SSH_BAR_INTERVAL_MS / 1000, ms: run.ms, size: formatBytes(run.bytes, language) }) : null,
  ].filter(Boolean).join('\n');

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const shownItems = shownBarItems(toggles);
    const entries: MenuItem[] = [
      { label: tr('Ukryj pasek w tej komórce'), icon: <IEyeOff />, onClick: () => { update((st) => updateCell(st, cell.id, { sshBarHidden: true })); toast(tr('Pasek ukryty w tej komórce. Przywrócisz go w Ustawienia > SSH.')); } },
      { label: tr('Ukryj pasek we wszystkich komórkach SSH'), icon: <IEyeOff />, onClick: () => update((st) => updateSettings(st, { sshStatusBar: false })) },
      { sep: true },
      { header: tr('Elementy paska') },
      ...(Object.keys(BAR_ITEM_LABELS) as SshBarItem[]).map((item) => {
        const on = items.has(item);
        // The last item shown stays: hiding the whole bar has its own entries.
        return { label: tr(BAR_ITEM_LABELS[item]), icon: on ? <ICheck /> : undefined, disabled: on && shownItems.length === 1, onClick: () => setBarItem(item, !on) };
      }),
    ];
    openMenu(e.clientX, e.clientY, entries);
  };

  const cpu = track?.cpuPercent;
  const fmtPct = (v: number) => `${new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(v)}%`;
  const at = (item: SshBarItem) => ({ 'data-item': item, ...(drop.has(item) ? { 'data-drop': '' } : {}) });
  return (
    <div ref={ref} className="ssh-bar" role="status" aria-label={tr('Pasek stanu serwera')} onContextMenu={menu}>
      {items.has('host') && (
        <span {...at('host')} className="ssh-bar-item ssh-bar-host" title={hostTitle || undefined}>
          {icon ? (
            <svg className="ssh-bar-logo" viewBox="0 0 24 24" aria-hidden="true" style={{ color: icon.color }}><path fill="currentColor" d={icon.path} /></svg>
          ) : <IServer />}
          <span className="ssh-bar-text">{name}</span>
        </span>
      )}
      {items.has('cpu') && cpu !== undefined && (
        <HoverCard attrs={at('cpu')} className="ssh-bar-cpu" content={() => (
          <table className="ssh-bar-table"><tbody>
            <tr><th>{tr('Procesor')}</th><td>{fmtPct(cpu)}</td></tr>
            {track?.ncpu !== undefined && <tr><th>{tr('Rdzenie')}</th><td>{track.ncpu}</td></tr>}
            {sample?.load && <tr><th>{tr('Obciążenie (1, 5, 15 min)')}</th><td>{sample.load.map((v) => new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)).join(' / ')}</td></tr>}
            {sample?.uptime !== undefined && <tr><th>{tr('Czas działania')}</th><td>{formatUptime(sample.uptime)}</td></tr>}
          </tbody></table>
        )}>
          <ICpu /><span className="ssh-bar-text ssh-bar-num">{fmtPct(cpu)}</span>
          <Sparkline history={track?.cpuHistory ?? []} />
        </HoverCard>
      )}
      {items.has('mem') && sample?.mem && (
        <span {...at('mem')} className="ssh-bar-item ssh-bar-mem" title={tr('Pamięć: {used} z {total} zajęte ({percent})', {
          used: formatBytes(sample.mem.total - sample.mem.available, language), total: formatBytes(sample.mem.total, language),
          percent: fmtPct(((sample.mem.total - sample.mem.available) / sample.mem.total) * 100),
        })}>
          <IMem /><span className="ssh-bar-text">{formatMemory(sample.mem, language)}</span>
        </span>
      )}
      {items.has('net') && track?.rx !== undefined && track.tx !== undefined && (
        <span {...at('net')} className="ssh-bar-item ssh-bar-net" title={tr('Sieć (wszystkie interfejsy poza lo): odbiór {rx}, wysyłanie {tx}', { rx: formatRate(track.rx, language), tx: formatRate(track.tx, language) })}>
          <span className="ssh-bar-text"><span className="ssh-bar-arrow" aria-hidden="true">↓</span>{formatRate(track.rx, language)} <span className="ssh-bar-arrow" aria-hidden="true">↑</span>{formatRate(track.tx, language)}</span>
        </span>
      )}
      {items.has('user') && sample?.user && (
        <HoverCard attrs={at('user')} className="ssh-bar-user" content={() => (
          sample.who.length ? (
            <table className="ssh-bar-table ssh-bar-cols">
              <thead><tr><th>{tr('Użytkownik')}</th><th>{tr('Terminal')}</th><th>{tr('Skąd')}</th><th>{tr('Zalogowany od')}</th></tr></thead>
              <tbody>{sample.who.map((w, i) => (
                <tr key={i} className={w.self ? 'self' : undefined}>
                  <td>{w.user}{w.self && <span className="ssh-bar-you">{tr('(ty)')}</span>}</td><td>{w.tty || '-'}</td><td>{w.from || '-'}</td><td>{w.since || '-'}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="ssh-bar-note">{tr('Serwer nie podał listy zalogowanych')}</p>
        )}>
          <IUser /><span className="ssh-bar-text">{sample.user}</span>
          {sample.who.length > 1 && <span className="ssh-bar-count">{sample.who.length}</span>}
        </HoverCard>
      )}
      {items.has('disk') && disk && (
        <HoverCard attrs={at('disk')} className={`ssh-bar-disk ${diskLevel(disk.percent)}`} content={() => (
          <table className="ssh-bar-table ssh-bar-cols">
            <thead><tr><th>{tr('Montowanie')}</th><th>{tr('Rozmiar')}</th><th>{tr('Użyte')}</th><th>{tr('Wolne')}</th><th>%</th></tr></thead>
            <tbody>{sample!.disks.map((d) => (
              <tr key={d.mount} title={d.fs}>
                <td className="ssh-bar-mount">{d.mount}</td><td>{formatBytes(d.size, language)}</td><td>{formatBytes(d.used, language)}</td>
                <td>{formatBytes(d.avail, language)}</td><td className={`ssh-bar-pct ${diskLevel(d.percent)}`}>{d.percent}%</td>
              </tr>
            ))}</tbody>
          </table>
        )}>
          <IDisk /><span className="ssh-bar-text">{disk.mount}: {disk.percent}%</span>
        </HoverCard>
      )}
    </div>
  );
}

/** A bar item with a small card above it while hovered (a table: the styled `title` tooltips are plain text). */
function HoverCard({ className, attrs, content, children }: { className: string; attrs: Record<string, string>; content: () => ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !ref.current || !card.current) { setPos(null); return; }
    const a = ref.current.getBoundingClientRect();
    const c = card.current.getBoundingClientRect();
    // Above the bar first: the bar is at the bottom of the cell.
    const placed = placeTooltip({ left: a.left, right: a.right, top: a.top, bottom: a.top }, { width: c.width, height: c.height }, { width: window.innerWidth, height: window.innerHeight });
    const above = a.top - 6 - c.height;
    // 1.0.7: within the cell's card when it fits there (the disk sits at the right edge, the CPU near the left one), so the
    // card never spills over the next cell or a side panel; a card wider than the cell is centred on the window's clamp.
    const cell = ref.current.closest('.cell')?.getBoundingClientRect();
    const left = cell ? clampInto(placed.left, c.width, Math.max(cell.left + 6, 6), Math.min(cell.right - 6, window.innerWidth - 6)) : placed.left;
    setPos({ left, top: above >= 6 ? above : placed.top });
  }, [open]);
  return (
    <span ref={ref} {...attrs} className={`ssh-bar-item ${className}`}
      onMouseEnter={() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(true), 250); }}
      onMouseLeave={() => { window.clearTimeout(timer.current); setOpen(false); }}>
      {children}
      {open && createPortal(
        <div ref={card} className="ssh-bar-card" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>{content()}</div>,
        document.body,
      )}
    </span>
  );
}

/** `left` moved so a box of `width` lies within [lo, hi]; unchanged when it cannot fit there. */
function clampInto(left: number, width: number, lo: number, hi: number): number {
  if (width > hi - lo) return left;
  return Math.min(Math.max(left, lo), hi - width);
}

function Sparkline({ history }: { history: number[] }) {
  const points = sparklinePoints(history, 40, 12);
  return (
    <svg className="ssh-bar-spark" width="40" height="12" viewBox="0 0 40 12" aria-hidden="true">
      <line x1="0" y1="11.5" x2="40" y2="11.5" className="ssh-bar-spark-base" />
      {points && <polyline points={`${points.split(' ')[0].split(',')[0]},12 ${points} 40,12`} className="ssh-bar-spark-fill" />}
      {points && <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />}
    </svg>
  );
}

const icon = (children: ReactNode) => (
  <svg className="ssh-bar-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IServer = () => icon(<><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><rect x="2.5" y="9" width="11" height="4.5" rx="1" /><path d="M5 4.75h.01M5 11.25h.01" /></>);
const ICpu = () => icon(<><rect x="4" y="4" width="8" height="8" rx="1" /><path d="M6.5 6.5h3v3h-3zM6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" /></>);
const IMem = () => icon(<><rect x="1.5" y="4.5" width="13" height="6" rx="1" /><path d="M4.5 10.5v2M8 10.5v2M11.5 10.5v2M4.5 6.75v1.5M8 6.75v1.5M11.5 6.75v1.5" /></>);
const IUser = () => icon(<><circle cx="8" cy="5.5" r="2.75" /><path d="M2.75 14c.6-2.9 2.7-4.5 5.25-4.5s4.65 1.6 5.25 4.5" /></>);
const IDisk = () => icon(<><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4.5 9.5h.01M7 9.5h5" /></>);
