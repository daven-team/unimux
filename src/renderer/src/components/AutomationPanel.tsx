import { Select } from './Select';
import { shownProfileName } from '../../../shared/profiles';
import { RoleSelect } from './RoleSelect';
import { changeAgentRole } from '../agentRoles';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { activeProject, getProfile } from '../../../shared/state';
import { isClosedTask, taskPrompt, type AgentRuntimeStatus, type AutomationInput, type AutomationOperation, type TaskStatus } from '../../../shared/automation';
import { focusCell } from '../actions';
import { useI18n } from '../i18n';
import { askChoice, setUi, toast, useStore } from '../store';
import { IX } from './icons';
import { terminals } from '../terminals/TerminalManager';

const taskLabels = { queued: 'W kolejce', in_progress: 'W trakcie', blocked: 'Zablokowane', completed: 'Ukończone', cancelled: 'Anulowane' } as const;
const runtimeLabels = { starting: 'Uruchamianie', working: 'pracuje', ready: 'Gotowy', needs_attention: 'Wymaga uwagi', unknown: 'Brak potwierdzenia', exited: 'zakończony' } as const;

export function AutomationPanel() {
  const { tr, errorText } = useI18n();
  const state = useStore((s) => s.s);
  const info = useStore((s) => s.ui.mcpInfo);
  const project = activeProject(state);
  const [tab, setTab] = useState<'agents' | 'tasks' | 'messages' | 'activity'>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState<Record<string, AgentRuntimeStatus>>({});
  const section = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(readPanelHeight);
  /** A drag only renders the new height; the end of the drag and every key step save it. */
  const changeHeight = (next: number, save: boolean) => {
    setHeight(next);
    if (save) try { localStorage.setItem(HEIGHT_KEY, String(next)); } catch { /* the height just is not remembered */ }
  };
  const agents = project?.tabs.flatMap((grid) => grid.cells.filter((cell) => getProfile(state, cell.profileId).cli !== 'shell').map((cell) => ({ cell, grid }))) ?? [];
  const recipients = agents.filter(({ cell }) => cell.role);
  const targetId = recipients.some(({ cell }) => cell.id === target) ? target : recipients[0]?.cell.id ?? '';
  const tasks = state.automation.tasks.filter((task) => task.projectId === project?.id);
  const messages = state.automation.messages.filter((message) => message.projectId === project?.id);
  const label = (cellId?: string) => cellId ? agents.find(({ cell }) => cell.id === cellId)?.cell.name ?? agents.find(({ cell }) => cell.id === cellId)?.grid.name ?? tr('Agent niedostępny') : tr('Ty');

  useEffect(() => { setTarget(''); setTitle(''); setPrompt(''); setSelectedTaskId(null); setComposing(false); }, [project?.id]);

  useEffect(() => {
    if (!project) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const list = await window.mc.automation('list_agents', { projectId: project.id }) as Array<{ cellId: string; status: AgentRuntimeStatus }>;
        if (!disposed) setRuntime(Object.fromEntries(list.map((a) => [a.cellId, a.status])));
      } catch { /* The project may have been removed while the request was pending. */ }
    };
    void refresh();
    // Main pushes every status change; the slow poll is only a fallback.
    const off = window.mc.on('automation:statuses', (statuses) => { if (!disposed) setRuntime(statuses); });
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { disposed = true; off(); clearInterval(timer); };
  }, [project?.id]);

  const run = async <K extends AutomationOperation,>(operation: K, args: AutomationInput<K>): Promise<boolean> => {
    setBusy(true);
    try { await window.mc.automation(operation, args); return true; }
    catch (error) { toast(errorText(String(error).replace(/^Error: /, '')), 'error'); return false; }
    finally { setBusy(false); }
  };
  const copy = (text: string) => { window.mc.clipboardWrite(text); toast(tr('Skopiowano. Wklej do wybranego agenta.')); };
  /** Removes finished items: the given ones, or every closed task / read message of the project. */
  const remove = (kind: 'task' | 'message', ids?: string[]) => {
    if (!project) return;
    void run('remove_items', { projectId: project.id, kind, ...(ids ? { ids } : {}) }).then((ok) => { if (ok && kind === 'task' && ids) setSelectedTaskId(null); });
  };
  /** Closed tasks an open task still depends on stay (main keeps them), so they are neither counted nor offered for removal. */
  const needed = new Set(state.automation.tasks.filter((task) => !isClosedTask(task)).flatMap((task) => task.dependsOn ?? []));
  const removable = (task: (typeof tasks)[number]) => isClosedTask(task) && !needed.has(task.id);
  const finishedTasks = tasks.filter(removable).length;
  const readMessages = messages.filter((message) => message.readAt).length;
  /** Removing all finished items asks first (like removing a project). */
  const removeAll = async (kind: 'task' | 'message') => {
    const count = kind === 'task' ? finishedTasks : readMessages;
    const choice = await askChoice(
      kind === 'task' ? tr('Usunąć {count} zakończonych zadań?', { count }) : tr('Usunąć {count} przeczytanych wiadomości?', { count }),
      tr('Tego nie można cofnąć. Otwarte zadania i nieprzeczytane wiadomości zostają.'),
      [{ label: tr(kind === 'task' ? 'Usuń zakończone' : 'Usuń przeczytane'), value: 'yes', danger: true }],
    );
    if (choice === 'yes') remove(kind);
  };
  const delivery = (value: string) => tr(value === 'native' ? 'Przekazano do sesji' : value === 'startup' ? 'Prompt startowy' : 'W skrzynce agenta');

  return <section ref={section} className="automation-panel" aria-label={tr('Zadania i wiadomości agentów')} style={height ? { '--automation-height': `${height}px` } as CSSProperties : undefined}>
    <PanelSplitter section={section} height={height} onChange={changeHeight} />
    <div className="automation-head">
      <strong>{tr('Zespół AI')}</strong>
      {/* Nothing while the server is still starting (the window opens before it listens). */}
      {!info.starting && <span className={`mcp-state ${info.running ? 'connected' : ''}`} title={info.error ?? info.url}>{info.running ? tr('Serwer MCP działa') : tr('MCP niedostępne')}</span>}
      {!info.running && !info.starting && <button className="btn small" disabled={busy} onClick={() => { setBusy(true); void window.mc.retryMcp().then((mcpInfo) => setUi({ mcpInfo })).catch(() => {}).finally(() => setBusy(false)); }}>{tr('Spróbuj ponownie')}</button>}
      <span className="grow" />
      {tab === 'tasks' && <button className="btn small" onClick={() => { setComposing((v) => !v); setSelectedTaskId(null); }}>{composing ? tr('Zamknij') : '+ ' + tr('Nowe zadanie')}</button>}
      <button className={`btn small ${state.automation.paused ? 'paused' : ''}`} disabled={busy} onClick={() => void run('set_paused', { paused: !state.automation.paused })}>
        {tr(state.automation.paused ? 'Wznów automatyzację' : 'Wstrzymaj automatyzację')}
      </button>
      <button className="btn ghost icon" aria-label={tr('Zamknij')} title={tr('Zamknij')} onClick={() => setUi({ automationOpen: false })}><IX /></button>
    </div>
    <div className="automation-tabs" role="tablist" aria-label={tr('Zespół AI')}>
      {(['agents', 'tasks', 'messages', 'activity'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => { setTab(item); setSelectedTaskId(null); setComposing(false); }}>
        {tr({ agents: 'Agenci', tasks: 'Zadania', messages: 'Wiadomości', activity: 'Aktywność' }[item] as 'Agenci' | 'Zadania' | 'Wiadomości' | 'Aktywność')}
        {item === 'tasks' ? ` (${tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length})` : item === 'messages' ? ` (${messages.filter((m) => !m.readAt).length})` : ''}
      </button>)}
    </div>
    {state.automation.paused && <div className="automation-note">{tr('Automatyzacja wstrzymana. Wyniki trwających zadań nadal można odebrać.')}</div>}
    {!project ? <div className="automation-empty">{tr('Najpierw dodaj projekt')}</div> : <div className="automation-content">
      {((tab === 'tasks' && composing) || tab === 'messages') && <form className="automation-compose" onSubmit={(event) => {
        event.preventDefault();
        if (!targetId || !prompt.trim()) return;
        void run(tab === 'tasks' ? 'create_task' : 'send_message', tab === 'tasks'
          ? { cellId: targetId, title: title.trim(), prompt: prompt.trim() }
          : { toCellId: targetId, text: prompt.trim() }).then((ok) => { if (ok) { setTitle(''); setPrompt(''); setComposing(false); } });
      }}>
        <label>{tr('Odbiorca')}<Select className="select" value={targetId} disabled={busy || !recipients.length} onChange={(e) => setTarget(e.target.value)}>
          {!recipients.length && <option value="">{tr('Brak agentów')}</option>}
          {recipients.map(({ cell, grid }) => <option key={cell.id} value={cell.id}>{grid.name} · {cell.name ?? shownProfileName(getProfile(state, cell.profileId), state.settings.shell, tr)}</option>)}
        </Select></label>
        {tab === 'tasks' && <label>{tr('Tytuł zadania')}<input className="input" disabled={busy} required maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} /></label>}
        <label>{tr(tab === 'tasks' ? 'Treść zadania' : 'Wiadomość')}<textarea className="textarea" disabled={busy} required maxLength={32000} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <button className="btn white" disabled={busy || !targetId || state.automation.paused}>{tr(tab === 'tasks' ? 'Przydziel zadanie' : 'Wyślij wiadomość')}</button>
        <p className="muted">{tr('Zadania i wiadomości trafiają do skrzynki MCP. Potwierdzone sesje Codexa otrzymują je także przez kolejkę.')}</p>
      </form>}
      <div className="automation-list" role="tabpanel">
        {tab === 'agents' && <>
          <p className="muted">{tr('Koordynator może tworzyć zespoły i przydzielać zadania innym agentom.')}</p>
          {!agents.length && <p className="automation-empty">{tr('Brak agentów')}</p>}
          {agents.map(({ cell, grid }) => <article className="automation-card" key={cell.id}>
            <div className="row"><strong>{cell.name ?? shownProfileName(getProfile(state, cell.profileId), state.settings.shell, tr)}</strong><span className="grow" /><span className="muted">{tr(runtimeLabels[runtime[cell.id] ?? 'unknown'])}</span></div>
            {cell.role && <span className={`agent-mcp-status ${info.connectedCellIds?.includes(cell.id) ? 'connected' : ''}`}>{tr(info.connectedCellIds?.includes(cell.id) ? 'MCP działa' : info.configuredCellIds?.includes(cell.id) ? 'MCP skonfigurowane · oczekiwanie na agenta' : 'Wymaga restartu')}
              {!info.configuredCellIds?.includes(cell.id) && <button className="btn small" onClick={() => void changeAgentRole(cell.id, cell.role!)}>{tr('Uruchom ponownie')}</button>}</span>}
            <span className="muted">{grid.name}{cell.worktree ? ` · ${cell.worktree.branch}` : ''}</span>
            <div className="row">
              <RoleSelect value={cell.role} disabled={busy} onChange={(role) => void changeAgentRole(cell.id, role ?? null)} />
              <button className="btn small" onClick={() => focusCell(cell.id)}>{tr('Otwórz agenta')}</button>
              {getProfile(state, cell.profileId).cli === 'codex' && !cell.session?.confirmed && <button className="btn small" onClick={() => { focusCell(cell.id); setUi({ modal: { kind: 'history', projectId: project.id } }); }}>{tr('Wybierz sesję z historii')}</button>}
            </div>
          </article>)}
          <p className="muted">{tr('Po zmianie roli uruchom agenta ponownie, aby włączyć MCP.')}</p>
        </>}
        {tab === 'tasks' && <>
          {selectedTaskId && <button className="btn small task-back" onClick={() => setSelectedTaskId(null)}>← {tr('Wróć do zadań')}</button>}
          {!tasks.length && <p className="automation-empty">{tr('Brak zadań. Przydziel pierwsze zadanie agentowi.')}</p>}
          {!selectedTaskId && finishedTasks > 0 && <div className="row wrap">
            <span className="muted grow">{tr('Zakończone zadania i przeczytane wiadomości starsze niż 7 dni są usuwane automatycznie.')}</span>
            <button className="btn small" disabled={busy} onClick={() => void removeAll('task')}>{tr('Usuń zakończone')} ({finishedTasks})</button>
          </div>}
          <div className={selectedTaskId ? 'task-detail-list' : 'task-card-grid'}>
          {[...tasks].reverse().filter((task) => !selectedTaskId || task.id === selectedTaskId).map((task) => <article className={`automation-card task-${task.status} ${selectedTaskId ? 'task-detail' : 'task-summary'}`} key={task.id}>
            {!selectedTaskId ? <button className="task-open" onClick={() => { setSelectedTaskId(task.id); setComposing(false); }}>
              <div className="task-summary-head"><strong title={task.title}>{task.title}</strong><span className="task-state">{tr(taskLabels[task.status])}</span></div>
              <span className="muted">{label(task.cellId)}</span>
              <span className="task-summary-foot">{delivery(task.delivery)} <span>↗</span></span>
            </button> : <>
            <div className="row"><strong>{task.title}</strong><span className="grow" /><span className="task-state">{tr(taskLabels[task.status as TaskStatus])}</span></div>
            <span className="muted">{label(task.cellId)} · {delivery(task.delivery)}</span>
            <details><summary>{tr('Treść zadania')}</summary><p className="automation-text">{task.prompt}</p></details>
            {task.blockedReason && <p className="automation-text blocked-reason">{task.blockedReason}</p>}
            {task.result && <details open><summary>{tr('Wynik zadania')}</summary>
              <p className="automation-text">{task.result.summary}</p>
              {(task.result.branch || task.result.commit) && <p className="muted">{[task.result.branch, task.result.commit].filter(Boolean).join(' · ')}</p>}
              {task.result.files.length > 0 && <p className="automation-text"><strong>{tr('Pliki')}: </strong>{task.result.files.join(', ')}</p>}
              {task.result.tests.length > 0 && <p className="automation-text"><strong>{tr('Testy')}: </strong>{task.result.tests.join('\n')}</p>}
            </details>}
            {task.deliveryError && task.status === 'queued' && <p className="muted">{tr('Oczekuje w skrzynce. Możesz skopiować prompt do terminala.')}</p>}
            <div className="row wrap">
              <button className="btn small" disabled={!agents.some(({ cell }) => cell.id === task.cellId)} onClick={() => focusCell(task.cellId)}>{tr('Otwórz agenta')}</button>
              {!['completed', 'cancelled'].includes(task.status) && <>
                <button className="btn small" onClick={() => copy(taskPrompt(task))}>{tr('Kopiuj prompt')}</button>
                {task.delivery === 'pending' && <button className="btn small" disabled={busy || state.automation.paused} onClick={() => void run('deliver_task', { taskId: task.id })}>{tr('Ponów dostarczenie')}</button>}
                <button className="btn small" disabled={busy} onClick={() => void run('update_task', { taskId: task.id, status: 'cancelled' })}>{tr('Anuluj zadanie')}</button>
              </>}
              {removable(task) && <button className="btn small" disabled={busy} onClick={() => remove('task', [task.id])}>{tr('Usuń')}</button>}
            </div>
          </>}
          </article>)}
          </div>
        </>}
        {tab === 'messages' && <>
          {!messages.length && <p className="automation-empty">{tr('Brak wiadomości')}</p>}
          {readMessages > 0 && <div className="row wrap">
            <span className="muted grow">{tr('Zakończone zadania i przeczytane wiadomości starsze niż 7 dni są usuwane automatycznie.')}</span>
            <button className="btn small" disabled={busy} onClick={() => void removeAll('message')}>{tr('Usuń przeczytane')} ({readMessages})</button>
          </div>}
          {[...messages].reverse().map((message) => <article className="automation-card" key={message.id}>
            <div className="row"><strong>{label(message.fromCellId)} → {label(message.toCellId)}</strong><span className="grow" /><span className="muted">{message.readAt ? tr('Przeczytane') : delivery(message.delivery)}</span></div>
            <p className="automation-text">{message.text}</p>
            <div className="row wrap">
              <button className="btn small" disabled={!agents.some(({ cell }) => cell.id === message.toCellId)} onClick={() => focusCell(message.toCellId)}>{tr('Otwórz agenta')}</button>
              <button className="btn small" onClick={() => copy(`[Unimux message ${message.id}]\n${message.text}\nUse read_inbox with acknowledge:true to mark it read.`)}>{tr('Kopiuj prompt')}</button>
              {message.delivery === 'pending' && !message.readAt && <button className="btn small" disabled={busy || state.automation.paused} onClick={() => void run('deliver_message', { messageId: message.id })}>{tr('Ponów dostarczenie')}</button>}
              {!message.readAt && <button className="btn small" disabled={busy} onClick={() => void run('acknowledge_message', { messageId: message.id })}>{tr('Oznacz jako przeczytane')}</button>}
              {message.readAt && <button className="btn small" disabled={busy} onClick={() => remove('message', [message.id])}>{tr('Usuń')}</button>}
            </div>
          </article>)}
        </>}
        {tab === 'activity' && <>
          {!state.automation.events.some((e) => e.projectId === project.id) && <p className="automation-empty">{tr('Brak aktywności')}</p>}
          {state.automation.events.filter((e) => e.projectId === project.id).slice(-50).reverse().map((event) => <article className="automation-card" key={event.id}>
            <div className="row"><strong>{event.detail}</strong><span className="grow" /><time className="muted">{new Date(event.createdAt).toLocaleTimeString()}</time></div>
            <span className="muted">{label(event.cellId)}</span>
          </article>)}
        </>}
      </div>
    </div>}
  </section>;
}

const HEIGHT_KEY = 'mc-automation-height-v1';
const MIN_PANEL = 140;
const MIN_GRID = 200;
const DEFAULT_PANEL = 310;
function readPanelHeight(): number | null {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(value) && value >= MIN_PANEL ? Math.round(value) : null;
  } catch { return null; }
}

/**
 * The divider on top of the AI team panel: drag it (up = taller) or use ArrowUp/ArrowDown (Shift for bigger steps), Home/End.
 * The saved height is only a flex basis (styles.css), so a smaller window shrinks the panel; here it is clamped so the grid
 * above keeps at least MIN_GRID pixels.
 */
function PanelSplitter({ section, height, onChange }: { section: React.RefObject<HTMLElement | null>; height: number | null; onChange: (height: number, save: boolean) => void }) {
  const { tr } = useI18n();
  const drag = useRef<{ id: number; y: number; start: number; last: number | null; release: () => void } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** What the panel really shows (a saved height may be shrunk by a short window) and the largest height the room allows. */
  const [measured, setMeasured] = useState<{ now: number; max: number }>({ now: height ?? DEFAULT_PANEL, max: height ?? DEFAULT_PANEL });
  useEffect(() => () => drag.current?.release(), []);
  const content = () => section.current?.parentElement?.querySelector<HTMLElement>(':scope > .workspace-content') ?? null;
  /** The room shared by the grid and the panel. */
  const room = () => (section.current?.offsetHeight ?? DEFAULT_PANEL) + (content()?.offsetHeight ?? MIN_GRID);
  const maxHeight = () => Math.max(MIN_PANEL, room() - MIN_GRID);
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const measure = () => setMeasured((m) => {
      const next = { now: el.offsetHeight, max: maxHeight() };
      return next.now === m.now && next.max === m.max ? m : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const grid = content();
    if (grid) observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  const clamp = (value: number) => Math.round(Math.max(MIN_PANEL, Math.min(maxHeight(), value)));
  /** The rendered height: a saved height may have been shrunk by a smaller window. */
  const current = () => section.current?.offsetHeight ?? height ?? DEFAULT_PANEL;
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (d.last !== null) onChange(d.last, true);
    // After the final height is rendered, so each terminal is fitted once.
    setTimeout(d.release, 0);
  };
  return <div
    className={`automation-splitter ${dragging ? 'dragging' : ''}`}
    role="separator"
    aria-orientation="horizontal"
    aria-label={tr('Zmień wysokość panelu zespołu AI')}
    aria-valuemin={MIN_PANEL}
    aria-valuemax={measured.max}
    aria-valuenow={measured.now}
    aria-valuetext={tr('{width} pikseli', { width: measured.now })}
    tabIndex={0}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current?.release();
      drag.current = { id: e.pointerId, y: e.clientY, start: current(), last: null, release: terminals.holdFits() };
      setDragging(true);
    }}
    onPointerMove={(e) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      d.last = clamp(d.start - (e.clientY - d.y));
      onChange(d.last, false);
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
    onLostPointerCapture={finish}
    onKeyDown={(e) => {
      const step = e.shiftKey ? 72 : 24;
      const next = e.key === 'ArrowUp' ? current() + step : e.key === 'ArrowDown' ? current() - step
        : e.key === 'Home' ? MIN_PANEL : e.key === 'End' ? Number.POSITIVE_INFINITY : null;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(clamp(next), true);
    }}
  />;
}
