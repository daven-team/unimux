// The lines of a unified diff (the Git diff and the save-conflict diff) with the find widget: Ctrl+F searches every line, the
// removed and the added side alike, marks the matches and scrolls to the current one.
import { useMemo, useRef, type ReactNode } from 'react';
import type { DiffLine } from '../../../shared/git';
import type { ItemMatch } from '../../../shared/findItems';
import { ItemText, useFileFinder, useItemFind } from './itemFind';
import type { FileFinder } from './MarkdownPreview';
import './findWidget.css';

export function DiffLines({ lines, width, label, finder, children }: { lines: readonly DiffLine[]; width: number; label: string; finder?: FileFinder; children?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const texts = useMemo(() => lines.map((line) => line.text), [lines]);
  const find = useItemFind(texts, {
    scroller,
    reveal: (match: ItemMatch) => {
      const box = scroller.current;
      const row = box?.querySelector<HTMLElement>(`[data-line="${match.item}"]`);
      if (!box || !row) return;
      const rect = row.getBoundingClientRect();
      const view = box.getBoundingClientRect();
      // Below the widget and above the bottom edge: leave the view where it is.
      if (rect.top >= view.top + 44 && rect.bottom <= view.bottom - 8) return;
      row.scrollIntoView({ block: 'center' });
    },
    firstVisible: () => {
      const box = scroller.current;
      if (!box) return 0;
      const top = box.getBoundingClientRect().top;
      const rows = box.querySelectorAll<HTMLElement>('[data-line]');
      for (const row of rows) if (row.getBoundingClientRect().bottom > top) return Number(row.dataset.line);
      return 0;
    },
  });
  useFileFinder(finder, find.open);
  return (
    <div className="find-host" onKeyDown={find.onKeyDown}>
      <div ref={scroller} className="git-diff" role="table" tabIndex={0} aria-label={label} style={{ ['--ln' as string]: `${width}ch` }}>
        {lines.map((line, i) => (
          <div key={i} className={`git-diff-line ${line.kind}`} role="row" data-line={i}>
            <span className="ln" aria-hidden>{line.oldNo ?? ''}</span>
            <span className="ln" aria-hidden>{line.newNo ?? ''}</span>
            <span className="sign" aria-hidden>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}</span>
            <span className="code">{line.text ? <ItemText text={line.text} item={i} find={find} /> : ' '}</span>
          </div>
        ))}
        {children}
      </div>
      {find.widget}
    </div>
  );
}
