// The editor of notes and snippets with code (1.0.6): CodeMirror with the file editor's colours, the chosen language
// (Markdown highlights its fenced code blocks in their own language), wrapped lines and, for snippets, marked {{variables}}.
// Loaded lazily (see LazyTextCodeEditor.tsx) together with the languages.
import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { markdownKeymap } from '@codemirror/lang-markdown';
import {
  Decoration, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightSpecialChars, keymap, MatchDecorator, placeholder,
  ViewPlugin, type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import type { CodeLanguage } from '../../../shared/codeLanguages';
import { snippetVarPattern } from '../../../shared/snippetVars';
import { minimalChange } from '../../../shared/textDiff';
import { codeLanguage } from '../codeHighlight';
import { colors, theme } from './CodeEditor';

const varMarks = new MatchDecorator({ regexp: snippetVarPattern(), decoration: Decoration.mark({ class: 'snip-var' }) });
const variables = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = varMarks.createDeco(view); }
  update(update: ViewUpdate) { this.decorations = varMarks.updateDeco(update, this.decorations); }
}, { decorations: (plugin) => plugin.decorations });

const compact = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'transparent' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 10px' },
  '.cm-scroller': { lineHeight: '1.55' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'normal' },
});

export interface TextCodeEditorApi {
  /** `at`: the cursor goes there first (a note made from a template); -1 = the end of the text. */
  focus(at?: number): void;
  /** Replaces the selection with `text` (the cursor after it). */
  insert(text: string): void;
}

export interface TextCodeEditorProps {
  value: string;
  language: CodeLanguage;
  onChange: (text: string) => void;
  onBlur?: () => void;
  ariaLabel: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Longer input is refused (the textarea's maxLength). */
  maxLength?: number;
  /** Marks {{name}} and {{name:default}} (snippets). */
  markVariables?: boolean;
  /** Tab indents (notes); without it Tab moves on to the next field (the snippet form). */
  tabIndents?: boolean;
  className?: string;
  onApi?: (api: TextCodeEditorApi | null) => void;
  /** Sees every key before the editor does (capture): Escape, the save shortcut; stopPropagation keeps a key from the editor. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Mod+Enter rewrites every line the selection touches with this (notes: a task is ticked, any line becomes a task). */
  onToggleLine?: (line: string) => string;
  /** A pasted image: resolves to the text put in its place (notes: a link to the saved file), null to paste nothing. */
  onPasteImage?: (file: File) => Promise<string | null>;
}

export default function TextCodeEditor({ value, language, onChange, onBlur, ariaLabel, placeholder: hint, autoFocus, maxLength, markVariables, tabIndents, className = '', onApi, onKeyDown, onToggleLine, onPasteImage }: TextCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const blurred = useRef(onBlur);
  blurred.current = onBlur;
  const toggleLine = useRef(onToggleLine);
  toggleLine.current = onToggleLine;
  const pasteImage = useRef(onPasteImage);
  pasteImage.current = onPasteImage;
  const lang = useRef(new Compartment());
  // Markdown (1.0.7): Enter continues a list or a task list (`- [ ] `), Backspace removes an empty item's marker.
  const listKeys = useRef(new Compartment());
  const listKeysOf = (id: CodeLanguage) => (id === 'markdown' ? Prec.high(keymap.of(markdownKeymap)) : []);
  /** The text the editor reported last: when it comes back as `value`, the editor already shows it. */
  const emitted = useRef<string | null>(null);
  useEffect(() => {
    const languageOf = codeLanguage(language);
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: [
      highlightSpecialChars(), history(), drawSelection(), dropCursor(), indentOnInput(), bracketMatching(), highlightActiveLine(),
      keymap.of([{ key: 'Mod-Enter', run: (v) => toggleLines(v, toggleLine.current) }, ...defaultKeymap, ...historyKeymap, ...(tabIndents ? [indentWithTab] : [])]),
      EditorView.domEventHandlers({ paste: (event, v) => pasteImageInto(event, v, pasteImage.current) }),
      theme, compact, colors, indentUnit.of('  '), EditorView.lineWrapping,
      lang.current.of(languageOf ?? []),
      listKeys.current.of(listKeysOf(language)),
      ...(markVariables ? [variables] : []),
      ...(hint ? [placeholder(hint)] : []),
      ...(maxLength ? [EditorState.changeFilter.of((tr) => tr.newDoc.length <= maxLength)] : []),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) { const text = update.state.doc.toString(); emitted.current = text; changed.current(text); }
        if (update.focusChanged && !update.view.hasFocus) blurred.current?.();
      }),
    ] }) });
    view.current = editor;
    if (autoFocus) editor.focus();
    onApi?.({
      focus: (at) => {
        const end = editor.state.doc.length;
        if (at !== undefined) editor.dispatch({ selection: { anchor: at < 0 ? end : Math.min(at, end) }, scrollIntoView: true });
        editor.focus();
      },
      insert: (text) => { editor.dispatch(editor.state.replaceSelection(text)); editor.focus(); },
    });
    return () => { onApi?.(null); view.current = null; editor.destroy(); };
  }, []);
  useEffect(() => {
    view.current?.dispatch({ effects: [lang.current.reconfigure(codeLanguage(language) ?? []), listKeys.current.reconfigure(listKeysOf(language))] });
  }, [language]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || value === emitted.current) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: minimalChange(current, value) });
  }, [value]);
  return <div ref={host} className={`text-code-editor ${className}`} onKeyDownCapture={onKeyDown} onContextMenu={(e) => e.stopPropagation()} />;
}

/** Mod+Enter: each line the selection touches is rewritten by `toggle` (false without it: the key does what it did before). */
function toggleLines(view: EditorView, toggle: ((line: string) => string) | undefined): boolean {
  if (!toggle) return false;
  const { state } = view;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const next = toggle(line.text);
      if (next === line.text) continue;
      // Only the changed part (a box ticked, a marker added): a cursor elsewhere on the line stays where it was.
      const d = minimalChange(line.text, next);
      changes.push({ from: line.from + d.from, to: line.from + d.to, insert: d.insert });
    }
  }
  if (!changes.length) return true;
  const set = state.changes(changes);
  view.dispatch({ changes: set, selection: state.selection.map(set, 1), userEvent: 'input' });
  return true;
}

/** A paste holding an image (and no text): the image is handed to `save`, its answer goes where the selection was. */
function pasteImageInto(event: ClipboardEvent, view: EditorView, save: ((file: File) => Promise<string | null>) | undefined): boolean {
  if (!save || !event.clipboardData) return false;
  const file = Array.from(event.clipboardData.files).find((f) => f.type.startsWith('image/'));
  if (!file || event.clipboardData.getData('text/plain')) return false;
  event.preventDefault();
  void save(file).then((text) => {
    if (!text || !view.dom.isConnected) return;
    // The image on a line of its own.
    const { from, to } = view.state.selection.main;
    const before = from > view.state.doc.lineAt(from).from ? '\n' : '';
    const after = to < view.state.doc.lineAt(to).to ? '\n' : '';
    view.dispatch(view.state.replaceSelection(before + text + after));
  });
  return true;
}
