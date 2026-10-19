import { useShortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '../../../shared/fuzzy';
import { describeLayout } from '../../../shared/layout';
import { activeProject, activeTab } from '../../../shared/state';
import type { SessionInfo } from '../../../shared/types';
import {
  addAgent, closeTab, createProject, moveCellBy, openTab, quickTab, restartCell, restoreArchived, resumeSession, selectTab,
  sendSnippet, switchProject, toggleMaximize,
} from '../actions';
import { openSidebarPanel } from '../panelActions';
import { openSshView, reconnectAllSsh, reconnectAllTargetsOf } from '../ssh';
import { openSftp } from '../sftp';
import { getS, getUi, setUi, toast, update, useStore } from '../store';
import { profileOptionLabel } from '../cliUi';
import { statusLog, terminals } from '../terminals/TerminalManager';

interface Item {
  kind: string;
  title: string;
  desc?: string;
  run: (shift: boolean) => void;
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
    // actions first so short queries like "his" / "ust" find them
    out.push({ kind: tr('Akcja'), title: tr("Nowy projekt") + '…', run: () => void createProject() });
    // SSH editors need no project: after "Nowy terminal (zakładka)" with a project (L16), right here without one.
    const ssh: Item[] = [
      { kind: tr('Akcja'), title: tr('SSH: hosty i klucze'), run: () => openSshView() },
      { kind: tr('Akcja'), title: tr('SSH: nowy host'), run: () => openSshView({ kind: 'host' }) },
      { kind: tr('Akcja'), title: tr('SSH: nowy klucz'), run: () => openSshView({ kind: 'newKey' }) },
      { kind: tr('Akcja'), title: tr('SFTP: połącz z hostem…'), run: () => openSftp({ picker: true }) },
    ];
    if (!project) out.push(...ssh);
    if (project) {
      out.push({ kind: tr('Akcja'), title: tr("Nowy grid / preset…"), desc: keys('grid.new') || undefined, run: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) });
      out.push({ kind: tr('Akcja'), title: tr("Nowy terminal (zakładka)"), desc: keys('terminal.new') || undefined, run: () => quickTab() });
      out.push(...ssh);
      if (tab?.cells.some((c) => c.ssh)) out.push({ kind: tr('Akcja'), title: tr('SSH: wysyłanie masowe'), run: () => setUi({ modal: { kind: 'broadcast', projectId: project.id, tabId: tab.id } }) });
      if (tab && reconnectAllTargetsOf(project.id, tab.id).length) out.push({ kind: tr('Akcja'), title: tr('SSH: połącz ponownie wszystkie'), run: () => reconnectAllSsh(project.id, tab.id) });
      out.push({ kind: tr('Akcja'), title: tr("Historia projektu"), desc: keys('history.open') || undefined, run: () => setUi({ modal: { kind: 'history', projectId: project.id } }) });
      out.push({ kind: tr('Akcja'), title: tr("Otwórz folder projektu"), run: () => window.mc.openPath(project.path) });
      out.push({ kind: tr('Akcja'), title: tr("Otwórz projekt w Cursorze"), run: () => window.mc.openInEditor(project.path) });
      if (tab) out.push({ kind: tr('Akcja'), title: tr('Zamknij zakładkę „{name}”', { name: tab.name }), desc: keys('tab.close') || undefined, run: () => void closeTab(project.id, tab.id) });
    }
    if (focused) {
      out.push({ kind: tr('Akcja'), title: tr("Maksymalizuj / przywróć komórkę"), desc: keys('cell.maximize') || undefined, run: () => toggleMaximize(focused) });
      out.push({ kind: tr('Akcja'), title: tr("Komórka: wznów rozmowę od nowa (restart)"), run: () => restartCell(focused, 'resume') });
      out.push({ kind: tr('Akcja'), title: tr("Komórka: nowa rozmowa"), run: () => restartCell(focused, 'new') });
      out.push({ kind: tr('Akcja'), title: tr("Komórka: zresetuj terminal (tryby myszy i klawiatury)"), run: () => { terminals.resetInput(focused); toast(tr("Terminal zresetowany - historia została zachowana.")); } });
      const moves: Array<[string, string, number, number]> = [
        [tr('Komórka: przesuń w lewo'), 'left', -1, 0], [tr('Komórka: przesuń w prawo'), 'right', 1, 0],
        [tr('Komórka: przesuń w górę'), 'up', 0, -1], [tr('Komórka: przesuń w dół'), 'down', 0, 1],
      ];
      for (const [title, arrow, dx, dy] of moves) out.push({ kind: tr('Akcja'), title, desc: keys(`cell.move.${arrow}`) || undefined, run: () => moveCellBy(dx, dy) });
    }
    out.push({ kind: tr('Akcja'), title: tr("Pokaż / ukryj snippety"), desc: keys('snippets.toggle') || undefined, run: () => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen })) });
    out.push({ kind: tr('Akcja'), title: tr("Pokaż / ukryj panel projektów"), desc: keys('sidebar.toggle') || undefined, run: () => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed })) });
    out.push({ kind: tr('Akcja'), title: tr('Panel: Git'), run: () => { openSidebarPanel('git'); } });
    out.push({ kind: tr('Akcja'), title: tr("Nowy snippet") + '…', run: () => setUi({ modal: { kind: 'snippet', snippetId: null } }) });
    out.push({ kind: tr('Akcja'), title: tr("Ustawienia"), run: () => setUi({ settingsTabOpen: true, settingsActive: true }) });
    out.push({ kind: tr('Akcja'), title: tr('Skopiuj dziennik statusów'), run: () => {
      if (!statusLog.size) { toast(tr('Dziennik statusów jest jeszcze pusty')); return; }
      window.mc.clipboardWrite(statusLog.toText());
      toast(tr('Skopiowano dziennik statusów. Wpisów: {count}', { count: statusLog.size }));
    } });

    for (const p of s.projects) out.push({ kind: tr('Projekt'), title: p.name, desc: p.path, run: () => switchProject(p.id) });
    for (const p of s.projects)
      for (const t of p.tabs)
        out.push({ kind: tr('Zakładka'), title: t.name, desc: `${p.name} · ${describeLayout(t.layout)}`, run: () => selectTab(p.id, t) });
    for (const sn of s.snippets.filter((x) => !x.projectId || x.projectId === project?.id))
      out.push({ kind: tr('Snippet'), title: sn.name, desc: tr("Enter: aktywna · Shift+Enter: wszystkie"), run: (shift) => sendSnippet(sn, shift ? 'all' : 'focused') });
    if (project) {
      for (const pr of s.presets.filter((x) => !x.projectId || x.projectId === project.id))
        out.push({ kind: tr('Preset'), title: pr.name, desc: describeLayout(pr.layout), run: () => void openTab(project.id, pr.layout, pr.cells) });
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
  const results = useMemo(() => fuzzyFilter(items, q, (i) => `${i.title} ${i.kind} ${i.desc ?? ''}`, 80), [items, q]);
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
              <span className="kind">{item.kind}</span>
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
