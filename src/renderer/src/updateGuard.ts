// Starting an update while work is in progress (1.1.2). Every in-app way to start an update (the status bar button for an offered,
// downloading or downloaded update; on Windows and macOS alike) goes through requestUpdateInstall: when nothing would be
// interrupted it starts the update as before; otherwise it lists what would be (shared/updateWait.ts) and offers "update when
// they finish", "update now" and cancel. Waiting shows in the status bar (useUpdateWait) and can be cancelled there.
// The question is always asked, whatever settings.confirmCloseWorking says: that setting is about closing a cell, a grid or the
// app on purpose, while an update restarts everything and is one casual click away.
// Only the main window has the update button; it already knows every window's cells (their statuses and waits are mirrored
// here) and the detached windows' unsaved work (closeGuard.detachedWork).
import { create } from 'zustand';
import {
  collectUpdateWork, hasUpdateWork, pendingText, stepUpdateWait, updateBlockers, updateWorkGroups, WAIT_TICK_MS,
  type Blocker, type UpdateText, type UpdateWaitState, type UpdateWork,
} from '../../shared/updateWait';
import type { UpdateState } from '../../shared/types';
import { activeTransferCount, databaseCounts, detachedWork } from './closeGuard';
import { flushDrafts, isFileDirty, useFileStore } from './files';
import { tr } from './i18n';
import { askChoice, getS, getUi, toast, type DialogGroup } from './store';

export interface PendingUpdate { startedAt: number; blockers: Blocker[]; text: UpdateText }
export const useUpdateWait = create<{ pending: PendingUpdate | null }>(() => ({ pending: null }));

/** The update state main last reported (an update can only be waited for while it is offered, downloading or downloaded). */
let updateStatus: UpdateState['status'] = 'idle';
let watching = false;
function watchUpdateState(): void {
  if (watching) return;
  watching = true;
  window.mc.on('update:state', (next) => { updateStatus = next.status; if (useUpdateWait.getState().pending) void tick(); });
  void window.mc.getUpdate().then((next) => { if (updateStatus === 'idle') updateStatus = next.status; }).catch(() => undefined);
}

/** What an update started now would interrupt, over every window. */
export async function currentUpdateWork(): Promise<UpdateWork> {
  const s = getS();
  const ui = getUi();
  const docs = useFileStore.getState().documents;
  const away = detachedWork();
  const busy = await window.mc.updateBusy().catch(() => ({ swap: false, login: false }));
  return collectUpdateWork({
    state: s, statuses: ui.statuses, sessionTitles: ui.sessionTitles, waits: ui.waits,
    unsaved: docs.filter(isFileDirty).map((d) => d.name), saving: docs.filter((d) => d.saving).length,
    away, local: databaseCounts(), transfers: activeTransferCount(), swap: busy.swap, login: busy.login,
  });
}

const text = (t: UpdateText): string => tr(t.key, t.params);
const groupsOf = (work: UpdateWork): DialogGroup[] =>
  updateWorkGroups(work).map((g) => ({ key: g.key, title: text(g.title), names: g.names, note: text(g.note), tone: g.tone }));

/** Hands over to the update window (main shows the download if it is not done, then installs and restarts). */
function startUpdate(): void {
  stopWaiting();
  // Unsaved editor text is kept as drafts over the restart; write the newest one now, not up to 700 ms later.
  flushDrafts();
  window.mc.installUpdate();
}

let timer: ReturnType<typeof setInterval> | null = null;
let waitState: UpdateWaitState | null = null;
let ticking = false;

function stopWaiting(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  waitState = null;
  if (useUpdateWait.getState().pending) useUpdateWait.setState({ pending: null });
}

const installable = (status: UpdateState['status']): boolean => status === 'available' || status === 'downloading' || status === 'ready';

async function tick(): Promise<void> {
  if (!waitState || ticking) return;
  ticking = true;
  try {
    if (!installable(updateStatus)) {
      // Installing already (started elsewhere), or the update went away or failed: nothing to wait for any more.
      const was = updateStatus;
      stopWaiting();
      if (was !== 'installing') toast(tr('Aktualizacja nie jest już gotowa do instalacji.'), 'error');
      return;
    }
    const work = await currentUpdateWork();
    if (!waitState) return;
    const step = stepUpdateWait(waitState, work, Date.now(), { downloading: updateStatus === 'downloading' });
    waitState = step.state;
    if (step.action === 'install') { startUpdate(); return; }
    if (step.action === 'expire') {
      stopWaiting();
      toast(tr('Aktualizacja nie doczekała się końca pracy. Zainstalujesz ją przyciskiem w stopce.'), 'error');
      return;
    }
    useUpdateWait.setState({ pending: { startedAt: waitState.startedAt, blockers: step.blockers, text: pendingText(step.blockers) } });
  } finally { ticking = false; }
}

/** "Update when they finish": looks again every second until nothing is in progress, then starts the update. */
export function waitThenUpdate(now = Date.now()): void {
  watchUpdateState();
  stopWaiting();
  waitState = { startedAt: now };
  useUpdateWait.setState({ pending: { startedAt: now, blockers: [], text: pendingText([{ kind: 'working' }]) } });
  timer = setInterval(() => { void tick(); }, WAIT_TICK_MS);
  void tick();
}

/** The waiting update is dropped (the status bar's X, or "Nie aktualizuj"); the button offers the update again. */
export function cancelWaitingUpdate(): void { stopWaiting(); }

let asking = false;

/** The status bar's update button: updates at once when nothing is in progress, else asks (or, while waiting, says what for). */
export async function requestUpdateInstall(status?: UpdateState['status']): Promise<void> {
  watchUpdateState();
  if (status) updateStatus = status;
  if (asking) return;
  asking = true;
  try {
    if (useUpdateWait.getState().pending) { await askAboutWaiting(); return; }
    const work = await currentUpdateWork();
    if (!hasUpdateWork(work)) { startUpdate(); return; }
    const now = Date.now();
    const waits = updateBlockers(work, now, now).length > 0;
    const intro = tr('Aktualizacja zamknie aplikację i uruchomi nową wersję. Rozmowy agentów wrócą po restarcie (aplikacja wznowi ich sesje), ale przerwana tura przepadnie.');
    const choice = await askChoice(waits ? tr('Aktualizacja przerwie pracę w toku') : tr('Zaktualizować aplikację?'), intro, waits ? [
      { label: tr('Zaktualizuj teraz'), value: 'now', danger: true, title: tr('Przerywa bieżące tury agentów i pozostałą pracę w toku') },
      { label: tr('Zaktualizuj, gdy skończą'), value: 'wait', primary: true },
    ] : [
      { label: tr('Zaktualizuj'), value: 'now', primary: true },
    ], { groups: groupsOf(work) });
    if (choice === 'now') startUpdate();
    else if (choice === 'wait') waitThenUpdate();
  } finally { asking = false; }
}

/** A click on the waiting update: what it still waits for, with "update now" and "do not update". */
async function askAboutWaiting(): Promise<void> {
  const work = await currentUpdateWork();
  const choice = await askChoice(tr('Aktualizacja czeka na koniec pracy'), tr('Aktualizacja zacznie się sama, gdy nic nie będzie w toku. Możesz dalej pracować i wysyłać prompty.'), [
    { label: tr('Nie aktualizuj'), value: 'cancel' },
    { label: tr('Zaktualizuj teraz'), value: 'now', danger: true, title: tr('Przerywa bieżące tury agentów i pozostałą pracę w toku') },
  ], { groups: groupsOf(work), cancelLabel: tr('Czekaj dalej') });
  if (!useUpdateWait.getState().pending) return;
  if (choice === 'now') startUpdate();
  else if (choice === 'cancel') stopWaiting();
}
