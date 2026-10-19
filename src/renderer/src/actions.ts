import { errorText, tr } from './i18n';
// High-level user actions: they combine state transitions with pty/terminal side effects.
import type { GridLayout } from '../../shared/layout';
import { normalizeProjectPath } from '../../shared/platform';
import { layoutForCount } from '../../shared/layout';
import { CELL_HEAD_HEIGHT, cellBodyBox, chooseGridSize, type Size } from '../../shared/cellBox';
import {
  activeProject, activeTab, addCell, addProject, addTab, cellWorktreeUse, closeTab as closeTabState, ensureShellProfile, findCell, getProfile,
  removeCell as removeCellState, removeProject as removeProjectState, restoreTab, setActiveProject, setActiveTab, focusGrid,
  swapCells as swapCellsState, uid, updateCell, updateSettings,
} from '../../shared/state';
import { canSwapCells, neighborSlot } from '../../shared/gridDrag';
import { CLI_NAMES, profileAvailable, type CliId, type CliStatusMap } from '../../shared/cliStatus';
import { snapshotCellRects } from './gridMotion';
import { sessionSearchPaths } from '../../shared/sessionTrack';
import { sshSpecName, sshStartEffects } from '../../shared/ssh';
import type { CellSession, Profile, SessionInfo, Snippet, Tab, Worktree, WorktreeInspection, WorktreeInspectResult, WorktreeRemoveResult } from '../../shared/types';
import { askChoice, getS, getUi, setUi, toast, update } from './store';
import { confirmCloseWorking } from './closeGuard';
import { namesList, workingAgents } from '../../shared/agentWork';
import { flushDrafts, showTerminalTabs } from './files';
import { cancelReconnectAtStart, connectOnMount, reconnectCell, startSshCell } from './ssh';
import { terminals } from './terminals/TerminalManager';

/** Cells whose pty was started (or found alive) during this renderer session. */
const started = new Set<string>();
let aliveAtStart = new Set<string>();
/** Cells the user chose to start although their CLI is detected as missing (an alias, a profile-defined PATH...). */
const forcedCells = new Set<string>();

// Held cells (start skipped, CLI missing) live in the store so the install card is only drawn for them.
const hold = (cellId: string): void => { if (!getUi().heldCells[cellId]) setUi((ui) => ({ heldCells: { ...ui.heldCells, [cellId]: true } })); };
const unhold = (cellId: string): void => {
  if (getUi().heldCells[cellId]) setUi((ui) => { const { [cellId]: _, ...rest } = ui.heldCells; return { heldCells: rest }; });
};

export function setAliveAtStart(ids: string[]): void {
  aliveAtStart = new Set(ids);
}

export function resetStarted(): void {
  started.clear();
  skippedInBackground.clear();
  aliveAtStart.clear();
  // D5: after a Pty Host crash no SSH cell connects by itself, not even one marked but not yet mounted.
  connectOnMount.clear();
  cancelReconnectAtStart(); // and no app-start reconnect either: a Pty Host restart is not an app start
  setUi((ui) => ({ epoch: ui.epoch + 1 }));
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// ── cells ───────────────────────────────────────────────────────────────────

/** Ctrl+wheel resizes the font on every notch; the saved value follows once the wheel rests (one edit instead of dozens). */
const fontSizeSaves = new Map<string, { timer: number; size: number }>();
function saveFontSize(cellId: string, size: number): void {
  const earlier = fontSizeSaves.get(cellId);
  if (earlier) window.clearTimeout(earlier.timer);
  fontSizeSaves.set(cellId, { size, timer: window.setTimeout(() => commitFontSize(cellId), 250) });
}
function commitFontSize(cellId: string): void {
  const save = fontSizeSaves.get(cellId);
  if (!save) return;
  window.clearTimeout(save.timer);
  fontSizeSaves.delete(cellId);
  update((s) => updateCell(s, cellId, { fontSize: save.size }));
}
/** Sends debounced edits now (window hidden, reload, app quitting), so the last wheel notch or keystroke is not lost. */
export function flushPendingSaves(): void {
  for (const cellId of [...fontSizeSaves.keys()]) commitFontSize(cellId);
  flushDrafts(); // unsaved editor drafts (written with a delay while typing)
}

export function ensureTerminal(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const profile = getProfile(getS(), found.cell.profileId);
  // An SSH cell stays SSH whatever its profile says (R5).
  const ssh = !!found.cell.ssh;
  terminals.ensure(cellId, {
    fontSize: found.cell.fontSize ?? getS().settings.fontSize,
    agent: !ssh && profile.cli !== 'shell',
    codex: !ssh && profile.cli === 'codex',
    remote: ssh,
    onFontSize: (size) => saveFontSize(cellId, size),
  });
}

/**
 * Starts the cell's terminal once per session (resuming its conversation when it has one). `fromView` is set by the cell view
 * when it mounts: only then may an SSH cell connect by itself at app start (never from automation or a path drop).
 */
export function ensureStarted(cellId: string, fromView = false): void {
  void startOnce(cellId, undefined, fromView);
}

/** The cell's start was requested in this renderer session. */
export const isStarted = (cellId: string): boolean => started.has(cellId);

function startOnce(cellId: string, beforeSpawn?: (cellId: string) => void, fromView = false): Promise<void> {
  if (started.has(cellId)) return Promise.resolve();
  started.add(cellId);
  startListeners.forEach((l) => l());
  ensureTerminal(cellId);
  if (findCell(getS(), cellId)?.cell.ssh) {
    const decision = startSshCell(cellId, aliveAtStart.delete(cellId), fromView);
    // A start from outside the view that ends idle does not count: the cell's later mount decides again (app-start reconnect).
    if (!sshStartEffects(fromView, decision).keepStarted) started.delete(cellId);
    return Promise.resolve();
  }
  // pty survived a renderer reload; its output is replayed
  if (aliveAtStart.delete(cellId)) {
    terminals.beginCodex(cellId, findCell(getS(), cellId)?.cell.session);
    return Promise.resolve();
  }
  beforeSpawn?.(cellId);
  const cell = findCell(getS(), cellId)?.cell;
  return spawnCell(cellId, cell?.session ? 'resume' : 'new');
}

/** Cells the background loader found it cannot start (missing worktree folder): they start, and report it, once opened. */
const skippedInBackground = new Set<string>();
export const needsBackgroundStart = (cellId: string): boolean => {
  if (started.has(cellId) || skippedInBackground.has(cellId)) return false;
  const found = findCell(getS(), cellId);
  if (found?.cell.ssh) return false; // SSH cells never connect in the background (D5)
  return !!found && !getUi().missingPaths[found.project.id];
};

/**
 * Starts a cell that is not on screen, by the same rules as opening it (resume or new, held while its CLI is missing, MCP role,
 * one-shot startup prompt, alive pty survivors). Its terminal is created off-screen and fitted to the box the cell will get.
 */
export async function startCellInBackground(cellId: string): Promise<boolean> {
  if (!needsBackgroundStart(cellId)) return false;
  const found = findCell(getS(), cellId)!;
  if (found.cell.worktree && !(await window.mc.pathExists(found.cell.worktree.path))) {
    skippedInBackground.add(cellId);
    return false;
  }
  if (!needsBackgroundStart(cellId)) return false; // opened or closed meanwhile
  await startOnce(cellId, presizeForLayout);
  return true;
}

const startListeners = new Set<() => void>();
/** Called whenever a cell's start is requested (by a view or the loader). */
export const onCellStart = (listener: () => void): (() => void) => { startListeners.add(listener); return () => startListeners.delete(listener); };

let lastGridSize: Size | null = null;
const measure = (selector: string): Size | null => {
  const rect = document.querySelector(selector)?.getBoundingClientRect();
  return rect ? { width: rect.width, height: rect.height } : null;
};

/** The header height of a rendered cell, else the --cell-head CSS variable, else the shared constant. */
function cellHeadHeight(): number {
  const rendered = document.querySelector<HTMLElement>('.cell-head')?.offsetHeight;
  if (rendered) return rendered;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-head')) || CELL_HEAD_HEIGHT;
}

/** Fits the not yet shown terminal of a cell to the box it will get. The grid measures 0x0 while Settings or an editor covers it: the workspace (or the last size seen) stands in. */
function presizeForLayout(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const grid = chooseGridSize([measure('.terminal-workspace .grid'), measure('.workspace-content')], lastGridSize);
  if (!grid) return;
  lastGridSize = grid;
  const box = cellBodyBox(found.tab.layout, found.tab.cells.findIndex((c) => c.id === cellId), grid, cellHeadHeight());
  if (box) terminals.presize(cellId, box.width, box.height);
}

export async function spawnCell(cellId: string, mode: 'new' | 'resume'): Promise<void> {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const { project, cell } = found;
  const profile = getProfile(getS(), cell.profileId);
  started.add(cellId);
  // "Uruchom ponownie" of an SSH cell is "Połącz ponownie": kill and wait, then connect; the terminal is not reset (R13).
  if (cell.ssh) { void reconnectCell(cellId); return; }
  ensureTerminal(cellId);
  // A CLI known to be missing never gets a shell that only prints "command not found": the cell shows an install card.
  if (!forcedCells.has(cellId) && !profileAvailable(profile, getUi().cliStatus)) return holdForCli(cellId);
  unhold(cellId);

  let sessionId: string | undefined;
  const sameCli = cell.session && cell.session.cli === profile.cli;
  if (mode === 'resume' && sameCli) sessionId = cell.session!.id;
  else mode = 'new';

  if (mode === 'new') {
    let session: CellSession | undefined;
    if (profile.cli === 'claude') {
      sessionId = uid();
      session = { cli: 'claude', id: sessionId };
    }
    update((s) => updateCell(s, cellId, { session }));
  }

  terminals.prepareSpawn(cellId, mode === 'resume' && sameCli ? cell.session : undefined);
  setUi((ui) => {
    const { [cellId]: _, ...rest } = ui.cellErrors;
    return { cellErrors: rest };
  });
  const { cols, rows } = terminals.size(cellId);
  let r: Awaited<ReturnType<typeof window.mc.spawnCell>>;
  try {
    r = await window.mc.spawnCell({
      cellId, cwd: cell.worktree?.path ?? project.path, cols, rows, profile, mode, sessionId, ...(forcedCells.has(cellId) ? { force: true } : {}),
      sessionConfirmed: mode === 'resume' && cell.session?.confirmed === true,
      startupPrompt: mode === 'new' && profile.cli !== 'shell' ? cell.startupPrompt : undefined,
    });
  } catch (error) {
    // The call itself failed (main threw): the cell says so instead of staying blank.
    r = { ok: false, error: tr('Nie udało się uruchomić terminala: {error}', { error: error instanceof Error ? error.message : String(error) }) };
  }
  // The startup prompt is a one-shot: later restarts must not send it again.
  if (r.ok && cell.startupPrompt && mode === 'new') update((s) => updateCell(s, cellId, { startupPrompt: undefined }));
  if (!r.ok && r.cliMissing) {
    // The renderer's picture was stale (still unknown): main knows the CLI is missing.
    const cli = r.cliMissing;
    const known = r.cliStatus ?? { cli, state: 'missing' as const, checkedAt: Date.now() };
    setUi((ui) => ({ cliStatus: { ...ui.cliStatus, [cli]: known } }));
    return holdForCli(cellId);
  }
  if (!r.ok) setUi((ui) => ({ cellErrors: { ...ui.cellErrors, [cellId]: r.error } }));
  else terminals.syncSize(cellId);
}

function holdForCli(cellId: string): void {
  hold(cellId);
  window.mc.killCell(cellId); // a previous shell of this cell (profile switch) must not keep running behind the card
}

export const hasBlockedCells = (): boolean => Object.keys(getUi().heldCells).length > 0;

/** "Uruchom mimo to": starts a held cell although its CLI is detected as missing; later detections do not hold it again. */
export function startCellAnyway(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found) return;
  forcedCells.add(cellId);
  unhold(cellId);
  void spawnCell(cellId, found.cell.session ? 'resume' : 'new');
}

/** Starts, exactly once, every held cell whose CLI is not known to be missing any more (resume rules unchanged). */
export function resumeBlockedCells(): void {
  for (const cellId of Object.keys(getUi().heldCells)) {
    const found = findCell(getS(), cellId);
    if (!found) { unhold(cellId); continue; }
    if (!profileAvailable(getProfile(getS(), found.cell.profileId), getUi().cliStatus)) continue;
    unhold(cellId);
    void spawnCell(cellId, found.cell.session ? 'resume' : 'new');
  }
}

/** New detection results (push or answer to a recheck). Results are merged: an absent CLI is only "being checked". */
export function applyCliStatus(map: CliStatusMap): void {
  const before = getUi().cliStatus;
  setUi((ui) => ({ cliStatus: { ...ui.cliStatus, ...map } }));
  const recovered = (Object.keys(map) as CliId[]).filter((cli) => before[cli]?.state === 'missing' && map[cli]?.state === 'found');
  if (recovered.length && hasBlockedCells()) toast(tr('Wykryto: {name}', { name: recovered.map((cli) => CLI_NAMES[cli]).join(', ') }));
  resumeBlockedCells();
}

/** Forgets cached detection and looks again; resolves with the new status of that CLI. */
export async function recheckCli(cli?: CliId): Promise<void> {
  try { applyCliStatus(await window.mc.cliRecheck(cli)); } catch { /* the next focus or click tries again */ }
}

/** Opens the official instructions (address chosen in main from an allow-list). */
export function showCliInstructions(cli: CliId): void {
  window.mc.cliOpenDocs(cli);
}

/** "Zainstaluj": the single entry point of the install flow (cell card, new-grid banner, menus, palette). Opens the install window; nothing runs until the user confirms there. */
export function offerInstall(cli: CliId): void {
  if (getUi().install?.locked) return; // an install is running: it is never replaced behind the user's back
  setUi({ install: { cli, locked: false } });
}

export function restartCell(cellId: string, mode: 'new' | 'resume'): void {
  void spawnCell(cellId, mode);
  requestAnimationFrame(() => terminals.focus(cellId));
}

export function changeCellProfile(cellId: string, profileId: string): void {
  forcedCells.delete(cellId);
  update((s) => updateCell(s, cellId, { profileId, session: undefined }));
  update((s) => updateSettings(s, { lastProfileId: profileId }));
  ensureTerminal(cellId);
  restartCell(cellId, 'new');
}

export async function removeCell(cellId: string): Promise<void> {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const { project, tab, cell } = found;
  if (tab.cells.length === 1) { await closeTab(project.id, tab.id); return; }
  // A working agent asks first (before the worktree question, which stays separate).
  if (!(await confirmCloseWorking([cellId], 'cell'))) return;
  let removeWt: false | { confirmed?: WorktreeInspection } = false;
  // A worktree another cell still works in (open or in a closed grid, e.g. after a resumed conversation) stays without asking.
  const use = cellWorktreeUse(getS(), cellId, sameFolder);
  if (use === 'gone') return;
  if (cell.worktree && use === 'own') {
    const answer = await askWorktreeRemoval(project.path, cell.worktree);
    if (answer === null) return;
    removeWt = answer;
  }
  // The grid as it is now: other cells may have been closed while a question was open.
  const now = findCell(getS(), cellId);
  if (!now) return;
  if (now.tab.cells.length === 1) {
    // It is the last cell now: the grid goes to the history with it, so its worktree stays (the archived grid uses it).
    killAndDispose(cellId);
    update((s) => closeTabState(s, now.project.id, now.tab.id));
    toast(tr('Zakładka „{name}” trafiła do historii', { name: now.tab.name }));
    return;
  }
  killAndDispose(cellId);
  update((s) => removeCellState(s, now.project.id, now.tab.id, cellId));
  if (cell.worktree && use === 'shared') toast(tr('Worktree zostaje: używa go inna komórka lub zamknięty grid.'));
  if (removeWt && cell.worktree) {
    // Windows can't delete a folder that is still some process's cwd: wait for the pty to exit.
    await window.mc.killCellAndWait(cellId);
    await deleteWorktree(project.path, cell.worktree, removeWt.confirmed);
  }
}

/** Only branches unimux created for a cell go with its worktree (the same rule as ownsBranch in src/main/worktree.ts). */
const ownsBranch = (wt: Worktree): boolean => !wt.adopted && wt.branch.startsWith('mc/');
/** Commits removing the worktree would drop: its branch's own ones only when the branch goes too. */
const lostCommits = (wt: Worktree, i: WorktreeInspection): number => i.detached + (ownsBranch(wt) ? i.unmerged : 0);

/**
 * The worktree part of closing a cell: shows what removing it would lose (uncommitted files, commits the project's
 * branch does not have) and asks a second time when that is anything. null = cancelled, false = keep the worktree.
 */
async function askWorktreeRemoval(projectPath: string, wt: Worktree): Promise<false | { confirmed?: WorktreeInspection } | null> {
  let checked: WorktreeInspectResult;
  try { checked = await window.mc.inspectWorktree(projectPath, wt); } catch (e) { checked = { ok: false, error: (e as Error).message }; }
  const owned = ownsBranch(wt);
  const lines = [wt.path, ...(wt.branch ? [`branch ${wt.branch}`] : []), ''];
  if (!checked.ok) {
    // Nothing is known about what it holds: it can only stay (removing it is possible later in git or the file manager).
    lines.push(tr('Nie udało się sprawdzić stanu worktree: {error}', { error: errorText(checked.error) }), tr('Worktree zostanie na dysku.'));
    const choice = await askChoice(tr("Zamknąć komórkę z worktree?"), lines.join('\n'), [{ label: tr("Zostaw worktree"), value: 'keep', primary: true }]);
    return choice ? false : null;
  }
  const info = checked.inspection;
  const commits = lostCommits(wt, info);
  if (!info.dirty && !commits) lines.push(owned ? tr('Brak niezatwierdzonych plików i commitów spoza {base}.', { base: info.base }) : tr('Brak niezatwierdzonych plików i commitów, które by przepadły.'));
  else {
    lines.push(tr('Niezatwierdzone pliki: {count}', { count: info.dirty }));
    if (owned) lines.push(tr('Commity, których nie ma w {base}: {count}', { base: info.base, count: info.unmerged }));
    if (info.detached) lines.push(tr('Commity poza każdym branchem (odłączony HEAD): {count}', { count: info.detached }));
  }
  if (!owned) {
    // An adopted worktree (a resumed conversation) may well have an mc/ branch from an earlier cell: no claim about who made it.
    lines.push('', wt.adopted ? tr('Branch tego worktree zostaje (komórka dołączyła do istniejącego worktree).') : tr('Branch tego worktree nie zostanie usunięty (nie utworzył go unimux).'));
  }
  const choice = await askChoice(tr("Zamknąć komórkę z worktree?"), lines.join('\n'), [
    { label: tr("Zostaw worktree"), value: 'keep', primary: true },
    { label: owned ? tr("Usuń worktree i branch") : tr('Usuń worktree'), value: 'remove', danger: true },
  ]);
  if (!choice) return null;
  if (choice !== 'remove') return false;
  if (!info.dirty && !commits) return {};
  const again = await confirmLoss(wt, info, tr('Usunąć worktree z niezapisaną pracą?'));
  if (again === null) return null;
  return again ? { confirmed: info } : false;
}

/** The second, explicit confirmation of a loss; true = remove anyway, false = keep, null = cancelled. */
async function confirmLoss(wt: Worktree, info: WorktreeInspection, title: string): Promise<boolean | null> {
  const answer = await askChoice(title, `${wt.path}\n\n${tr('Tej pracy nie da się potem odzyskać.')}`, [
    { label: tr("Zostaw worktree"), value: 'keep', primary: true },
    { label: tr('Usuń mimo to: przepadną pliki ({files}) i commity ({commits})', { files: info.dirty, commits: lostCommits(wt, info) }), value: 'force', danger: true },
  ]);
  return answer === null ? null : answer === 'force';
}

/**
 * Removes the worktree after the cell's terminal is gone. Main inspects again: when more work appeared than the user
 * accepted (the agent kept writing while the dialog was open), it refuses and the user is asked again with the new numbers.
 */
async function deleteWorktree(projectPath: string, wt: Worktree, confirmed?: WorktreeInspection): Promise<void> {
  const name = wt.branch || wt.path;
  for (let round = 0; round < 5; round++) {
    let result: WorktreeRemoveResult;
    try { result = await window.mc.removeWorktree(projectPath, wt, true, confirmed); }
    catch (e) { result = { ok: false, code: 'failed', error: (e as Error).message }; }
    if (result.ok) return toast(tr('Usunięto worktree {branch}', { branch: name }));
    if (result.code === 'branch') return toast(tr('Usunięto worktree, ale branch {branch} został: {error}', { branch: wt.branch, error: result.error }), 'error');
    if (result.code !== 'unsafe' || !result.inspection) return toast(tr('Nie udało się usunąć worktree: {error}', { error: errorText(result.error) }), 'error');
    const again = await confirmLoss(wt, result.inspection, tr('W worktree pojawiła się nowa praca. Usunąć mimo to?'));
    if (!again) return toast(tr('Worktree {branch} został na dysku.', { branch: name }));
    confirmed = result.inspection;
  }
  toast(tr('Worktree {branch} został na dysku.', { branch: name }));
}

function killAndDispose(cellId: string): void {
  window.mc.killCell(cellId);
  releaseCellTerminal(cellId);
}

export function releaseCellTerminal(cellId: string): void {
  terminals.dispose(cellId);
  started.delete(cellId);
  skippedInBackground.delete(cellId);
  unhold(cellId);
  forcedCells.delete(cellId);
  aliveAtStart.delete(cellId);
  setUi((ui) => {
    const { [cellId]: _s, ...statuses } = ui.statuses;
    const { [cellId]: _f, ...failures } = ui.failures;
    return {
      statuses,
      failures,
      focusedCellId: ui.focusedCellId === cellId ? null : ui.focusedCellId,
      maximizedCellId: ui.maximizedCellId === cellId ? null : ui.maximizedCellId,
    };
  });
}

export function setCellColor(cellId: string, color: string | undefined): void {
  update((s) => updateCell(s, cellId, { color }));
}

export function renameCell(cellId: string, name: string): void {
  update((s) => updateCell(s, cellId, { name: name.trim() || undefined }));
}

const titlesTimers = new Map<string, number>();
const titlesRequests = new Map<string, number>();
/** Refreshes conversation titles for a project and its worktrees (debounced per project); used as default cell labels. */
export function refreshSessionTitles(projectPath: string | undefined, delay = 0): void {
  if (!projectPath) return;
  clearTimeout(titlesTimers.get(projectPath));
  titlesTimers.set(projectPath, window.setTimeout(async () => {
    titlesTimers.delete(projectPath);
    const request = (titlesRequests.get(projectPath) ?? 0) + 1;
    titlesRequests.set(projectPath, request);
    const lists = await Promise.all(sessionSearchPaths(projectPath, getS()).map((p) => window.mc.listSessions(p).catch(() => [])));
    if (titlesRequests.get(projectPath) !== request) return; // a newer refresh superseded this one
    setUi((ui) => {
      // Copied only when a title is new or changed: an unchanged answer (the 20 s refresh) leaves the store as it is.
      let sessionTitles = ui.sessionTitles;
      for (const list of lists) for (const x of list) {
        if (sessionTitles[x.id] === x.title) continue;
        if (sessionTitles === ui.sessionTitles) sessionTitles = { ...ui.sessionTitles };
        sessionTitles[x.id] = x.title;
      }
      return { sessionTitles };
    });
  }, delay));
}

export function focusCell(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found) return;
  showTerminalTabs();
  update((s) => setActiveTab(setActiveProject(s, found.project.id), found.project.id, found.tab.id));
  // Keep a maximized cell only if it is the one being focused; otherwise the target would be hidden.
  setUi((ui) => ({ focusedCellId: cellId, maximizedCellId: ui.maximizedCellId === cellId ? cellId : null }));
  requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(cellId)));
}

export function moveFocus(dx: number, dy: number): void {
  const tab = activeTab(activeProject(getS()));
  if (!tab) return;
  const idx = Math.max(0, tab.cells.findIndex((c) => c.id === getUi().focusedCellId));
  const best = neighborSlot(tab.layout.areas, idx, dx, dy);
  if (best >= 0 && tab.cells[best]) focusCell(tab.cells[best].id);
}

/** Swaps two cells of the active tab (drag and drop, keyboard); their ptys are untouched. */
export function swapCellSlots(a: string, b: string): void {
  const project = activeProject(getS());
  const tab = activeTab(project);
  if (!project || !tab || !canSwapCells(tab, a, b)) return;
  snapshotCellRects();
  update((s) => swapCellsState(s, project.id, tab.id, a, b));
  setUi({ focusedCellId: a });
  // The keyed DOM move drops the textarea focus, so give it back once the move is committed.
  requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(a)));
}

/** Moves the focused cell into the neighbouring slot in a direction (swap with whatever sits there). */
export function moveCellBy(dx: number, dy: number): void {
  const tab = activeTab(activeProject(getS()));
  const id = getUi().focusedCellId;
  if (!tab || !id || getUi().maximizedCellId) return;
  const idx = tab.cells.findIndex((c) => c.id === id);
  const to = idx < 0 ? -1 : neighborSlot(tab.layout.areas, idx, dx, dy);
  if (to >= 0 && tab.cells[to]) swapCellSlots(id, tab.cells[to].id);
}

export function toggleMaximize(cellId?: string): void {
  const id = cellId ?? getUi().focusedCellId;
  if (!id) return;
  setUi((ui) => ({ maximizedCellId: ui.maximizedCellId === id ? null : id, focusedCellId: id }));
  requestAnimationFrame(() => terminals.focus(id));
}

// ── projects ────────────────────────────────────────────────────────────────

export async function createProject(): Promise<void> {
  const path = await window.mc.pickFolder();
  if (!path) return;
  const existing = getS().projects.find((p) => normalizeProjectPath(p.path) === normalizeProjectPath(path));
  if (existing) return switchProject(existing.id);
  update((s) => addProject(s, { name: basename(path), path }));
}

export function switchProject(projectId: string): void {
  showTerminalTabs();
  update((s) => setActiveProject(s, projectId));
  const p = getS().projects.find((x) => x.id === projectId);
  const tab = activeTab(p ?? null);
  const cellId = tab?.cells[0]?.id;
  setUi({ maximizedCellId: null, focusedCellId: cellId ?? null });
  if (cellId) requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(cellId)));
}

export async function removeProject(projectId: string): Promise<void> {
  const p = getS().projects.find((x) => x.id === projectId);
  if (!p) return;
  const live = p.tabs.reduce((n, t) => n + t.cells.length, 0);
  const { tasks, messages } = getS().automation;
  const aiItems = tasks.some((t) => t.projectId === projectId) || messages.some((m) => m.projectId === projectId);
  // Working agents are named like in the tab and cell confirmation (one dialog here: removing a project always asks).
  const ui = getUi();
  const working = workingAgents(getS(), p.tabs.flatMap((t) => t.cells.map((c) => c.id)), ui.statuses, ui.sessionTitles);
  const choice = await askChoice(
    tr('Usunąć projekt „{name}” z listy?', { name: p.name }),
    tr('Folder na dysku zostaje nietknięty.') + (live ? ' ' + tr('Zamkniętych zostanie {count} terminali.', { count: live }) : '')
      + (aiItems ? ' ' + tr('Zadania i wiadomości zespołu AI tego projektu zostaną usunięte.') : '')
      + (working.length ? '\n\n' + tr('Pracujący agenci ({count}): {names}. Ich bieżąca tura zostanie przerwana.', { count: working.length, names: namesList(working.map((w) => w.label)) }) : ''),
    [{ label: tr("Usuń z listy"), value: 'yes', danger: true }],
  );
  if (choice !== 'yes') return;
  for (const t of p.tabs) for (const c of t.cells) killAndDispose(c.id);
  update((s) => removeProjectState(s, projectId));
}

export async function relocateProject(projectId: string): Promise<void> {
  const path = await window.mc.pickFolder();
  if (!path) return;
  update((s) => ({ ...s, projects: s.projects.map((p) => (p.id === projectId ? { ...p, path } : p)) }));
  setUi((ui) => {
    const { [projectId]: _, ...rest } = ui.missingPaths;
    return { missingPaths: rest };
  });
}

// ── tabs ────────────────────────────────────────────────────────────────────

export interface TabSpecCell {
  model?: string;
  color?: string;
  profileId: string;
  role?: import('../../shared/automation').AgentRole;
  worktree: boolean;
  /** An existing worktree the cell works in (a resumed worktree conversation); `worktree` then creates nothing. */
  existingWorktree?: Worktree;
  name?: string;
  prompt?: string;
  session?: CellSession;
  /** A saved SSH host: the cell becomes an SSH session (a deleted host gives a local shell). */
  sshHostId?: string;
}

/** Opens a new tab and resolves to the ids of its cells (none when it could not be created). */
export async function openTab(projectId: string, layout: GridLayout, cells: TabSpecCell[], name?: string): Promise<string[]> {
  const project = getS().projects.find((p) => p.id === projectId);
  if (!project) return [];
  // SSH cells and resumed sessions take the direct path; MCP's create_grid never sees hosts (R2).
  if (!cells.some((cell) => cell.session || cell.sshHostId)) {
    const used = new Set([...project.tabs, ...project.archive].map((tab) => tab.name));
    let number = 1;
    while (used.has(`Grid ${number}`)) number++;
    try {
      const created = await window.mc.automation('create_grid', {
        projectId, name: name?.trim() || `Grid ${number}`, layout,
        cells: layout.areas.map((_, i) => {
          const spec = cells[i] ?? cells[cells.length - 1] ?? { profileId: getS().settings.lastProfileId, worktree: false };
          return { profileId: spec.profileId, model: spec.model, color: spec.color, role: getProfile(getS(), spec.profileId).cli === 'shell' ? undefined : spec.role, name: spec.name?.trim() || undefined,
            worktree: spec.worktree, prompt: getProfile(getS(), spec.profileId).cli === 'shell' ? undefined : spec.prompt?.trim() || undefined };
        }),
      }) as { gridId: string; cellIds: string[] };
      update((s) => setActiveTab(setActiveProject(s, projectId), projectId, created.gridId));
      if (created.cellIds[0]) focusCell(created.cellIds[0]);
      update((s) => updateSettings(s, { lastProfileId: cells[0]?.profileId ?? s.settings.lastProfileId }));
      return created.cellIds;
    } catch (error) { toast(tr('Nie udało się utworzyć gridu: {error}', { error: String(error) }), 'error'); }
    return [];
  }
  const tabName = name ?? undefined;
  // A preset can outlive the shell profile it names; SSH cells always get a present one.
  let sshProfileId: string | undefined;
  if (cells.some((cell) => cell.sshHostId)) update((s) => { const r = ensureShellProfile(s); sshProfileId = r.profileId; return r.s; });
  const specs: Array<{ model?: string; color?: string; profileId: string; role?: import('../../shared/automation').AgentRole; name?: string; startupPrompt?: string; worktree?: Worktree; session?: CellSession; ssh?: { hostId: string } }> = [];
  for (let i = 0; i < layout.areas.length; i++) {
    const spec = cells[i] ?? cells[cells.length - 1] ?? { profileId: getS().settings.lastProfileId, worktree: false };
    let worktree: Worktree | undefined = spec.sshHostId ? undefined : spec.existingWorktree;
    if (!worktree && spec.worktree && !spec.sshHostId) {
      try {
        worktree = await window.mc.createWorktree(project.path, `${tabName ?? 'grid'}-${i + 1}`);
      } catch (e) {
        toast(tr('Worktree nie powstał (komórka {number}): {error}', { number: i + 1, error: (e as Error).message }), 'error');
      }
    }
    const host = spec.sshHostId ? getS().sshHosts.find((h) => h.id === spec.sshHostId) : undefined;
    specs.push({ profileId: host && sshProfileId ? sshProfileId : spec.profileId, model: spec.model, color: spec.color, role: host ? undefined : spec.role, name: sshSpecName(spec.name, host), startupPrompt: host ? undefined : spec.prompt, worktree, session: spec.session, ...(host ? { ssh: { hostId: host.id } } : {}) });
  }
  update((s) => setActiveProject(addTab(s, projectId, { name: tabName, layout, cells: specs }), projectId));
  const tab = activeTab(getS().projects.find((p) => p.id === projectId) ?? null);
  // Marked before React renders the new cells (their views start them on mount): a grid of hosts connects on open (R19).
  for (const c of tab?.cells ?? []) if (c.ssh) connectOnMount.add(c.id);
  if (tab?.cells[0]) focusCell(tab.cells[0].id);
  // An SSH grid does not change the profile new agents get (L9).
  if (!specs.every((spec) => spec.ssh)) update((s) => updateSettings(s, { lastProfileId: specs[0]?.profileId ?? s.settings.lastProfileId }));
  return tab?.cells.map((c) => c.id) ?? [];
}

export function quickTab(profileId?: string): void {
  const p = activeProject(getS());
  if (!p) return void createProject();
  void openTab(p.id, layoutForCount(1), [{ profileId: profileId ?? getS().settings.lastProfileId, worktree: false }]);
}

export async function addAgent(profileId: string, worktree = false): Promise<void> {
  const p = activeProject(getS());
  if (!p) return void createProject();
  const tab = activeTab(p);
  if (!tab) { await openTab(p.id, layoutForCount(1), [{ profileId, worktree }]); return; }
  if (tab.cells.length >= 20) return toast(tr("Siatka ma już maksymalnie 20 komórek"), 'error');
  let wt: Worktree | undefined;
  if (worktree) {
    try {
      wt = await window.mc.createWorktree(p.path, `${tab.name}-${tab.cells.length + 1}`);
    } catch (e) {
      toast(tr('Worktree nie powstał: {error}', { error: (e as Error).message }), 'error');
    }
  }
  update((s) => updateSettings(addCell(s, p.id, tab.id, profileId, { worktree: wt }), { lastProfileId: profileId }));
  const newTab = activeTab(activeProject(getS()));
  const cell = newTab?.cells[newTab.cells.length - 1];
  if (cell) focusCell(cell.id);
}

export async function closeTab(projectId: string, tabId: string): Promise<void> {
  const asked = getS().projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  if (!asked) return;
  if (!(await confirmCloseWorking(asked.cells.map((c) => c.id), 'tab'))) return;
  // The grid as it is now: cells may have been added or removed while the question was open.
  const tab = getS().projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  for (const c of tab.cells) killAndDispose(c.id);
  update((s) => closeTabState(s, projectId, tabId));
  toast(tr('Zakładka „{name}” trafiła do historii', { name: tab.name }));
}

export function restoreArchived(projectId: string, archivedId: string): void {
  update((s) => setActiveProject(restoreTab(s, projectId, archivedId), projectId));
  const tab = activeTab(getS().projects.find((p) => p.id === projectId) ?? null);
  if (tab?.cells[0]) focusCell(tab.cells[0].id);
}

/** Brings a grid to the front; a grid of another project switches the project too (1.0.0: the strip holds all projects). */
export function selectTab(projectId: string, tab: Tab): void {
  showTerminalTabs();
  update((s) => focusGrid(s, projectId, tab.id));
  setUi({ maximizedCellId: null, focusedCellId: tab.cells[0]?.id ?? null });
  const id = tab.cells[0]?.id;
  if (id) requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(id)));
}

// ── sessions ────────────────────────────────────────────────────────────────

function profileFor(cli: 'claude' | 'codex'): Profile {
  const s = getS();
  const last = s.profiles.find((p) => p.id === s.settings.lastProfileId);
  return last?.cli === cli ? last : (s.profiles.find((p) => p.cli === cli) ?? getProfile(s, 'shell'));
}

export function resumeSession(info: SessionInfo, target: 'cell' | 'newCell' | 'newTab'): void {
  const p = activeProject(getS());
  if (!p) return;
  const profile = profileFor(info.cli);
  const session: CellSession = { cli: info.cli, id: info.id, confirmed: true };
  // A conversation of a worktree resumes in that folder (the cell is bound to the worktree); a removed folder cannot.
  const wt = info.worktree;
  if (wt && !wt.exists) return void toast(tr('Folder worktree {name} już nie istnieje, więc tej rozmowy nie da się wznowić: {path}', { name: wt.label, path: wt.path }), 'error');
  // Adopted: the cell joins the folder but never owns its branch (closing it never deletes the branch); an unknown branch stays ''.
  const worktree: Worktree | undefined = wt ? { path: wt.path, branch: wt.branch ?? '', adopted: true } : undefined;
  const focused = getUi().focusedCellId;
  const focusedCell = focused ? findCell(getS(), focused)?.cell : undefined;
  // The active cell can take it only when it works in the same folder (Claude and Codex resume a conversation per folder).
  if (target === 'cell' && focused && focusedCell && sameFolder(focusedCell.worktree?.path, worktree?.path)) {
    update((s) => updateCell(s, focused, { profileId: profile.id, session }));
    restartCell(focused, 'resume');
    return;
  }
  const tab = activeTab(p);
  if ((target === 'newCell' || target === 'cell') && tab) {
    update((s) => addCell(s, p.id, tab.id, profile.id, { session, ...(worktree ? { worktree } : {}) }));
    const t = activeTab(activeProject(getS()));
    const cell = t?.cells[t.cells.length - 1];
    if (cell) focusCell(cell.id);
    return;
  }
  void openTab(p.id, layoutForCount(1), [{ profileId: profile.id, worktree: false, ...(worktree ? { existingWorktree: worktree } : {}), session }], info.title.slice(0, 24));
}

const sameFolder = (a: string | undefined, b: string | undefined): boolean =>
  (a ? normalizeProjectPath(a) : '') === (b ? normalizeProjectPath(b) : '');

// ── snippets ────────────────────────────────────────────────────────────────

/** Pastes a snippet: into the focused cell, a given cell, or every cell of the active tab. */
export function sendSnippet(snippet: Snippet, target: 'focused' | 'all' | { cellId: string }): void {
  const tab = activeTab(activeProject(getS()));
  if (!tab) return toast(tr("Najpierw otwórz grid w projekcie"), 'error');
  let ids: string[];
  if (target === 'all') ids = tab.cells.map((c) => c.id);
  else if (target === 'focused') {
    const f = getUi().focusedCellId;
    ids = [f && tab.cells.some((c) => c.id === f) ? f : tab.cells[0].id];
  } else ids = [target.cellId];
  // Cells that never started have no agent to receive the text yet (it would hit the bare shell
  // before the launch command): start them, but don't paste.
  const ready = ids.filter((id) => started.has(id));
  ids.filter((id) => !started.has(id)).forEach((id) => ensureStarted(id));
  if (ready.length < ids.length) toast(tr('Komórki w trakcie startu: {count}. Wklej do nich ponownie za chwilę.', { count: ids.length - ready.length }));
  for (const id of ready) terminals.paste(id, snippet.text, snippet.autoSend);
  if (ids.length === 1) focusCell(ids[0]);
}
