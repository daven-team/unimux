// The prompt queue of an agent cell (1.0.9) in the cell's footer: one slim row while prompts wait ("Kolejka 2", what happens
// next, pause / resume, send now) and a panel above it to add, edit, reorder (drag), send and delete them. The queue itself is
// run by renderer/promptQueue.ts; this only shows it and edits it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PAUSE_LABEL, promptPreview, QUEUE_MAX_ITEMS, WAIT_LABEL, type QueuedPrompt } from '../../../shared/promptQueue';
import type { Cell } from '../../../shared/types';
import { useI18n } from '../i18n';
import {
  addToQueue, clearQueue, closeQueue, editQueuedPrompt, moveQueuedPrompt, openQueue, pauseCellQueue, queueCapable, removeQueuedPrompt,
  resumeCellQueue, sendQueuedNow, useQueueRuntime, verdictFor,
} from '../promptQueue';
import { titleWithShortcut, useShortcutText } from '../shortcuts';
import { useStore } from '../store';
import { IGrip, IPlay, IX } from './icons';
import './promptQueue.css';

const ISend = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
);
const IPause = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" /><rect x="9.4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" /></svg>
);
const IQueue = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h12M4 12h12M4 18h8M19 15v6M16 18h6" /></svg>
);

export function PromptQueueBar({ cell }: { cell: Cell }) {
  const capable = useStore((st) => queueCapable(st.s, cell));
  const open = useQueueRuntime((r) => r.open?.cellId === cell.id);
  if (!capable || (!cell.promptQueue && !open)) return null;
  return <Bar cell={cell} open={open} />;
}

function Bar({ cell, open }: { cell: Cell; open: boolean }) {
  const { tr } = useI18n();
  useShortcutText();
  const barRef = useRef<HTMLDivElement>(null);
  const items = cell.promptQueue?.items ?? [];
  const paused = cell.promptQueue?.paused;
  const due = useQueueRuntime((r) => r.countdown[cell.id]);
  // Re-read the verdict whenever the cell's status changes (it lives in the store) or a prompt was just sent.
  useStore((st) => `${st.ui.statuses[cell.id]}|${st.ui.statusDetails[cell.id]?.kind}|${st.ui.failures[cell.id]}`);
  useQueueRuntime((r) => r.sent[cell.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (due === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [due]);
  const verdict = verdictFor(cell.id);
  const state = due !== undefined
    ? tr('wysyłanie za {seconds} s', { seconds: Math.max(1, Math.ceil((due - now) / 1000)) })
    : paused ? tr(PAUSE_LABEL[paused])
    : verdict.kind === 'wait' ? tr(WAIT_LABEL[verdict.why])
    : verdict.kind === 'ready' ? tr('następny po zakończeniu tury') : '';
  const next = items[0];
  return (
    <div ref={barRef} className={`queue-bar${paused ? ' paused' : ''}${due !== undefined ? ' due' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className={`queue-badge${open ? ' on' : ''}`} title={titleWithShortcut(tr('Kolejka promptów'), 'cell.queue')}
        aria-expanded={open} onClick={() => (open ? closeQueue() : openQueue(cell.id, false))}>
        <IQueue /><span>{tr('Kolejka {count}', { count: items.length })}</span>
      </button>
      {state && <span className="queue-state" title={state}>{state}</span>}
      {next && <span className="queue-next" title={next.text}>{promptPreview(next.text)}</span>}
      <span className="queue-actions">
        {due !== undefined
          ? <button type="button" className="queue-btn" onClick={() => pauseCellQueue(cell.id)}>{tr('Anuluj')}</button>
          : items.length > 0 && (paused
            ? <button type="button" className="queue-btn" title={tr('Wznów kolejkę')} aria-label={tr('Wznów kolejkę')} onClick={() => resumeCellQueue(cell.id)}><IPlay /></button>
            : <button type="button" className="queue-btn" title={tr('Wstrzymaj kolejkę')} aria-label={tr('Wstrzymaj kolejkę')} onClick={() => pauseCellQueue(cell.id)}><IPause /></button>)}
        {items.length > 0 && <button type="button" className="queue-btn" title={tr('Wyślij następny teraz')} aria-label={tr('Wyślij następny teraz')} onClick={() => sendQueuedNow(cell.id)}><ISend /></button>}
      </span>
      {open && <Panel cell={cell} items={items} anchor={barRef} />}
    </div>
  );
}

function Panel({ cell, items, anchor }: { cell: Cell; items: QueuedPrompt[]; anchor: React.RefObject<HTMLDivElement | null> }) {
  const { tr } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const openState = useQueueRuntime((r) => r.open);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  // The dragged prompt also in a ref: the drop may come before React re-rendered with the state.
  const dragged = useRef<string | null>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const paused = cell.promptQueue?.paused;

  useLayoutEffect(() => {
    const placeIt = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 340), 520, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setPlace({ left, bottom: window.innerHeight - rect.top + 4, width });
    };
    placeIt();
    window.addEventListener('resize', placeIt);
    return () => window.removeEventListener('resize', placeIt);
  }, [anchor]);

  // The shortcut and the palette open the panel with the add field focused (again when it is already open).
  const placed = place !== null;
  useEffect(() => { if (placed && openState?.compose) composeRef.current?.focus(); }, [placed, openState?.seq, openState?.compose]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) return;
      closeQueue();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) { e.stopPropagation(); closeQueue(); } };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', esc, true); };
  }, [anchor, editing]);

  const add = () => {
    if (!draft.trim()) return;
    addToQueue(cell.id, draft);
    setDraft('');
  };
  const saveEdit = () => {
    if (editing) editQueuedPrompt(cell.id, editing.id, editing.text);
    setEditing(null);
  };

  if (!place) return null;
  return createPortal(
    <div ref={panelRef} className="queue-panel" role="dialog" aria-label={tr('Kolejka promptów')}
      style={{ left: place.left, bottom: place.bottom, width: place.width }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="queue-panel-head">
        <span className="queue-panel-title">{tr('Kolejka promptów')}</span>
        <span className="queue-panel-hint">{paused ? tr(PAUSE_LABEL[paused]) : tr('Następny prompt trafi do agenta, gdy skończy turę.')}</span>
        <button type="button" className="queue-btn" aria-label={tr('Zamknij')} title={tr('Zamknij')} onClick={closeQueue}><IX /></button>
      </div>
      {items.length > 0 && <ol className="queue-list" onDragOver={(e) => e.preventDefault()}>
        {items.map((item, index) => (
          <li key={item.id}
            className={`queue-item${drag?.id === item.id ? ' dragging' : ''}${drag && drag.over === index && drag.id !== item.id ? ' over' : ''}`}
            draggable={editing?.id !== item.id}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); dragged.current = item.id; setDrag({ id: item.id, over: index }); }}
            onDragOver={(e) => { e.preventDefault(); if (drag && drag.over !== index) setDrag({ ...drag, over: index }); }}
            onDrop={(e) => { e.preventDefault(); if (dragged.current) moveQueuedPrompt(cell.id, dragged.current, index); dragged.current = null; setDrag(null); }}
            onDragEnd={() => { dragged.current = null; setDrag(null); }}
          >
            <span className="queue-grip" title={tr('Przeciągnij, aby zmienić kolejność')}><IGrip /></span>
            <span className="queue-index">{index + 1}</span>
            {editing?.id === item.id ? (
              <textarea className="queue-edit" autoFocus value={editing.text} rows={Math.min(8, Math.max(2, editing.text.split('\n').length))}
                onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
                onBlur={saveEdit}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                }} />
            ) : (
              <span className="queue-text" title={tr('Kliknij, aby edytować')} onClick={() => setEditing({ id: item.id, text: item.text })}>{item.text}</span>
            )}
            <span className="queue-item-actions">
              <button type="button" className="queue-btn" title={tr('Wyślij teraz')} aria-label={tr('Wyślij teraz')} onClick={() => sendQueuedNow(cell.id, item.id)}><ISend /></button>
              <button type="button" className="queue-btn" title={tr('Usuń')} aria-label={tr('Usuń')} onClick={() => removeQueuedPrompt(cell.id, item.id)}><IX /></button>
            </span>
          </li>
        ))}
      </ol>}
      <div className="queue-compose">
        <textarea ref={composeRef} value={draft} rows={Math.min(6, Math.max(2, draft.split('\n').length))}
          placeholder={tr('Dodaj prompt do kolejki (Enter dodaje, Shift+Enter nowa linia)')}
          disabled={items.length >= QUEUE_MAX_ITEMS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); add(); }
            if (e.key === 'Escape') { e.preventDefault(); closeQueue(); }
          }} />
      </div>
      <div className="queue-panel-foot">
        <button type="button" className="btn small primary" disabled={!draft.trim()} onClick={add}>{tr('Dodaj')}</button>
        <span className="grow" />
        {items.length > 0 && (paused
          ? <button type="button" className="btn small" onClick={() => resumeCellQueue(cell.id)}>{tr('Wznów kolejkę')}</button>
          : <button type="button" className="btn small" onClick={() => pauseCellQueue(cell.id)}>{tr('Wstrzymaj kolejkę')}</button>)}
        {items.length > 0 && <button type="button" className="btn small" onClick={() => clearQueue(cell.id)}>{tr('Wyczyść')}</button>}
      </div>
    </div>,
    document.body,
  );
}
