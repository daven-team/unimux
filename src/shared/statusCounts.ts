// Status badges of grids and projects, derived from the per-cell statuses as one comparable key: a status flip that leaves
// every count as it was produces the same key, so the tab strip and the project list do not re-render for it.
import { aggregate, type CellStatus, type StatusCounts, type StatusDetail } from './status';
import { failedExit } from './statusDetail';

interface TabLike { id: string; cells: ReadonlyArray<{ id: string }> }
interface ProjectLike { id: string; tabs: ReadonlyArray<TabLike> }

export const NO_COUNTS: StatusCounts = Object.freeze({ working: 0, waiting: 0, exited: 0 });

/** Key of the project entries in the result of statusCountsOf (tab ids are used as they are). */
export const projectCountsKey = (projectId: string): string => `project:${projectId}`;

/**
 * Counts per tab id and per project (projectCountsKey); groups with no working, waiting or exited cell are left out.
 * 1.0.7: `failed` counts the exited cells whose process ended with a non-zero code (part of `exited`), read from `details`.
 */
export function statusCountsOf(
  projects: ReadonlyArray<ProjectLike>, statuses: Readonly<Record<string, CellStatus>>, details: Readonly<Record<string, StatusDetail>> = {},
): Record<string, StatusCounts> {
  const out: Record<string, StatusCounts> = {};
  const busy = (c: StatusCounts) => c.working + c.waiting + c.exited > 0;
  for (const p of projects) {
    const all: StatusCounts = { working: 0, waiting: 0, exited: 0 };
    for (const t of p.tabs) {
      const counts = aggregate(t.cells.map((c) => statuses[c.id] ?? 'idle'));
      if (!busy(counts)) continue;
      const failed = t.cells.filter((c) => statuses[c.id] === 'exited' && failedExit(details[c.id])).length;
      if (failed) counts.failed = failed;
      out[t.id] = counts;
      all.working += counts.working; all.waiting += counts.waiting; all.exited += counts.exited;
      if (failed) all.failed = (all.failed ?? 0) + failed;
    }
    if (busy(all)) out[projectCountsKey(p.id)] = all;
  }
  return out;
}

/** statusCountsOf as a string: equal strings mean equal badges everywhere. */
export const statusCountsKey = (
  projects: ReadonlyArray<ProjectLike>, statuses: Readonly<Record<string, CellStatus>>, details?: Readonly<Record<string, StatusDetail>>,
): string => JSON.stringify(statusCountsOf(projects, statuses, details));
