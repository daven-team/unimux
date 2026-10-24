// SSH actions of the renderer: connect, reconnect and disconnect cells, open hosts in cells and tabs, follow session events.
// Imports actions.ts for cell helpers, and actions.ts imports this module: a static cycle, safe because neither module uses
// the other at load time (only inside functions).
import { layoutForCount as layoutFor } from '../../shared/layout';
import type { AppState } from '../../shared/types';
import { activeProject, activeTab, addCell, ensureShellProfile, findCell, removeSshHost } from '../../shared/state';
import { hostEndpoint, promptNeedsToast, reconnectAllTargets, reconnectAtStartCells, restoredPromptToasts, restoresAtStart, sshCellStart, sshCellVisible, sshStartEffects, type SshStartDecision, sshGridName, sshSessionEnded, type SshPrompt, type SshSessionState } from '../../shared/ssh';
import { menuHosts, sectionChange, sectionForDetail, type SshDetail } from '../../shared/sshView';
import { createProject, ensureTerminal, focusCell, openTab } from './actions';
import { gridCovered } from './splitView';
import type { MenuItem } from './components/ContextMenu';
import { createElement } from 'react';
import { IPlus, IServer } from './components/icons';
import { tr } from './i18n';
import type { MessageKey } from '../../shared/i18n';
import { askChoice, getS, getUi, setUi, toast, update } from './store';
import { createInitGate, useSshStore } from './sshStore';
import { useSshConnectStore } from './sshConnectStore';
import type { ConnectContext } from '../../shared/sshConnect';
import { hostLogin } from '../../shared/sshIdentity';
import { terminals } from './terminals/TerminalManager';
import { forgetRestore, sessionConnected } from './sshRestore';

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

export function markReconnectAtStart(state: Pick<AppState, 'projects' | 'sshHosts' | 'settings'>): void {
  reconnectAtStart.clear();
  for (const id of reconnectAtStartCells(state.projects, state.sshHosts, state.settings.sshRestoreSessions === true)) reconnectAtStart.add(id);
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

/** What the connecting card's log says about the host (user, key, saved password); the same login main will use. */
export function connectContext(hostId: string): ConnectContext {
  const host = getS().sshHosts.find((h) => h.id === hostId);
  if (!host) return { ...sshContext(hostId), user: '' };
  const login = hostLogin(host, getS().sshIdentities);
  const vault = useSshStore.getState().vault;
  const saved = login.secret.kind === 'identity' ? vault?.savedIdentityPasswords ?? [] : vault?.savedPasswords ?? [];
  const keyLabel = login.keyId ? vault?.keys.find((k) => k.id === login.keyId)?.label : undefined;
  return { ...sshContext(hostId), user: login.username, ...(keyLabel ? { keyLabel } : {}), savedPassword: saved.includes(login.secret.id) };
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
  useSshConnectStore.getState().apply(state.cellId, { kind: 'session', at: Date.now(), state, ctx: connectContext(state.hostId) });
  useSshStore.getState().setSession(state);
  // I2: a network drop or a close while vim or htop ran leaves the alternate screen and the remote modes. The terminal gets no
  // status line of the app: from now on the cell card covers it and says what happened (1.0.5).
  if (sshSessionEnded(previous, state.phase)) { terminals.resetSshModes(state.cellId); forgetRestore(state.cellId); }
  if (state.phase === 'connected' && previous !== 'connected') sessionConnected(state.cellId);
}

function onPrompt(cellId: string, prompt: SshPrompt | null): void {
  const previousId = useSshStore.getState().prompts[cellId]?.id;
  useSshConnectStore.getState().apply(cellId, { kind: 'prompt', at: Date.now(), prompt });
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
    // A reload in the middle of a connect: the card picks up from the sessions and prompts main still has.
    for (const state of snapshot.sessions) useSshConnectStore.getState().apply(state.cellId, { kind: 'session', at: Date.now(), state, ctx: connectContext(state.hostId) });
    for (const { cellId, prompt } of snapshot.prompts) useSshConnectStore.getState().apply(cellId, { kind: 'prompt', at: Date.now(), prompt });
    // A reload keeps the prompts open in main (R7): a hidden cell that waits is announced again (Review Focus 2 and 3).
    // Before the held events run (M7): a prompt that arrived meanwhile announces itself through onPrompt.
    for (const cellId of restoredPromptToasts(useSshStore.getState().prompts, cellVisible)) announcePrompt(cellId);
  } finally { gate.open(); sshLoaded(); }
}

/**
 * Called by startOnce for SSH cells (D5: never a connect without the user's intent, the host's opt-in at app start, or the
 * session restore of Settings > SSH for a cell that was connected when the app closed).
 */
export function startSshCell(cellId: string, alive: boolean, mounted: boolean): SshStartDecision {
  const found = findCell(getS(), cellId);
  if (!found?.cell.ssh) return 'idle';
  const created = connectOnMount.delete(cellId);
  const decision = sshCellStart({
    alive, connectOnMount: created, appStart: reconnectAtStart.has(cellId), mounted,
    reconnectOnStart: restoresAtStart(found.cell.ssh, getS().sshHosts, getS().settings.sshRestoreSessions === true), phase: useSshStore.getState().sessions[cellId]?.phase,
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
  // A restored session goes back into its last folder (main types the cd once the shell is up).
  await connectCell(cellId, { restoreCwd: getS().settings.sshRestoreSessions === true });
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

export async function connectCell(cellId: string, opts: { restoreCwd?: boolean } = {}): Promise<void> {
  const found = findCell(getS(), cellId);
  const ref = found?.cell.ssh;
  if (!ref) return;
  ensureTerminal(cellId);
  // A second click while the first request is still connecting starts nothing new (main answers it without an event, R13).
  const repeated = useSshStore.getState().sessions[cellId]?.phase === 'connecting';
  if (!repeated) {
    // A new attempt starts on a clean terminal (before the request leaves, so it always precedes the server greeting, W4):
    // nothing of an earlier session or attempt shows once the shell opens; the card covers the cell until then.
    terminals.prepareReconnect(cellId);
    useSshConnectStore.getState().apply(cellId, { kind: 'start', at: Date.now(), ctx: connectContext(ref.hostId) });
    useSshStore.getState().setSession({ cellId, hostId: ref.hostId, phase: 'connecting', since: Date.now() });
  }
  const { cols, rows } = terminals.size(cellId);
  const result = await window.mc.ssh.connect({ cellId, hostId: ref.hostId, cols, rows, ...(opts.restoreCwd ? { restoreCwd: true } : {}) });
  // A refusal before any session event: the same path as an event, so the card shows the failure.
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
      : [{ label: tr('Dodaj host SSH…'), icon: createElement(IPlus), onClick: () => openSshView({ kind: 'host' }) }]),
    ...(more ? [{ label: tr('Wszystkie hosty…'), icon: createElement(IServer), onClick: () => openSshView() }] : []),
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
