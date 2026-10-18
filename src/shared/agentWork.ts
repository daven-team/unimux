// The agents of a grid as the user knows them: the label of a cell (its name, the conversation title or the profile name), which
// Claude or Codex cells are in the middle of a turn (closing them would cut the turn), and the text listing them.
import { getProfile } from './state';
import type { CellStatus } from './status';
import type { AppState, Cell } from './types';

/** The label a cell header shows: the name the user gave it, else the conversation title, else the profile name. */
export function cellLabel(cell: Pick<Cell, 'name' | 'session'>, sessionTitles: Readonly<Record<string, string>>, profileName: string): string {
  const name = cell.name?.trim();
  if (name) return name;
  const title = cell.session ? sessionTitles[cell.session.id]?.trim() : undefined;
  return title || profileName;
}

export interface WorkingAgent { cellId: string; label: string }

/** Claude and Codex cells among `cellIds` that are working right now (waiting for you, idle or exited cells do not count). */
export function workingAgents(
  s: AppState, cellIds: Iterable<string>, statuses: Readonly<Record<string, CellStatus>>, sessionTitles: Readonly<Record<string, string>>,
): WorkingAgent[] {
  const wanted = new Set(cellIds);
  const out: WorkingAgent[] = [];
  for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) {
    if (!wanted.has(c.id) || statuses[c.id] !== 'working' || c.ssh) continue;
    const profile = getProfile(s, c.profileId);
    if (profile.cli === 'shell') continue;
    out.push({ cellId: c.id, label: cellLabel(c, sessionTitles, profile.name) });
  }
  return out;
}

/** Every cell id of the open grids (quitting the app closes them all). */
export const allCellIds = (s: AppState): string[] => s.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells.map((c) => c.id)));

/** Whether closing should ask first: the setting is on and at least one affected agent is working. */
export const shouldConfirmClose = (s: AppState, working: readonly WorkingAgent[]): boolean => s.settings.confirmCloseWorking && working.length > 0;

/** The first `max` names joined by commas, then "+N" for the rest. */
export function namesList(labels: readonly string[], max = 3): string {
  const shown = labels.slice(0, max).join(', ');
  return labels.length > max ? `${shown} +${labels.length - max}` : shown;
}
