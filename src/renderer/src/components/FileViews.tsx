// Read-only views of the editor tabs: a table (CSV / TSV / Parquet), an image and a large text file (windowed, so 8 MB stay light).
// The table and the large file have the find widget (Ctrl+F): it searches the data in memory, not the few rows on screen.
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useFileZoom } from '../fileZoom';
import { DATA_FIND_LIMIT, lineWindow, type ItemMatch } from '../../../shared/findItems';
import { ItemText, revealMarkHorizontally, rowScrollTop, useFileFinder, useItemFind } from './itemFind';
import type { FileFinder } from './MarkdownPreview';
import './fileViews.css';
import './findWidget.css';

const BASE_ROW = 20;
const OVERSCAN = 20;
/** Characters of one line the large file view draws. */
const LINE_CHARS = 2000;

/**
 * A grid of text cells with a sticky header and a row-number column; rows beyond the first screens are windowed.
 * Find searches every cell of `rows`: all the rows the tab holds (the CSV text that was read, the rows read from a Parquet file).
 */
export const DataTable = memo(function DataTable({ columns, types, rows, note, finder }: { columns: string[]; types?: string[]; rows: (string | null)[][]; note?: string; finder?: FileFinder }) {
  const { tr } = useI18n();
  const ROW_HEIGHT = Math.round(BASE_ROW * useFileZoom());
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const width = Math.max(1, columns.length);
  // One piece per cell, row by row (a missing cell of a short row is empty; NULL is not text).
  const cells = useMemo(() => {
    const out: string[] = new Array(rows.length * width);
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < width; c++) out[r * width + c] = rows[r][c] ?? '';
    return out;
  }, [rows, width]);
  /** The current match is on a row that is drawn after the scroll: then the scroller moves sideways to its cell. */
  const sideways = useRef(false);
  const find = useItemFind(cells, {
    scroller,
    limit: DATA_FIND_LIMIT,
    reveal: (match: ItemMatch) => {
      const el = scroller.current;
      if (!el) return;
      const scroll = rowScrollTop(Math.floor(match.item / width), ROW_HEIGHT, el, head.current?.offsetHeight ?? 0);
      if (scroll !== null) el.scrollTop = scroll;
      setTop(el.scrollTop);
      setHeight(el.clientHeight);
      sideways.current = true;
    },
    firstVisible: () => Math.max(0, Math.floor((scroller.current?.scrollTop ?? 0) / ROW_HEIGHT)) * width,
  });
  useFileFinder(finder, find.open);
  useLayoutEffect(() => {
    if (sideways.current && scroller.current && revealMarkHorizontally(scroller.current, 56, '.data-cell.find-current')) sideways.current = false;
  });
  const currentItem = find.current !== null ? find.matches[find.current]?.item ?? -1 : -1;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  const template = `56px repeat(${columns.length}, minmax(90px, 260px))`;
  return (
    <div className="data-view">
      {note && <div className="preview-notice">{note}</div>}
      <div className="find-host" onKeyDown={find.onKeyDown}>
        <div
          className="data-scroll"
          ref={scroller}
          tabIndex={0}
          onScroll={(e) => { setTop(e.currentTarget.scrollTop); setHeight(e.currentTarget.clientHeight); }}
          role="table"
          aria-label={tr('Tabela')}
          aria-rowcount={rows.length + 1}
        >
          <div ref={head} className="data-row data-head" role="row" style={{ gridTemplateColumns: template }}>
            <span className="data-cell data-index" role="columnheader">#</span>
            {columns.map((name, i) => <span key={i} className="data-cell" role="columnheader" title={types?.[i] ? `${name} · ${types[i]}` : name}>{name}{types?.[i] ? <em>{types[i].toLowerCase()}</em> : null}</span>)}
          </div>
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {rows.slice(first, last).map((row, offset) => {
              const index = first + offset;
              return (
                <div key={index} className="data-row" role="row" style={{ gridTemplateColumns: template, top: index * ROW_HEIGHT }}>
                  <span className="data-cell data-index" role="cell">{index + 1}</span>
                  {columns.map((_, c) => {
                    const value = row[c];
                    const item = index * width + c;
                    const empty = value === null || value === undefined;
                    return (
                      <span key={c} className={`data-cell ${empty ? 'data-null' : ''} ${item === currentItem ? 'find-current' : ''}`} role="cell" title={value ?? undefined}>
                        {empty ? 'NULL' : <ItemText text={value} item={item} find={find} />}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        {find.widget}
      </div>
    </div>
  );
});

export function ImageView({ src, name, size }: { src: string; name: string; size?: number }) {
  const { language } = useI18n();
  const zoom = useFileZoom();
  const [dimensions, setDimensions] = useState<string>('');
  const kb = size === undefined ? '' : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(size / 1024)} KB`;
  return (
    <div className="image-view">
      <div className="image-stage"><img src={src} alt={name} draggable={false} style={zoom === 1 ? undefined : { maxWidth: 'none', maxHeight: 'none', width: `${zoom * 100}%`, objectFit: 'contain' }} onLoad={(e) => setDimensions(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} /></div>
      <div className="image-meta muted">{[dimensions, kb].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

/** Plain text with a line-number gutter, windowed by fixed-height rows (no wrapping). Find searches every line that was read. */
export function LargeTextView({ text, notice, finder }: { text: string; notice: string; finder?: FileFinder }) {
  const ROW_HEIGHT = Math.round(BASE_ROW * useFileZoom());
  const lines = useMemo(() => text.split('\n'), [text]);
  const scroller = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const sideways = useRef(false);
  const find = useItemFind(lines, {
    scroller,
    limit: DATA_FIND_LIMIT,
    reveal: (match: ItemMatch) => {
      const el = scroller.current;
      if (!el) return;
      const scroll = rowScrollTop(match.item, ROW_HEIGHT, el);
      if (scroll !== null) el.scrollTop = scroll;
      setTop(el.scrollTop);
      setHeight(el.clientHeight);
      sideways.current = true;
    },
    firstVisible: () => Math.max(0, Math.floor((scroller.current?.scrollTop ?? 0) / ROW_HEIGHT)),
  });
  useFileFinder(finder, find.open);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (sideways.current && el && revealMarkHorizontally(el, el.querySelector<HTMLElement>('.large-no')?.offsetWidth ?? 0)) sideways.current = false;
  });
  const current = find.current !== null ? find.matches[find.current] : undefined;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  const digits = String(lines.length).length;
  return (
    <div className="large-view">
      <div className="preview-notice">{notice}</div>
      <div className="find-host" onKeyDown={find.onKeyDown}>
        <div
          ref={scroller}
          className="large-scroll"
          tabIndex={0}
          onScroll={(e) => { setTop(e.currentTarget.scrollTop); setHeight(e.currentTarget.clientHeight); }}
          style={{ ['--digits' as string]: `${digits}ch` }}
        >
          <div style={{ height: lines.length * ROW_HEIGHT, position: 'relative', minWidth: 'max-content' }}>
            {lines.slice(first, last).map((line, offset) => {
              const index = first + offset;
              // A very long line shows 2000 characters: from its start, or around the current match when that lies further.
              const { start, end } = lineWindow(line.length, LINE_CHARS, current?.item === index ? [current.from, current.to] : undefined);
              return (
                <div key={index} className="large-line" style={{ top: index * ROW_HEIGHT }}>
                  <span className="large-no">{index + 1}</span>
                  <span className="large-code">{line ? <ItemText text={line} item={index} find={find} start={start} end={end} prefix={start > 0 ? '… ' : ''} suffix={end < line.length ? ' …' : ''} /> : ' '}</span>
                </div>
              );
            })}
          </div>
        </div>
        {find.widget}
      </div>
    </div>
  );
}
