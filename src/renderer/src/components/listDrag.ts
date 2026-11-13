import type { DropEdge } from '../../../shared/state';

export function dropEdge(element: HTMLElement, clientY: number): DropEdge {
  const bounds = element.getBoundingClientRect();
  return clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

/** Keep long lists usable while dragging an item past the visible portion. */
export function scrollDragList(element: HTMLElement, clientY: number): void {
  const bounds = element.getBoundingClientRect();
  const distance = 32;
  if (clientY < bounds.top + distance) element.scrollTop -= 12;
  else if (clientY > bounds.bottom - distance) element.scrollTop += 12;
}

/** Where a drop on a row lands: its top or bottom edge reorders, its middle (when `into` is allowed) drops onto the item. */
export type DropZone = 'before' | 'after' | 'into';

export function dropZone(element: HTMLElement, clientY: number, into: boolean): DropZone {
  if (!into) return dropEdge(element, clientY);
  const bounds = element.getBoundingClientRect();
  const y = (clientY - bounds.top) / Math.max(1, bounds.height);
  return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'into';
}
