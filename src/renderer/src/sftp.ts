// SFTP actions of the renderer (0.9.8): the view's one session (connect, switch host, disconnect), the login prompts, the
// transfer queue from the SFTP Host's port, conflict questions and the entry points (SSH host menu, SSH cell menu, palette).
// The session model: connect answers with the session id at once; connecting / connected / error / closed and the prompts
// arrive as events for that id (events that come before the answer are held and applied once the id is known).
import { finishedMoves, isActive, isFinished, sftpErrorText, type ConflictChoice, type TransferRequest, type SftpPortMessage, type SftpSessionState, type TransferItem, applyPortMessage, failUnfinished, LOCAL_QUEUE_ID } from '../../shared/sftp';
import type { SshPrompt } from '../../shared/ssh';
import { canRetry, formatBytes, mergeSnapshot, reenqueueRequest, type PathFlavor } from '../../shared/sftpView';
import { chosenLanguage, tr } from './i18n';
import { askChoice, askChoiceChecked, getS, getUi, toast, useStore } from './store';
import { openSshView, selectSshSection } from './ssh';
import { useSshStore } from './sshStore';
import { useSftpStore } from './sftpStore';
import { liveSession, pinnedHosts } from './remoteSessions';
import { followMoves } from './files';

export const pathFlavor = (): PathFlavor => (window.mc.platform === 'win32' ? 'win32' : 'posix');
/** The queue id of an item as the API wants it: null for the local copies. */
export const queueOf = (sessionId: string): string | null => (sessionId === LOCAL_QUEUE_ID ? null : sessionId);

// ── the transfer port ───────────────────────────────────────────────────────

let port: MessagePort | null = null;

function onPortMessage(m: SftpPortMessage): void {
  if (m.t === 'opProgress') {
    useSftpStore.setState((st) => ({ opProgress: { ...st.opProgress, [m.opId]: { done: m.done, total: m.total } } }));
    return;
  }
  const moves = finishedMoves(useSftpStore.getState().transfers, m);
  useSftpStore.setState((st) => ({ transfers: m.t === 'snapshot' ? mergeSnapshot(st.transfers, m.items) : applyPortMessage(st.transfers, m) }));
  if (moves.length) followQueueMoves(moves);
}

/** Editor tabs follow the moves the queue finished (0.9.9): a server move by the host of its session, a local one on this computer. */
function followQueueMoves(items: TransferItem[]): void {
  const local = items.filter((i) => i.direction === 'local-move').map((i) => ({ from: i.source, to: i.target }));
  if (local.length) followMoves({ kind: 'local' }, local);
  const hosts = useSftpStore.getState().sessionHosts;
  const byHost = new Map<string, Array<{ from: string; to: string }>>();
  for (const i of items) {
    const hostId = i.direction === 'move' ? hosts[i.sessionId] ?? lastState.get(i.sessionId)?.hostId : undefined;
    if (hostId) byHost.set(hostId, [...(byHost.get(hostId) ?? []), { from: i.source, to: i.target }]);
  }
  for (const [hostId, moves] of byHost) followMoves({ kind: 'remote', hostId }, moves);
}

// Registered when the module loads (before the page finishes loading), so a port sent at did-finish-load is never missed.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data !== 'mc:sftp-port' || !e.ports[0]) return;
    port?.close();
    port = e.ports[0];
    port.onmessage = (ev: MessageEvent<SftpPortMessage>) => { if (ev.data && typeof ev.data === 'object' && 't' in ev.data) onPortMessage(ev.data); };
    port.start();
  });
}

// ── session events ──────────────────────────────────────────────────────────

/** The newest state and prompt of every session, also of ones whose id the view does not know yet (connect not answered). */
const lastState = new Map<string, SftpSessionState>();
const lastPrompt = new Map<string, SshPrompt | null>();

function adopt(sessionId: string, hostId: string): void {
  useSftpStore.setState((st) => ({
    sessionId, hostId, session: lastState.get(sessionId) ?? { id: sessionId, hostId, state: 'connecting', phase: 'connecting', since: Date.now() },
    prompt: lastPrompt.get(sessionId) ?? null, sessionHosts: { ...st.sessionHosts, [sessionId]: hostId },
  }));
}

function onSession(state: SftpSessionState): void {
  lastState.set(state.id, state);
  useSftpStore.setState((st) => ({
    sessionHosts: st.sessionHosts[state.id] ? st.sessionHosts : { ...st.sessionHosts, [state.id]: state.hostId },
    ...(st.sessionId === state.id ? { session: state, ...(state.state !== 'connecting' ? { prompt: null } : {}) } : {}),
  }));
}

function onPrompt(sessionId: string, prompt: SshPrompt | null): void {
  lastPrompt.set(sessionId, prompt);
  if (useSftpStore.getState().sessionId === sessionId) useSftpStore.setState({ prompt });
}

function onHostCrashed(): void {
  useSftpStore.setState((st) => ({ transfers: failUnfinished(st.transfers, Date.now()) }));
}

/** Whether the SFTP view is on screen: SSH view in front, its SFTP section chosen, Settings not over it. */
export const sftpVisible = (): boolean => {
  const ssh = useSshStore.getState();
  return ssh.viewOpen && ssh.viewActive && ssh.section === 'sftp' && !getUi().settingsActive;
};

let booted = false;
/**
 * 1.0.8, a detached window: no SFTP view there, but its editor tab follows the moves and renames the queue finishes (the port
 * reaches every window); the hosts of the sessions come from their events.
 */
export async function initSftpFollow(): Promise<void> {
  if (booted) return;
  booted = true;
  window.mc.on('sftp:session', onSession);
  window.mc.on('sftp:hostCrashed', onHostCrashed);
  try {
    const snapshot = await window.mc.sftp.sessions();
    for (const s of snapshot.sessions) if (!lastState.has(s.id)) lastState.set(s.id, s);
    useSftpStore.setState((st) => ({ sessionHosts: { ...Object.fromEntries(snapshot.sessions.map((s) => [s.id, s.hostId])), ...st.sessionHosts } }));
  } catch { /* no sessions yet */ }
}

export async function initSftp(): Promise<void> {
  if (booted) return;
  booted = true;
  window.mc.on('sftp:session', onSession);
  window.mc.on('sftp:prompt', onPrompt);
  window.mc.on('sftp:hostCrashed', onHostCrashed);
  // The idle disconnect of main needs to know when the view is on screen and which session it shows (every other one may go
  // idle meanwhile).
  let shown = false;
  let shownSession: string | null = null;
  const follow = () => {
    const now = sftpVisible();
    const session = useSftpStore.getState().sessionId;
    if (now === shown && (!now || session === shownSession)) return;
    const opened = now && !shown;
    shown = now;
    shownSession = now ? session : null;
    if (now) window.mc.sftp.viewOpened(session); else window.mc.sftp.viewClosed();
    if (opened) void askNextConflict();
  };
  useSshStore.subscribe(follow);
  useStore.subscribe((st, prev) => {
    if (st.ui.settingsActive !== prev.ui.settingsActive) follow();
    // A conflict question waits for any open dialog to close (it never replaces one).
    if (prev.ui.dialog && !st.ui.dialog) void askNextConflict();
  });
  useSftpStore.subscribe((st, prev) => {
    if (st.sessionId !== prev.sessionId) follow();
    if (st.transfers === prev.transfers) return;
    // An item that left the conflict state (answered, retried, removed) may be asked again when it meets a conflict later.
    if (asked.size) {
      const open = new Set(st.transfers.filter((i) => i.state === 'conflict').map((i) => i.id));
      for (const id of asked) if (!open.has(id)) asked.delete(id);
    }
    void askNextConflict();
  });
  follow();
  try {
    // After a reload: main still has the session (and maybe a prompt) the view showed.
    const snapshot = await window.mc.sftp.sessions();
    for (const s of snapshot.sessions) if (!lastState.has(s.id)) lastState.set(s.id, s);
    for (const p of snapshot.prompts) if (!lastPrompt.has(p.sessionId)) lastPrompt.set(p.sessionId, p.prompt);
    // Sessions of editor tabs (plain) are never adopted: the view would work without sudo and its "Rozłącz" would end them.
    const live = [...snapshot.sessions].reverse().find((s) => !s.plain && (s.state === 'connected' || s.state === 'connecting'));
    if (live && !useSftpStore.getState().sessionId) adopt(live.id, live.hostId);
  } catch { /* no SFTP sessions to restore */ }
}

// ── connecting ──────────────────────────────────────────────────────────────

const activeOf = (sessionId: string | null) => useSftpStore.getState().transfers.filter((i) => i.sessionId === sessionId && isActive(i.state));

/** Bumped by every connect: an answer that arrives after a newer connect started is disconnected, never adopted. */
let connectSeq = 0;

/** Whether dirty editor tabs use the view's session: a pinned host and the session the tabs pick (never a sudo one). */
const tabsUse = (sessionId: string, hostId: string | null): boolean => !!hostId && pinnedHosts().has(hostId) && liveSession(hostId) === sessionId;

/** Connects the view to a saved host; a session of another host with running transfers is asked about first. */
export async function connectSftp(hostId: string, initialPath?: string): Promise<boolean> {
  const seq = ++connectSeq;
  const st = useSftpStore.getState();
  if (!getS().sshHosts.some((h) => h.id === hostId)) return false;
  const live = st.session && (st.session.state === 'connected' || st.session.state === 'connecting');
  if (st.sessionId && live && st.hostId === hostId) {
    // Already on this host: only the folder changes.
    if (initialPath) useSftpStore.setState({ remoteGoto: { path: initialPath, seq: (st.remoteGoto?.seq ?? 0) + 1 }, pickerOpen: false });
    else useSftpStore.setState({ pickerOpen: false });
    return true;
  }
  if (st.sessionId && live) {
    const running = activeOf(st.sessionId).length;
    if (running) {
      const choice = await askChoice(tr('Przerwać transfery i zmienić host?'), tr('Transfery w toku: {count}. Zmiana hosta je anuluje.', { count: running }), [
        { label: tr('Zmień host'), value: 'yes', danger: true },
      ]);
      if (choice !== 'yes' || seq !== connectSeq) return false;
    }
    // Unsaved remote tabs of the old host keep using its session: the view only lets go of it (main keeps a pinned session).
    // A sudo session is never one the tabs use, so it always ends here.
    if (!tabsUse(st.sessionId, st.hostId)) void window.mc.sftp.disconnect(st.sessionId);
    else if (running) void window.mc.sftp.cancel(st.sessionId, { itemIds: activeOf(st.sessionId).map((i) => i.id).slice(0, 1000) });
  }
  const path = initialPath ?? getS().sftp?.remotePaths[hostId];
  useSftpStore.setState({ pickerOpen: false, remoteGoto: null, prompt: null });
  const result = await window.mc.sftp.connect(hostId, path);
  if (seq !== connectSeq) {
    // Another host was chosen meanwhile: this session would stay connected but unseen.
    if (result.ok) void window.mc.sftp.disconnect(result.sessionId);
    return false;
  }
  if (!result.ok) {
    useSftpStore.setState({ sessionId: null, hostId, session: { id: '', hostId, state: 'error', phase: 'error', since: Date.now(), error: result.error }, prompt: null });
    return false;
  }
  adopt(result.sessionId, hostId);
  return true;
}

/** Disconnect (remote pane Actions): running transfers of the session are asked about first. */
export async function disconnectSftp(): Promise<void> {
  const { sessionId, hostId } = useSftpStore.getState();
  if (!sessionId) return;
  if (tabsUse(sessionId, hostId)) {
    // Editor tabs with unsaved changes use this connection: their next save would have to log in again.
    const choice = await askChoice(tr('Rozłączyć mimo niezapisanych plików?'), tr('Karty z niezapisanymi zmianami w plikach tego serwera korzystają z tego połączenia. Przy zapisie połączą się ponownie.'), [
      { label: tr('Rozłącz'), value: 'yes', danger: true },
    ]);
    if (choice !== 'yes') return;
  }
  const running = activeOf(sessionId).length;
  if (running) {
    const choice = await askChoice(tr('Rozłączyć i przerwać transfery?'), tr('Transfery w toku: {count}.', { count: running }), [
      { label: tr('Rozłącz'), value: 'yes', danger: true },
    ]);
    if (choice !== 'yes') return;
  }
  await window.mc.sftp.disconnect(sessionId);
  useSftpStore.setState({ sessionId: null, session: null, prompt: null, remoteGoto: null });
}

/** "Zmień host": the picker over the remote pane (the session stays until another host is chosen). */
export const openHostPicker = (): void => useSftpStore.setState({ pickerOpen: true });

// ── entry points ────────────────────────────────────────────────────────────

/** Shows the SFTP view (SSH mode, SFTP section); with a host it connects, optionally in `path`; `picker` opens the host list. */
export function openSftp(opts: { hostId?: string; path?: string; picker?: boolean } = {}): void {
  openSshView();
  selectSshSection('sftp');
  if (opts.hostId) void connectSftp(opts.hostId, opts.path);
  else if (opts.picker) openHostPicker();
}

// ── transfers ───────────────────────────────────────────────────────────────

/**
 * Starts a transfer. The view picks the batch id, so a long folder walk can be stopped (cancelBatch) before the host answers;
 * meanwhile the batch shows as "preparing" in the transfer panel. A failure (not a cancel) is shown as a toast.
 */
export async function enqueueTransfer(queue: string | null, req: TransferRequest): Promise<boolean> {
  const batchId = crypto.randomUUID();
  useSftpStore.setState((st) => ({ preparing: [...st.preparing, { batchId, queue, sources: req.sources.length }] }));
  try {
    const r = await window.mc.sftp.enqueue(queue, { ...req, batchId });
    if (!r.ok && r.error !== 'cancelled') { const t = sftpErrorText(r.error); toast(tr(t.key, t.params), 'error'); }
    return r.ok;
  } catch {
    toast(tr('Operacja nie powiodła się'), 'error');
    return false;
  } finally {
    useSftpStore.setState((st) => ({ preparing: st.preparing.filter((b) => b.batchId !== batchId) }));
  }
}

export function cancelBatch(queue: string | null, batchId: string): void {
  void window.mc.sftp.cancel(queue, { batchId });
}

export function cancelTransfer(item: TransferItem): void {
  void window.mc.sftp.cancel(queueOf(item.sessionId), { itemIds: [item.id] });
}

export async function retryTransfer(item: TransferItem): Promise<void> {
  // Entries a folder transfer left out (links, unsafe names) stay out: a re-enqueue as a top-level source would follow a link.
  if (!canRetry(item)) return;
  const st = useSftpStore.getState();
  const liveQueue = item.sessionId === LOCAL_QUEUE_ID || (item.sessionId === st.sessionId && st.session?.state === 'connected');
  if (item.error !== 'sftpHostCrashed' && liveQueue) {
    // The host refuses a retry of entries a folder transfer left out (links, unsafe names): it says so.
    if (!(await window.mc.sftp.retry(queueOf(item.sessionId), [item.id])).ok) toast(tr('Nie udało się ponowić transferu'), 'error');
    return;
  }
  // The SFTP Host restarted or the item's session ended, so its queue is gone: the same source goes into the same folder
  // again, on the view's session to the same host.
  let queue: string | null = null;
  if (item.sessionId !== LOCAL_QUEUE_ID) {
    const host = st.sessionHosts[item.sessionId];
    if (!st.sessionId || st.session?.state !== 'connected' || st.hostId !== host) { toast(tr('Połącz się ponownie z tym hostem, aby ponowić transfer'), 'error'); return; }
    queue = st.sessionId;
  }
  if (!await enqueueTransfer(queue, reenqueueRequest(item, pathFlavor()))) return;
  useSftpStore.setState((s) => ({ transfers: s.transfers.filter((i) => i.id !== item.id) }));
}

export async function clearFinishedTransfers(): Promise<void> {
  const queues = [...new Set(useSftpStore.getState().transfers.map((i) => i.sessionId))];
  const results = await Promise.all(queues.map((q) => window.mc.sftp.clearFinished(queueOf(q)).catch(() => ({ ok: false }))));
  // A queue the host no longer has (its session ended, the host restarted) is cleared here: nothing would remove its items.
  const gone = new Set(queues.filter((_, i) => !results[i].ok));
  useSftpStore.setState((s) => ({ transfers: s.transfers.filter((i) => !(isFinished(i.state) && (gone.has(i.sessionId) || i.error === 'sftpHostCrashed'))) }));
}

// ── conflicts ───────────────────────────────────────────────────────────────

/** Conflicts already put to the user (a dismissed question is not asked again: the queue row offers it). */
const asked = new Set<string>();
let asking = false;

export async function askConflict(item: TransferItem): Promise<void> {
  if (!item.conflict) return;
  asked.add(item.id);
  const language = chosenLanguage();
  const when = (ms: number) => (ms ? new Date(ms).toLocaleString(language) : '-');
  const c = item.conflict;
  const body = [
    tr('{name} już istnieje w miejscu docelowym.', { name: item.name }),
    '',
    tr('Istniejący: {size}, {date}', { size: c.existing.kind === 'dir' ? tr('Folder') : formatBytes(c.existing.size, language), date: when(c.existing.mtime) }),
    tr('Nowy: {size}, {date}', { size: c.incoming.kind === 'dir' ? tr('Folder') : formatBytes(c.incoming.size, language), date: when(c.incoming.mtime) }),
  ].join('\n');
  // Only a file replaces a file (0.9.9: a moved folder is never merged into or replaced by another entry).
  const canOverwrite = c.existing.kind !== 'dir' && c.incoming.kind !== 'dir';
  const { value, checked, replaced } = await askChoiceChecked(tr('Konflikt nazw'), body, [
    ...(canOverwrite ? [{ label: tr('Zastąp'), value: 'overwrite', danger: true }] : []),
    { label: tr('Pomiń'), value: 'skip' },
    { label: tr('Zachowaj oba'), value: 'keepBoth', primary: true },
  ], tr('Zrób to samo dla pozostałych'));
  // Another dialog took its place: the question comes back once that one is closed. Only Anuluj counts as dismissed.
  if (replaced) asked.delete(item.id);
  if (!value) return;
  // The rest of the batch is answered by the host: its open conflicts are not asked again while the update is on its way.
  if (checked) for (const i of useSftpStore.getState().transfers) if (i.batchId === item.batchId && i.state === 'conflict') asked.add(i.id);
  await window.mc.sftp.answerConflict(queueOf(item.sessionId), item.id, { choice: value as ConflictChoice, applyToRest: checked });
}

async function askNextConflict(): Promise<void> {
  if (asking || !sftpVisible() || getUi().dialog) return;
  const next = useSftpStore.getState().transfers.find((i) => i.state === 'conflict' && i.conflict && !asked.has(i.id));
  if (!next) return;
  asking = true;
  try { await askConflict(next); } finally { asking = false; }
  void askNextConflict();
}
