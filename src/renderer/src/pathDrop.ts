// Puts files and folders (dragged from the Files tree, or added from its context menu) into a cell's input, never submitting.
import { buildPathText, capItems, dropAbsPath, dropBlock, MAX_DROP_ITEMS, parsePathPayload, resolveDropTarget, validRelPath, type DropTarget, type PathItem } from '../../shared/pathDrop';
import { activeProject, activeTab, cellCwd, findCell, getProfile } from '../../shared/state';
import { ensureStarted, focusCell, isStarted } from './actions';
import { kindOf } from './explorer';
import { tr } from './i18n';
import { getS, getUi, toast } from './store';
import { terminals } from './terminals/TerminalManager';

/** Local paths mean nothing on a remote host: SSH cells refuse every path drop (snippets still work). */
const isSsh = (cellId: string): boolean => !!findCell(getS(), cellId)?.cell.ssh;

/** True while the cell would refuse the paths (shown on the drop hint). */
export function cellRefusesPaths(cellId: string): boolean {
  if (isSsh(cellId)) return true;
  const ui = getUi();
  return dropBlock({ held: ui.heldCells[cellId] === true, error: !!ui.cellErrors[cellId], started: isStarted(cellId), status: ui.statuses[cellId] ?? 'idle' }) !== null;
}

/** The format that a drop on this cell would insert, and the folder it is relative to: the agent's for an agent cell, else the user's override, else the agent seen running in the shell. */
export function cellDropFormat(cellId: string): { target: DropTarget; cwd: string } | null {
  const state = getS();
  const found = findCell(state, cellId);
  if (!found) return null;
  const profile = getProfile(state, found.cell.profileId);
  const inferred = profile.cli === 'shell' ? terminals.inferredAgent(cellId) : null;
  const target = resolveDropTarget(profile.cli, found.cell.pathMode, inferred?.agent ?? null);
  const cellFolder = cellCwd(found.project, found.cell);
  return { target, cwd: inferred && inferred.agent === target && inferred.cwd ? inferred.cwd : cellFolder };
}

/** Validated items of a drag payload (the raw string comes from the DOM and is untrusted). */
export const readDroppedPaths = (raw: string) => parsePathPayload(raw, window.mc.platform);

/**
 * Inserts the items at the cursor of the cell's input. Absolute paths are rebuilt here from the project that the item names;
 * whatever absolute path the drag carried is ignored.
 */
export async function addPathsToCell(cellId: string, items: PathItem[], rejected = 0, cut = false): Promise<void> {
  if (isSsh(cellId)) return void toast(tr('Ścieżki lokalne nie działają w sesji SSH'), 'error');
  if (cut) toast(tr('Dodano pierwsze {count} ścieżek', { count: MAX_DROP_ITEMS }));
  const state = getS();
  const found = findCell(state, cellId);
  if (!found) return void toast(tr('Nie udało się dodać ścieżki.'), 'error');
  const ui = getUi();
  const block = dropBlock({ held: ui.heldCells[cellId] === true, error: !!ui.cellErrors[cellId], started: isStarted(cellId), status: ui.statuses[cellId] ?? 'idle' });
  if (block === 'starting') {
    ensureStarted(cellId);
    return void toast(tr('Komórka dopiero się uruchamia - upuść ścieżkę ponownie za chwilę.'));
  }
  if (block) return void toast(tr('Nie dodano ścieżki: komórka nie jest uruchomiona.'), 'error');

  const platform = window.mc.platform;
  const resolved: Array<{ kind: PathItem['kind']; abs: string }> = [];
  const worktree = found.cell.worktree?.path;
  for (const item of items) {
    const project = state.projects.find((p) => p.id === item.projectId);
    if (!project) { rejected++; continue; }
    const sameProject = project.id === found.project.id;
    const existsInWorktree = worktree && sameProject ? await window.mc.pathExists(dropAbsPath({ projectPath: worktree, relPath: item.relPath, sameProject, platform })).catch(() => false) : false;
    resolved.push({ kind: item.kind, abs: dropAbsPath({ projectPath: project.path, relPath: item.relPath, sameProject, worktreePath: worktree, existsInWorktree, platform }) });
  }
  // The cell may have been closed or restarted while the files were looked up.
  if (!findCell(getS(), cellId) || cellRefusesPaths(cellId)) return void toast(tr('Nie dodano ścieżki: komórka nie jest uruchomiona.'), 'error');
  const format = cellDropFormat(cellId)!;
  const { text, skipped } = buildPathText(format.target, resolved, { cwd: format.cwd, platform, shell: state.settings.shell });
  rejected += skipped;
  if (rejected > 0) toast(tr('Pominięto elementy, których nie można dodać: {count}', { count: rejected }), 'error');
  if (!text) return;
  terminals.paste(cellId, text, false);
  focusCell(cellId);
}

/** Files and folders dragged in from the system file manager: their own absolute paths go into the input, like a tree drop. */
export async function addDroppedFilesToCell(cellId: string, files: File[]): Promise<void> {
  if (isSsh(cellId)) return void toast(tr('Ścieżki lokalne nie działają w sesji SSH'), 'error');
  const all = files.map((file) => window.mc.pathForFile(file)).filter(Boolean);
  if (!all.length) return void toast(tr('Nie udało się dodać ścieżki.'), 'error');
  const capped = capItems(all);
  if (capped.cut) toast(tr('Dodano pierwsze {count} ścieżek', { count: MAX_DROP_ITEMS }));
  const state = getS();
  const found = findCell(state, cellId);
  if (!found) return void toast(tr('Nie udało się dodać ścieżki.'), 'error');
  const ui = getUi();
  const block = dropBlock({ held: ui.heldCells[cellId] === true, error: !!ui.cellErrors[cellId], started: isStarted(cellId), status: ui.statuses[cellId] ?? 'idle' });
  if (block === 'starting') {
    ensureStarted(cellId);
    return void toast(tr('Komórka dopiero się uruchamia - upuść ścieżkę ponownie za chwilę.'));
  }
  if (block) return void toast(tr('Nie dodano ścieżki: komórka nie jest uruchomiona.'), 'error');
  const kinds = await window.mc.pathKinds(capped.items);
  const resolved = capped.items.flatMap((abs, i) => (kinds[i] ? [{ kind: kinds[i]!, abs }] : []));
  let rejected = capped.items.length - resolved.length;
  if (!findCell(getS(), cellId) || cellRefusesPaths(cellId)) return void toast(tr('Nie dodano ścieżki: komórka nie jest uruchomiona.'), 'error');
  const format = cellDropFormat(cellId)!;
  const { text, skipped } = buildPathText(format.target, resolved, { cwd: format.cwd, platform: window.mc.platform, shell: state.settings.shell });
  rejected += skipped;
  if (rejected > 0) toast(tr('Pominięto elementy, których nie można dodać: {count}', { count: rejected }), 'error');
  if (!text) return;
  terminals.paste(cellId, text, false);
  focusCell(cellId);
}

/** The focused cell of the visible grid (where "Add to conversation" from the tree sends its items), or null. */
export function focusedCellId(): string | null {
  const id = getUi().focusedCellId;
  return id && activeTab(activeProject(getS()))?.cells.some((cell) => cell.id === id) ? id : null;
}

/** "Add to conversation" for tree entries (project-relative paths): the same insertion as a drop on the focused cell. */
export function addTreePathsToFocusedCell(projectId: string, paths: string[]): void {
  const cellId = focusedCellId();
  if (!cellId) return;
  const valid = paths.filter((path) => validRelPath(path, window.mc.platform));
  const capped = capItems(valid);
  const items: PathItem[] = capped.items.map((relPath) => ({ kind: kindOf(projectId, relPath) === 'directory' ? 'dir' : 'file', projectId, relPath }));
  void addPathsToCell(cellId, items, paths.length - valid.length, capped.cut);
}
