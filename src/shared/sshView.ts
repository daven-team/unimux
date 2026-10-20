// Pure helpers of the SSH view (the `ssh` workspace tab, W3). No DOM imports: tested in Node.
import { groupHosts, isLivePhase, toggleSelection, type SshHost, type SshSessionState } from './ssh';

/** What the details pane of the SSH view shows; a host (or identity) without id is the "Nowy host" ("Nowa tożsamość") form. */
export type SshDetail =
  | { kind: 'host'; hostId?: string }
  | { kind: 'key'; keyId: string }
  | { kind: 'newKey'; mode?: NewKeyMode; seq?: number }
  | { kind: 'identity'; identityId?: string };

export type NewKeyMode = 'generate' | 'file' | 'paste';

export type HostTileState = 'connected' | 'connecting' | 'error' | 'idle';

/** The dot of a host tile: the best state among the cells (in any project and grid) that run this host. */
export function hostTileState(hostId: string, cells: ReadonlyArray<{ id: string; ssh?: { hostId: string } }>, sessions: Readonly<Record<string, SshSessionState | undefined>>): HostTileState {
  let state: HostTileState = 'idle';
  for (const cell of cells) {
    if (cell.ssh?.hostId !== hostId) continue;
    const phase = sessions[cell.id]?.phase;
    if (phase === 'connected') return 'connected';
    if (isLivePhase(phase)) state = 'connecting';
    else if (phase === 'error' && state === 'idle') state = 'error';
  }
  return state;
}

/** A detail whose host, key or identity no longer exists shows the empty hint instead. */
export function liveDetail(detail: SshDetail | null, hosts: ReadonlyArray<Pick<SshHost, 'id'>>, keyIds: readonly string[], identityIds: readonly string[] = []): SshDetail | null {
  if (!detail) return null;
  if (detail.kind === 'host' && detail.hostId && !hosts.some((h) => h.id === detail.hostId)) return null;
  if (detail.kind === 'key' && !keyIds.includes(detail.keyId)) return null;
  if (detail.kind === 'identity' && detail.identityId && !identityIds.includes(detail.identityId)) return null;
  return detail;
}

/** React key of the pane: another host, key or identity is a fresh pane (typed secrets and drafts of the previous one are dropped, R12). */
export const detailKey = (d: SshDetail): string => {
  switch (d.kind) {
    case 'host': return `host:${d.hostId ?? 'new'}`;
    case 'key': return `key:${d.keyId}`;
    case 'identity': return `identity:${d.identityId ?? 'new'}`;
    default: return `newKey:${d.mode ?? 'generate'}${d.seq ? `:${d.seq}` : ''}`;
  }
};

/** "Nowy klucz > mode" from the header: an open new-key pane (in any mode) is replaced by a fresh one in the asked mode. */
export function newKeyDetail(current: SshDetail | null, mode: NewKeyMode): SshDetail & { kind: 'newKey' } {
  return current?.kind === 'newKey' ? { kind: 'newKey', mode, seq: (current.seq ?? 0) + 1 } : { kind: 'newKey', mode };
}

export const MENU_HOSTS = 12;

/** Hosts offered in the "Dodaj" and cell menus (R14): the view's order (groups, then hosts by label), at most `max`. */
export function menuHosts(hosts: readonly SshHost[], max = MENU_HOSTS): { shown: SshHost[]; more: boolean } {
  const ordered = groupHosts(hosts).flatMap((g) => g.hosts);
  return { shown: ordered.slice(0, max), more: ordered.length > max };
}

// ── SSH mode (0.9.2): the left side panel shows the SSH sections while the SSH view is in front ──

/** The sections of the SSH view; SFTP (0.9.8) is the two-pane file manager. */
export type SshSection = 'hosts' | 'keys' | 'knownHosts' | 'sftp';

export interface SshNavEntry { id: SshSection; label: 'Hosty' | 'Klucze' | 'Znane hosty' | 'SFTP'; disabled?: true }

/** The navigation of SSH mode, in order. A disabled entry (none since 0.9.8) would be shown greyed and never chosen. */
export const SSH_NAV: readonly SshNavEntry[] = [
  { id: 'hosts', label: 'Hosty' },
  { id: 'keys', label: 'Klucze' },
  { id: 'knownHosts', label: 'Znane hosty' },
  { id: 'sftp', label: 'SFTP' },
];

export const DEFAULT_SSH_SECTION: SshSection = 'hosts';

/** A click on a navigation entry: an enabled one becomes the section, a disabled or unknown one changes nothing. */
export function chooseSshSection(current: SshSection, clicked: string): SshSection {
  const entry = SSH_NAV.find((e) => e.id === clicked);
  return entry && !entry.disabled ? (entry.id as SshSection) : current;
}

/** The section a detail belongs to (a host form to Hosty; a key, a new-key form or an identity to Klucze); null keeps the current one. */
export function sectionForDetail(detail: SshDetail | null): SshSection | null {
  if (!detail) return null;
  return detail.kind === 'host' ? 'hosts' : 'keys';
}

/** What the details pane of a section shows: only a detail of that section (Znane hosty has no pane). */
export function paneDetail(section: SshSection, detail: SshDetail | null): SshDetail | null {
  return detail && sectionForDetail(detail) === section ? detail : null;
}

/**
 * The details pane is only on screen while it shows something (0.9.2 polish): with nothing selected the hosts or keys use the
 * whole width. `detail` is the stored one; a deleted host or key (liveDetail) or a detail of another section closes it.
 */
export function detailPaneOpen(section: SshSection, detail: SshDetail | null): boolean {
  return paneDetail(section, detail) !== null;
}

/** A click on a tile: the tile shown in the pane closes the pane again (deselect), any other tile is shown. */
export function clickedDetail(current: SshDetail | null, clicked: SshDetail): SshDetail | null {
  return current && detailKey(current) === detailKey(clicked) ? null : clicked;
}

/** Esc pressed with the focus inside the pane closes it; Esc elsewhere is not the pane's. */
export const paneEscape = (focusInPane: boolean, detail: SshDetail | null): boolean => focusInPane && detail !== null;

/** Typing in the host search keeps only the selected hosts that are still shown, so "Otwórz jako siatkę (n)" counts visible hosts. */
export function visibleSelection(selected: readonly string[], shown: ReadonlyArray<Pick<SshHost, 'id'>>): string[] {
  const ids = new Set(shown.map((h) => h.id));
  return selected.filter((id) => ids.has(id));
}

/**
 * The store change for a click in the SSH mode navigation: the new section, the detail only if it belongs there (a new-key
 * draft or a host form of the old section is dropped) and the host selection only in Hosty. Nothing for the same section.
 */
export function sectionChange(st: { section: SshSection; detail: SshDetail | null; selectedHosts: string[] }, clicked: string): Partial<{ section: SshSection; detail: SshDetail | null; selectedHosts: string[] }> {
  const section = chooseSshSection(st.section, clicked);
  if (section === st.section) return {};
  return { section, detail: paneDetail(section, st.detail), selectedHosts: section === 'hosts' ? st.selectedHosts : [] };
}

/** SSH mode: the SSH view is the workspace on screen (Settings in front ends it). */
export const sshModeActive = (ctx: { viewActive: boolean; settingsActive: boolean }): boolean => ctx.viewActive && !ctx.settingsActive;

export interface GroupTile { key: string; name: string; count: number }

/** The "Grupy" row: one tile per named group, by name ("Wszystkie" comes first in the view; hosts without a group get no tile). */
export function groupTiles(hosts: readonly SshHost[]): GroupTile[] {
  return groupHosts(hosts).flatMap((g) => (g.name === null ? [] : [{ key: g.name, name: g.name, count: g.hosts.length }]));
}

/** The row is only worth showing when at least one host has a group. */
export const showGroupRow = (tiles: readonly GroupTile[]): boolean => tiles.length > 0;

/** The list shows group headings only when some host has a group; otherwise the hosts are one plain list without "Bez grupy". */
export const showGroupHeadings = (hosts: ReadonlyArray<Pick<SshHost, 'group'>>): boolean => hosts.some((h) => !!h.group);

/** Hosts of the chosen group tile ('' = without a group); null shows every host. */
export function hostsInGroup(hosts: readonly SshHost[], groupKey: string | null): SshHost[] {
  return groupKey === null ? [...hosts] : hosts.filter((h) => (h.group ?? '') === groupKey);
}

/** A group filter whose group no longer has hosts (renamed, emptied) falls back to every host. */
export function liveGroupFilter(groupKey: string | null, hosts: readonly SshHost[]): string | null {
  return groupKey !== null && hosts.some((h) => (h.group ?? '') === groupKey) ? groupKey : null;
}

/** A click on a group tile filters to that group; a click on the chosen one shows every host again. */
export const toggleGroupFilter = (current: string | null, clicked: string): string | null => (current === clicked ? null : clicked);

/** What of the SSH store decides which item the details pane holds. */
export interface PaneScreen { viewOpen: boolean; section: SshSection; detail: SshDetail | null }

/**
 * 0.9.3: whether a store change drops the item of the details pane (another tile, another section, the SSH tab closed). With
 * unsaved edits in the pane the change is asked about first, like Esc, X and a second click. The view going to the
 * background (a grid, a file, Settings, connect, open as grid) keeps the pane and its drafts, as in 0.9.2.
 */
export function paneLeaves(prev: PaneScreen, next: PaneScreen): boolean {
  const before = paneDetail(prev.section, prev.detail);
  if (!before) return false;
  if (prev.viewOpen && !next.viewOpen) return true;
  const after = paneDetail(next.section, next.detail);
  return !after || detailKey(after) !== detailKey(before);
}

// ── host cards (Termius-like) ────────────────────────────────────────────────

/**
 * Ctrl/Cmd+click on a host card toggles it in the multi-selection. A plain click only picks one card (it no longer opens the
 * editor: the pencil does), and that card is where a multi-selection starts, so "click A, Ctrl+click B" selects both. A picked
 * card that is not shown (searched away, in a folded group) never joins: "Otwórz jako siatkę (n)" counts shown hosts only. The
 * clicked card stays picked only while it is selected (a card Ctrl+clicked out of the selection does not look selected).
 */
export function ctrlPick(selected: readonly string[], picked: string | null, clicked: string, shown: readonly string[]): { selected: string[]; picked: string | null } {
  const start = !selected.length && picked && picked !== clicked && shown.includes(picked) ? [picked] : selected;
  const next = toggleSelection(start, clicked);
  return { selected: next, picked: next.includes(clicked) ? clicked : null };
}

/** The second line of a host card, like Termius: the protocol, the user name and the tags ("ssh, adam, hetzner"). */
export const hostCardDetail = (h: Pick<SshHost, 'username' | 'tags'>): string => ['ssh', h.username, ...(h.tags ?? [])].join(', ');

/** Enter on a host card connects, like a double-click; with a modifier it is left to the rest of the app. */
export const cardKeyConnects = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean =>
  e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
