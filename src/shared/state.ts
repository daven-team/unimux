// Pure state transitions. Every function returns a new AppState and never mutates its input.
import { growLayout, layoutForCount, MAX_CELLS, removeArea, type GridLayout } from './layout';
import { DEFAULT_PROFILES, RETIRED_PROFILES } from './profiles';
import { isLanguage } from './languages';
import { defaultShell, shellsForPlatform, type AppPlatform } from './platform';
import { normalizePanelWidth, PANEL_LIMITS } from './panels';
import { normalizePathMode } from './pathDrop';
import { defaultAutomation, pruneAutomation } from './automation';
import { USAGE_INTERVALS_MINUTES } from './usage';
import { defaultAlerts, LEGACY_ALERT_KEYS, readAlerts } from './alerts';
import { DEFAULT_UPDATE_MODE, normalizeUpdateMode } from './updateMode';
import { DEFAULT_BACKGROUND_LOAD, normalizeBackgroundLoad } from './backgroundLoad';
import { DEFAULT_SCROLLBACK_LINES, normalizeScrollback } from './terminalLimits';
import { normalizeShortcutOverrides } from './shortcuts';
import { normalizeSshCellRef, normalizeSshHosts, patchSshCellRef, type SshCellRef, type SshHost } from './ssh';
import { normalizeSshIdentities } from './sshIdentity';
import { DEFAULT_SSH_THEME, normalizeSshThemeId } from './sshThemes';
import { defaultSftpPlaces, forgetRemotePlace, normalizeSftpPlaces } from './sftpView';
import { DEFAULT_STRIP_SCOPE, normalizeStripScope, normalizeWorkspaceOrder } from './workspaceOrder';
import { normalizeDbConnections, normalizeDbGroupColors } from './db';
import { NOTE_LIMITS, normalizeNotes } from './notes';
import type {
  AppState, ArchivedTab, Cell, Note, Preset, PresetCell, Profile, Project, Settings, Snippet, Tab, Worktree,
} from './types';

export const ARCHIVE_LIMIT = 50;
export const PROJECT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

export const uid = () => globalThis.crypto.randomUUID();

export function defaultState(platform: AppPlatform = 'win32'): AppState {
  return {
    version: 1,
    automation: defaultAutomation(),
    projects: [],
    activeProjectId: null,
    profiles: DEFAULT_PROFILES.map((p) => ({ ...p, ...(p.cli === 'shell' && platform !== 'win32' ? { name: 'Terminal' } : {}) })),
    presets: [],
    snippets: [],
    notes: [],
    sshHosts: [],
    sshIdentities: [],
    sftp: defaultSftpPlaces(),
    dbConnections: [],
    dbGroupColors: {},
    settings: { language: null, fontSize: 13, shell: defaultShell(platform), lastProfileId: 'claude', updateMode: DEFAULT_UPDATE_MODE, showAiUsage: true, usageIntervalMinutes: 5, usageCollapsed: false, alerts: defaultAlerts(), backgroundLoad: DEFAULT_BACKGROUND_LOAD, shortcuts: {}, confirmCloseWorking: true, scrollbackLines: DEFAULT_SCROLLBACK_LINES, sshTheme: DEFAULT_SSH_THEME, stripScope: DEFAULT_STRIP_SCOPE },
    sidebarCollapsed: false,
    snippetsOpen: true,
    notesOpen: false,
    sidebarWidth: PANEL_LIMITS.sidebar.default,
    snippetsWidth: PANEL_LIMITS.snippets.default,
  };
}

const mapProject = (s: AppState, projectId: string, fn: (p: Project) => Project): AppState => ({
  ...s,
  projects: s.projects.map((p) => (p.id === projectId ? fn(p) : p)),
});

const mapTab = (s: AppState, projectId: string, tabId: string, fn: (t: Tab) => Tab): AppState =>
  mapProject(s, projectId, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }));

type CellInput = { color?: string; model?: string; profileId: string; role?: Cell['role']; name?: string; startupPrompt?: string; worktree?: Worktree; session?: Cell['session']; ssh?: SshCellRef };

/** Accent colors handed out to new cells, in order; also used for agents created by a coordinator. */
export const CELL_COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#c084fc', '#a3e635',
  '#818cf8', '#2dd4bf', '#f472b6', '#fb923c', '#38bdf8', '#4ade80', '#e879f9', '#facc15', '#93c5fd', '#6ee7b7', '#fda4af', '#d8b4fe'];

/**
 * The colour a cell is drawn in (1.0.4). An SSH cell of a host with a colour (Hosty) shows the host's colour, unless the user
 * gave the cell its own: the cell menu picks from PROJECT_COLORS, while the CELL_COLORS accent every new cell gets on its own
 * gives way to the host's. Other cells keep their own colour. "Usuń kolor" only removes the cell's own colour.
 */
export function cellDrawColor(cell: { color?: string; ssh?: unknown }, host: { color?: string } | null | undefined): string | undefined {
  const hostColor = cell.ssh ? host?.color : undefined;
  if (!cell.color) return hostColor;
  return hostColor && CELL_COLORS.includes(cell.color.toLowerCase()) ? hostColor : cell.color;
}

/** The first accent color no other cell of the grid uses; once all are taken the palette repeats. */
export function nextCellColor(used: Array<string | undefined>): string {
  const taken = new Set(used.map((color) => color?.toLowerCase()));
  return CELL_COLORS.find((color) => !taken.has(color)) ?? CELL_COLORS[used.length % CELL_COLORS.length];
}

const newCell = (c: CellInput, color?: string): Cell => ({
  id: uid(),
  profileId: c.profileId,
  ...((c.color ?? color) ? { color: c.color ?? color } : {}),
  ...(c.model ? { model: c.model } : {}),
  ...(c.role ? { role: c.role } : {}),
  ...(c.name?.trim() ? { name: c.name.trim() } : {}),
  ...(c.startupPrompt?.trim() ? { startupPrompt: c.startupPrompt } : {}),
  ...(c.worktree ? { worktree: c.worktree } : {}),
  ...(c.session ? { session: c.session } : {}),
  ...(c.ssh ? { ssh: { hostId: c.ssh.hostId } } : {}),
});

// ── projects ────────────────────────────────────────────────────────────────

export function addProject(s: AppState, input: { name: string; path: string }): AppState {
  const project: Project = {
    id: uid(),
    name: input.name,
    path: input.path,
    color: PROJECT_COLORS[s.projects.length % PROJECT_COLORS.length],
    tabs: [],
    archive: [],
    activeTabId: null,
  };
  return { ...s, projects: [...s.projects, project], activeProjectId: project.id };
}

export function updateProject(s: AppState, id: string, patch: Partial<Pick<Project, 'name' | 'path' | 'color' | 'icon'>>): AppState {
  return mapProject(s, id, (p) => {
    const next = { ...p, ...patch };
    if ('icon' in patch && !patch.icon) delete next.icon;
    return next;
  });
}

export function removeProject(s: AppState, id: string): AppState {
  const idx = s.projects.findIndex((p) => p.id === id);
  const projects = s.projects.filter((p) => p.id !== id);
  const activeProjectId =
    s.activeProjectId === id ? (projects[Math.min(idx, projects.length - 1)]?.id ?? null) : s.activeProjectId;
  // The project's tasks, messages and activity go with it (they no longer count anywhere and nothing can show them).
  const automation = pruneAutomation(s.automation, new Set(projects.map((p) => p.id)), Date.now());
  return { ...s, projects, activeProjectId, automation };
}

export type DropEdge = 'before' | 'after';

function moveRelative<T extends { id: string }>(items: T[], id: string, targetId: string | null, edge: DropEdge): T[] {
  const moving = items.find((item) => item.id === id);
  if (!moving || id === targetId) return items;
  const rest = items.filter((item) => item.id !== id);
  const target = targetId === null ? rest.length : rest.findIndex((item) => item.id === targetId);
  if (target < 0) return items;
  rest.splice(target + (targetId !== null && edge === 'after' ? 1 : 0), 0, moving);
  return rest.every((item, i) => item === items[i]) ? items : rest;
}

export function moveProject(s: AppState, id: string, targetId: string | null, edge: DropEdge = 'before'): AppState {
  const projects = moveRelative(s.projects, id, targetId, edge);
  return projects === s.projects ? s : { ...s, projects };
}

export function setActiveProject(s: AppState, id: string): AppState {
  return s.projects.some((p) => p.id === id) ? { ...s, activeProjectId: id } : s;
}

// ── tabs ────────────────────────────────────────────────────────────────────

export interface NewTabInput {
  color?: string;
  name?: string;
  layout: GridLayout;
  cells: CellInput[];
}

export function addTab(s: AppState, projectId: string, input: NewTabInput): AppState {
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) return s;
  const count = input.layout.areas.length;
  const cells: Cell[] = [];
  for (let i = 0; i < count; i++) {
    const spec = input.cells[i] ?? input.cells[0] ?? { profileId: 'shell' };
    cells.push(newCell(spec, spec.color ? undefined : nextCellColor(cells.map((cell) => cell.color))));
  }
  const color = input.color || nextCellColor(project.tabs.map((tab) => tab.color));
  const tab: Tab = { id: uid(), color, name: input.name ?? nextTabName(project), layout: input.layout, cells };
  return mapProject(s, projectId, (p) => ({ ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }));
}

function nextTabName(p: Project): string {
  const used = new Set([...p.tabs, ...p.archive].map((t) => t.name));
  for (let i = 1; ; i++) if (!used.has(`Grid ${i}`)) return `Grid ${i}`;
}

/** Replaces a grid's layout (used to persist dragged divider positions). */
export function setTabLayout(s: AppState, projectId: string, tabId: string, layout: GridLayout): AppState {
  return mapTab(s, projectId, tabId, (t) => ({ ...t, layout }));
}

export function renameTab(s: AppState, projectId: string, tabId: string, name: string): AppState {
  return mapTab(s, projectId, tabId, (t) => ({ ...t, name }));
}

export function setActiveTab(s: AppState, projectId: string, tabId: string): AppState {
  return mapProject(s, projectId, (p) => ({ ...p, activeTabId: tabId }));
}

/** A grid tab of the strip was clicked: its project becomes the active one (sidebar, Files, Git follow) and the grid its active tab. */
export function focusGrid(s: AppState, projectId: string, tabId: string): AppState {
  const project = s.projects.find((p) => p.id === projectId);
  if (!project?.tabs.some((t) => t.id === tabId)) return s;
  return setActiveTab(setActiveProject(s, projectId), projectId, tabId);
}

export function moveTab(s: AppState, projectId: string, tabId: string, toIndex: number): AppState {
  return mapProject(s, projectId, (p) => {
    const tabs = [...p.tabs];
    const from = tabs.findIndex((t) => t.id === tabId);
    if (from < 0) return p;
    const [t] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(tabs.length, toIndex)), 0, t);
    return { ...p, tabs };
  });
}

export function closeTab(s: AppState, projectId: string, tabId: string): AppState {
  return mapProject(s, projectId, (p) => {
    const idx = p.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return p;
    const tab = p.tabs[idx];
    const tabs = p.tabs.filter((t) => t.id !== tabId);
    const activeTabId = p.activeTabId === tabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : p.activeTabId;
    const archive = [{ ...tab, closedAt: Date.now() }, ...p.archive].slice(0, ARCHIVE_LIMIT);
    return { ...p, tabs, activeTabId, archive };
  });
}

export function restoreTab(s: AppState, projectId: string, archivedId: string): AppState {
  return mapProject(s, projectId, (p) => {
    const archived = p.archive.find((t) => t.id === archivedId);
    if (!archived) return p;
    const { closedAt: _closedAt, ...tab } = archived;
    return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id, archive: p.archive.filter((t) => t.id !== archivedId) };
  });
}

export function deleteArchived(s: AppState, projectId: string, archivedId: string): AppState {
  return mapProject(s, projectId, (p) => ({ ...p, archive: p.archive.filter((t) => t.id !== archivedId) }));
}

// ── cells ───────────────────────────────────────────────────────────────────

export function addCell(
  s: AppState, projectId: string, tabId: string, profileId: string,
  extra: Omit<CellInput, 'profileId'> = {},
): AppState {
  return mapTab(s, projectId, tabId, (t) => {
    const layout = growLayout(t.layout);
    if (!layout) return t;
    return { ...t, layout, cells: [...t.cells, newCell({ profileId, ...extra }, extra.color ? undefined : nextCellColor(t.cells.map((cell) => cell.color)))] };
  });
}

export function removeCell(s: AppState, projectId: string, tabId: string, cellId: string): AppState {
  const tab = s.projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  if (!tab) return s;
  if (tab.cells.length <= 1) {
    // Closing the last cell closes the whole tab (it stays in the archive).
    return closeTab(s, projectId, tabId);
  }
  return mapTab(s, projectId, tabId, (t) => ({
    ...t,
    layout: removeArea(t.layout),
    cells: t.cells.filter((c) => c.id !== cellId),
  }));
}

/** Exchanges the area slots of two cells; the layout (sizes, dividers) stays as it is. */
export function swapCells(s: AppState, projectId: string, tabId: string, a: string, b: string): AppState {
  const tab = s.projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  if (!tab || a === b || !tab.cells.some((c) => c.id === a) || !tab.cells.some((c) => c.id === b)) return s;
  return mapTab(s, projectId, tabId, (t) => {
    const i = t.cells.findIndex((c) => c.id === a);
    const j = t.cells.findIndex((c) => c.id === b);
    if (i < 0 || j < 0) return t;
    const cells = [...t.cells];
    [cells[i], cells[j]] = [cells[j], cells[i]];
    return { ...t, cells };
  });
}

export function updateCell(s: AppState, cellId: string, patch: Partial<Omit<Cell, 'id'>>): AppState {
  const found = findCell(s, cellId);
  if (!found) return s;
  return mapTab(s, found.project.id, found.tab.id, (t) => ({
    ...t,
    cells: t.cells.map((c) => {
      if (c.id !== cellId) return c;
      const next: Cell = { ...c, ...patch };
      // `undefined` in the patch means "remove the field".
      for (const k of Object.keys(patch) as Array<keyof typeof patch>) if (patch[k] === undefined) delete next[k];
      return next;
    }),
  }));
}

/** An SSH cell's restore data (1.0.6): the same state when nothing changes (no save, no state event). */
export function patchSshCell(s: AppState, cellId: string, patch: { cwd?: string | null; resume?: boolean }): AppState {
  const ref = findCell(s, cellId)?.cell.ssh;
  if (!ref) return s;
  const next = patchSshCellRef(ref, patch);
  return next === ref ? s : updateCell(s, cellId, { ssh: next });
}

/** At load with the session restore off: no cell keeps the "connected at close" mark of the last run (the same state when none has it). */
export function unlessRestoring(s: AppState): AppState {
  if (s.settings.sshRestoreSessions === true) return s;
  let changed = false;
  const projects = s.projects.map((p) => {
    let touched = false;
    const tabs = p.tabs.map((t) => {
      if (!t.cells.some((c) => c.ssh?.resume)) return t;
      touched = true;
      return { ...t, cells: t.cells.map((c) => (c.ssh?.resume ? { ...c, ssh: patchSshCellRef(c.ssh, { resume: false }) } : c)) };
    });
    if (!touched) return p;
    changed = true;
    return { ...p, tabs };
  });
  return changed ? { ...s, projects } : s;
}

export function findCell(s: AppState, cellId: string): { project: Project; tab: Tab; cell: Cell } | null {
  for (const project of s.projects)
    for (const tab of project.tabs) {
      const cell = tab.cells.find((c) => c.id === cellId);
      if (cell) return { project, tab, cell };
    }
  return null;
}

/**
 * What closing a cell may do with its worktree, judged from the state as it is now (after any question was answered):
 * 'gone' = the cell is no longer open; 'last' = it is the only cell of its grid, so closing it sends the grid (with this
 * cell and its worktree) to the history; 'shared' = another open or closed-grid cell works in the same folder; 'own' = the
 * worktree belongs to this cell alone; 'none' = no worktree.
 */
export function cellWorktreeUse(s: AppState, cellId: string, samePath: (a: string, b: string) => boolean): 'gone' | 'last' | 'shared' | 'own' | 'none' {
  const found = findCell(s, cellId);
  if (!found) return 'gone';
  if (found.tab.cells.length <= 1) return 'last';
  const path = found.cell.worktree?.path;
  if (!path) return 'none';
  const shared = s.projects.some((p) => [...p.tabs, ...p.archive].some((t) => t.cells.some((c) => c.id !== cellId && !!c.worktree?.path && samePath(c.worktree.path, path))));
  return shared ? 'shared' : 'own';
}

// ── library: profiles, presets, snippets, settings ──────────────────────────

const upsert = <T extends { id: string }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

export const upsertProfile = (s: AppState, p: Profile): AppState => ({ ...s, profiles: upsert(s.profiles, p) });
export const removeProfile = (s: AppState, id: string): AppState =>
  s.profiles.length <= 1 ? s : { ...s, profiles: s.profiles.filter((p) => p.id !== id) };
export const upsertPreset = (s: AppState, p: Preset): AppState => ({ ...s, presets: upsert(s.presets, p) });
export const removePreset = (s: AppState, id: string): AppState => ({ ...s, presets: s.presets.filter((p) => p.id !== id) });
export const upsertSnippet = (s: AppState, sn: Snippet): AppState => ({ ...s, snippets: upsert(s.snippets, sn) });
export function moveSnippet(s: AppState, id: string, targetId: string | null, edge: DropEdge = 'before'): AppState {
  const snippets = moveRelative(s.snippets, id, targetId, edge);
  return snippets === s.snippets ? s : { ...s, snippets };
}
export const removeSnippet = (s: AppState, id: string): AppState => ({ ...s, snippets: s.snippets.filter((x) => x.id !== id) });
export const upsertNote = (s: AppState, note: Note): AppState => ({ ...s, notes: upsert(s.notes, note) });
/** A change of a note's name or text (capped like on load); the same state when nothing differs, so typing pauses write nothing. */
export function editNote(s: AppState, id: string, patch: Partial<Pick<Note, 'name' | 'text'>>, now = Date.now()): AppState {
  const note = s.notes.find((x) => x.id === id);
  if (!note) return s;
  const name = patch.name === undefined ? note.name : patch.name.slice(0, NOTE_LIMITS.name);
  const text = patch.text === undefined ? note.text : patch.text.slice(0, NOTE_LIMITS.text);
  if (name === note.name && text === note.text) return s;
  return upsertNote(s, { ...note, name, text, updatedAt: now });
}
export function moveNote(s: AppState, id: string, targetId: string | null, edge: DropEdge = 'before'): AppState {
  const notes = moveRelative(s.notes, id, targetId, edge);
  return notes === s.notes ? s : { ...s, notes };
}
export const removeNote = (s: AppState, id: string): AppState => ({ ...s, notes: s.notes.filter((x) => x.id !== id) });
export const updateSettings = (s: AppState, patch: Partial<Settings>): AppState => ({ ...s, settings: { ...s.settings, ...patch } });

// ── ssh hosts ───────────────────────────────────────────────────────────────

export const addSshHost = (s: AppState, host: SshHost): AppState => ({ ...s, sshHosts: upsert(s.sshHosts, host) });

/** `undefined` in the patch removes the field (for example `keyId`). */
export function updateSshHost(s: AppState, id: string, patch: Partial<Omit<SshHost, 'id' | 'createdAt' | 'updatedAt'>>, now = Date.now()): AppState {
  if (!s.sshHosts.some((h) => h.id === id)) return s;
  return { ...s, sshHosts: s.sshHosts.map((h) => {
    if (h.id !== id) return h;
    const next: SshHost = { ...h, ...patch, updatedAt: now };
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) if (patch[key] === undefined) delete next[key];
    return next;
  }) };
}

export const removeSshHost = (s: AppState, id: string): AppState => ({ ...s, sshHosts: s.sshHosts.filter((h) => h.id !== id), sftp: forgetRemotePlace(s.sftp ?? defaultSftpPlaces(), id) });

export function duplicateSshHost(s: AppState, id: string, newId = uid(), now = Date.now()): AppState {
  const source = s.sshHosts.find((h) => h.id === id);
  if (!source) return s;
  const labels = new Set(s.sshHosts.map((h) => h.label));
  let n = 2;
  while (labels.has(`${source.label} (${n})`)) n++;
  const copy: SshHost = { ...source, id: newId, label: `${source.label} (${n})`.slice(0, 80), createdAt: now, updatedAt: now };
  const at = s.sshHosts.findIndex((h) => h.id === id) + 1;
  return { ...s, sshHosts: [...s.sshHosts.slice(0, at), copy, ...s.sshHosts.slice(at)] };
}

/** A deleted key: hosts and identities that used it fall back to password or keyboard-interactive sign-in. */
export function clearSshKeyRefs(s: AppState, keyId: string): AppState {
  const identities = s.sshIdentities ?? [];
  if (!s.sshHosts.some((h) => h.keyId === keyId) && !identities.some((i) => i.keyId === keyId)) return s;
  const drop = <T extends { keyId?: string }>(x: T): T => {
    if (x.keyId !== keyId) return x;
    const { keyId: _keyId, ...rest } = x;
    return rest as T;
  };
  return { ...s, sshHosts: s.sshHosts.map(drop), sshIdentities: identities.map(drop) };
}

/** The profile SSH cells use: the first shell profile; the default one is restored when the user deleted every shell profile (R5). */
export function ensureShellProfile(s: AppState): { s: AppState; profileId: string } {
  const existing = s.profiles.find((p) => p.cli === 'shell');
  if (existing) return { s, profileId: existing.id };
  const shell = DEFAULT_PROFILES.find((p) => p.cli === 'shell')!;
  // A fixed fallback id (not uid()): callers may run this on every render and must get the same id each time.
  const id = s.profiles.some((p) => p.id === shell.id) ? 'ssh-shell' : shell.id;
  return { s: { ...s, profiles: [...s.profiles, { ...shell, id }] }, profileId: id };
}

export const getProfile = (s: AppState, id: string): Profile =>
  s.profiles.find((p) => p.id === id) ?? s.profiles.find((p) => p.cli === 'shell') ?? s.profiles[0];

export const activeProject = (s: AppState): Project | null => s.projects.find((p) => p.id === s.activeProjectId) ?? null;
export const activeTab = (p: Project | null): Tab | null => p?.tabs.find((t) => t.id === p.activeTabId) ?? null;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNumbers = (v: unknown): boolean => Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isNumberRows = (v: unknown): boolean => Array.isArray(v) && v.every((row) => row === null || isNumbers(row));

/** A saved layout the grid can draw for `count` cells: one area per cell inside the grid, size fields of the right type. */
export function isUsableLayout(layout: unknown, count: number): layout is GridLayout {
  if (!isRecord(layout)) return false;
  const { cols, rows, areas } = layout;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1) return false;
  // Row-based layouts use the LCM of their row counts as tracks (60 for 5, 4, 3); either axis in cols mode.
  if ((cols as number) > 60 || (rows as number) > 60) return false;
  if (!Array.isArray(areas) || areas.length !== count) return false;
  const inside = areas.every((a) => isRecord(a)
    && [a.col, a.row, a.colSpan, a.rowSpan].every((n) => Number.isInteger(n))
    && (a.col as number) >= 0 && (a.row as number) >= 0 && (a.colSpan as number) >= 1 && (a.rowSpan as number) >= 1
    && (a.col as number) + (a.colSpan as number) <= (cols as number) && (a.row as number) + (a.rowSpan as number) <= (rows as number));
  if (!inside) return false;
  if (layout.mode !== undefined && layout.mode !== 'cols') return false;
  for (const field of ['rowCounts', 'rowSizes', 'colSizes'] as const) if (layout[field] !== undefined && !isNumbers(layout[field])) return false;
  for (const field of ['rowColSizes', 'colRowSizes'] as const) if (layout[field] !== undefined && !isNumberRows(layout[field])) return false;
  return true;
}

/**
 * One saved tab, repaired so the grid can draw it: cells without an id or profile are dropped (at most MAX_CELLS stay) and a
 * layout that does not fit the cells is rebuilt. A tab left with no cell is dropped (null). Damage in one tab never loses the rest.
 */
export function repairTab<T extends Tab>(raw: unknown): T | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  const cells = (Array.isArray(raw.cells) ? raw.cells : [])
    .filter((c): c is Cell => isRecord(c) && typeof c.id === 'string' && typeof c.profileId === 'string')
    .slice(0, MAX_CELLS);
  if (!cells.length) return null;
  const layout = isUsableLayout(raw.layout, cells.length) ? raw.layout : layoutForCount(cells.length);
  return { ...raw, name: typeof raw.name === 'string' ? raw.name : '', cells, layout } as unknown as T;
}

/** Basic shape check for data loaded from disk; fills in fields added in later versions. */
export function normalizeState(raw: unknown, platform: AppPlatform = 'win32'): AppState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AppState>;
  if (r.version !== 1 || !Array.isArray(r.projects)) return null;
  const d = defaultState(platform);
  const dbConnections = normalizeDbConnections(r.dbConnections);
  const remap = (id: string) => RETIRED_PROFILES[id] ?? id;
  const remapCells = <T extends { profileId: string }>(cells: T[]) => cells.map((c) => ({ ...c, profileId: remap(c.profileId) }));
  // A cell's path format override survives only as one of the known values; an SSH reference only as { hostId: string }.
  const cleanCells = (cells: Cell[]) => remapCells(cells).map((c) => {
    const { pathMode: raw, ssh, ...rest } = c;
    const pathMode = normalizePathMode(raw);
    const ref = normalizeSshCellRef(ssh);
    return { ...rest, ...(pathMode ? { pathMode } : {}), ...(ref ? { ssh: ref } : {}) };
  });
  const cleanPresetCells = (cells: PresetCell[]) => remapCells(cells).map((c) => {
    const { sshHostId, ...rest } = c;
    return typeof sshHostId === 'string' && sshHostId.length <= 64 ? { ...rest, sshHostId } : rest;
  });
  const profiles = (Array.isArray(r.profiles) && r.profiles.length ? r.profiles : d.profiles).filter((p) => !(p.id in RETIRED_PROFILES));
  const normalized = {
    ...d,
    ...r,
    automation: {
      paused: r.automation?.paused === true,
      tasks: Array.isArray(r.automation?.tasks) ? r.automation.tasks : [],
      messages: Array.isArray(r.automation?.messages) ? r.automation.messages : [],
      events: Array.isArray(r.automation?.events) ? r.automation.events.slice(-200) : [],
    },
    sidebarCollapsed: r.sidebarCollapsed === true,
    sidebarWidth: normalizePanelWidth(r.sidebarWidth, 'sidebar'),
    snippetsWidth: normalizePanelWidth(r.snippetsWidth, 'snippets'),
    profiles: profiles.length ? profiles : d.profiles,
    presets: (Array.isArray(r.presets) ? r.presets : []).map((p) => ({ ...p, cells: cleanPresetCells(p.cells ?? []) })),
    snippets: Array.isArray(r.snippets) ? r.snippets : [],
    notes: normalizeNotes(r.notes),
    notesOpen: r.notesOpen === true,
    sshHosts: normalizeSshHosts(r.sshHosts),
    sshIdentities: normalizeSshIdentities(r.sshIdentities),
    sftp: normalizeSftpPlaces(r.sftp),
    dbConnections,
    dbGroupColors: normalizeDbGroupColors(r.dbGroupColors, dbConnections),
    settings: {
      ...d.settings, ...(r.settings ?? {}),
      // Existing Polish installations keep their UI and do not get first-run onboarding again.
      language: r.settings?.language === undefined ? 'pl' : isLanguage(r.settings.language) ? r.settings.language : null,
      shell: shellsForPlatform(platform).some((shell) => shell.code === r.settings?.shell) ? r.settings!.shell! : d.settings.shell,
      lastProfileId: remap(r.settings?.lastProfileId ?? d.settings.lastProfileId),
      // The retired boolean `autoInstallUpdates` only seeds the mode when none is saved yet.
      updateMode: normalizeUpdateMode(r.settings?.updateMode, (r.settings as Record<string, unknown> | undefined)?.autoInstallUpdates),
      showAiUsage: typeof r.settings?.showAiUsage === 'boolean' ? r.settings.showAiUsage : d.settings.showAiUsage,
      usageIntervalMinutes: (USAGE_INTERVALS_MINUTES as readonly number[]).includes(r.settings?.usageIntervalMinutes as number) ? r.settings!.usageIntervalMinutes! : d.settings.usageIntervalMinutes,
      usageCollapsed: typeof r.settings?.usageCollapsed === 'boolean' ? r.settings.usageCollapsed : d.settings.usageCollapsed,
      confirmCloseWorking: typeof r.settings?.confirmCloseWorking === 'boolean' ? r.settings.confirmCloseWorking : d.settings.confirmCloseWorking,
      backgroundLoad: normalizeBackgroundLoad(r.settings?.backgroundLoad),
      scrollbackLines: normalizeScrollback(r.settings?.scrollbackLines),
      sshTheme: normalizeSshThemeId(r.settings?.sshTheme),
      stripScope: normalizeStripScope(r.settings?.stripScope),
      shortcuts: normalizeShortcutOverrides(r.settings?.shortcuts, platform),
      // The retired notifications / waitingSound* keys only seed the alerts when none are saved yet; they are never written again.
      alerts: readAlerts(r.settings as Record<string, unknown> | undefined),
    },
    // A damaged project (no id or path) or tab is dropped or repaired on its own instead of rejecting the whole file.
    projects: (r.projects as unknown[]).filter((p): p is Project => isRecord(p) && typeof p.id === 'string' && typeof p.path === 'string').map((p) => ({
      ...p,
      tabs: (Array.isArray(p.tabs) ? p.tabs : []).map((t) => repairTab<Tab>(t)).filter((t): t is Tab => t !== null).map((t) => ({ ...t, cells: cleanCells(t.cells) })),
      archive: (Array.isArray(p.archive) ? p.archive : []).map((t) => repairTab<ArchivedTab>(t)).filter((t): t is ArchivedTab => t !== null).map((t) => ({ ...t, cells: cleanCells(t.cells) })),
    })),
  } as AppState;
  for (const key of LEGACY_ALERT_KEYS) delete (normalized.settings as unknown as Record<string, unknown>)[key];
  // Grid ids are unique across all projects (the strip keys grids by id): a repeated id (open or archived, a hand-edited or merged
  // file) gets a new one; an active tab that was re-id'd follows.
  const seenTabIds = new Set<string>();
  const freshId = (id: string) => { if (!seenTabIds.has(id)) { seenTabIds.add(id); return id; } const next = uid(); seenTabIds.add(next); return next; };
  normalized.projects = normalized.projects.map((p) => {
    const tabs = p.tabs.map((t) => { const id = freshId(t.id); return id === t.id ? t : { ...t, id }; });
    // The active tab keeps pointing at the same grid: if its id was given away, the first grid that had it.
    const kept = tabs.some((t) => t.id === p.activeTabId);
    const moved = p.tabs.findIndex((t) => t.id === p.activeTabId);
    const activeTabId = kept || moved < 0 ? p.activeTabId : tabs[moved].id;
    const archive = p.archive.map((t) => { const id = freshId(t.id); return id === t.id ? t : { ...t, id }; });
    return tabs.every((t, i) => t === p.tabs[i]) && archive.every((t, i) => t === p.archive[i]) ? p : { ...p, tabs, archive, activeTabId };
  });
  // An active project or tab dropped by the repair falls back to the first one left, so the window does not open on an empty grid.
  normalized.projects = normalized.projects.map((p) =>
    p.activeTabId && !p.tabs.some((t) => t.id === p.activeTabId) ? { ...p, activeTabId: p.tabs[0]?.id ?? null } : p);
  if (normalized.activeProjectId && !normalized.projects.some((p) => p.id === normalized.activeProjectId)) {
    normalized.activeProjectId = normalized.projects[0]?.id ?? null;
  }
  // The strip order keeps only keys of a known kind and grids that are still open; absent stays absent for the migration.
  const workspaceOrder = normalizeWorkspaceOrder(r.workspaceOrder, new Set(normalized.projects.flatMap((p) => p.tabs.map((t) => t.id))));
  if (workspaceOrder) normalized.workspaceOrder = workspaceOrder;
  else delete normalized.workspaceOrder;
  // Retention of the MCP inboxes (also drops what removed projects left behind before 0.9.3).
  normalized.automation = pruneAutomation(normalized.automation, new Set(normalized.projects.map((p) => p.id)), Date.now());
  return normalized;
}

