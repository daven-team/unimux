// Which window this renderer is (1.0.6): the main window, or a detached window showing one tab (`?detached=<id>`, see
// main/detachedWindows.ts). A window starts, shows and adopts only the cells it owns (shared/detached.ts cellOwners).
import { cellOwners, detachedByKey, findDetached, ownsCell, type DetachedWindow } from '../../shared/detached';
import { getS } from './store';

/** The id of this detached window; null in the main window. */
export const detachedId: string | null = (() => {
  try { return new URLSearchParams(window.location.search).get('detached'); } catch { return null; }
})();

/** This window's registry entry (a detached window only; undefined while the state has not arrived or after it was attached). */
export function thisDetached(): DetachedWindow | undefined {
  return detachedId === null ? undefined : findDetached(getS(), detachedId);
}

/** Is the cell shown in this window? The main window owns every cell outside detached grids. */
export function cellShownHere(cellId: string): boolean {
  return ownsCell(cellOwners(getS()), detachedId, cellId);
}

/** The detached window showing a strip key ('grid:<id>' / 'file:<id>'), seen from the main window. */
export function detachedWindowOf(key: string): DetachedWindow | undefined {
  return detachedId === null ? detachedByKey(getS(), key) : undefined;
}

/** The detached window showing a cell, seen from the main window. */
export function windowOfCell(cellId: string): string | undefined {
  return detachedId === null ? cellOwners(getS()).get(cellId) : undefined;
}
