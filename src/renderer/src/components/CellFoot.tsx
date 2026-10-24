// The footer slot of a grid cell card (1.0.7): a bar under the terminal body, inside the card (CellView renders it in
// `.cell-foot`). Whatever this returns is drawn there; null leaves the slot empty and it takes no space (`.cell-foot:empty`).
// The terminal body shrinks by the bar's height and its terminal is refitted by its ResizeObserver, so a bar can appear and
// go at any time. Keep a bar one line high (about 24px, see terminalCell.css) and give it its own memoized component that
// subscribes to its own store slice: CellView never re-renders for terminal output and the foot must not make it.
import type { Cell } from '../../../shared/types';

/** The bar under a cell's terminal; `cell` is the cell of the card (an SSH cell has `cell.ssh`). */
export function CellFoot(_props: { cell: Cell }) {
  return null;
}
