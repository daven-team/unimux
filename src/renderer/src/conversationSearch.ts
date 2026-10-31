// Actions of the conversation search (1.0.9): where a found conversation can be resumed, and resuming it in the project
// (or worktree) that holds its folder. A folder no project holds yet is added as a project first.
import { folderOwner, normalizeFolder, type ConvHit, type FolderProject } from '../../shared/convSearch';
import { activeProject, activeTab, cellCwd, findCell, getProfile } from '../../shared/state';
import type { AppState, SessionInfo } from '../../shared/types';
import { addProjectFolder, focusCell, resumeSession, switchProject } from './actions';
import { tr } from './i18n';
import { closeModal, getS, getUi, setUi, toast, type Ui } from './store';

export function folderProjects(s: AppState): FolderProject[] {
  return s.projects.map((p) => ({
    id: p.id,
    path: p.path,
    worktrees: [...p.tabs, ...p.archive].flatMap((t) => t.cells.flatMap((c) => (c.worktree ? [{ path: c.worktree.path, branch: c.worktree.branch }] : []))),
  }));
}

/** The cell (in any open grid) that already runs this conversation. */
export function openCellOf(s: AppState, hit: Pick<ConvHit, 'id'>): string | null {
  for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) if (c.session?.id === hit.id) return c.id;
  return null;
}

export type FocusedUse = { ok: true; cellId: string } | { ok: false; reason: 'none' | 'project' | 'folder' | 'busy' | 'ssh' };

/**
 * Can the focused cell take the conversation: it is in the active grid of the project that holds the folder, works in the
 * same folder (Claude and Codex resume per folder), is no SSH cell and has no running turn or open question.
 */
export function focusedCellUse(s: AppState, ui: Pick<Ui, 'focusedCellId' | 'statuses'>, hit: Pick<ConvHit, 'cwd'>): FocusedUse {
  const id = ui.focusedCellId;
  const project = activeProject(s);
  const tab = activeTab(project);
  const cell = id && tab ? tab.cells.find((c) => c.id === id) : undefined;
  if (!id || !project || !cell) return { ok: false, reason: 'none' };
  const owner = folderOwner(folderProjects(s), hit.cwd);
  if (!owner || owner.projectId !== project.id) return { ok: false, reason: 'project' };
  if (cell.ssh) return { ok: false, reason: 'ssh' };
  if (normalizeFolder(cellCwd(project, cell)) !== normalizeFolder(owner.worktree?.path ?? project.path)) return { ok: false, reason: 'folder' };
  const status = ui.statuses[id];
  const cli = getProfile(s, cell.profileId).cli;
  if ((status === 'working' || status === 'waiting') && cli !== 'shell') return { ok: false, reason: 'busy' };
  return { ok: true, cellId: id };
}

/** Resumes a found conversation: in a new cell of the grid of its project, or in the focused cell when it is free. */
export async function resumeConversation(hit: ConvHit, target: 'newCell' | 'cell'): Promise<void> {
  const open = openCellOf(getS(), hit);
  if (open && findCell(getS(), open)) { closeModal(); focusCell(open); return; }
  let owner = folderOwner(folderProjects(getS()), hit.cwd);
  if (!owner) {
    if (!hit.cwd || !(await window.mc.pathExists(hit.cwd).catch(() => false))) {
      toast(tr('Folder tej rozmowy już nie istnieje: {path}', { path: hit.cwd || '?' }), 'error');
      return;
    }
    addProjectFolder(hit.cwd);
    owner = folderOwner(folderProjects(getS()), hit.cwd);
    if (!owner) return;
    toast(tr('Dodano projekt {path}, żeby wznowić w nim rozmowę.', { path: hit.cwd }));
  }
  const wt = owner.worktree;
  const exists = wt ? await window.mc.pathExists(wt.path).catch(() => false) : true;
  const use = target === 'cell' ? focusedCellUse(getS(), getUi(), hit) : null;
  if (getS().activeProjectId !== owner.projectId) switchProject(owner.projectId);
  const info: SessionInfo = {
    cli: hit.cli, id: hit.id, cwd: hit.cwd, title: hit.title, startedAt: hit.startedAt, updatedAt: hit.updatedAt,
    ...(wt ? { worktree: { path: wt.path, label: wt.label, exists, ...(wt.branch ? { branch: wt.branch } : {}) } } : {}),
  };
  closeModal();
  if (use?.ok) {
    setUi({ focusedCellId: use.cellId });
    resumeSession(info, 'cell');
  } else resumeSession(info, 'newCell');
}

export function copySessionId(hit: Pick<ConvHit, 'id'>): void {
  window.mc.clipboardWrite(hit.id);
  toast(tr('Skopiowano identyfikator rozmowy {id}', { id: hit.id }));
}
