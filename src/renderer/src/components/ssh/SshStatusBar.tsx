// The status bar under a connected SSH terminal (1.0.7): the server's system and name, CPU with a sparkline, memory, network,
// uptime, the user and the root disk, read over the cell's own connection (shared/sshBar.ts, renderer/sshBar.ts). Runs only
// while the bar is on screen and the window is shown. Hovering the CPU, the user and the disk opens a small card with the
// details; the right-click menu hides the bar here, everywhere, or single items. A narrow cell first shortens the values,
// then drops the sparkline, then the least important items (fitBar).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  diskLevel, fitBar, formatBytes, formatMemory, formatRate, formatUptime, formatUptimeShort, memoryPercent, rootDisk, shownBarItems,
  sparklinePoints, splitWho, SSH_BAR_INTERVAL_MS, SSH_BAR_ITEMS, type BarItemWidths, type BarStage, type SshBarItem, type WhoEntry,
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
  host: 'Host i system', cpu: 'Procesor', mem: 'Pamięć', net: 'Sieć', uptime: 'Czas działania', user: 'Użytkownicy', disk: 'Dysk',
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
  const measure = useRef<HTMLDivElement>(null);
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

  // 1.0.8: one compact row, left to right. Every item is measured in each of its forms in a hidden copy of the bar (a
  // dropped or shortened item has no width on screen to measure), and fitBar picks the roomiest layout that fits: full
  // values, then short ones ("24%" for the memory), then no sparkline, then items dropped by SSH_BAR_PRIORITY.
  const [stage, setStage] = useState<BarStage | undefined>(undefined);
  const [, setResized] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setResized((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const track = entry?.track ?? null;
  const sample = track?.sample;
  const items = new Set(shownBarItems(toggles));
  const name = sample?.host ?? host?.address ?? '';
  const os = track?.os;
  const icon = os && os.id !== 'unknown' ? OS_ICONS[os.id] : null;
  const disk = sample ? rootDisk(sample.disks) : undefined;
  const cpu = track?.cpuPercent;
  const mem = sample?.mem;
  const uptime = sample?.uptime;
  const rx = track?.rx;
  const tx = track?.tx;
  const who = splitWho(sample?.who ?? [], sample?.user);
  // The items switched on that have something to show (a rate needs two runs).
  const has: Record<SshBarItem, boolean> = {
    host: true, cpu: cpu !== undefined, mem: !!mem, net: rx !== undefined && tx !== undefined, uptime: uptime !== undefined, user: !!sample?.user, disk: !!disk,
  };
  const present = track ? SSH_BAR_ITEMS.filter((item) => items.has(item) && has[item]) : [];

  useLayoutEffect(() => {
    const bar = ref.current;
    const box = measure.current;
    if (!bar || !box) return;
    const widths: Partial<Record<SshBarItem, BarItemWidths>> = {};
    for (const el of box.querySelectorAll<HTMLElement>('[data-measure]')) {
      const [item, form] = el.dataset.measure!.split(':') as [SshBarItem, keyof BarItemWidths];
      (widths[item] ??= { full: 0, compact: 0 })[form] = el.getBoundingClientRect().width;
    }
    const style = getComputedStyle(bar);
    const gap = parseFloat(style.columnGap) || 0;
    const room = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const next = fitBar(present, widths, room, gap, HOST_MIN, stage);
    if (!stage || next.rank !== stage.rank || next.compact !== stage.compact || next.spark !== stage.spark || next.items.join() !== stage.items.join()) setStage(next);
  });

  if (entry?.stopped) return null;
  // Nothing on screen until the first answer (a server without sh never shows a bar): an empty line the observer can see.
  if (!track) return <div ref={ref} className="ssh-bar ssh-bar-pending" aria-hidden="true" />;
  // Until measured everything in full; the layout effect corrects it before the first paint.
  const layout = stage ?? { compact: false, spark: true, items: present, rank: 0 };
  const visible = present.filter((item) => layout.items.includes(item));
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
      ...SSH_BAR_ITEMS.map((item) => {
        const on = items.has(item);
        // The last item shown stays: hiding the whole bar has its own entries.
        return { label: tr(BAR_ITEM_LABELS[item]), icon: on ? <ICheck /> : undefined, disabled: on && shownItems.length === 1, onClick: () => setBarItem(item, !on) };
      }),
    ];
    openMenu(e.clientX, e.clientY, entries);
  };

  const fmtPct = (v: number) => `${new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(v)}%`;
  /** The inside of an item in its full or short form: the same in the bar and in the hidden copy that measures it. */
  const body = (item: SshBarItem, compact: boolean, spark: boolean): ReactNode => {
    switch (item) {
      case 'host': return <>
        {icon ? (
          <svg className="ssh-bar-logo" viewBox="0 0 24 24" aria-hidden="true" style={{ color: icon.color }}><path fill="currentColor" d={icon.path} /></svg>
        ) : <IServer />}
        <span className="ssh-bar-text">{name}</span>
      </>;
      case 'cpu': return <>
        <ICpu /><span className="ssh-bar-text ssh-bar-num ssh-bar-pct3">{fmtPct(cpu ?? 0)}</span>
        {spark && <Sparkline history={track.cpuHistory} />}
      </>;
      case 'mem': return <>
        <IMem />
        {compact
          ? <span className="ssh-bar-text ssh-bar-num ssh-bar-pct3">{fmtPct(memoryPercent(mem!))}</span>
          : <span className="ssh-bar-text ssh-bar-num">{formatMemory(mem!, language)}</span>}
      </>;
      // Up and down apart, like MobaXterm: sending first.
      case 'net': return <>
        <span className="ssh-bar-dir"><IUp /><span className={`ssh-bar-text ssh-bar-num ${compact ? 'ssh-bar-rate-short' : 'ssh-bar-rate'}`}>{formatRate(tx!, language, compact)}</span></span>
        <span className="ssh-bar-dir"><IDown /><span className={`ssh-bar-text ssh-bar-num ${compact ? 'ssh-bar-rate-short' : 'ssh-bar-rate'}`}>{formatRate(rx!, language, compact)}</span></span>
      </>;
      case 'uptime': return <><IClock /><span className="ssh-bar-text">{formatUptimeShort(uptime!, language, compact)}</span></>;
      case 'user': return <>
        <IUser /><span className="ssh-bar-text">{sample!.user}</span>
        {who.others.length > 0 && <span className="ssh-bar-more">+{who.others.length}</span>}
      </>;
      case 'disk': return <><IDisk /><span className="ssh-bar-text ssh-bar-num">{compact ? `${disk!.percent}%` : `${disk!.mount}: ${disk!.percent}%`}</span></>;
    }
  };

  const whoRow = (w: WhoEntry, i: number) => (
    <tr key={i} className={w.self ? 'self' : undefined}>
      <td>{w.user}{w.self && <span className="ssh-bar-you">{tr('(ty)')}</span>}</td><td>{w.tty || '-'}</td><td>{w.from || '-'}</td><td>{w.since || '-'}</td>
    </tr>
  );
  const shownItem = (it: SshBarItem): ReactNode => {
    const inner = body(it, layout.compact, layout.spark);
    const attrs = { 'data-item': it };
    switch (it) {
      case 'host': return <span key={it} {...attrs} className="ssh-bar-item ssh-bar-host" title={hostTitle || undefined}>{inner}</span>;
      case 'cpu': return (
        <HoverCard key={it} attrs={attrs} className="ssh-bar-cpu" content={() => (
          <table className="ssh-bar-table"><tbody>
            <tr><th>{tr('Procesor')}</th><td>{fmtPct(cpu ?? 0)}</td></tr>
            {track.ncpu !== undefined && <tr><th>{tr('Rdzenie')}</th><td>{track.ncpu}</td></tr>}
            {sample?.load && <tr><th>{tr('Obciążenie (1, 5, 15 min)')}</th><td>{sample.load.map((v) => new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)).join(' / ')}</td></tr>}
            {uptime !== undefined && <tr><th>{tr('Czas działania')}</th><td>{formatUptime(uptime)}</td></tr>}
          </tbody></table>
        )}>{inner}</HoverCard>
      );
      case 'mem': return (
        <span key={it} {...attrs} className="ssh-bar-item ssh-bar-mem" title={tr('Pamięć: {used} z {total} zajęte ({percent})', {
          used: formatBytes(mem!.total - mem!.available, language), total: formatBytes(mem!.total, language), percent: fmtPct(memoryPercent(mem!)),
        })}>{inner}</span>
      );
      case 'net': return (
        <span key={it} {...attrs} className="ssh-bar-item ssh-bar-net" title={tr('Sieć (wszystkie interfejsy poza lo): odbiór {rx}, wysyłanie {tx}', { rx: formatRate(rx!, language), tx: formatRate(tx!, language) })}>{inner}</span>
      );
      case 'uptime': return (
        <span key={it} {...attrs} className="ssh-bar-item ssh-bar-uptime" title={tr('Czas działania serwera: {time}', { time: formatUptime(uptime!) })}>{inner}</span>
      );
      case 'user': return (
        <HoverCard key={it} attrs={attrs} className="ssh-bar-user" content={() => (
          who.self || who.others.length ? (
            <table className="ssh-bar-table ssh-bar-cols">
              <thead><tr><th>{tr('Użytkownik')}</th><th>{tr('Terminal')}</th><th>{tr('Skąd')}</th><th>{tr('Zalogowany od')}</th></tr></thead>
              {/* 1.0.8: everyone else first, this session last. */}
              <tbody>{[...who.others, ...(who.self ? [who.self] : [])].map(whoRow)}</tbody>
            </table>
          ) : <p className="ssh-bar-note">{tr('Serwer nie podał listy zalogowanych')}</p>
        )}>{inner}</HoverCard>
      );
      case 'disk': return (
        <HoverCard key={it} attrs={attrs} className={`ssh-bar-disk ${diskLevel(disk!.percent)}`} content={() => (
          <table className="ssh-bar-table ssh-bar-cols">
            <thead><tr><th>{tr('Montowanie')}</th><th>{tr('Rozmiar')}</th><th>{tr('Użyte')}</th><th>{tr('Wolne')}</th><th>%</th></tr></thead>
            <tbody>{sample!.disks.map((d) => (
              <tr key={d.mount} title={d.fs}>
                <td className="ssh-bar-mount">{d.mount}</td><td>{formatBytes(d.size, language)}</td><td>{formatBytes(d.used, language)}</td>
                <td>{formatBytes(d.avail, language)}</td><td className={`ssh-bar-pct ${diskLevel(d.percent)}`}>{d.percent}%</td>
              </tr>
            ))}</tbody>
          </table>
        )}>{inner}</HoverCard>
      );
    }
  };

  return (
    <div ref={ref} className="ssh-bar" role="status" aria-label={tr('Pasek stanu serwera')} data-stage={layout.rank} onContextMenu={menu}>
      {visible.map(shownItem)}
      {/* Every item in every form, out of sight: fitBar's widths. */}
      <div ref={measure} className="ssh-bar-measure" aria-hidden="true">
        {present.map((it) => (
          <span key={it}>
            <span data-measure={`${it}:full`} className={`ssh-bar-item ssh-bar-${it}`}>{body(it, false, true)}</span>
            <span data-measure={`${it}:compact`} className={`ssh-bar-item ssh-bar-${it}`}>{body(it, true, true)}</span>
            {it === 'cpu' && <span data-measure="cpu:bare" className="ssh-bar-item ssh-bar-cpu">{body(it, true, false)}</span>}
          </span>
        ))}
      </div>
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
    // 1.0.7: within the cell's card when it fits there, so the card never spills over the next cell or a side panel; a card
    // wider than the cell is centred on the window's clamp.
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
const IUp = () => icon(<path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />);
const IDown = () => icon(<path d="M8 3v9.5M4.5 9 8 12.5 11.5 9" />);
const IClock = () => icon(<><circle cx="8" cy="8" r="6" /><path d="M8 4.75V8l2.25 1.5" /></>);
const IUser = () => icon(<><circle cx="8" cy="5.5" r="2.75" /><path d="M2.75 14c.6-2.9 2.7-4.5 5.25-4.5s4.65 1.6 5.25 4.5" /></>);
const IDisk = () => icon(<><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4.5 9.5h.01M7 9.5h5" /></>);
