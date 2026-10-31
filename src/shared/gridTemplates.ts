// Grid templates (1.1.1): a grid saved with its layout and the setup of every cell, opened again in any project in one click.
// Stored as `presets` (MCP's save_preset / presetId share them). A template never keeps a conversation session, a queued
// prompt or a remote folder, and an SSH cell only names its saved host (secrets stay in the SSH vault).
import { isUsableLayout, layoutForCount, MAX_CELLS, type GridLayout } from './layout';
import { relativeInside } from './pathDrop';
import { fullProjectPath, type AppPlatform } from './platform';
import type { Cell, Preset, PresetCell, Project, Tab } from './types';

export const TEMPLATE_LIMITS = { count: 100, name: 140, prompt: 32000, dir: 1000, cellName: 140, model: 128 } as const;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A drive path (C:\ or C:/), a UNC path or a POSIX absolute path. */
export const isAbsoluteDir = (dir: string): boolean => /^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('/') || dir.startsWith('\\\\');

/**
 * A template folder in its stored form: absolute paths as they are (no trailing separator), relative ones with "/" and without
 * "." segments. Empty, "." , a relative path that climbs out of the project ("..") or one that is too long gives undefined (the root).
 */
export function cleanTemplateDir(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const dir = raw.trim();
  if (!dir || dir.length > TEMPLATE_LIMITS.dir || dir.includes('\0')) return undefined;
  if (isAbsoluteDir(dir)) {
    const stripped = dir.replace(/(?<=.)[\\/]+$/, '');
    // "C:" alone is not a folder; "C:\" keeps its separator.
    return /^[a-zA-Z]:$/.test(stripped) ? `${stripped}\\` : stripped;
  }
  // A drive-relative path ("C:web") means a different folder in every process: not a template folder.
  if (/^[a-zA-Z]:/.test(dir)) return undefined;
  const parts = dir.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.includes('..')) return undefined;
  return parts.join('/');
}

/** How a cell's folder is stored in a template: absent at the project root, relative inside the project, absolute outside it. */
export function templateDir(projectPath: string, abs: string | undefined, platform: AppPlatform): string | undefined {
  if (!abs) return undefined;
  const inside = relativeInside(projectPath, abs, platform);
  if (inside === '.') return undefined;
  return cleanTemplateDir(inside ?? abs);
}

/** The absolute folder a template folder means in a project; undefined = the project root. */
export function resolveTemplateDir(projectPath: string, dir: string | undefined, platform: AppPlatform): string | undefined {
  const clean = cleanTemplateDir(dir);
  if (!clean) return undefined;
  return isAbsoluteDir(clean) ? clean : fullProjectPath(projectPath, clean, platform);
}

/** One cell of a grid as a template cell: profile or SSH host, name, colour, role, model, folder, worktree and muted flag. */
export function templateCell(cell: Cell, projectPath: string, platform: AppPlatform): PresetCell {
  const host = cell.ssh?.hostId;
  // A worktree decides the folder by itself; an SSH cell starts in its remote home.
  const dir = host || cell.worktree ? undefined : templateDir(projectPath, cell.dir, platform);
  const name = cell.name?.trim();
  return {
    profileId: cell.profileId,
    worktree: !host && !!cell.worktree,
    ...(cell.role && !host ? { role: cell.role } : {}),
    ...(cell.model && !host ? { model: cell.model } : {}),
    ...(name ? { name } : {}),
    ...(cell.color ? { color: cell.color } : {}),
    ...(host ? { sshHostId: host } : {}),
    ...(dir ? { dir } : {}),
    ...(cell.muted ? { muted: true as const } : {}),
  };
}

/** A copy of a layout with only the fields a grid draws (areas, splits and the dragged sizes). */
export function templateLayout(layout: GridLayout): GridLayout {
  const copy = JSON.parse(JSON.stringify(layout)) as GridLayout;
  const { cols, rows, areas, rowCounts, rowSizes, rowColSizes, colSizes, mode, colRowSizes } = copy;
  return {
    cols, rows, areas: areas.map(({ col, row, colSpan, rowSpan }) => ({ col, row, colSpan, rowSpan })),
    ...(rowCounts ? { rowCounts } : {}), ...(rowSizes ? { rowSizes } : {}), ...(rowColSizes ? { rowColSizes } : {}),
    ...(colSizes ? { colSizes } : {}), ...(mode ? { mode } : {}), ...(colRowSizes ? { colRowSizes } : {}),
  };
}

/** A grid as a global template (no projectId): usable in every project. */
export function captureTemplate(input: { id: string; name: string; project: Pick<Project, 'path'>; tab: Pick<Tab, 'layout' | 'cells'>; platform: AppPlatform }): Preset {
  const cells = input.tab.cells.slice(0, MAX_CELLS).map((cell) => templateCell(cell, input.project.path, input.platform));
  const layout = isUsableLayout(input.tab.layout, cells.length) ? templateLayout(input.tab.layout) : layoutForCount(cells.length);
  return { id: input.id, name: input.name.trim().slice(0, TEMPLATE_LIMITS.name), layout, cells };
}

/** The absolute folders a template's cells would start in (to check on disk before the grid opens). */
export function templateFolders(cells: PresetCell[], projectPath: string, platform: AppPlatform): string[] {
  const out: string[] = [];
  for (const cell of cells) {
    if (cell.sshHostId || cell.worktree) continue;
    const abs = resolveTemplateDir(projectPath, cell.dir, platform);
    if (abs && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/**
 * The cells of a template for a project: `dir` becomes the absolute folder, or is dropped (the project root) when the folder does
 * not exist there. `missing` lists the template folders that fell back, for a short note.
 */
export function applyTemplateCells(cells: PresetCell[], projectPath: string, platform: AppPlatform, exists: (abs: string) => boolean): { cells: PresetCell[]; missing: string[] } {
  const missing: string[] = [];
  const out = cells.map((cell) => {
    const { dir, ...rest } = cell;
    if (!dir) return rest;
    if (cell.sshHostId || cell.worktree) return rest;
    const abs = resolveTemplateDir(projectPath, dir, platform);
    if (abs && exists(abs)) return { ...rest, dir: abs };
    if (!missing.includes(dir)) missing.push(dir);
    return rest;
  });
  return { cells: out, missing };
}

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const text = v.trim();
  return text && text.length <= max ? text : undefined;
};

/** One stored template cell, repaired: null without a profile. */
export function normalizeTemplateCell(raw: unknown, remap: (id: string) => string = (id) => id): PresetCell | null {
  if (!isRecord(raw) || typeof raw.profileId !== 'string' || !raw.profileId || raw.profileId.length > 128) return null;
  const name = clip(raw.name, TEMPLATE_LIMITS.cellName);
  const model = clip(raw.model, TEMPLATE_LIMITS.model);
  const color = clip(raw.color, 32);
  const prompt = typeof raw.prompt === 'string' && raw.prompt.trim() && raw.prompt.length <= TEMPLATE_LIMITS.prompt ? raw.prompt : undefined;
  const sshHostId = typeof raw.sshHostId === 'string' && raw.sshHostId && raw.sshHostId.length <= 64 ? raw.sshHostId : undefined;
  const dir = cleanTemplateDir(raw.dir);
  return {
    profileId: remap(raw.profileId),
    worktree: raw.worktree === true,
    ...(raw.role === 'coordinator' || raw.role === 'worker' ? { role: raw.role } : {}),
    ...(model ? { model } : {}),
    ...(name ? { name } : {}),
    ...(color ? { color } : {}),
    ...(prompt ? { prompt } : {}),
    ...(sshHostId ? { sshHostId } : {}),
    ...(dir ? { dir } : {}),
    ...(raw.muted === true ? { muted: true as const } : {}),
  };
}

/**
 * The saved templates, repaired: at most TEMPLATE_LIMITS.count with a unique id and a name, at most MAX_CELLS cells each; a layout
 * that does not fit the cells is rebuilt. Unknown fields are dropped.
 */
export function normalizePresets(raw: unknown, remap: (id: string) => string = (id) => id): Preset[] {
  if (!Array.isArray(raw)) return [];
  const out: Preset[] = [];
  const ids = new Set<string>();
  for (const p of raw) {
    if (out.length >= TEMPLATE_LIMITS.count) break;
    if (!isRecord(p) || typeof p.id !== 'string' || !p.id || p.id.length > 128 || ids.has(p.id)) continue;
    const name = clip(p.name, TEMPLATE_LIMITS.name);
    if (!name) continue;
    const cells = (Array.isArray(p.cells) ? p.cells : []).map((c) => normalizeTemplateCell(c, remap)).filter((c): c is PresetCell => c !== null).slice(0, MAX_CELLS);
    if (!cells.length) continue;
    const layout = isUsableLayout(p.layout, cells.length) ? templateLayout(p.layout) : layoutForCount(cells.length);
    ids.add(p.id);
    out.push({ id: p.id, name, layout, cells, ...(typeof p.projectId === 'string' && p.projectId && p.projectId.length <= 128 ? { projectId: p.projectId } : {}) });
  }
  return out;
}

/** Templates offered in a project: the global ones and the project's own. */
export const templatesFor = (presets: Preset[], projectId: string): Preset[] => presets.filter((p) => !p.projectId || p.projectId === projectId);

/** A cell folder kept in the state: an absolute path of a sane length. */
export const normalizeCellDir = (raw: unknown): string | undefined => {
  const dir = cleanTemplateDir(raw);
  return dir && isAbsoluteDir(dir) ? dir : undefined;
};
