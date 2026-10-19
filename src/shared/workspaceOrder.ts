/** Keep surviving cards in their saved order and append newly opened cards. */
export function workspaceOrder(saved: string[], available: string[]): string[] {
  const present = new Set(available);
  return [...new Set([...saved.filter((id) => present.has(id)), ...available])];
}

export function reorderWorkspace(order: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !order.includes(source) || !order.includes(target)) return order;
  const next = order.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

/** Which workspace tab is shown: Settings above the SSH view above a file above the grid. */
export function activeWorkspaceKey(s: { settingsActive: boolean; sshActive: boolean; fileId: string | null; gridId: string | null }): string | null {
  if (s.settingsActive) return 'settings';
  if (s.sshActive) return 'ssh';
  if (s.fileId) return `file:${s.fileId}`;
  return s.gridId ? `grid:${s.gridId}` : null;
}

// ── 1.0.0: one strip for all projects ───────────────────────────────────────
// The strip holds the open grids of every project, the file tabs, Settings and the SSH view in one global order that lives in
// state.json (`AppState.workspaceOrder`). Keys: 'settings', 'ssh', `grid:<tabId>` (tab ids are UUIDs, unique across projects)
// and `file:<documentId>`. File tabs are not in AppState, so the state keeps their keys and the renderer drops closed ones.

export const WORKSPACE_ORDER_LIMIT = 1000;
const KEY_MAX = 4096;

const isFixedKey = (key: string): boolean => key === 'settings' || key === 'ssh';
export const isGridKey = (key: string): boolean => key.startsWith('grid:');

/** The stored order, repaired: strings of a known kind, grids that still exist, no duplicates. Absent stays absent (migration). */
export function normalizeWorkspaceOrder(raw: unknown, gridIds: ReadonlySet<string>): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of raw) {
    if (typeof key !== 'string' || key.length > KEY_MAX || seen.has(key)) continue;
    const ok = isFixedKey(key) || (isGridKey(key) && gridIds.has(key.slice(5))) || (key.startsWith('file:') && key.length > 5);
    if (!ok) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= WORKSPACE_ORDER_LIMIT) break;
  }
  return out;
}

/**
 * One global order from the per-project orders of 0.9.x (localStorage `mc-workspace-order-v1`, keyed by project id): the
 * projects in their sidebar order, each with its saved order and then its grids the saved order did not know.
 */
export function migrateWorkspaceOrders(legacy: unknown, projects: ReadonlyArray<{ id: string; tabs: ReadonlyArray<{ id: string }> }>): string[] {
  const saved = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy as Record<string, unknown> : {};
  const out: string[] = [];
  for (const p of projects) {
    const own = Array.isArray(saved[p.id]) ? (saved[p.id] as unknown[]).filter((key): key is string => typeof key === 'string') : [];
    out.push(...own, ...p.tabs.map((t) => `grid:${t.id}`));
  }
  return normalizeWorkspaceOrder(out, new Set(projects.flatMap((p) => p.tabs.map((t) => t.id)))) ?? [];
}

/**
 * The order with what is open now: surviving keys keep their place, closed ones are dropped. New grids go right after
 * `anchor` (the tab that was in front when they were opened), other new keys at the end.
 */
export function mergeWorkspaceOrder(saved: readonly string[], available: readonly string[], anchor: string | null): string[] {
  const present = new Set(available);
  const kept = [...new Set(saved.filter((key) => present.has(key)))];
  const known = new Set(kept);
  const fresh = [...new Set(available.filter((key) => !known.has(key)))];
  const grids = fresh.filter(isGridKey);
  const others = fresh.filter((key) => !isGridKey(key));
  const at = anchor ? kept.indexOf(anchor) : -1;
  const out = at < 0 ? [...kept, ...grids] : [...kept.slice(0, at + 1), ...grids, ...kept.slice(at + 1)];
  return [...out, ...others];
}

/** The tab after (or before) the one in front, wrapping around; null when there is nothing to move to. */
export function stepWorkspace(shown: readonly string[], active: string | null, dir: 1 | -1): string | null {
  if (!shown.length) return null;
  const at = active ? shown.indexOf(active) : -1;
  if (at < 0) return dir === 1 ? shown[0] : shown[shown.length - 1];
  if (shown.length < 2) return null;
  return shown[(at + dir + shown.length) % shown.length];
}

export const sameOrder = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((key, i) => key === b[i]);

/** Grid tab texts: a grid whose name is also used by a grid of another project gets its project name as a prefix. */
export function gridTabLabels(projects: ReadonlyArray<{ id: string; name: string; tabs: ReadonlyArray<{ id: string; name: string }> }>): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const p of projects) for (const t of p.tabs) owners.set(t.name, (owners.get(t.name) ?? new Set<string>()).add(p.id));
  const labels = new Map<string, string>();
  for (const p of projects) for (const t of p.tabs) labels.set(t.id, (owners.get(t.name)?.size ?? 0) > 1 ? `${p.name} · ${t.name}` : t.name);
  return labels;
}

/** Entries of the "all tabs" menu: tabs outside the projects first, then one group per project (in the sidebar order). */
export function groupWorkspaceKeys(shown: readonly string[], projectOf: (key: string) => string | null, projectIds: readonly string[]): Array<{ projectId: string | null; keys: string[] }> {
  const groups = new Map<string | null, string[]>();
  for (const key of shown) {
    const id = projectOf(key);
    groups.set(id, [...(groups.get(id) ?? []), key]);
  }
  return [null, ...projectIds].filter((id) => groups.has(id)).map((id) => ({ projectId: id, keys: groups.get(id)! }));
}

export type WorkspaceTarget = { kind: 'settings' } | { kind: 'ssh' } | { kind: 'file'; id: string } | { kind: 'grid'; id: string };

/** What a strip key stands for (what Mod+Shift+W, a click or Mod+Tab acts on); null for an unknown key. */
export function parseWorkspaceKey(key: string): WorkspaceTarget | null {
  if (key === 'settings' || key === 'ssh') return { kind: key };
  if (key.startsWith('file:') && key.length > 5) return { kind: 'file', id: key.slice(5) };
  if (isGridKey(key) && key.length > 5) return { kind: 'grid', id: key.slice(5) };
  return null;
}

export interface StripInput {
  settingsOpen: boolean;
  sshOpen: boolean;
  activeProjectId: string | null;
  projects: ReadonlyArray<{ id: string; tabs: ReadonlyArray<{ id: string }> }>;
  files: ReadonlyArray<{ id: string; projectId: string }>;
}

/**
 * The keys of everything open (`all`, what the order is kept for) and of what the strip shows (`shown`): the grids of every
 * project, but the file tabs only of the project on screen and of files outside the projects (projectId '').
 */
export function stripKeys(input: StripInput): { all: string[]; shown: string[] } {
  const fixed = [...(input.settingsOpen ? ['settings'] : []), ...(input.sshOpen ? ['ssh'] : [])];
  const grids = input.projects.flatMap((p) => p.tabs.map((t) => `grid:${t.id}`));
  const fileShown = (f: { projectId: string }) => !f.projectId || f.projectId === input.activeProjectId;
  return {
    all: [...fixed, ...grids, ...input.files.map((f) => `file:${f.id}`)],
    shown: [...fixed, ...grids, ...input.files.filter(fileShown).map((f) => `file:${f.id}`)],
  };
}

/** Project tabs sorted by the strip order (the sidebar lists a project's grids, its "last 3" follow the strip). */
export function sortTabsByOrder<T extends { id: string }>(tabs: readonly T[], order: readonly string[]): T[] {
  const at = (t: T) => { const i = order.indexOf(`grid:${t.id}`); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return [...tabs].sort((a, b) => at(a) - at(b));
}
