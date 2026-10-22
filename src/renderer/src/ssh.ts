// SSH actions of the renderer: connect, reconnect and disconnect cells, open hosts in cells and tabs, follow session events.
// Imports actions.ts for cell helpers, and actions.ts imports this module: a static cycle, safe because neither module uses
// the other at load time (only inside functions).
import { layoutForCount as layoutFor } from '../../shared/layout';
import type { AppState } from '../../shared/types';
import { activeProject, activeTab, addCell, ensureShellProfile, findCell, removeSshHost } from '../../shared/state';
import { connectingNotice, hostEndpoint, promptNeedsToast, reconnectAllTargets, reconnectAtStartCells, restoredPromptToasts, sshCellStart, sshCellVisible, sshStartEffects, type SshStartDecision, sshGridName, sshNotice, sshSessionEnded, type SshPrompt, type SshSessionState } from '../../shared/ssh';
import { menuHosts, sectionChange, sectionForDetail, type SshDetail } from '../../shared/sshView';
import { createProject, ensureTerminal, focusCell, openTab } from './actions';
import { gridCovered } from './splitView';
import type { MenuItem } from './components/ContextMenu';
import { tr } from './i18n';
import type { MessageKey } from '../../shared/i18n';
import { askChoice, getS, getUi, setUi, toast, update } from './store';
import { createInitGate, useSshStore } from './sshStore';
import { terminals } from './terminals/TerminalManager';

/** SSH cells created by the user in this renderer session: they connect when their view mounts (spec 6.1 step 1). */
export const connectOnMount = new Set<string>();

/**
 * SSH cells of hosts with "Łącz ponownie po uruchomieniu aplikacji" that were in the state when this app run's first renderer
 * load booted: each connects once, when its view mounts (a start from automation or a path drop leaves the mark). Empty after
 * a reload (main answers claimAppStart once per run) and cleared by a Pty Host restart (D5 keeps applying there).
 */
const reconnectAtStart = new Set<string>();
/** Bumped by every cancel: an app-start connect still waiting for the sessions of main gives up. */
let startGeneration = 0;

export function markReconnectAtStart(state: Pick<AppState, 'projects' | 'sshHosts'>): void {
  reconnectAtStart.clear();
  for (const id of reconnectAtStartCells(state.projects, state.sshHosts)) reconnectAtStart.add(id);
}

/** A Pty Host restart (heard early in the boot or later): no marked cell connects by itself any more. */
export function cancelReconnectAtStart(): void {
  reconnectAtStart.clear();
  startGeneration++;
}

/** Resolved once initSsh has loaded the sessions of main: an app-start connect waits for it, so the snapshot cannot hide it. */
let sshLoaded!: () => void;
const sshReady = new Promise<void>((resolve) => { sshLoaded = resolve; });

export function sshContext(hostId?: string): { host: string; endpoint: string } {
  const host = hostId ? getS().sshHosts.find((h) => h.id === hostId) : undefined;
  return host ? { host: host.address, endpoint: hostEndpoint(host.address, host.port) } : { host: '', endpoint: '' };
}

const cellLabel = (cellId: string): string => {
  const found = findCell(getS(), cellId);
  const host = found?.cell.ssh ? getS().sshHosts.find((h) => h.id === found.cell.ssh!.hostId) : undefined;
  return found?.cell.name ?? host?.label ?? tr('Host usunięty');
};

const cellVisible = (cellId: string): boolean => {
  const tab = activeTab(activeProject(getS()));
  const max = getUi().maximizedCellId;
  return sshCellVisible({
    cellId,
    inActiveTab: !!tab?.cells.some((c) => c.id === cellId),
    covered: gridCovered(getUi().settingsActive, useSshStore.getState().viewActive),
    maximizedCellId: max && tab?.cells.some((c) => c.id === max) ? max : null,
  });
};

const announcePrompt = (cellId: string): void => toast(tr('SSH: {name} czeka na Twoją decyzję', { name: cellLabel(cellId) }));

function onSession(state: SshSessionState): void {
  const previous = useSshStore.getState().sessions[state.cellId]?.phase;
  useSshStore.getState().setSession(state);
  // I2: a network drop or a close while vim or htop ran leaves the alternate screen, so the notice below stays readable.
  if (sshSessionEnded(previous, state.phase)) terminals.resetSshModes(state.cellId);
  const notice = sshNotice(previous, state, sshContext(state.hostId));
  if (!notice) return;
  const text = notice.key === '[SSH · błąd: {reason}]'
    ? tr(notice.key, { reason: tr(notice.reason.key, notice.reason.params) })
    : tr(notice.key, 'params' in notice ? notice.params : undefined);
  terminals.writeNotice(state.cellId, text);
}

function onPrompt(cellId: string, prompt: SshPrompt | null): void {
  const previousId = useSshStore.getState().prompts[cellId]?.id;
  useSshStore.getState().setPrompt(cellId, prompt);
  if (prompt && promptNeedsToast({ visible: cellVisible(cellId), previousId, nextId: prompt.id })) announcePrompt(cellId);
}

export async function initSsh(): Promise<void> {
  const gate = createInitGate();
  window.mc.on('ssh:session', gate.wrap(onSession));
  window.mc.on('ssh:prompt', gate.wrap(onPrompt));
  window.mc.on('ssh:vault:changed', gate.wrap((vault) => useSshStore.getState().setVault(vault)));
  try {
    const [vault, snapshot] = await Promise.all([window.mc.ssh.vaultInfo(), window.mc.ssh.sessions()]);
    useSshStore.getState().load(vault, snapshot);
    // A reload keeps the prompts open in main (R7): a hidden cell that waits is announced again (Review Focus 2 and 3).
    // Before the held events run (M7): a prompt that arrived meanwhile announces itself through onPrompt.
    for (const cellId of restoredPromptToasts(useSshStore.getState().prompts, cellVisible)) announcePrompt(cellId);
  } finally { gate.open(); sshLoaded(); }
}

/** Called by startOnce for SSH cells (D5: never a connect without the user's intent, or the host's opt-in at app start). */
export function startSshCell(cellId: string, alive: boolean, mounted: boolean): SshStartDecision {
  const found = findCell(getS(), cellId);
  if (!found?.cell.ssh) return 'idle';
  const hostId = found.cell.ssh.hostId;
  const created = connectOnMount.delete(cellId);
  const decision = sshCellStart({
    alive, connectOnMount: created, appStart: reconnectAtStart.has(cellId), mounted,
    reconnectOnStart: getS().sshHosts.some((h) => h.id === hostId && h.reconnectOnStart), phase: useSshStore.getState().sessions[cellId]?.phase,
  });
  if (sshStartEffects(mounted, decision).spendMark) reconnectAtStart.delete(cellId);
  if (decision === 'connect' && created) { void connectCell(cellId); return decision; }
  if (decision === 'connect') { void connectAtStart(cellId); return decision; }
  if (decision === 'idle' && !useSshStore.getState().sessions[cellId]) {
    useSshStore.getState().setSession({ cellId, hostId: found.cell.ssh.hostId, phase: 'idle', since: Date.now() });
  }
  return decision;
}

/** The app-start connect waits for the sessions of main; a Pty Host restart, a closed cell or a connect meanwhile cancels it. */
async function connectAtStart(cellId: string): Promise<void> {
  const epoch = getUi().epoch;
  const generation = startGeneration;
  await sshReady;
  if (getUi().epoch !== epoch || startGeneration !== generation || !findCell(getS(), cellId)?.cell.ssh) return;
  const phase = useSshStore.getState().sessions[cellId]?.phase;
  if (phase !== undefined && phase !== 'idle') return;
  await connectCell(cellId);
}

/** "Połącz ponownie wszystkie SSH": the tab's SSH cells that are idle, ended or failed (never connecting or connected ones). */
export function reconnectAllTargetsOf(projectId: string, tabId: string): string[] {
  const tab = getS().projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  if (!tab) return [];
  return reconnectAllTargets(tab.cells, useSshStore.getState().sessions, new Set(getS().sshHosts.map((h) => h.id)));
}

export function reconnectAllSsh(projectId: string, tabId: string): void {
  for (const cellId of reconnectAllTargetsOf(projectId, tabId)) void connectCell(cellId);
}

export async function connectCell(cellId: string): Promise<void> {
  const found = findCell(getS(), cellId);
  const ref = found?.cell.ssh;
  if (!ref) return;
  ensureTerminal(cellId);
  // A second click while the first request is still connecting writes no second line (main answers it without an event, R13).
  const repeated = useSshStore.getState().sessions[cellId]?.phase === 'connecting';
  terminals.prepareReconnect(cellId);
  if (!repeated) {
    // Written before the request leaves, so it always precedes the server greeting (W4).
    const notice = connectingNotice(sshContext(ref.hostId));
    terminals.writeNotice(cellId, tr(notice.key, notice.params));
    useSshStore.getState().setSession({ cellId, hostId: ref.hostId, phase: 'connecting', since: Date.now() });
  }
  const { cols, rows } = terminals.size(cellId);
  const result = await window.mc.ssh.connect({ cellId, hostId: ref.hostId, cols, rows });
  // A refusal before any session event: the same path as an event, so the "[SSH · błąd: ...]" line is written too.
  if (!result.ok) onSession({ cellId, hostId: ref.hostId, phase: 'error', error: result.error, since: Date.now() });
  else terminals.syncSize(cellId);
}

export async function reconnectCell(cellId: string): Promise<void> {
  await window.mc.killCellAndWait(cellId);
  await connectCell(cellId);
}

export function disconnectCell(cellId: string): void {
  window.mc.killCell(cellId);
}

/** Opens one host in the active grid (a new cell) or in a new tab. No project yet: the usual "create project" flow (D4). */
export async function openHostInCell(hostId: string, target: 'cell' | 'tab'): Promise<void> {
  const host = getS().sshHosts.find((h) => h.id === hostId);
  const project = activeProject(getS());
  if (!host) return;
  if (!project) return createProject();
  const tab = activeTab(project);
  if (target === 'tab' || !tab) return openSshTab(project.id, [hostId], host.label);
  if (tab.cells.length >= 20) return void toast(tr('Siatka ma już maksymalnie 20 komórek'), 'error');
  update((s) => { const r = ensureShellProfile(s); return addCell(r.s, project.id, tab.id, r.profileId, { ssh: { hostId } }); });
  const cell = activeTab(activeProject(getS()))?.cells.at(-1);
  // The cell view mounts in a later effect, so marking it here is in time.
  if (cell?.ssh) { connectOnMount.add(cell.id); focusCell(cell.id); }
}

/** Menu rows that add an SSH cell to the active grid, like choosing a profile (R14): at most 12 hosts, then "Wszystkie hosty…". */
export function sshHostMenuItems(header: MessageKey): MenuItem[] {
  const { shown, more } = menuHosts(getS().sshHosts);
  // The host's colour (Hosty) as a swatch; once one host has a colour the others keep an empty one, so the names line up.
  const anyColor = shown.some((h) => h.color);
  return [
    { header: tr(header) },
    ...(shown.length
      ? shown.map((h) => ({ label: h.label, hint: h.group, color: h.color ?? (anyColor ? 'transparent' : undefined), onClick: () => void openHostInCell(h.id, 'cell') }))
      : [{ label: tr('Dodaj host SSH…'), onClick: () => openSshView({ kind: 'host' }) }]),
    ...(more ? [{ label: tr('Wszystkie hosty…'), onClick: () => openSshView() }] : []),
  ];
}

/** A new tab with one SSH cell per host; openTab marks the cells for connectOnMount before they render. */
export async function openSshTab(projectId: string, hostIds: string[], name?: string): Promise<void> {
  let profileId = '';
  update((s) => { const r = ensureShellProfile(s); profileId = r.profileId; return r.s; });
  await openTab(projectId, layoutFor(hostIds.length), hostIds.map((sshHostId) => ({ profileId, worktree: false, sshHostId })), name);
}

/** A new tab with one connecting cell per host (at most 20), named after the shared group or by count. */
export async function openHostsAsGrid(hostIds: string[]): Promise<void> {
  const project = activeProject(getS());
  if (!project) return createProject();
  const hosts = hostIds.map((id) => getS().sshHosts.find((h) => h.id === id)).filter((h): h is NonNullable<typeof h> => !!h).slice(0, 20);
  if (!hosts.length) return;
  const name = sshGridName(hosts);
  await openSshTab(project.id, hosts.map((h) => h.id), 'group' in name ? name.group : tr('SSH ({count})', { count: name.count }));
}

/** Asks before deleting a host (shared by the host list and the host editor); true when it was deleted. */
export async function confirmRemoveSshHost(hostId: string): Promise<boolean> {
  const host = getS().sshHosts.find((h) => h.id === hostId);
  if (!host) return false;
  const choice = await askChoice(tr('Usunąć host {name}?', { name: host.label }), '', [{ label: tr('Usuń host'), value: 'yes', danger: true }]);
  if (choice !== 'yes') return false;
  update((s) => removeSshHost(s, hostId));
  return true;
}

// ── the SSH view (W3) ────────────────────────────────────────────────────────

/**
 * Brings the SSH view to the front (entered from the rail, 1.0.4: no tab in the strip); with a detail, the pane shows that host
 * or key. Once opened it stays mounted in the background, so its sessions and SFTP connections and its place are kept.
 */
export function openSshView(detail?: SshDetail): void {
  useSshStore.setState((st) => (detail ? { viewOpen: true, viewActive: true, detail, section: sectionForDetail(detail) ?? st.section } : { viewOpen: true, viewActive: true }));
  setUi({ settingsActive: false });
}

/**
 * SSH mode ends: the view goes to the background (it stays open, hidden) and the grid or file under it comes back, also
 * when Settings is in front of it (a panel chosen there is what the user wants to see next).
 */
export function leaveSshMode(): void {
  useSshStore.setState({ viewActive: false });
}

/** A click in the SSH mode navigation: a detail of another section and the host selection go (drafts are not kept, R12). */
export function selectSshSection(clicked: string): void {
  useSshStore.setState((st) => sectionChange(st, clicked));
}

/** Shows a host or key in the details pane, switching to its section (a new key from Hosty opens Klucze). */
export function showSshDetail(detail: SshDetail | null): void {
  useSshStore.setState((st) => ({ detail, section: sectionForDetail(detail) ?? st.section }));
}
