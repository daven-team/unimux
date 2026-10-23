// The popup of the SSH command autocomplete (Termius-like): matching commands under (or above) the cursor, lined up with
// the typed command, and the rest of the chosen one as ghost text after the cursor, both in the terminal's font over its
// character grid. State and keys: terminals/sshAutocomplete.ts. Entries of a server folder (a path word, 1.0.6) show only
// their name, folders first and with a '/', lined up with the word; Tab and Shift+Tab cycle through them.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { Suggestion } from '../../../../shared/commandSuggest';
import { useI18n } from '../../i18n';
import { acceptSuggestion, autocompleteView, subscribeAutocomplete, terminalGeometry } from '../../terminals/sshAutocomplete';
import { ISnippet } from '../icons';
import './sshAutocomplete.css';

function Highlighted({ item }: { item: Suggestion }) {
  const text = item.display ?? item.text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of item.ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export function SshAutocomplete({ cellId }: { cellId: string }) {
  const { tr } = useI18n();
  const subscribe = useCallback((listener: () => void) => subscribeAutocomplete(cellId, listener), [cellId]);
  const view = useSyncExternalStore(subscribe, () => autocompleteView(cellId));
  const box = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);

  // Placed before the browser paints: from the terminal grid on screen to the cell's own coordinates.
  useLayoutEffect(() => {
    const el = box.current;
    const root = el?.offsetParent as HTMLElement | null | undefined;
    const geo = terminalGeometry(cellId);
    if (!view || !el || !root || !geo) {
      if (el) el.style.visibility = 'hidden';
      if (ghost.current) ghost.current.style.visibility = 'hidden';
      return;
    }
    const frame = root.getBoundingClientRect();
    const ox = geo.left - frame.left - root.clientLeft;
    const oy = geo.top - frame.top - root.clientTop;
    const caretX = ox + view.col * geo.cellWidth;
    const caretY = oy + view.row * geo.cellHeight;
    const font = { fontFamily: geo.fontFamily, fontSize: `${geo.fontSize}px` };
    if (ghost.current) {
      Object.assign(ghost.current.style, font, {
        left: `${caretX}px`, top: `${caretY}px`, height: `${geo.cellHeight}px`, lineHeight: `${geo.cellHeight}px`, visibility: 'visible',
      });
      ghost.current.style.setProperty('--cell-w', `${geo.cellWidth}px`);
    }
    // Measured from the left edge: the place of the last keystroke would narrow the shrink-to-fit width of the box.
    Object.assign(el.style, font, { maxHeight: '', left: '0px', top: '0px', visibility: 'visible' });
    const text = el.querySelector<HTMLElement>('.ssh-ac-text');
    const inset = el.clientLeft + (text?.offsetLeft ?? 0);
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(4, Math.min(ox + view.startCol * geo.cellWidth - inset, root.clientWidth - width - 4));
    const below = caretY + geo.cellHeight + 2;
    const spaceBelow = root.clientHeight - below - 4;
    const spaceAbove = caretY - 2 - Math.max(0, oy - 2);
    const under = height <= spaceBelow || spaceBelow >= spaceAbove;
    const room = Math.max(48, under ? spaceBelow : spaceAbove);
    el.style.maxHeight = `${room}px`;
    el.style.left = `${left}px`;
    el.style.top = `${under ? below : caretY - 2 - Math.min(height, room)}px`;
    // The chosen item stays visible in a short list (scrolled by hand: scrollIntoView would also scroll the cell).
    const sel = el.querySelector<HTMLElement>('.ssh-ac-item.sel');
    if (sel && sel.offsetTop < el.scrollTop) el.scrollTop = sel.offsetTop;
    else if (sel && sel.offsetTop + sel.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = sel.offsetTop + sel.offsetHeight - el.clientHeight;
  }, [view, cellId]);

  if (!view) return null;
  const snippets = view.items.some((item) => item.kind === 'snippet');
  const paths = view.items[0]?.kind === 'path';
  const ghostChars = Array.from(view.ghost).slice(0, view.room);
  return <>
    {ghostChars.length > 0 && (
      <div ref={ghost} className="ssh-ghost" aria-hidden="true">
        {ghostChars.map((ch, i) => <span key={i}>{ch}</span>)}
      </div>
    )}
    <div ref={box} className="ssh-ac" role="listbox" aria-label={tr('Podpowiedzi')} onMouseDown={(e) => e.preventDefault()}>
      {view.items.map((item, i) => (
        <div key={item.text} role="option" aria-selected={i === view.selected}
          className={`ssh-ac-item${i === view.selected ? ' sel' : ''}${item.kind === 'path' && item.display?.endsWith('/') ? ' dir' : ''}`}
          title={item.label ? `${item.label}\n${item.text}` : item.text} onClick={() => acceptSuggestion(cellId, i)}>
          {snippets && <span className="ssh-ac-kind" title={item.kind === 'snippet' ? tr('Snippet') : undefined}>{item.kind === 'snippet' && <ISnippet />}</span>}
          <span className="ssh-ac-text"><Highlighted item={item} /></span>
          {item.label && <span className="ssh-ac-label">{item.label}</span>}
        </div>
      ))}
      <div className="ssh-ac-foot">{paths ? tr('Tab następny · Shift+Tab poprzedni · Enter wstaw · Esc zamknij') : tr('↓ wybierz · Enter wstaw · → dopełnij · Esc zamknij')}</div>
    </div>
  </>;
}
