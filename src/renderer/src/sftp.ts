// SFTP actions of the renderer (0.9.8): the view's one session (connect, switch host, disconnect), the login prompts, the
// transfer queue from the SFTP Host's port, conflict questions and the entry points (SSH host menu, SSH cell menu, palette).
// The session model: connect answers with the session id at once; connecting / connected / error / closed and the prompts
// arrive as events for that id (events that come before the answer are held and applied once the id is known).
import { isActive, isFinished, type ConflictChoice, type SftpPortMessage, type SftpSessionState, type TransferItem, applyPortMessage, failUnfinished, LOCAL_QUEUE_ID } from '../../shared/sftp';
import type { SshPrompt } from '../../shared/ssh';
import { formatBytes, mergeSnapshot, reenqueueRequest, type PathFlavor } from '../../shared/sftpView';
import { chosenLanguage, tr } from './i18n';
import { askChoice, askChoiceChecked, getS, getUi, toast, useStore } from './store';
import { openSshView, selectSshSection } from './ssh';
import { useSshStore } from './sshStore';
import { useSftpStore } from './sftpStore';

export const pathFlavor = (): PathFlavor => (window.mc.platform === 'win32' ? 'win32' : 'posix');
/** The queue id of an item as the API wants it: null for the local copies. */
export const queueOf = (sessionId: string): string | null => (sessionId === LOCAL_QUEUE_ID ? null : sessionId);

// ── the transfer port ───────────────────────────────────────────────────────

let port: MessagePort | null = null;

function onPortMessage(m: SftpPortMessage): void {
  useSftpStore.setState((st) => ({ transfers: m.t === 'snapshot' ? mergeSnapshot(st.transfers, m.items) : applyPortMessage(st.transfers, m) }));
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
export async function initSftp(): Promise<void> {
  if (booted) return;
  booted = true;
  window.mc.on('sftp:session', onSession);
  window.mc.on('sftp:prompt', onPrompt);
  window.mc.on('sftp:hostCrashed', onHostCrashed);
  // The idle disconnect of main needs to know when the view is on screen.
  let shown = false;
  const follow = () => {
    const now = sftpVisible();
    if (now === shown) return;
    shown = now;
    if (now) window.mc.sftp.viewOpened(); else window.mc.sftp.viewClosed();
    if (now) void askNextConflict();
  };
  useSshStore.subscribe(follow);
  useStore.subscribe((st, prev) => { if (st.ui.settingsActive !== prev.ui.settingsActive) follow(); });
  useSftpStore.subscribe((st, prev) => { if (st.transfers !== prev.transfers) void askNextConflict(); });
  follow();
  try {
    // After a reload: main still has the session (and maybe a prompt) the view showed.
    const snapshot = await window.mc.sftp.sessions();
    for (const s of snapshot.sessions) if (!lastState.has(s.id)) lastState.set(s.id, s);
    for (const p of snapshot.prompts) if (!lastPrompt.has(p.sessionId)) lastPrompt.set(p.sessionId, p.prompt);
    const live = [...snapshot.sessions].reverse().find((s) => s.state === 'connected' || s.state === 'connecting');
    if (live && !useSftpStore.getState().sessionId) adopt(live.id, live.hostId);
  } catch { /* no SFTP sessions to restore */ }
}

// ── connecting ──────────────────────────────────────────────────────────────

const activeOf = (sessionId: string | null) => useSftpStore.getState().transfers.filter((i) => i.sessionId === sessionId && isActive(i.state));

/** Connects the view to a saved host; a session of another host with running transfers is asked about first. */
export async function connectSftp(hostId: string, initialPath?: string): Promise<boolean> {
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
      if (choice !== 'yes') return false;
    }
    void window.mc.sftp.disconnect(st.sessionId);
  }
  const path = initialPath ?? getS().sftp?.remotePaths[hostId];
  useSftpStore.setState({ pickerOpen: false, remoteGoto: null, prompt: null });
  const result = await window.mc.sftp.connect(hostId, path);
  if (!result.ok) {
    useSftpStore.setState({ sessionId: null, hostId, session: { id: '', hostId, state: 'error', phase: 'error', since: Date.now(), error: result.error }, prompt: null });
    return false;
  }
  adopt(result.sessionId, hostId);
  return true;
}

/** Disconnect (remote pane Actions): running transfers of the session are asked about first. */
export async function disconnectSftp(): Promise<void> {
  const { sessionId } = useSftpStore.getState();
  if (!sessionId) return;
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

export function cancelTransfer(item: TransferItem): void {
  void window.mc.sftp.cancel(queueOf(item.sessionId), { itemIds: [item.id] });
}

export async function retryTransfer(item: TransferItem): Promise<void> {
  if (item.error !== 'sftpHostCrashed' && (await window.mc.sftp.retry(queueOf(item.sessionId), [item.id])).ok) return;
  // The SFTP Host restarted (or the session of the item ended) and forgot this item: the same source goes into the same
  // folder again, on the view's session to the same host.
  const st = useSftpStore.getState();
  let queue: string | null = null;
  if (item.sessionId !== LOCAL_QUEUE_ID) {
    const host = st.sessionHosts[item.sessionId];
    if (!st.sessionId || st.session?.state !== 'connected' || st.hostId !== host) { toast(tr('Połącz się ponownie z tym hostem, aby ponowić transfer'), 'error'); return; }
    queue = st.sessionId;
  }
  const result = await window.mc.sftp.enqueue(queue, reenqueueRequest(item, pathFlavor()));
  if (!result.ok) { toast(tr('Nie udało się ponowić transferu'), 'error'); return; }
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
    tr('Nowy: {size}, {date}', { size: formatBytes(c.incoming.size, language), date: when(c.incoming.mtime) }),
  ].join('\n');
  const { value, checked } = await askChoiceChecked(tr('Konflikt nazw'), body, [
    { label: tr('Zastąp'), value: 'overwrite', danger: true },
    { label: tr('Pomiń'), value: 'skip' },
    { label: tr('Zachowaj oba'), value: 'keepBoth', primary: true },
  ], tr('Zrób to samo dla pozostałych'));
  if (!value) return;
  // The rest of the batch is answered by the host: its open conflicts are not asked again while the update is on its way.
  if (checked) for (const i of useSftpStore.getState().transfers) if (i.batchId === item.batchId && i.state === 'conflict') asked.add(i.id);
  await window.mc.sftp.answerConflict(queueOf(item.sessionId), item.id, { choice: value as ConflictChoice, applyToRest: checked });
}

async function askNextConflict(): Promise<void> {
  if (asking || !sftpVisible()) return;
  const next = useSftpStore.getState().transfers.find((i) => i.state === 'conflict' && i.conflict && !asked.has(i.id));
  if (!next) return;
  asking = true;
  try { await askConflict(next); } finally { asking = false; }
  void askNextConflict();
}
