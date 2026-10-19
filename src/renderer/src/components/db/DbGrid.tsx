// The data grid of table and query result tabs (1.0.0): a sticky header with the type, a row-number column, and windowing of
// rows and columns (wide tables with hundreds of columns stay light). Cells select with the mouse or the keyboard, copy as
// TSV / CSV / JSON, and, where the owner allows it, edit inline with an input for the column's kind (NULL is its own choice).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { DbSort, DbValue, DbValueKind } from '../../../../shared/db';
import { isTruncated } from '../../../../shared/db';
import { formatDbValue, isNumericKind, parseDbInput, rowsToCsv, rowsToJson, rowsToTsv } from '../../../../shared/dbSql';
import { clampColumnWidth, columnWindow, defaultColumnWidth, inRange, moveCell, rangeOf, type CellPos, type CellRange } from '../../../../shared/dbTabs';
import { rowWindow } from '../../../../shared/virtualRows';
import { useI18n } from '../../i18n';
import { openMenu, type MenuItem } from '../ContextMenu';

export interface GridColumn { name: string; typeName: string; kind: DbValueKind; key?: boolean }
/** A cell as the grid shows it: undefined = DEFAULT (a new row's untouched cell). */
export interface GridCell { value: DbValue | undefined; changed?: boolean }
export type RowState = 'deleted' | 'inserted' | null;

export interface DbGridProps {
  columns: readonly GridColumn[];
  rowCount: number;
  cell(row: number, col: number): GridCell;
  rowState?(row: number): RowState;
  /** The first row's number (paging). */
  firstNumber?: number;
  sort?: readonly DbSort[];
  onSort?(column: string, add: boolean): void;
  canEdit?(row: number, col: number): boolean;
  onEdit?(row: number, col: number, value: string | null): void;
  /** Opens the value viewer (JSON, long text). */
  onOpenValue?(row: number, col: number): void;
  /** Extra context menu items for the selected rows. */
  menuItems?(rows: number[], range: CellRange): MenuItem[];
  onDeleteKey?(rows: number[]): void;
  /** The rows the selection covers (the owner's toolbar acts on them). */
  onSelectRows?(rows: number[]): void;
  /** Changes scroll back to the top (a new page). */
  resetKey?: unknown;
  widths?: Record<string, number>;
  onWidths?(widths: Record<string, number>): void;
  label: string;
}

const ROW = 24;
const HEAD = 40;
const RN = 56;

const cellText = (v: DbValue | undefined, kind: DbValueKind): string => {
  if (v === undefined) return '';
  const t = formatDbValue(v, kind);
  return t === null ? '' : (isTruncated(v!) ? `${t}…` : t).replace(/[\r\n\t]+/g, ' ').slice(0, 2000);
};

/** The inline editor of one cell: typed text or NULL; Enter saves, Escape cancels. */
function CellEditor({ column, initial, onDone, style }: { column: GridColumn; initial: string | null; style: CSSProperties; onDone(value: string | null | undefined): void }) {
  const { tr } = useI18n();
  const [text, setText] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => { input.current?.focus(); if (input.current && 'select' in input.current && column.kind !== 'bool') input.current.select(); }, [column.kind]);
  const commit = (asNull = false, value = text) => {
    const r = parseDbInput(column.kind, value, { asNull, typeName: column.typeName });
    if (!r.ok) { setError(tr(r.error)); return; }
    onDone(r.value);
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); onDone(undefined); }
  };
  return (
    <div className="db-cell-editor" style={style} onMouseDown={(e) => e.stopPropagation()}>
      {column.kind === 'bool' ? (
        <select ref={input} className="input" value={text === '' && initial === null ? '' : text} onKeyDown={onKey}
          onChange={(e) => (e.target.value === '' ? commit(true) : commit(false, e.target.value))}>
          <option value="">NULL</option><option value="t">true</option><option value="f">false</option>
        </select>
      ) : (
        <input ref={input} className={`input ${isNumericKind(column.kind) ? 'num' : ''}`} value={text} spellCheck={false} placeholder={initial === null ? 'NULL' : ''}
          onChange={(e) => { setText(e.target.value); setError(null); }} onKeyDown={onKey} onBlur={() => commit()} aria-label={column.name} />
      )}
      <button type="button" className="db-null-btn" title={tr('Ustaw NULL')} onMouseDown={(e) => { e.preventDefault(); commit(true); }}>NULL</button>
      {error && <div className="db-cell-error" role="alert">{error}</div>}
    </div>
  );
}

export const DbGrid = memo(function DbGrid(props: DbGridProps) {
  const { tr } = useI18n();
  const { columns, rowCount } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, width: 800, height: 400 });
  const [focus, setFocus] = useState<CellPos | null>(null);
  const [anchor, setAnchor] = useState<CellPos | null>(null);
  const [editing, setEditing] = useState<CellPos | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<string, number> | null>(null);
  const dragging = useRef(false);
  const range = focus && anchor ? rangeOf(anchor, focus) : null;
  const widthsSource = liveWidths ?? props.widths ?? {};
  const onSelectRows = props.onSelectRows;
  useEffect(() => {
    if (!onSelectRows) return;
    const rows: number[] = [];
    if (range) for (let i = range.r0; i <= range.r1 && i < rowCount; i++) rows.push(i);
    onSelectRows(rows);
  }, [range?.r0, range?.r1, rowCount, onSelectRows]); // eslint-disable-line react-hooks/exhaustive-deps
  const widths = useMemo(() => columns.map((c) => widthsSource[c.name] ?? defaultColumnWidth(c.name, c.kind)), [columns, widthsSource]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el) { el.scrollTop = 0; setView((v) => ({ ...v, top: 0 })); }
    setFocus(null); setAnchor(null); setEditing(null);
  }, [props.resetKey]);

  const rw = rowWindow(view.top, view.height - HEAD, ROW, rowCount, 8);
  const cw = columnWindow(widths, Math.max(0, view.left - RN), view.width - RN, 2);
  const visibleCols: number[] = [];
  for (let c = cw.start; c < cw.end; c++) visibleCols.push(c);

  const rowsOf = (r: CellRange): DbValue[][] => {
    const out: DbValue[][] = [];
    for (let i = r.r0; i <= Math.min(rowCount - 1, r.r1); i++) {
      const row: DbValue[] = [];
      for (let c = r.c0; c <= Math.min(columns.length - 1, r.c1); c++) row.push(props.cell(i, c).value ?? null);
      out.push(row);
    }
    return out;
  };
  const full = (rows: number[]): CellRange => ({ r0: Math.min(...rows), r1: Math.max(...rows), c0: 0, c1: columns.length - 1 });
  const copy = (r: CellRange, format: 'tsv' | 'csv' | 'json') => {
    const data = rowsOf(r);
    const cols = columns.slice(r.c0, r.c1 + 1);
    const text = format === 'tsv' ? rowsToTsv(data) : format === 'csv' ? rowsToCsv(cols, data) : rowsToJson(cols, data);
    window.mc.clipboardWrite(text);
  };
  const selectedRows = (): number[] => {
    if (!range) return [];
    const out: number[] = [];
    for (let i = range.r0; i <= range.r1 && i < rowCount; i++) out.push(i);
    return out;
  };
  const reveal = (p: CellPos) => {
    const el = scroller.current;
    if (!el) return;
    const top = HEAD + p.row * ROW;
    if (top < el.scrollTop + HEAD) el.scrollTop = top - HEAD;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
    const left = RN + cw.lefts[p.col];
    const w = widths[p.col] ?? 0;
    if (left < el.scrollLeft + RN) el.scrollLeft = left - RN;
    else if (left + w > el.scrollLeft + el.clientWidth) el.scrollLeft = left + w - el.clientWidth;
  };
  const startEdit = (p: CellPos) => {
    if (!props.canEdit?.(p.row, p.col) || !props.onEdit) {
      const v = props.cell(p.row, p.col).value;
      if (props.onOpenValue && v !== undefined && v !== null) props.onOpenValue(p.row, p.col);
      return;
    }
    const col = columns[p.col];
    const v = props.cell(p.row, p.col).value;
    // JSON, long and truncated values open in the side viewer (it edits them there).
    if (v !== undefined && v !== null && (isTruncated(v) || v.length > 200 || v.includes('\n') || col.kind === 'json') && props.onOpenValue) { props.onOpenValue(p.row, p.col); return; }
    setEditing(p);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !rowCount || !columns.length) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') { if (range) { e.preventDefault(); copy(range, 'tsv'); } return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setAnchor({ row: 0, col: 0 }); setFocus({ row: rowCount - 1, col: columns.length - 1 }); return; }
    const cur = focus ?? { row: 0, col: 0 };
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); if (focus) startEdit(focus); return; }
    if (e.key === 'Delete' && props.onDeleteKey && range) { e.preventDefault(); props.onDeleteKey(selectedRows()); return; }
    const next = moveCell(cur, e.key === 'Tab' && e.shiftKey ? 'ArrowLeft' : e.key, rowCount, columns.length, Math.max(1, Math.floor((view.height - HEAD) / ROW) - 1));
    if (next === cur && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(e.key)) return;
    e.preventDefault();
    setFocus(next);
    if (!e.shiftKey || e.key === 'Tab') setAnchor(next);
    reveal(next);
  };
  const cellMenu = (x: number, y: number) => {
    if (!range) return;
    const rows = selectedRows();
    const single = range.r0 === range.r1 && range.c0 === range.c1;
    const extra = props.menuItems?.(rows, range) ?? [];
    openMenu(x, y, [
      { label: single ? tr('Kopiuj wartość') : tr('Kopiuj zaznaczenie'), hint: 'Ctrl+C', onClick: () => copy(range, 'tsv') },
      { label: tr('Kopiuj zaznaczenie jako CSV'), onClick: () => copy(range, 'csv') },
      { label: tr('Kopiuj zaznaczenie jako JSON'), onClick: () => copy(range, 'json') },
      { label: rows.length > 1 ? tr('Kopiuj wiersze') : tr('Kopiuj wiersz'), onClick: () => copy(full(rows), 'tsv') },
      { label: tr('Kopiuj wiersze jako JSON'), onClick: () => copy(full(rows), 'json') },
      ...(single && props.onOpenValue ? [{ label: tr('Pokaż wartość'), onClick: () => props.onOpenValue!(range.r0, range.c0) }] : []),
      ...(single && props.canEdit?.(range.r0, range.c0) ? [
        { label: tr('Edytuj'), hint: 'Enter', onClick: () => startEdit({ row: range.r0, col: range.c0 }) },
        { label: tr('Ustaw NULL'), onClick: () => props.onEdit!(range.r0, range.c0, null) },
      ] : []),
      ...(extra.length ? [{ sep: true } as MenuItem, ...extra] : []),
    ]);
  };

  // Column resizing: drag the right edge of a header.
  const resize = (col: number, startX: number) => {
    const base = widths[col];
    const name = columns[col].name;
    let last = { ...widthsSource };
    const move = (e: MouseEvent) => { last = { ...widthsSource, [name]: clampColumnWidth(base + e.clientX - startX) }; setLiveWidths(last); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setLiveWidths(null); props.onWidths?.(last); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  useEffect(() => { const up = () => { dragging.current = false; }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); }, []);

  const total = RN + cw.total;
  const sortOf = (name: string) => props.sort?.findIndex((s) => s.column === name) ?? -1;
  const first = props.firstNumber ?? 1;
  const rowsShown: ReactNode[] = [];
  for (let r = rw.start; r < rw.end; r++) {
    const state = props.rowState?.(r) ?? null;
    rowsShown.push(
      <div key={r} className={`db-grow ${state ?? ''} ${focus?.row === r ? 'cur' : ''}`} style={{ top: r * ROW, width: total }} role="row" aria-rowindex={r + 2}>
        <span className={`db-rn ${range && r >= range.r0 && r <= range.r1 ? 'sel' : ''}`} role="rowheader"
          onMouseDown={(e) => { e.preventDefault(); scroller.current?.focus(); const end = { row: r, col: columns.length - 1 }; if (e.shiftKey && anchor) setFocus(end); else { setAnchor({ row: r, col: 0 }); setFocus(end); } }}
          onContextMenu={(e) => { e.preventDefault(); if (!range || r < range.r0 || r > range.r1) { setAnchor({ row: r, col: 0 }); setFocus({ row: r, col: columns.length - 1 }); } setTimeout(() => cellMenu(e.clientX, e.clientY)); }}>
          {state === 'inserted' ? '+' : first + r}
        </span>
        {visibleCols.map((c) => {
          const col = columns[c];
          const { value, changed } = props.cell(r, c);
          const sel = inRange(range, r, c);
          const isFocus = focus?.row === r && focus.col === c;
          return (
            <span key={c} role="gridcell" data-col={c}
              className={`db-gcell ${isNumericKind(col.kind) ? 'num' : ''} ${sel ? 'sel' : ''} ${isFocus ? 'focus' : ''} ${changed ? 'changed' : ''}`}
              style={{ left: RN + cw.lefts[c], width: widths[c] }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                scroller.current?.focus();
                const p = { row: r, col: c };
                setFocus(p);
                if (!e.shiftKey || !anchor) setAnchor(p);
                dragging.current = true;
              }}
              onMouseEnter={(e) => { if (dragging.current && e.buttons === 1) setFocus({ row: r, col: c }); }}
              onDoubleClick={() => startEdit({ row: r, col: c })}
              onContextMenu={(e) => { e.preventDefault(); if (!inRange(range, r, c)) { setAnchor({ row: r, col: c }); setFocus({ row: r, col: c }); } setTimeout(() => cellMenu(e.clientX, e.clientY)); }}>
              {value === undefined ? <span className="db-default">DEFAULT</span> : value === null ? <span className="db-null">NULL</span> : cellText(value, col.kind)}
            </span>
          );
        })}
      </div>,
    );
  }
  const edit = editing && editing.row < rowCount ? editing : null;
  const editInitial = edit ? props.cell(edit.row, edit.col).value : undefined;

  return (
    <div className="db-grid" ref={scroller} tabIndex={0} role="grid" aria-label={props.label} aria-rowcount={rowCount + 1} aria-colcount={columns.length}
      onKeyDown={onKey} onScroll={(e) => { const el = e.currentTarget; setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight }); }}>
      <div className="db-ghead" style={{ width: total, height: HEAD }} role="row">
        <span className="db-rn db-corner" onMouseDown={(e) => { e.preventDefault(); if (rowCount && columns.length) { setAnchor({ row: 0, col: 0 }); setFocus({ row: rowCount - 1, col: columns.length - 1 }); } }} />
        {visibleCols.map((c) => {
          const col = columns[c];
          const s = sortOf(col.name);
          const dir = s >= 0 ? (props.sort![s].desc ? '↓' : '↑') : '';
          return (
            <span key={c} className={`db-hcell ${s >= 0 ? 'sorted' : ''}`} style={{ left: RN + cw.lefts[c], width: widths[c] }} role="columnheader" data-col={col.name}
              title={`${col.name} · ${col.typeName}${props.onSort ? `\n${tr('Kliknij, aby sortować (Shift: kolejna kolumna)')}` : ''}`}
              onClick={(e) => props.onSort?.(col.name, e.shiftKey)}>
              <span className="db-hname">{col.key && <span className="db-hkey">PK</span>}{col.name}{dir && <span className="db-sortdir">{dir}{props.sort!.length > 1 ? s + 1 : ''}</span>}</span>
              <span className="db-htype">{col.typeName}</span>
              <span className="db-resize" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); resize(c, e.clientX); }} onClick={(e) => e.stopPropagation()} />
            </span>
          );
        })}
      </div>
      <div className="db-gbody" style={{ height: rowCount * ROW, width: total }}>
        {rowsShown}
        {edit && (
          <CellEditor key={`${edit.row}:${edit.col}`} column={columns[edit.col]} initial={editInitial === undefined ? null : editInitial === null ? null : isTruncated(editInitial) ? editInitial.head : editInitial}
            style={{ top: edit.row * ROW, left: RN + cw.lefts[edit.col], minWidth: widths[edit.col] }}
            onDone={(value) => { const p = edit; setEditing(null); scroller.current?.focus(); if (value !== undefined) props.onEdit?.(p.row, p.col, value); }} />
        )}
      </div>
      {!rowCount && <div className="db-grid-empty">{tr('Brak wierszy')}</div>}
    </div>
  );
});
