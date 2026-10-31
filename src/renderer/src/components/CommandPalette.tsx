import { useShortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  IBranch, IDatabase, IFolder, IGrid, IHistory, IKey, IMax, IPlus, IPrompt, IRestart, IServer, ISettings, ISidebar, ISnippet, IUpload, IX,
  IArrowLeft, IArrowRight, IArrowUp,
} from './icons';
import { ICodeEditor, ICopy, IMoveDown, IRefresh } from './menuIcons';
import { ICalendar, ICapture, INoteBlank } from './notesIcons';
import { strictFieldFilter } from '../../../shared/fuzzy';
import type { MessageKey } from '../../../shared/i18n';
import { describeLayout } from '../../../shared/layout';
import { activeProject, activeTab, findCell } from '../../../shared/state';
import { openQueue, queueCapable } from '../promptQueue';
import { openAgentPrompt } from '../agentPrompt';
import { agentTargets } from '../../../shared/agentPrompt';
import { ProviderIcon } from './ProviderIcons';
import type { SessionInfo } from '../../../shared/types';
import {
  addAgent, closeTab, createProject, moveCellBy, quickTab, restartCell, restoreArchived, resumeSession, selectTab,
  sendSnippet, switchProject, toggleMaximize,
} from '../actions';
import { openSidebarPanel } from '../panelActions';
import { openTemplate, saveGridAsTemplate } from '../templates';
import { templatesFor } from '../../../shared/gridTemplates';
import { openSshView, reconnectAllSsh, reconnectAllTargetsOf } from '../ssh';
import { openSftp } from '../sftp';
import { openRedisTab, viewLabel } from '../redis/redisClient';
import { initDb, revealConnection } from '../db/dbClient';
import { dbEndpoint, dbKindLabel, isSqlKind } from '../../../shared/db';
import { getS, getUi, setUi, toast, update, useStore } from '../store';
import { profileOptionLabel } from '../cliUi';
import { statusLog, terminals } from '../terminals/TerminalManager';
import { captureSelectionToNote, createNote, openNoteInPanel, openNoteTab } from '../notesUi';
import { noteExcerpt } from '../../../shared/noteTools';
import { cellOwners } from '../../../shared/detached';
import { waitAge, waitText } from '../../../shared/waiting';
import { currentWaiting, revealWaiting, stepToWaiting } from '../waiting';
import { waitingRowInfo } from './WaitingPanel';
import { TWaiting } from './icons';

interface Item {
  kind: string;
  title: string;
  desc?: string;
  /** 1.0.7: a 14px icon like the menus'; without one the row shows its kind's icon. */
  icon?: ReactNode;
  run: (shift: boolean) => void;
}

/** The icon of a row without its own: by its kind (projects, tabs, snippets, notes, sessions…). */
function kindIcon(kind: string, tr: (key: MessageKey) => string): ReactNode {
  if (kind === tr('Projekt')) return <IFolder />;
  if (kind === tr('Zakładka') || kind === tr('Szablon')) return <IGrid />;
  if (kind === tr('Snippet')) return <ISnippet />;
  if (kind === tr('Notatka')) return <INoteBlank />;
  if (kind === tr('Baza danych') || kind === 'Redis') return <IDatabase />;
  if (kind === tr('Historia')) return <IHistory />;
  if (kind === '+ agent') return <IPlus />;
  // Terminal profiles and resumable sessions of a CLI.
  return <IPrompt />;
}

export function CommandPalette() {
  const open = useStore((st) => st.ui.palette);
  if (!open) return null;
  return <PaletteInner />;
}

function PaletteInner() {
  const { tr } = useI18n();
  const keys = useShortcutText();
  const s = useStore((st) => st.s);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const project = activeProject(s);

  useEffect(() => {
    if (project) void window.mc.listSessions(project.path).then(setSessions);
  }, [project?.path]);

  const close = () => setUi({ palette: false });

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const tab = activeTab(project);
    const focused = getUi().focusedCellId;
    // 1.0.9: the cells that wait for you come first (there are few, and they are what the user is most likely after).
    const waitingNow = Date.now();
    const owners = cellOwners(s);
    for (const entry of currentWaiting()) {
      const info = waitingRowInfo(s, entry, getUi().sessionTitles, tr, owners);
      if (!info) continue;
      const what = waitText(entry);
      const age = waitAge(entry.since, waitingNow);
      out.push({ kind: tr('Czeka na Ciebie'), title: info.label, icon: <TWaiting />, desc: `${tr(what.key, what.params)} · ${tr(age.key, age.params)} · ${info.place}`, run: () => revealWaiting(entry.cellId) });
    }
    // actions first so short queries like "his" / "ust" find them
    out.push({ kind: tr('Akcja'), title: tr("Nowy projekt") + '…', icon: <IPlus />, run: () => void createProject() });
    // SSH editors need no project: after "Nowy terminal (zakładka)" with a project (L16), right here without one.
    const ssh: Item[] = [
      { kind: tr('Akcja'), title: tr('SSH: hosty i klucze'), icon: <IServer />, run: () => openSshView() },
      { kind: tr('Akcja'), title: tr('SSH: nowy host'), icon: <IServer />, run: () => openSshView({ kind: 'host' }) },
      { kind: tr('Akcja'), title: tr('SSH: nowy klucz'), icon: <IKey />, run: () => openSshView({ kind: 'newKey' }) },
      { kind: tr('Akcja'), title: tr('SFTP: połącz z hostem…'), icon: <IUpload />, run: () => openSftp({ picker: true }) },
    ];
    if (!project) out.push(...ssh);
    if (project) {
      out.push({ kind: tr('Akcja'), title: tr('Nowy grid / szablon…'), icon: <IGrid />, desc: keys('grid.new') || undefined, run: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) });
      out.push({ kind: tr('Akcja'), title: tr("Nowy terminal (zakładka)"), icon: <IPrompt />, desc: keys('terminal.new') || undefined, run: () => quickTab() });
      out.push(...ssh);
      if (tab?.cells.some((c) => c.ssh)) out.push({ kind: tr('Akcja'), title: tr('SSH: wysyłanie masowe'), icon: <IServer />, run: () => setUi({ modal: { kind: 'broadcast', projectId: project.id, tabId: tab.id } }) });
      if (tab && reconnectAllTargetsOf(project.id, tab.id).length) out.push({ kind: tr('Akcja'), title: tr('SSH: połącz ponownie wszystkie'), icon: <IRefresh />, run: () => reconnectAllSsh(project.id, tab.id) });
      out.push({ kind: tr('Akcja'), title: tr("Historia projektu"), icon: <IHistory />, desc: keys('history.open') || undefined, run: () => setUi({ modal: { kind: 'history', projectId: project.id } }) });
      out.push({ kind: tr('Akcja'), title: tr("Otwórz folder projektu"), icon: <IFolder />, run: () => window.mc.openPath(project.path) });
      out.push({ kind: tr('Akcja'), title: tr("Otwórz projekt w Cursorze"), icon: <ICodeEditor />, run: () => window.mc.openInEditor(project.path) });
      if (tab) out.push({ kind: tr('Akcja'), title: tr('Zapisz grid „{name}” jako szablon…', { name: tab.name }), icon: <IGrid />, run: () => void saveGridAsTemplate(project.id, tab.id) });
      if (tab) out.push({ kind: tr('Akcja'), title: tr('Zamknij zakładkę „{name}”', { name: tab.name }), icon: <IX />, desc: keys('tab.close') || undefined, run: () => void closeTab(project.id, tab.id) });
    }
    if (focused) {
      out.push({ kind: tr('Akcja'), title: tr("Maksymalizuj / przywróć komórkę"), icon: <IMax />, desc: keys('cell.maximize') || undefined, run: () => toggleMaximize(focused) });
      out.push({ kind: tr('Akcja'), title: tr("Komórka: wznów rozmowę od nowa (restart)"), icon: <IRestart />, run: () => restartCell(focused, 'resume') });
      out.push({ kind: tr('Akcja'), title: tr("Komórka: nowa rozmowa"), icon: <IPlus />, run: () => restartCell(focused, 'new') });
      // 1.0.9: the prompt queue of the focused agent cell, with its add field ready.
      const focusedCell = findCell(s, focused)?.cell;
      if (focusedCell && queueCapable(s, focusedCell)) out.push({ kind: tr('Akcja'), title: tr('Komórka: dodaj prompt do kolejki'), icon: <IPlus />, desc: keys('cell.queue') || undefined, run: () => openQueue(focused) });
      out.push({ kind: tr('Akcja'), title: tr("Komórka: zresetuj terminal (tryby myszy i klawiatury)"), icon: <IRefresh />, run: () => { terminals.resetInput(focused); toast(tr("Terminal zresetowany - historia została zachowana.")); } });
      const moves: Array<[string, string, number, number]> = [
        [tr('Komórka: przesuń w lewo'), 'left', -1, 0], [tr('Komórka: przesuń w prawo'), 'right', 1, 0],
        [tr('Komórka: przesuń w górę'), 'up', 0, -1], [tr('Komórka: przesuń w dół'), 'down', 0, 1],
      ];
      const arrowIcon: Record<string, ReactNode> = { left: <IArrowLeft />, right: <IArrowRight />, up: <IArrowUp />, down: <IMoveDown /> };
      for (const [title, arrow, dx, dy] of moves) out.push({ kind: tr('Akcja'), title, icon: arrowIcon[arrow], desc: keys(`cell.move.${arrow}`) || undefined, run: () => moveCellBy(dx, dy) });
    }
    // 1.1.1: one prompt to several Claude and Codex cells (every grid and window).
    if (agentTargets(s).length) out.push({ kind: tr('Akcja'), title: tr('Wyślij prompt do wielu agentów…'), icon: <ProviderIcon provider="claude" size={14} />, desc: keys('agents.prompt') || undefined, run: () => openAgentPrompt() });
    out.push({ kind: tr('Akcja'), title: tr('Szukaj w rozmowach Claude i Codex…'), icon: <IHistory />, desc: keys('conversations.search') || undefined, run: () => setUi({ modal: { kind: 'conversations' } }) });
    out.push({ kind: tr('Akcja'), title: tr("Pokaż / ukryj snippety"), icon: <ISnippet />, desc: keys('snippets.toggle') || undefined, run: () => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen })) });
    out.push({ kind: tr('Akcja'), title: tr("Pokaż / ukryj notatki"), icon: <INoteBlank />, desc: keys('notes.toggle') || undefined, run: () => update((st) => ({ ...st, notesOpen: !st.notesOpen })) });
    out.push({ kind: tr('Akcja'), title: tr('Notatki: nowa notatka'), icon: <INoteBlank />, run: () => createNote() });
    out.push({ kind: tr('Akcja'), title: tr('Notatki: notatka dzienna'), icon: <ICalendar />, run: () => createNote('daily') });
    out.push({ kind: tr('Akcja'), title: tr('Notatki: nowa z zaznaczonego tekstu'), icon: <ICapture />, desc: keys('notes.capture') || undefined, run: () => captureSelectionToNote() });
    out.push({ kind: tr('Akcja'), title: tr("Pokaż / ukryj panel projektów"), icon: <ISidebar />, desc: keys('sidebar.toggle') || undefined, run: () => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed })) });
    out.push({ kind: tr('Akcja'), title: tr('Panel: Git'), icon: <IBranch />, run: () => { openSidebarPanel('git'); } });
    if (getS().settings.sidePanels?.waiting) out.push({ kind: tr('Akcja'), title: tr('Czeka na Ciebie: pokaż listę'), icon: <TWaiting />, run: () => { openSidebarPanel('waiting'); } });
    out.push({ kind: tr('Akcja'), title: tr('Następna komórka, która czeka na Ciebie'), icon: <TWaiting />, desc: keys('waiting.next') || undefined, run: () => stepToWaiting(1) });
    out.push({ kind: tr('Akcja'), title: tr('Poprzednia komórka, która czeka na Ciebie'), icon: <TWaiting />, desc: keys('waiting.prev') || undefined, run: () => stepToWaiting(-1) });
    out.push({ kind: tr('Akcja'), title: tr('Bazy danych: nowe połączenie'), icon: <IDatabase />, run: () => setUi({ modal: { kind: 'dbConnection', dbKind: 'postgres' } }) });
    out.push({ kind: tr('Akcja'), title: tr('Bazy danych: otwórz połączenie…'), icon: <IDatabase />, run: () => { openSidebarPanel('db'); } });
    for (const c of s.dbConnections) {
      out.push({ kind: tr('Baza danych'), title: c.name, desc: `${dbKindLabel(c)} · ${dbEndpoint(c)}`, run: () => {
        openSidebarPanel('db');
        if (!isSqlKind(c.kind)) return;
        initDb();
        void revealConnection(c.id).then((error) => { if (error) toast(error, 'error'); });
      } });
    }
    out.push({ kind: tr('Akcja'), title: tr("Nowy snippet") + '…', icon: <ISnippet />, run: () => setUi({ modal: { kind: 'snippet', snippetId: null } }) });
    out.push({ kind: tr('Akcja'), title: tr("Ustawienia"), icon: <ISettings />, run: () => setUi({ settingsTabOpen: true, settingsActive: true }) });
    out.push({ kind: tr('Akcja'), title: tr('Skopiuj dziennik statusów'), icon: <ICopy />, run: () => {
      if (!statusLog.size) { toast(tr('Dziennik statusów jest jeszcze pusty')); return; }
      window.mc.clipboardWrite(statusLog.toText());
      toast(tr('Skopiowano dziennik statusów. Wpisów: {count}', { count: statusLog.size }));
    } });

    // Redis connections (1.0.0): the key browser, the console, Pub/Sub and the server views of each saved connection.
    for (const c of s.dbConnections ?? []) {
      if (c.kind !== 'redis') continue;
      for (const view of ['keys', 'console', 'pubsub', 'info'] as const) {
        out.push({ kind: 'Redis', title: view === 'keys' ? tr('Otwórz przeglądarkę Redis: {name}', { name: c.name }) : `${c.name}: ${viewLabel(view)}`, desc: dbEndpoint(c), run: () => { openRedisTab(c.id, view); } });
      }
    }
    // 1.0.7: notes of the project on screen and the global ones; Enter opens one in the panel, Shift+Enter in a tab.
    for (const n of s.notes.filter((x) => !x.projectId || x.projectId === project?.id).slice(0, 200))
      out.push({ kind: tr('Notatka'), title: n.name.trim() || tr('Notatka bez nazwy'), desc: noteExcerpt(n.text, [], 1).slice(0, 80) || undefined, run: (shift) => (shift ? openNoteTab(n) : openNoteInPanel(n.id)) });
    for (const p of s.projects) out.push({ kind: tr('Projekt'), title: p.name, desc: p.path, run: () => switchProject(p.id) });
    for (const p of s.projects)
      for (const t of p.tabs)
        out.push({ kind: tr('Zakładka'), title: t.name, desc: `${p.name} · ${describeLayout(t.layout)}`, run: () => selectTab(p.id, t) });
    for (const sn of s.snippets.filter((x) => !x.projectId || x.projectId === project?.id))
      out.push({ kind: tr('Snippet'), title: sn.name, desc: tr("Enter: aktywna · Shift+Enter: wszystkie"), run: (shift) => sendSnippet(sn, shift ? 'all' : 'focused') });
    if (project) {
      // 1.1.1: grid templates; their folders are resolved against this project (a missing one falls back to its root).
      for (const pr of templatesFor(s.presets, project.id))
        out.push({ kind: tr('Szablon'), title: tr('Nowy grid z szablonu: {name}', { name: pr.name }), desc: `${describeLayout(pr.layout)} · ${pr.projectId ? tr('Szablon projektu') : tr('Szablon globalny')}`, run: () => void openTemplate(project.id, pr.id) });
      for (const pf of s.profiles) {
        const label = profileOptionLabel(pf, cliStatus, tr);
        out.push({ kind: '+ agent', title: label, desc: tr("Dodaj komórkę do siatki"), run: () => void addAgent(pf.id) });
        out.push({ kind: tr('Terminal'), title: label, desc: tr("Nowa zakładka z jednym terminalem"), run: () => quickTab(pf.id) });
      }
      for (const a of project.archive)
        out.push({ kind: tr('Historia'), title: a.name, desc: tr('zamknięty grid {layout}, przywróć', { layout: describeLayout(a.layout) }), run: () => restoreArchived(project.id, a.id) });
      for (const x of sessions)
        out.push({ kind: x.cli, title: x.title, desc: tr("wznów w nowej zakładce · Shift: w nowej komórce"), run: (shift) => resumeSession(x, shift ? 'newCell' : 'newTab') });
    }
    return out;
  }, [s, sessions, project, tr, cliStatus, keys]);

  // Only a new query or new items filter again; moving the highlight (mouse, arrows) just re-renders the list.
  // 1.0.7: strict matching (word starts and contiguous runs, the title first), no scattered single letters.
  const results = useMemo(() => strictFieldFilter(items, q, (i) => [i.title, i.kind, i.desc ?? ''], 80), [items, q]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (item: Item | undefined, shift: boolean) => {
    if (!item) return;
    close();
    item.run(shift);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal palette">
        <input
          autoFocus
          placeholder={tr('Szukaj projektów, zakładek, snippetów, rozmów, akcji…') + (getS().projects.length ? '' : tr(' (zacznij od „Nowy projekt”)'))}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(results.length - 1, x + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(results[sel], e.shiftKey); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((item, i) => (
            <div key={i} className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseMove={() => { if (i !== sel) setSel(i); }} onClick={(e) => run(item, e.shiftKey)}>
              {/* 1.0.7: the kind names a run of items once (its first row), not every row. */}
              <span className="kind">{results[i - 1]?.kind === item.kind ? '' : item.kind}</span>
              <span className="picon" aria-hidden="true">{item.icon ?? kindIcon(item.kind, tr)}</span>
              <span className="ptitle">{item.title}</span>
              {item.desc && <span className="pdesc">{item.desc}</span>}
            </div>
          ))}
          {!results.length && <div className="muted" style={{ padding: 12 }}>{tr("Nic nie znaleziono.")}</div>}
        </div>
      </div>
    </div>
  );
}
