// The editor of notes and snippets with code (1.0.6): CodeMirror with the file editor's colours, the chosen language
// (Markdown highlights its fenced code blocks in their own language), wrapped lines and, for snippets, marked {{variables}}.
// Loaded lazily (see LazyTextCodeEditor.tsx) together with the languages.
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
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

export interface TextCodeEditorApi { focus(): void }

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
}

export default function TextCodeEditor({ value, language, onChange, onBlur, ariaLabel, placeholder: hint, autoFocus, maxLength, markVariables, tabIndents, className = '', onApi, onKeyDown }: TextCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const blurred = useRef(onBlur);
  blurred.current = onBlur;
  const lang = useRef(new Compartment());
  /** The text the editor reported last: when it comes back as `value`, the editor already shows it. */
  const emitted = useRef<string | null>(null);
  useEffect(() => {
    const languageOf = codeLanguage(language);
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions: [
      highlightSpecialChars(), history(), drawSelection(), dropCursor(), indentOnInput(), bracketMatching(), highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...(tabIndents ? [indentWithTab] : [])]),
      theme, compact, colors, indentUnit.of('  '), EditorView.lineWrapping,
      lang.current.of(languageOf ?? []),
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
    onApi?.({ focus: () => editor.focus() });
    return () => { onApi?.(null); view.current = null; editor.destroy(); };
  }, []);
  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(codeLanguage(language) ?? []) });
  }, [language]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || value === emitted.current) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: minimalChange(current, value) });
  }, [value]);
  return <div ref={host} className={`text-code-editor ${className}`} onKeyDownCapture={onKeyDown} onContextMenu={(e) => e.stopPropagation()} />;
}
