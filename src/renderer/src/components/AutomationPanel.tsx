// "Zespół AI" (1.1.2 redesign): the bottom panel of agent tasks and messages over unimux's MCP server. One compact header (the
// tabs with their counts, the MCP state, the agent filter, the actions), then per tab a list and its detail side by side:
// tasks grouped by state (in progress, open, done) with who assigned what to whom and how long ago; message threads per agent
// with a composer; the agents with their runtime and MCP state; the activity log. The resizable height stays (PanelSplitter).
// The logic (groups, threads, filter, copied texts) is in shared/teamPanel.ts.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { isClosedTask, taskPrompt, type AgentMessage, type AgentRuntimeStatus, type AgentTask, type AutomationInput, type AutomationOperation, type TaskStatus } from '../../../shared/automation';
import { cellShell, shownProfileName } from '../../../shared/profiles';
import { getProfile } from '../../../shared/state';
import { activityOf, groupTasks, messageThreads, openPrerequisites, reassignInput, resultText, teamCounts, threadMessages, type TaskGroupId } from '../../../shared/teamPanel';
import type { AppState, Cell, Tab } from '../../../shared/types';
import { waitAge } from '../../../shared/waiting';
import { focusCell } from '../actions';
import { changeAgentRole } from '../agentRoles';
import { useI18n } from '../i18n';
import { terminals } from '../terminals/TerminalManager';
import { askChoice, setUi, toast, useStore } from '../store';
import { useWaitClock } from '../waiting';
import { IChevron, IPlus, IPrompt, IX } from './icons';
import { PanelEmpty } from './PanelEmpty';
import { ProviderIcon } from './ProviderIcons';
import { RoleSelect } from './RoleSelect';
import { Select } from './Select';
import './teamPanel.css';

type Tr = ReturnType<typeof useI18n>['tr'];
type TabId = 'tasks' | 'messages' | 'agents' | 'activity';
interface Agent { cell: Cell; grid: Tab; name: string; cli: 'claude' | 'codex' }

const taskLabels = { queued: 'W kolejce', in_progress: 'W trakcie', blocked: 'Zablokowane', completed: 'Ukończone', cancelled: 'Anulowane' } as const;
const runtimeLabels = { starting: 'Uruchamianie', working: 'pracuje', ready: 'Gotowy', needs_attention: 'Wymaga uwagi', unknown: 'Brak potwierdzenia', exited: 'zakończony' } as const;
const groupLabels = { progress: 'W trakcie', open: 'Otwarte', done: 'Zakończone' } as const;
const tabLabels = { tasks: 'Zadania', messages: 'Wiadomości', agents: 'Agenci', activity: 'Aktywność' } as const;
/** What an activity entry did (automation.ts log actions); others show no label. */
const actionLabels: Record<string, Parameters<Tr>[0]> = {
  task_created: 'Nowe zadanie', task_in_progress: 'W trakcie', task_blocked: 'Zablokowane', task_completed: 'Ukończone', task_cancelled: 'Anulowane', message: 'Wiadomość',
};

const PauseIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" /><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" /></svg>;
const ResumeIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3v10l8-5z" fill="currentColor" /></svg>;
const CopyIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M3 10.5V3.5A1.5 1.5 0 0 1 4.5 2h6" /></svg>;
const OpenIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>;

/** The mark of an agent (Claude's spark, Codex's cloud) or the user. */
function Mark({ agent }: { agent?: Agent }) {
  return <span className="team-mark">{agent ? <ProviderIcon provider={agent.cli} size={12} /> : <IPrompt />}</span>;
}

/** "12 min", "3 godz." from a time; the exact time is in the title. */
function Age({ at, now, tr, language }: { at: number; now: number; tr: Tr; language: string }) {
  const age = waitAge(at, now);
  return <time className="team-age" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString(language)}>{tr(age.key, age.params)}</time>;
}

const clock = (at: number, language: string) => {
  const d = new Date(at);
  return Date.now() - at < 86_400_000 ? d.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function AutomationPanel() {
  const { tr, errorText, language } = useI18n();
  // Only what the panel shows: a change of a terminal title or a layout does not render it again.
  const automation = useStore((s) => s.s.automation);
  const projects = useStore((s) => s.s.projects);
  const activeProjectId = useStore((s) => s.s.activeProjectId);
  const profiles = useStore((s) => s.s.profiles);
  const shell = useStore((s) => s.s.settings.shell);
  const info = useStore((s) => s.ui.mcpInfo);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const [tab, setTab] = useState<TabId>('tasks');
  const [filter, setFilter] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState<Record<string, AgentRuntimeStatus> | null>(null);
  const section = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(readPanelHeight);
  const now = useWaitClock(true);
  /** A drag only renders the new height; the end of the drag and every key step save it. */
  const changeHeight = (next: number, save: boolean) => {
    setHeight(next);
    if (save) try { localStorage.setItem(HEIGHT_KEY, String(next)); } catch { /* the height just is not remembered */ }
  };

  const agents = useMemo<Agent[]>(() => {
    const s = { profiles } as AppState;
    return project?.tabs.flatMap((grid) => grid.cells.flatMap((cell) => {
      const profile = getProfile(s, cell.profileId);
      if (profile.cli === 'shell' || cell.ssh) return [];
      return [{ cell, grid, cli: profile.cli, name: cell.name ?? shownProfileName(profile, cellShell(cell, shell), tr) }];
    })) ?? [];
  }, [project, profiles, shell, tr]);
  const agentOf = useMemo(() => new Map(agents.map((a) => [a.cell.id, a])), [agents]);
  const name = (cellId?: string) => cellId ? agentOf.get(cellId)?.name ?? tr('Agent niedostępny') : tr('Ty');
  const filterId = filter && agentOf.has(filter) ? filter : null;
  const tasks = useMemo(() => automation.tasks.filter((t) => t.projectId === project?.id), [automation.tasks, project?.id]);
  const messages = useMemo(() => automation.messages.filter((m) => m.projectId === project?.id), [automation.messages, project?.id]);
  const counts = teamCounts(tasks, messages, filterId);

  useEffect(() => { setSelectedTaskId(null); setComposing(false); setFilter(''); setThread(null); }, [project?.id]);
  // The filter picks the thread with that agent.
  useEffect(() => { setThread(filterId); }, [filterId]);

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
  const copy = (text: string, done: Parameters<Tr>[0] = 'Skopiowano. Wklej do wybranego agenta.') => { window.mc.clipboardWrite(text); toast(tr(done)); };
  /** Closed tasks an open task still depends on stay (main keeps them), so they are neither counted nor offered for removal. */
  const needed = useMemo(() => new Set(automation.tasks.filter((t) => !isClosedTask(t)).flatMap((t) => t.dependsOn ?? [])), [automation.tasks]);
  const removable = (task: AgentTask) => isClosedTask(task) && !needed.has(task.id);
  const remove = (kind: 'task' | 'message', ids?: string[]) => {
    if (!project) return;
    void run('remove_items', { projectId: project.id, kind, ...(ids ? { ids } : {}) }).then((ok) => { if (ok && kind === 'task' && ids?.includes(selectedTaskId ?? '')) setSelectedTaskId(null); });
  };
  /** Removing all finished items asks first (like removing a project). */
  const removeAll = async (kind: 'task' | 'message', count: number) => {
    const choice = await askChoice(
      kind === 'task' ? tr('Usunąć {count} zakończonych zadań?', { count }) : tr('Usunąć {count} przeczytanych wiadomości?', { count }),
      tr('Tego nie można cofnąć. Otwarte zadania i nieprzeczytane wiadomości zostają.'),
      [{ label: tr(kind === 'task' ? 'Usuń zakończone' : 'Usuń przeczytane'), value: 'yes', danger: true }],
    );
    if (choice === 'yes') remove(kind);
  };
  const ctx: Ctx = { tr, language, now, busy, paused: automation.paused, agents, agentOf, name, run, copy, remove, removeAll, removable, filterId };

  const tabs: Array<{ id: TabId; count?: number; alert?: boolean }> = [
    { id: 'tasks', count: counts.openTasks }, { id: 'messages', count: counts.unread, alert: counts.unread > 0 }, { id: 'agents', count: agents.length }, { id: 'activity' },
  ];
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    setTab(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  };

  return <section ref={section} className="automation-panel team-panel" aria-label={tr('Zadania i wiadomości agentów')} style={height ? { '--automation-height': `${height}px` } as CSSProperties : undefined}>
    <PanelSplitter section={section} height={height} onChange={changeHeight} />
    <header className="team-head">
      <strong className="team-title">{tr('Zespół AI')}</strong>
      <McpPill info={info} tr={tr} />
      <div className="team-tabs" role="tablist" aria-label={tr('Zespół AI')} onKeyDown={onTabKey}>
        {tabs.map((t) => <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className={`team-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
          {tr(tabLabels[t.id])}{t.count !== undefined && <span className={`team-tab-count ${t.alert ? 'alert' : ''}`}>{t.count}</span>}
        </button>)}
      </div>
      <span className="team-grow" />
      {agents.length > 1 && <Select className="select team-filter" title={tr('Filtruj według agenta')} aria-label={tr('Filtruj według agenta')} value={filterId ?? ''} onChange={(e) => setFilter(e.target.value)}>
        <option value="">{tr('Wszyscy agenci')}</option>
        {agents.map((a) => <option key={a.cell.id} value={a.cell.id}>{a.name} · {a.grid.name}</option>)}
      </Select>}
      {tab === 'tasks' && project && <button type="button" className={`btn small team-new-task ${composing ? 'on' : ''}`} disabled={!agents.some((a) => a.cell.role)} onClick={() => { setComposing((v) => !v); }}>
        <IPlus /> {tr('Nowe zadanie')}
      </button>}
      <button type="button" className={`team-icon-btn ${automation.paused ? 'paused' : ''}`} disabled={busy} title={tr(automation.paused ? 'Wznów automatyzację' : 'Wstrzymaj automatyzację')} aria-label={tr(automation.paused ? 'Wznów automatyzację' : 'Wstrzymaj automatyzację')} aria-pressed={automation.paused}
        onClick={() => void run('set_paused', { paused: !automation.paused })}>{automation.paused ? <ResumeIcon /> : <PauseIcon />}</button>
      <button type="button" className="team-icon-btn" aria-label={tr('Zamknij')} title={tr('Zamknij')} onClick={() => setUi({ automationOpen: false })}><IX /></button>
    </header>
    {automation.paused && <div className="team-banner warn" role="status">
      <span>{tr('Automatyzacja wstrzymana. Wyniki trwających zadań nadal można odebrać.')}</span>
      <button type="button" className="btn small" disabled={busy} onClick={() => void run('set_paused', { paused: false })}>{tr('Wznów automatyzację')}</button>
    </div>}
    {!info.running && !info.starting && <div className="team-banner error" role="alert">
      <span>{tr('Serwer MCP nie działa. Agenci nie widzą zadań ani wiadomości, dopóki nie wystartuje.')}{info.error ? ` (${info.error})` : ''}</span>
      <button type="button" className="btn small" disabled={busy} onClick={() => { setBusy(true); void window.mc.retryMcp().then((mcpInfo) => setUi({ mcpInfo })).catch(() => {}).finally(() => setBusy(false)); }}>{tr('Spróbuj ponownie')}</button>
    </div>}
    {!project ? <PanelEmpty className="team-empty"><p>{tr('Najpierw dodaj projekt')}</p></PanelEmpty>
      : tab === 'tasks' ? <TasksView ctx={ctx} tasks={tasks} selectedId={selectedTaskId} select={setSelectedTaskId} composing={composing} setComposing={setComposing} />
      : tab === 'messages' ? <MessagesView ctx={ctx} messages={messages} thread={thread} setThread={setThread} />
      : tab === 'agents' ? <AgentsView ctx={ctx} info={info} runtime={runtime} tasks={tasks} projectId={project.id} />
      : <ActivityView ctx={ctx} projectId={project.id} />}
  </section>;
}

interface Ctx {
  tr: Tr; language: string; now: number; busy: boolean; paused: boolean; filterId: string | null;
  agents: Agent[]; agentOf: Map<string, Agent>; name: (cellId?: string) => string;
  run: <K extends AutomationOperation>(operation: K, args: AutomationInput<K>) => Promise<boolean>;
  copy: (text: string, done?: Parameters<Tr>[0]) => void;
  remove: (kind: 'task' | 'message', ids?: string[]) => void;
  removeAll: (kind: 'task' | 'message', count: number) => Promise<void>;
  removable: (task: AgentTask) => boolean;
}

function McpPill({ info, tr }: { info: ReturnType<typeof useStore.getState>['ui']['mcpInfo']; tr: Tr }) {
  const state = info.running ? 'on' : info.starting ? 'starting' : 'off';
  const label = info.running ? tr('Serwer MCP działa') : info.starting ? tr('Uruchamianie serwera MCP') : tr('MCP niedostępne');
  return <span className={`team-mcp ${state}`} title={info.error ?? info.url ?? label} role="status"><span className="team-dot" />{label}</span>;
}

/** Arrow keys move along the rows of a list (like the "Czeka na Ciebie" list). */
function rowKeys(e: KeyboardEvent<HTMLElement>, selector: string) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (!rows.length) return;
  e.preventDefault();
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
  if (rows[next] === document.activeElement) return;
  rows[next].focus();
  rows[next].click();
}

// ── tasks ────────────────────────────────────────────────────────────────────

function TasksView({ ctx, tasks, selectedId, select, composing, setComposing }: { ctx: Ctx; tasks: AgentTask[]; selectedId: string | null; select: (id: string | null) => void; composing: boolean; setComposing: (v: boolean) => void }) {
  const { tr, filterId } = ctx;
  const groups = useMemo(() => groupTasks(tasks, filterId), [tasks, filterId]);
  const open = groups[0].tasks.length + groups[1].tasks.length;
  const [collapsed, setCollapsed] = useState<Set<TaskGroupId>>(() => new Set(open > 0 ? ['done'] : []));
  const shown = groups.flatMap((g) => g.tasks);
  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const finished = tasks.filter(ctx.removable).length;
  const toggle = (id: TaskGroupId) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return <div className="team-body">
    <div className="team-list-col">
      {composing && <TaskComposer ctx={ctx} close={() => setComposing(false)} created={() => setComposing(false)} />}
      {!shown.length && !composing && <PanelEmpty className="team-empty">
        <p>{tr(filterId ? 'Ten agent nie ma zadań.' : 'Brak zadań. Przydziel pierwsze zadanie agentowi.')}</p>
        {!filterId && <p>{tr('Koordynator przydziela zadania przez MCP; możesz też zrobić to tutaj.')}</p>}
      </PanelEmpty>}
      {!!shown.length && <div className="team-list" role="list" aria-label={tr('Zadania')} onKeyDown={(e) => rowKeys(e, '.team-task-row')}>
        {groups.map((group) => !group.tasks.length ? null : <div key={group.id} className="team-group" role="group" aria-label={tr(groupLabels[group.id])}>
          <div className="team-group-head">
            <button type="button" className="team-group-toggle" aria-expanded={!collapsed.has(group.id)} onClick={() => toggle(group.id)}>
              <span className={`team-chev ${collapsed.has(group.id) ? 'closed' : ''}`}><IChevron /></span>
              {tr(groupLabels[group.id])}<span className="team-group-count">{group.tasks.length}</span>
            </button>
            {group.id === 'done' && finished > 0 && !collapsed.has('done') && <button type="button" className="team-group-action" disabled={ctx.busy} onClick={() => void ctx.removeAll('task', finished)}>{tr('Usuń zakończone')}</button>}
          </div>
          {!collapsed.has(group.id) && group.tasks.map((task) => <TaskRow key={task.id} ctx={ctx} task={task} tasks={tasks} selected={task.id === selectedId} onSelect={() => select(task.id === selectedId ? null : task.id)} />)}
        </div>)}
      </div>}
    </div>
    <div className="team-detail-col">
      {selected ? <TaskDetail ctx={ctx} task={selected} tasks={tasks} select={select} />
        : <PanelEmpty className="team-empty"><p>{tr('Wybierz zadanie, aby zobaczyć treść, wynik i akcje.')}</p>
          <p className="team-muted">{tr('Zakończone zadania i przeczytane wiadomości starsze niż 7 dni są usuwane automatycznie.')}</p></PanelEmpty>}
    </div>
  </div>;
}

function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`team-status ${status}`} aria-hidden="true" />;
}

function TaskRow({ ctx, task, tasks, selected, onSelect }: { ctx: Ctx; task: AgentTask; tasks: AgentTask[]; selected: boolean; onSelect: () => void }) {
  const { tr, name, agentOf } = ctx;
  const waits = task.status === 'queued' ? openPrerequisites(task, tasks).length : 0;
  return <div role="listitem">
    <button type="button" className={`team-task-row ${task.status} ${selected ? 'on' : ''}`} aria-current={selected || undefined} onClick={onSelect}>
      <StatusDot status={task.status} />
      <span className="team-row-main">
        <span className="team-row-line"><span className="team-row-title" title={task.title}>{task.title}</span><Age at={task.updatedAt} now={ctx.now} tr={tr} language={ctx.language} /></span>
        <span className="team-row-meta">
          <span className="team-who"><Mark agent={task.fromCellId ? agentOf.get(task.fromCellId) : undefined} />{name(task.fromCellId)}<span className="team-arrow">→</span><Mark agent={agentOf.get(task.cellId)} />{name(task.cellId)}</span>
          {task.status === 'blocked' && <span className="team-tag warn">{tr('Zablokowane')}</span>}
          {waits > 0 && <span className="team-tag">{tr('czeka na zadania: {n}', { n: waits })}</span>}
          {task.delivery === 'pending' && !isClosedTask(task) && <span className="team-tag" title={task.deliveryError}>{tr('W skrzynce agenta')}</span>}
          {task.status === 'cancelled' && <span className="team-tag">{tr('Anulowane')}</span>}
        </span>
      </span>
    </button>
  </div>;
}

function TaskDetail({ ctx, task, tasks, select }: { ctx: Ctx; task: AgentTask; tasks: AgentTask[]; select: (id: string | null) => void }) {
  const { tr, name, agentOf, busy, paused, language } = ctx;
  const open = !isClosedTask(task);
  const waits = openPrerequisites(task, tasks);
  const agent = agentOf.get(task.cellId);
  return <article className={`team-detail ${task.status}`} aria-label={task.title}>
    <div className="team-detail-head">
      <span className={`team-chip ${task.status}`}><StatusDot status={task.status} />{tr(taskLabels[task.status])}</span>
      <h3 className="team-detail-title">{task.title}</h3>
      <button type="button" className="team-icon-btn team-task-back" aria-label={tr('Zamknij')} title={tr('Zamknij')} onClick={() => select(null)}><IX /></button>
    </div>
    <div className="team-detail-meta">
      <span className="team-who"><Mark agent={task.fromCellId ? agentOf.get(task.fromCellId) : undefined} />{name(task.fromCellId)}<span className="team-arrow">→</span><Mark agent={agent} />{name(task.cellId)}{agent ? <span className="team-muted"> · {agent.grid.name}</span> : null}</span>
      <span>{tr('Utworzono {time}', { time: clock(task.createdAt, language) })}</span>
      {task.updatedAt !== task.createdAt && <span>{tr('Zmieniono {time}', { time: clock(task.updatedAt, language) })}</span>}
      <span>{tr(task.delivery === 'native' ? 'Przekazano do sesji' : task.delivery === 'startup' ? 'Prompt startowy' : 'W skrzynce agenta')}</span>
    </div>
    {task.blockedReason && <div className="team-callout warn"><strong>{tr('Zablokowane')}</strong><p className="team-text">{task.blockedReason}</p></div>}
    {waits.length > 0 && <div className="team-callout"><strong>{tr('Czeka na')}</strong>
      <span className="team-deps">{waits.map((w) => <button key={w.id} type="button" className="team-dep" disabled={!w.task} onClick={() => w.task && select(w.id)}>{w.task ? <><StatusDot status={w.task.status} />{w.task.title}</> : w.id}</button>)}</span>
    </div>}
    {task.deliveryError && open && <p className="team-muted team-small">{tr('Oczekuje w skrzynce. Możesz skopiować prompt do terminala.')}</p>}
    {task.result && <section className="team-section">
      <h4>{tr('Wynik zadania')}</h4>
      <p className="team-text">{task.result.summary}</p>
      {(task.result.branch || task.result.commit) && <p className="team-refs">{task.result.branch && <code>{task.result.branch}</code>}{task.result.commit && <code>{task.result.commit}</code>}</p>}
      {task.result.files.length > 0 && <><h5>{tr('Pliki')} <span className="team-group-count">{task.result.files.length}</span></h5><ul className="team-files">{task.result.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul></>}
      {task.result.tests.length > 0 && <><h5>{tr('Testy')}</h5><ul className="team-files">{task.result.tests.map((t) => <li key={t}>{t}</li>)}</ul></>}
    </section>}
    <details className="team-section" open={!task.result}>
      <summary><h4>{tr('Treść zadania')}</h4></summary>
      <p className="team-text">{task.prompt}</p>
    </details>
    <div className="team-actions">
      <button type="button" className="btn small" disabled={!agent} onClick={() => focusCell(task.cellId)}><OpenIcon /> {tr('Otwórz agenta')}</button>
      {task.result && <button type="button" className="btn small" onClick={() => ctx.copy(resultText(task.result!), 'Skopiowano wynik.')}><CopyIcon /> {tr('Kopiuj wynik')}</button>}
      {open && <button type="button" className="btn small" onClick={() => ctx.copy(taskPrompt(task))}><CopyIcon /> {tr('Kopiuj prompt')}</button>}
      {open && task.delivery === 'pending' && <button type="button" className="btn small" disabled={busy || paused} onClick={() => void ctx.run('deliver_task', { taskId: task.id })}>{tr('Ponów dostarczenie')}</button>}
      {!open && agent?.cell.role && <button type="button" className="btn small" disabled={busy || paused} onClick={() => void ctx.run('create_task', reassignInput(task))}>{tr('Przydziel ponownie')}</button>}
      <span className="team-grow" />
      {open && <button type="button" className="btn small ghost team-danger" disabled={busy} onClick={() => void ctx.run('update_task', { taskId: task.id, status: 'cancelled' })}>{tr('Anuluj zadanie')}</button>}
      {ctx.removable(task) && <button type="button" className="btn small ghost team-danger" disabled={busy} onClick={() => ctx.remove('task', [task.id])}>{tr('Usuń')}</button>}
    </div>
  </article>;
}

/** The inline "Nowe zadanie" form at the top of the list: agent, title, instructions; Ctrl+Enter assigns, Escape closes. */
function TaskComposer({ ctx, close, created }: { ctx: Ctx; close: () => void; created: () => void }) {
  const { tr, busy, paused } = ctx;
  const recipients = ctx.agents.filter((a) => a.cell.role);
  const [target, setTarget] = useState(ctx.filterId && recipients.some((a) => a.cell.id === ctx.filterId) ? ctx.filterId : recipients[0]?.cell.id ?? '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const valid = !!target && !!title.trim() && !!prompt.trim();
  const submit = () => {
    if (!valid || busy || paused) return;
    void ctx.run('create_task', { cellId: target, title: title.trim(), prompt: prompt.trim() }).then((ok) => { if (ok) created(); });
  };
  return <form className="team-compose" aria-label={tr('Nowe zadanie')} onSubmit={(e) => { e.preventDefault(); submit(); }}
    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}>
    <div className="team-compose-row">
      <Select className="select team-compose-agent" aria-label={tr('Odbiorca')} value={target} disabled={busy || !recipients.length} onChange={(e) => setTarget(e.target.value)}>
        {!recipients.length && <option value="">{tr('Brak agentów')}</option>}
        {recipients.map((a) => <option key={a.cell.id} value={a.cell.id}>{a.name} · {a.grid.name}</option>)}
      </Select>
      <input className="input team-compose-title" autoFocus aria-label={tr('Tytuł zadania')} placeholder={tr('Tytuł zadania')} disabled={busy} maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} />
    </div>
    <textarea className="textarea team-compose-text" aria-label={tr('Treść zadania')} placeholder={tr('Treść zadania')} disabled={busy} maxLength={32000} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
    <div className="team-compose-row">
      <span className="team-muted team-small team-grow">{tr('Ctrl+Enter przydziela, Esc zamyka.')}</span>
      <button type="button" className="btn small ghost" onClick={close}>{tr('Anuluj')}</button>
      <button type="submit" className="btn small primary" disabled={!valid || busy || paused}>{tr('Przydziel zadanie')}</button>
    </div>
  </form>;
}

// ── messages ─────────────────────────────────────────────────────────────────

function MessagesView({ ctx, messages, thread, setThread }: { ctx: Ctx; messages: AgentMessage[]; thread: string | null; setThread: (id: string | null) => void }) {
  const { tr, name, agentOf, now, language } = ctx;
  const threads = useMemo(() => messageThreads(messages), [messages]);
  const shown = useMemo(() => threadMessages(messages, thread), [messages, thread]);
  const read = shown.filter((m) => m.readAt).length;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread, shown.length]);
  const preview = (m: AgentMessage) => `${name(m.fromCellId)} → ${name(m.toCellId)}: ${m.text}`;
  return <div className="team-body">
    <div className="team-list-col">
      <div className="team-list" role="list" aria-label={tr('Wiadomości')} onKeyDown={(e) => rowKeys(e, '.team-thread-row')}>
        <div role="listitem"><button type="button" className={`team-thread-row ${thread === null ? 'on' : ''}`} onClick={() => setThread(null)}>
          <span className="team-mark team-mark-all" aria-hidden="true">*</span>
          <span className="team-row-main"><span className="team-row-line"><span className="team-row-title">{tr('Wszystkie wiadomości')}</span>{messages.length > 0 && <span className="team-group-count">{messages.length}</span>}</span></span>
        </button></div>
        {threads.map((t) => <div role="listitem" key={t.cellId}><button type="button" className={`team-thread-row team-thread-agent ${thread === t.cellId ? 'on' : ''}`} onClick={() => setThread(t.cellId)}>
          <Mark agent={agentOf.get(t.cellId)} />
          <span className="team-row-main">
            <span className="team-row-line"><span className="team-row-title">{name(t.cellId)}</span>{t.unread > 0 && <span className="team-tab-count alert" aria-label={tr('Nieprzeczytane: {n}', { n: t.unread })}>{t.unread}</span>}<Age at={t.last.createdAt} now={now} tr={tr} language={language} /></span>
            <span className="team-row-preview" title={preview(t.last)}>{preview(t.last)}</span>
          </span>
        </button></div>)}
        {!threads.length && <PanelEmpty className="team-empty"><p>{tr('Brak wiadomości')}</p></PanelEmpty>}
      </div>
    </div>
    <div className="team-detail-col team-thread">
      <div className="team-thread-head">
        {thread ? <><Mark agent={agentOf.get(thread)} /><strong>{name(thread)}</strong>{agentOf.get(thread) && <span className="team-muted">{agentOf.get(thread)!.grid.name}</span>}</> : <strong>{tr('Wszystkie wiadomości')}</strong>}
        <span className="team-grow" />
        {thread && agentOf.has(thread) && <button type="button" className="btn small" onClick={() => focusCell(thread)}><OpenIcon /> {tr('Otwórz agenta')}</button>}
        {read > 0 && <button type="button" className="btn small ghost" disabled={ctx.busy} onClick={() => thread ? ctx.remove('message', shown.filter((m) => m.readAt).map((m) => m.id)) : void ctx.removeAll('message', read)}>{tr('Usuń przeczytane')}</button>}
      </div>
      <div className="team-messages" role="log" aria-label={thread ? name(thread) : tr('Wszystkie wiadomości')}>
        {!shown.length && <PanelEmpty className="team-empty"><p>{tr(thread ? 'Brak wiadomości z tym agentem.' : 'Brak wiadomości')}</p></PanelEmpty>}
        {shown.map((m) => <MessageItem key={m.id} ctx={ctx} message={m} mine={!!thread && m.fromCellId === thread} />)}
        <div ref={end} />
      </div>
      <MessageComposer ctx={ctx} to={thread} />
    </div>
  </div>;
}

function MessageItem({ ctx, message, mine }: { ctx: Ctx; message: AgentMessage; mine: boolean }) {
  const { tr, name, agentOf, busy, paused, language } = ctx;
  return <article className={`team-msg ${mine ? 'out' : 'in'} ${message.readAt ? 'read' : 'unread'}`}>
    <div className="team-msg-head">
      <span className="team-who"><Mark agent={message.fromCellId ? agentOf.get(message.fromCellId) : undefined} />{name(message.fromCellId)}<span className="team-arrow">→</span>{name(message.toCellId)}</span>
      <span className="team-grow" />
      <span className={`team-msg-state ${message.readAt ? '' : 'unread'}`}>{message.readAt ? tr('Przeczytane') : tr(message.delivery === 'native' ? 'Przekazano do sesji' : 'W skrzynce agenta')}</span>
      <time className="team-age" title={new Date(message.createdAt).toLocaleString(language)}>{clock(message.createdAt, language)}</time>
    </div>
    <p className="team-text">{message.text}</p>
    <div className="team-msg-actions">
      <button type="button" className="team-icon-btn" title={tr('Kopiuj prompt')} aria-label={tr('Kopiuj prompt')} onClick={() => ctx.copy(`[Unimux message ${message.id}]\n${message.text}\nUse read_inbox with acknowledge:true to mark it read.`)}><CopyIcon /></button>
      {agentOf.has(message.toCellId) && <button type="button" className="team-icon-btn" title={tr('Otwórz agenta')} aria-label={tr('Otwórz agenta')} onClick={() => focusCell(message.toCellId)}><OpenIcon /></button>}
      {message.delivery === 'pending' && !message.readAt && <button type="button" className="btn small ghost" disabled={busy || paused} onClick={() => void ctx.run('deliver_message', { messageId: message.id })}>{tr('Ponów dostarczenie')}</button>}
      {!message.readAt && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void ctx.run('acknowledge_message', { messageId: message.id })}>{tr('Oznacz jako przeczytane')}</button>}
      {message.readAt && <button type="button" className="btn small ghost team-danger" disabled={busy} onClick={() => ctx.remove('message', [message.id])}>{tr('Usuń')}</button>}
    </div>
  </article>;
}

/** Writes to the thread's agent, or (all messages) to the chosen one; Ctrl+Enter sends. */
function MessageComposer({ ctx, to }: { ctx: Ctx; to: string | null }) {
  const { tr, busy, paused } = ctx;
  const recipients = ctx.agents.filter((a) => a.cell.role);
  const [pick, setPick] = useState('');
  const [text, setText] = useState('');
  const target = to && recipients.some((a) => a.cell.id === to) ? to : recipients.some((a) => a.cell.id === pick) ? pick : recipients[0]?.cell.id ?? '';
  const send = () => {
    if (!target || !text.trim() || busy || paused) return;
    void ctx.run('send_message', { toCellId: target, text: text.trim() }).then((ok) => { if (ok) setText(''); });
  };
  if (!recipients.length) return null;
  const canWrite = !to || recipients.some((a) => a.cell.id === to);
  if (!canWrite) return <p className="team-muted team-small team-compose-note">{tr('Ten agent nie ma włączonego MCP, więc nie odbiera wiadomości.')}</p>;
  return <form className="team-reply" onSubmit={(e) => { e.preventDefault(); send(); }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}>
    {!to && <Select className="select team-compose-agent" aria-label={tr('Odbiorca')} value={target} disabled={busy} onChange={(e) => setPick(e.target.value)}>
      {recipients.map((a) => <option key={a.cell.id} value={a.cell.id}>{a.name} · {a.grid.name}</option>)}
    </Select>}
    <textarea className="textarea team-reply-text" rows={1} aria-label={tr('Wiadomość')} placeholder={tr('Wiadomość do {name} (Ctrl+Enter wysyła)', { name: ctx.name(target) })} disabled={busy} maxLength={32000} value={text} onChange={(e) => setText(e.target.value)} />
    <button type="submit" className="btn small primary" disabled={!text.trim() || busy || paused}>{tr('Wyślij wiadomość')}</button>
  </form>;
}

// ── agents and activity ──────────────────────────────────────────────────────

function AgentsView({ ctx, info, runtime, tasks, projectId }: { ctx: Ctx; info: ReturnType<typeof useStore.getState>['ui']['mcpInfo']; runtime: Record<string, AgentRuntimeStatus> | null; tasks: AgentTask[]; projectId: string }) {
  const { tr, busy, filterId } = ctx;
  const shown = filterId ? ctx.agents.filter((a) => a.cell.id === filterId) : ctx.agents;
  if (!ctx.agents.length) return <PanelEmpty className="team-empty"><p>{tr('Brak agentów')}</p><p>{tr('Koordynator może tworzyć zespoły i przydzielać zadania innym agentom.')}</p></PanelEmpty>;
  return <div className="team-scroll">
    <p className="team-muted team-small team-hint">{tr('Koordynator może tworzyć zespoły i przydzielać zadania innym agentom.')} {tr('Po zmianie roli uruchom agenta ponownie, aby włączyć MCP.')}</p>
    <div className="team-agents" role="list">
      {shown.map(({ cell, grid, name, cli }) => {
        const status = runtime?.[cell.id] ?? 'unknown';
        const connected = info.connectedCellIds?.includes(cell.id);
        const configured = info.configuredCellIds?.includes(cell.id);
        const open = tasks.filter((t) => t.cellId === cell.id && !isClosedTask(t)).length;
        return <div key={cell.id} role="listitem" className="team-agent">
          <span className="team-mark"><ProviderIcon provider={cli} size={14} /></span>
          <span className="team-agent-main">
            <span className="team-row-line"><span className="team-row-title">{name}</span>{open > 0 && <span className="team-group-count" title={tr('Otwarte zadania: {n}', { n: open })}>{open}</span>}</span>
            <span className="team-row-meta"><span>{grid.name}{cell.worktree ? ` · ${cell.worktree.branch}` : ''}</span></span>
          </span>
          <span className={`team-runtime ${status}`}>{runtime ? tr(runtimeLabels[status]) : '…'}</span>
          {cell.role ? <span className={`team-mcp-agent ${connected ? 'on' : configured ? 'wait' : 'off'}`}>{tr(connected ? 'MCP działa' : configured ? 'MCP skonfigurowane · oczekiwanie na agenta' : 'Wymaga restartu')}</span> : <span className="team-mcp-agent off">{tr('Bez MCP')}</span>}
          <span className="team-agent-actions">
            <RoleSelect value={cell.role} disabled={busy} onChange={(role) => void changeAgentRole(cell.id, role ?? null)} />
            {cell.role && !configured && <button type="button" className="btn small" onClick={() => void changeAgentRole(cell.id, cell.role!)}>{tr('Uruchom ponownie')}</button>}
            {cli === 'codex' && !cell.session?.confirmed && <button type="button" className="btn small ghost" onClick={() => { focusCell(cell.id); setUi({ modal: { kind: 'history', projectId } }); }}>{tr('Wybierz sesję z historii')}</button>}
            <button type="button" className="team-icon-btn" title={tr('Otwórz agenta')} aria-label={tr('Otwórz agenta')} onClick={() => focusCell(cell.id)}><OpenIcon /></button>
          </span>
        </div>;
      })}
    </div>
  </div>;
}

function ActivityView({ ctx, projectId }: { ctx: Ctx; projectId: string }) {
  const events = useStore((s) => s.s.automation.events);
  const { tr, name, agentOf, language } = ctx;
  const shown = useMemo(() => activityOf(events, projectId, ctx.filterId), [events, projectId, ctx.filterId]);
  if (!shown.length) return <PanelEmpty className="team-empty"><p>{tr('Brak aktywności')}</p></PanelEmpty>;
  return <div className="team-scroll"><ol className="team-events">
    {shown.map((e) => <li key={e.id} className="team-event">
      <time className="team-age">{clock(e.createdAt, language)}</time>
      <span className="team-who"><Mark agent={e.cellId ? agentOf.get(e.cellId) : undefined} />{name(e.cellId)}</span>
      <span className={`team-event-action ${e.action}`}>{actionLabels[e.action] ? tr(actionLabels[e.action]) : ''}</span>
      <span className="team-event-detail" title={e.detail}>{e.detail}</span>
    </li>)}
  </ol></div>;
}

// ── height ───────────────────────────────────────────────────────────────────

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
function PanelSplitter({ section, height, onChange }: { section: React.RefObject<HTMLElement | null>; height: number | null; onChange: (height: number, save: boolean) => void }): ReactNode {
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
