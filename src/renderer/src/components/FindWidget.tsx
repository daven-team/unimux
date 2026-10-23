// The find widget inside one file, in the style of VS Code: a small box floating at the top right of the text, a find field with
// the match case / whole word / regexp toggles, the counter, previous / next and close, and (in editable files) a replace row.
// The code editor (editorFind.tsx) drives @codemirror/search with it, the Markdown preview (MarkdownPreview.tsx) its rendered text.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { findCounter, findKey, type FindOptions } from '../../../shared/findText';
import { useI18n } from '../i18n';
import { IX } from './icons';
import './findWidget.css';

export type FindToggles = Omit<FindOptions, 'query'>;

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IUp = () => <Svg><path d="M8 12.5v-9M4 7.5l4-4 4 4" /></Svg>;
const IDown = () => <Svg><path d="M8 3.5v9M4 8.5l4 4 4-4" /></Svg>;
const IExpand = () => <Svg><path d="M6 4l4 4-4 4" /></Svg>;

export interface FindWidgetProps {
  query: string;
  onQuery(query: string): void;
  toggles: FindToggles;
  onToggle(name: keyof FindToggles): void;
  /** Index of the match at the cursor (null: the cursor is not on a match) and how many there are. */
  current: number | null;
  total: number;
  capped?: boolean;
  invalid?: boolean;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
  /** Present only where the text can be changed (the code editor). */
  replace?: {
    open: boolean;
    value: string;
    onValue(value: string): void;
    onOpen(open: boolean): void;
    onReplace(): void;
    onReplaceAll(): void;
  };
  /** Bumped to move the keyboard into the find field (and select its text) or into the replace field. */
  focusFind: number;
  focusReplace?: number;
  /** What the box searches, for screen readers (default: "Znajdź w pliku"). */
  label?: string;
  /** One more key that moves the keyboard back into the find field (the terminal's own find shortcut, Ctrl+Shift+F). */
  isFindKey?(e: KeyboardEvent): boolean;
}

const isMod = (e: KeyboardEvent) => (window.mc.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

export function FindWidget(props: FindWidgetProps) {
  const { tr, language } = useI18n();
  const { replace, toggles } = props;
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  // The field keeps its own text: the host answers asynchronously (the editor's update cycle), the caret must not jump.
  const [text, setText] = useState(props.query);
  const sent = useRef(props.query);
  useEffect(() => { if (props.query !== sent.current) { sent.current = props.query; setText(props.query); } }, [props.query]);
  const [replaceText, setReplaceText] = useState(replace?.value ?? '');
  useEffect(() => { if (replace && replace.value !== replaceText) setReplaceText(replace.value); }, [replace?.value]);
  useLayoutEffect(() => { findInput.current?.focus(); findInput.current?.select(); }, [props.focusFind]);
  useLayoutEffect(() => { if (props.focusReplace) { replaceInput.current?.focus(); replaceInput.current?.select(); } }, [props.focusReplace, replace?.open]);

  const format = (n: number) => n.toLocaleString(language);
  const counter = findCounter({ query: text, current: props.current, total: props.total, capped: props.capped, invalid: props.invalid }, format);
  const empty = !!counter?.empty;
  const none = props.total === 0;

  const onKey = (e: KeyboardEvent, field: 'find' | 'replace') => {
    const key = e.key;
    const shortcut = findKey(e, window.mc.platform);
    let handled = true;
    if (key === 'Escape') props.onClose();
    else if (key === 'F3') (e.shiftKey ? props.onPrev : props.onNext)();
    else if (key === 'Enter' && field === 'find') (e.shiftKey ? props.onPrev : props.onNext)();
    else if (key === 'Enter' && field === 'replace' && replace) (isMod(e) && e.altKey ? replace.onReplaceAll : replace.onReplace)();
    else if (shortcut === 'find' || (shortcut === 'replace' && !replace) || props.isFindKey?.(e)) { findInput.current?.focus(); findInput.current?.select(); }
    else if (shortcut === 'replace' && replace) {
      replace.onOpen(true);
      replaceInput.current?.focus();
      replaceInput.current?.select();
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyW' || e.code === 'KeyR')) {
      // VS Code's Alt+C / Alt+W / Alt+R (AltGr is Ctrl+Alt, so Polish letters typed with it never land here).
      props.onToggle(e.code === 'KeyC' ? 'caseSensitive' : e.code === 'KeyW' ? 'wholeWord' : 'regexp');
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const toggle = (name: keyof FindToggles, label: string, combo: string, glyph: ReactNode) => (
    <button type="button" className={`find-toggle ${toggles[name] ? 'on' : ''}`} title={`${label} (${combo})`} aria-label={label} aria-pressed={toggles[name]}
      data-find={name} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onToggle(name)}>{glyph}</button>
  );
  const iconButton = (label: string, hint: string, action: string, onClick: () => void, icon: ReactNode, disabled = false) => (
    <button type="button" className="btn ghost icon find-button" title={hint ? `${label} (${hint})` : label} aria-label={label} data-find={action}
      disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{icon}</button>
  );
  // Replace and Replace all are words, not icons: the two arrows of other editors are hard to tell apart at this size.
  const textButton = (label: string, hint: string, action: string, onClick: () => void, disabled: boolean) => (
    <button type="button" className="btn ghost small find-text-button" title={`${label} (${hint})`} data-find={action}
      disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  const replaceLabel = replace?.open ? tr('Ukryj zamianę') : tr('Pokaż zamianę');
  return (
    <div className={`find-widget ${replace ? 'with-replace' : ''} ${replace?.open ? 'replacing' : ''}`} role="search" aria-label={props.label ?? tr('Znajdź w pliku')}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onClose(); } }}>
      {replace && <button type="button" className="find-expand" title={replaceLabel} aria-label={replaceLabel} aria-expanded={replace.open} data-find="expand"
        onMouseDown={(e) => e.preventDefault()} onClick={() => replace.onOpen(!replace.open)}><span className={replace.open ? 'open' : ''}><IExpand /></span></button>}
      <div className="find-rows">
        <div className="find-row">
          <div className={`find-field ${text && empty ? 'no-match' : ''}`}>
            <input ref={findInput} className="find-input" main-field="true" type="text" spellCheck={false} autoComplete="off" placeholder={tr('Znajdź')} aria-label={tr('Znajdź')}
              value={text} onChange={(e) => { const value = e.target.value; setText(value); sent.current = value; props.onQuery(value); }} onKeyDown={(e) => onKey(e, 'find')} />
            {toggle('caseSensitive', tr('Uwzględnij wielkość liter'), 'Alt+C', <span className="find-glyph">Aa</span>)}
            {toggle('wholeWord', tr('Całe słowa'), 'Alt+W', <span className="find-glyph find-glyph-word">ab</span>)}
            {toggle('regexp', tr('Wyrażenie regularne'), 'Alt+R', <span className="find-glyph">.*</span>)}
          </div>
          <span className={`find-count ${empty ? 'empty' : ''}`} role="status" aria-live="polite">{counter ? tr(counter.key, counter.params) : ''}</span>
          {iconButton(tr('Poprzednie wystąpienie'), 'Shift+Enter', 'prev', props.onPrev, <IUp />, none)}
          {iconButton(tr('Następne wystąpienie'), 'Enter', 'next', props.onNext, <IDown />, none)}
          {iconButton(tr('Zamknij wyszukiwanie'), 'Esc', 'close', props.onClose, <IX />)}
        </div>
        {replace?.open && <div className="find-row">
          <div className="find-field">
            <input ref={replaceInput} className="find-input" type="text" spellCheck={false} autoComplete="off" placeholder={tr('Zamień na')} aria-label={tr('Zamień na')}
              value={replaceText} onChange={(e) => { setReplaceText(e.target.value); replace.onValue(e.target.value); }} onKeyDown={(e) => onKey(e, 'replace')} />
          </div>
          {textButton(tr('Zamień'), 'Enter', 'replace', replace.onReplace, none)}
          {textButton(tr('Zamień wszystko'), window.mc.platform === 'darwin' ? 'Cmd+Alt+Enter' : 'Ctrl+Alt+Enter', 'replace-all', replace.onReplaceAll, none)}
        </div>}
      </div>
    </div>
  );
}
